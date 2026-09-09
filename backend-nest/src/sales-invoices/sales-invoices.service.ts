import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { BatchAllocation, BatchesService } from '../batches/batches.service';
import { InventoryService } from '../inventory/inventory.service';
import { PricingService } from '../pricing/pricing.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { WebhookDispatchService } from '../common/wms/webhook-dispatch.service';
import { LedgerPostingService } from '../common/wms/ledger-posting.service';
import { AuditService } from '../common/services/audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { UpdateSalesInvoiceDto } from './dto/update-sales-invoice.dto';
import { SalesInvoiceQueryDto } from './dto/sales-invoice-query.dto';
import { CreateSalesInvoicePaymentDto } from './dto/create-sales-invoice-payment.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

@Injectable()
export class SalesInvoicesService {
  private readonly logger = new Logger(SalesInvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BatchesService,
    private readonly inventory: InventoryService,
    private readonly pricing: PricingService,
    private readonly documentNumbers: DocumentNumberService,
    private readonly auditService: AuditService,
    private readonly webhooks: WebhookDispatchService,
    private readonly ledger: LedgerPostingService,
  ) {}

  private audit(
    action: string,
    targetId: string | null | undefined,
    metadata: Record<string, unknown> | undefined,
    actor: Actor,
    req?: Request,
  ) {
    this.auditService.log(
      {
        action,
        actorId: actor?.userId,
        actorUsername: actor?.username,
        targetType: 'sales_invoice',
        targetId: targetId ?? undefined,
        metadata,
      },
      req,
    );
  }

  // ------------------------------------------------------------------ queries

  async list(query: SalesInvoiceQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.SalesInvoiceWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.search) where.invoiceNumber = { contains: query.search, mode: 'insensitive' };
    if (query.from || query.to) {
      where.invoiceDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.overdue === 'true') {
      where.dueDate = { lt: new Date() };
      where.status = { in: [DocumentStatus.POSTED, DocumentStatus.PARTIALLY_PAID] };
    }

    const [invoices, total] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where,
        orderBy: { invoiceDate: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.salesInvoice.count({ where }),
    ]);

    return paginatedResponse(
      invoices.map((inv) => ({
        ...inv,
        balance: D(inv.totalAmount).minus(D(inv.paidAmount)),
        margin: D(inv.subtotal).minus(D(inv.discountAmount)).minus(D(inv.cogsAmount)),
      })),
      page,
      limit,
      total,
    );
  }

  async get(invoiceId: string) {
    const invoice = await this.prisma.salesInvoice.findFirst({
      where: { id: invoiceId },
      include: {
        customer: true,
        priceTier: { select: { code: true, name: true } },
        items: { orderBy: { createdAt: 'asc' }, include: { batch: { select: { batchNumber: true, expiryDate: true } } } },
        deliveryNotes: { include: { items: true } },
        salesOrder: { select: { id: true, soNumber: true, status: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Sales invoice not found');

    return {
      ...invoice,
      balance: D(invoice.totalAmount).minus(D(invoice.paidAmount)),
      margin: D(invoice.subtotal).minus(D(invoice.discountAmount)).minus(D(invoice.cogsAmount)),
    };
  }

  // ------------------------------------------------------------------- create

  /**
   * Creates a draft invoice, pricing every line through the pricing engine and
   * proposing a FEFO batch per line.
   *
   * Nothing leaves stock here — a draft is a quotation the operator can still
   * change. Stock only moves at `post`.
   */
  async create(dto: CreateSalesInvoiceDto, actor: Actor, req?: Request) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const customer = await this.prisma.customer.findFirst({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Customer not found');

    const quote = await this.pricing.quote({
      customerId: dto.customerId,
      priceTierId: dto.priceTierId,
      items: dto.items.map((i) => ({
        sku: i.sku,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discountPercent: i.discountPercent,
        discountAmount: i.discountAmount,
        taxRate: i.taxRate,
      })),
    });

    // FEFO proposal per line. Advisory at draft stage: it tells the operator
    // which lot will ship and flags a shortfall before the customer is
    // promised anything, but `post` re-allocates against live stock.
    const proposals = await Promise.all(
      dto.items.map(async (item) => {
        const product = await this.prisma.product.findFirst({
          where: { sku: item.sku },
          select: { batchTracked: true },
        });
        if (!product?.batchTracked) return null;
        return this.batches.allocate({
          sku: item.sku,
          quantity: item.quantity,
          location: item.location,
          strategy: 'FEFO',
        });
      }),
    );

    const invoice = await this.prisma.$transaction(async (tx) => {
      const invoiceNumber = await this.documentNumbers.next(tx, 'salesInvoice', tenantId);

      const created = await tx.salesInvoice.create({
        data: {
          invoiceNumber,
          customerId: dto.customerId,
          salesOrderId: dto.salesOrderId ?? null,
          priceTierId: quote.priceTier?.id ?? null,
          invoiceDate: new Date(dto.invoiceDate ?? Date.now()),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          currency: dto.currency ?? 'SYP',
          notes: dto.notes ?? null,
          createdBy: actor?.userId ?? dto.customerId,
          items: {
            create: dto.items.map((item, index) => {
              const priced = quote.lines[index];
              const proposal = proposals[index];
              const first = proposal?.allocations[0];
              return {
                salesOrderItemId: item.salesOrderItemId ?? null,
                sku: item.sku,
                batchId: first?.batchId ?? null,
                batchNumber: first?.batchNumber ?? null,
                expiryDate: first?.expiryDate ?? null,
                quantity: item.quantity,
                unitPrice: priced.unitPrice,
                discountPercent: priced.discountPercent,
                discountAmount: priced.discountAmount,
                taxRate: priced.taxRate,
                taxAmount: priced.taxAmount,
                lineTotal: priced.lineTotal,
                location: item.location ?? 'WH-A',
              };
            }),
          },
        },
      });

      return this.recalculate(tx, created.id);
    });

    this.audit('sales_invoice.create', invoice.id, { invoiceNumber: invoice.invoiceNumber }, actor, req);

    return {
      ...invoice,
      // `allocate` already reports the SKU it planned for, so the proposals
      // list needs no re-keying — just drop the non-batch-tracked lines.
      fefo: proposals.filter((p) => p !== null),
    };
  }

  /** Prefills an invoice from a confirmed sales order. */
  async fromSalesOrder(salesOrderId: string) {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: salesOrderId },
      include: { items: true, customer: true },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    if (order.status === 'cancelled') {
      throw new ConflictException('Cannot invoice a cancelled sales order');
    }

    return {
      customerId: order.customerId,
      customerName: order.customer?.name ?? null,
      salesOrderId: order.id,
      soNumber: order.soNumber,
      invoiceDate: new Date().toISOString().slice(0, 10),
      items: order.items.map((item) => ({
        salesOrderItemId: item.id,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        taxRate: item.taxRate,
        location: item.location,
      })),
    };
  }

  async update(invoiceId: string, dto: UpdateSalesInvoiceDto, actor: Actor, req?: Request) {
    const invoice = await this.requireDraft(invoiceId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: {
          invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : undefined,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          notes: dto.notes,
        },
      });

      if (dto.items) {
        const quote = await this.pricing.quote({
          customerId: invoice.customerId,
          priceTierId: invoice.priceTierId ?? undefined,
          items: dto.items.map((i) => ({
            sku: i.sku,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discountPercent: i.discountPercent,
            discountAmount: i.discountAmount,
            taxRate: i.taxRate,
          })),
        });

        await tx.salesInvoiceItem.deleteMany({ where: { invoiceId } });
        for (const [index, item] of dto.items.entries()) {
          const priced = quote.lines[index];
          await tx.salesInvoiceItem.create({
            data: {
              invoiceId,
              salesOrderItemId: item.salesOrderItemId ?? null,
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: priced.unitPrice,
              discountPercent: priced.discountPercent,
              discountAmount: priced.discountAmount,
              taxRate: priced.taxRate,
              taxAmount: priced.taxAmount,
              lineTotal: priced.lineTotal,
              location: item.location ?? 'WH-A',
            },
          });
        }
      }

      return this.recalculate(tx, invoiceId);
    });

    this.audit('sales_invoice.update', invoiceId, { items: dto.items?.length }, actor, req);
    return updated;
  }

  async remove(invoiceId: string, actor: Actor, req?: Request) {
    await this.requireDraft(invoiceId);
    await this.prisma.salesInvoice.delete({ where: { id: invoiceId } });
    this.audit('sales_invoice.delete', invoiceId, undefined, actor, req);
    return { message: 'Draft sales invoice deleted' };
  }

  // --------------------------------------------------------------------- post

  /**
   * Posts the invoice: goods leave stock, a delivery note is issued, COGS is
   * frozen.
   *
   * Batch-tracked lines are re-allocated against live stock at this moment
   * rather than trusting the draft's proposal — between drafting and posting,
   * another order may have taken the lot, or the QC team may have quarantined
   * it. Non-tracked lines fall back to a plain location deduction.
   *
   * Credit limit is enforced here and nowhere else: a draft that exceeds it is
   * still a legitimate quotation, but it must not become a receivable.
   */
  async post(invoiceId: string, actor: Actor, req?: Request) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const invoice = await this.prisma.salesInvoice.findFirst({
      where: { id: invoiceId },
      include: { items: true, customer: true },
    });
    if (!invoice) throw new NotFoundException('Sales invoice not found');
    if (invoice.status !== DocumentStatus.DRAFT) {
      throw new ConflictException(`Only draft invoices can be posted (current: ${invoice.status})`);
    }
    if (invoice.items.length === 0) {
      throw new BadRequestException('Cannot post an invoice with no lines');
    }

    await this.assertCreditLimit(invoice.customerId, D(invoice.totalAmount), invoiceId);

    const result = await this.prisma.$transaction(
      async (tx) => {
        let cogs = ZERO;
        const deliveryItems: Array<{
          sku: string;
          batchId: string | null;
          batchNumber: string | null;
          quantity: number;
          location: string;
        }> = [];

        for (const item of invoice.items) {
          const product = await tx.product.findFirst({
            where: { sku: item.sku },
            select: { batchTracked: true, costPrice: true, name: true },
          });
          if (!product) throw new NotFoundException(`Product with SKU "${item.sku}" not found`);

          if (product.batchTracked) {
            const plan = await this.batches.allocate({
              sku: item.sku,
              quantity: item.quantity,
              location: item.location,
              strategy: 'FEFO',
            });

            if (plan.shortfall > 0) {
              const blocked = plan.blocked.length
                ? ` (${plan.blocked.length} batch(es) held: ${plan.blocked.map((b) => b.reason).join('، ')})`
                : '';
              throw new ConflictException(
                `Insufficient sellable stock for "${product.name}": short by ${plan.shortfall} unit(s)${blocked}`,
              );
            }

            await this.batches.consumeWithin(tx, plan.allocations, {
              reason: `Sales invoice ${invoice.invoiceNumber}`,
              referenceType: 'sales_invoice',
              referenceId: invoiceId,
              createdById: actor?.userId,
            });

            // COGS at the cost of the lots actually shipped, not at today's
            // average — that is what makes the margin on this invoice true.
            const lineCogs = plan.allocations.reduce(
              (sum: Prisma.Decimal, a: BatchAllocation) => sum.plus(a.unitCost.mul(a.quantity)),
              ZERO,
            );
            cogs = cogs.plus(lineCogs);

            const primary = plan.allocations[0];
            await tx.salesInvoiceItem.update({
              where: { id: item.id },
              data: {
                batchId: primary?.batchId ?? null,
                batchNumber: plan.allocations.map((a) => a.batchNumber).join(', ').slice(0, 200),
                expiryDate: primary?.expiryDate ?? null,
                unitCost: item.quantity > 0 ? lineCogs.div(item.quantity).toDecimalPlaces(4) : ZERO,
              },
            });

            for (const allocation of plan.allocations) {
              deliveryItems.push({
                sku: allocation.sku,
                batchId: allocation.batchId,
                batchNumber: allocation.batchNumber,
                quantity: allocation.quantity,
                location: allocation.location,
              });
            }
          } else {
            await this.inventory.applyStockChangeWithin(tx, {
              sku: item.sku,
              location: item.location,
              change: -item.quantity,
              reason: `Sales invoice ${invoice.invoiceNumber}`,
              referenceType: 'sales_invoice',
              referenceId: invoiceId,
              createdById: actor?.userId,
            });

            const unitCost = D(product.costPrice);
            cogs = cogs.plus(unitCost.mul(item.quantity));
            await tx.salesInvoiceItem.update({ where: { id: item.id }, data: { unitCost } });

            deliveryItems.push({
              sku: item.sku,
              batchId: null,
              batchNumber: null,
              quantity: item.quantity,
              location: item.location,
            });
          }
        }

        // The delivery note is the document the driver carries and the
        // customer signs; issuing it with the invoice keeps the two in step.
        const noteNumber = await this.documentNumbers.next(tx, 'deliveryNote', tenantId);
        await tx.deliveryNote.create({
          data: {
            noteNumber,
            salesInvoiceId: invoiceId,
            salesOrderId: invoice.salesOrderId,
            customerId: invoice.customerId,
            status: 'issued',
            issuedAt: new Date(),
            createdBy: actor?.userId ?? invoice.createdBy,
            items: { create: deliveryItems },
          },
        });

        await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: {
            status: DocumentStatus.POSTED,
            postedAt: new Date(),
            postedBy: actor?.userId ?? null,
            cogsAmount: cogs,
          },
        });

        if (invoice.salesOrderId) {
          await tx.salesOrder.updateMany({
            where: { id: invoice.salesOrderId },
            data: { status: 'delivered' },
          });
        }

        const totals = await this.recalculate(tx, invoiceId);

        // Revenue and COGS are recognised at the same moment the goods leave,
        // and COGS uses the cost of the lots actually shipped -- which is why
        // this runs after allocation rather than off the product's average.
        await this.ledger.postWithin(tx, tenantId, {
          description: `فاتورة بيع ${invoice.invoiceNumber}`,
          entryDate: invoice.invoiceDate,
          sourceType: 'sales_invoice',
          sourceId: invoiceId,
          sourceRef: `sales_invoice:post:${invoiceId}`,
          createdBy: actor?.userId ?? invoice.createdBy,
          lines: this.ledger.salesInvoiceLines({
            receivable: D(totals.totalAmount),
            revenue: D(totals.subtotal),
            discount: D(totals.discountAmount),
            taxAmount: D(totals.taxAmount),
            cogs,
          }),
        });

        return totals;
      },
      { timeout: 30_000 },
    );

    await this.inventory.invalidateCaches();

    // A storefront learning that stock left the building is the single most
    // time-critical event here — it is what stops the next oversale.
    this.webhooks.emit('invoice.posted', {
      kind: 'sales',
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      total: invoice.totalAmount.toString(),
      lines: invoice.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    });
    this.webhooks.emit('stock.changed', {
      reason: 'sales_invoice_posted',
      reference: invoice.invoiceNumber,
      skus: [...new Set(invoice.items.map((i) => i.sku))],
    });

    this.audit(
      'sales_invoice.post',
      invoiceId,
      { invoiceNumber: invoice.invoiceNumber, lines: invoice.items.length },
      actor,
      req,
    );

    return { message: 'Sales invoice posted — stock deducted and delivery note issued', invoice: result };
  }

  /** Reverses a posted invoice by returning the goods to their batches. */
  async cancel(invoiceId: string, reason: string, actor: Actor, req?: Request) {
    const invoice = await this.prisma.salesInvoice.findFirst({
      where: { id: invoiceId },
      include: { items: true, deliveryNotes: { include: { items: true } } },
    });
    if (!invoice) throw new NotFoundException('Sales invoice not found');
    if (invoice.status === DocumentStatus.CANCELLED) {
      throw new ConflictException('Invoice is already cancelled');
    }

    if (invoice.status === DocumentStatus.DRAFT) {
      await this.prisma.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: DocumentStatus.CANCELLED, notes: reason },
      });
      this.audit('sales_invoice.cancel', invoiceId, { reason, wasDraft: true }, actor, req);
      return { message: 'Draft invoice cancelled' };
    }

    if (D(invoice.paidAmount).greaterThan(ZERO)) {
      throw new ConflictException(
        `Invoice has ${invoice.paidAmount} recorded against it. Refund the payments before cancelling.`,
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        // Return exactly what the delivery note says left — the invoice lines
        // may name one batch while the shipment drew from several.
        const shipped = invoice.deliveryNotes.flatMap((note) => note.items);

        for (const line of shipped) {
          if (line.batchId) {
            await tx.productBatch.updateMany({
              where: { id: line.batchId },
              data: { quantity: { increment: line.quantity } },
            });
            await tx.batchStockLevel.updateMany({
              where: { batchId: line.batchId, location: line.location },
              data: {
                quantity: { increment: line.quantity },
                available: { increment: line.quantity },
              },
            });
          }

          await this.inventory.applyStockChangeWithin(tx, {
            sku: line.sku,
            location: line.location,
            change: line.quantity,
            reason: `Reversal of sales invoice ${invoice.invoiceNumber}: ${reason}`,
            referenceType: 'sales_invoice_reversal',
            referenceId: invoiceId,
            createdById: actor?.userId,
          });
        }

        await tx.deliveryNote.updateMany({
          where: { salesInvoiceId: invoiceId },
          data: { status: 'cancelled' },
        });

        await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: { status: DocumentStatus.CANCELLED, notes: reason },
        });

        await this.ledger.postWithin(tx, currentTenant()?.tenantId ?? null, {
          description: `عكس فاتورة بيع ${invoice.invoiceNumber} — ${reason}`,
          entryDate: new Date(),
          sourceType: 'sales_invoice',
          sourceId: invoiceId,
          sourceRef: `sales_invoice:reverse:${invoiceId}`,
          createdBy: actor?.userId ?? invoice.createdBy,
          lines: this.ledger.reverse(
            this.ledger.salesInvoiceLines({
              receivable: D(invoice.totalAmount),
              revenue: D(invoice.subtotal),
              discount: D(invoice.discountAmount),
              taxAmount: D(invoice.taxAmount),
              cogs: D(invoice.cogsAmount),
            }),
          ),
        });
      },
      { timeout: 30_000 },
    );

    await this.inventory.invalidateCaches();

    this.webhooks.emit('invoice.cancelled', {
      kind: 'sales',
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      reason,
    });
    this.webhooks.emit('stock.changed', {
      reason: 'sales_invoice_reversed',
      reference: invoice.invoiceNumber,
      skus: [...new Set(invoice.items.map((i) => i.sku))],
    });

    this.audit('sales_invoice.cancel', invoiceId, { reason, reversed: true }, actor, req);
    return { message: 'Posted invoice reversed — goods returned to stock' };
  }

  // ----------------------------------------------------------------- payments

  async addPayment(invoiceId: string, dto: CreateSalesInvoicePaymentDto, actor: Actor, req?: Request) {
    const invoice = await this.prisma.salesInvoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Sales invoice not found');
    if (invoice.status === DocumentStatus.DRAFT) {
      throw new ConflictException('Post the invoice before recording payments against it');
    }
    if (invoice.status === DocumentStatus.CANCELLED) {
      throw new ConflictException('Cannot pay a cancelled invoice');
    }

    const amount = D(dto.amount);
    const balance = D(invoice.totalAmount).minus(D(invoice.paidAmount));
    if (amount.greaterThan(balance)) {
      throw new BadRequestException(
        `Payment (${amount}) exceeds the outstanding balance (${balance})`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const paidAmount = D(invoice.paidAmount).plus(amount);
      const status = paidAmount.greaterThanOrEqualTo(D(invoice.totalAmount))
        ? DocumentStatus.PAID
        : DocumentStatus.PARTIALLY_PAID;

      // Recorded against the sales order when the invoice has one, so the
      // existing receivables screens keep working unchanged.
      if (invoice.salesOrderId) {
        await tx.salesPayment.create({
          data: {
            salesOrderId: invoice.salesOrderId,
            amount,
            method: dto.method ?? 'cash',
            paidBy: actor?.userId ?? invoice.createdBy,
            notes: `${dto.notes ?? ''} [${invoice.invoiceNumber}]`.trim(),
          },
        });
        await tx.salesOrder.updateMany({
          where: { id: invoice.salesOrderId },
          data: { paidAmount: { increment: amount } },
        });
      }

      return tx.salesInvoice.update({
        where: { id: invoiceId },
        data: { paidAmount, status },
        include: { items: true, customer: true },
      });
    });

    this.audit('sales_invoice.payment', invoiceId, { amount: dto.amount }, actor, req);
    return updated;
  }

  // ---------------------------------------------------------- delivery notes

  async listDeliveryNotes(query: { page?: string | number; limit?: string | number; customerId?: string; status?: string }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.DeliveryNoteWhereInput = {};
    if (query.customerId) where.customerId = query.customerId;
    if (query.status) where.status = query.status;

    const [notes, total] = await Promise.all([
      this.prisma.deliveryNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { items: true, salesInvoice: { select: { invoiceNumber: true } } },
      }),
      this.prisma.deliveryNote.count({ where }),
    ]);

    return paginatedResponse(notes, page, limit, total);
  }

  async markDelivered(noteId: string, receivedBy: string, actor: Actor, req?: Request) {
    const note = await this.prisma.deliveryNote.findFirst({ where: { id: noteId } });
    if (!note) throw new NotFoundException('Delivery note not found');
    if (note.status === 'cancelled') throw new ConflictException('Delivery note is cancelled');

    const updated = await this.prisma.deliveryNote.update({
      where: { id: noteId },
      data: { status: 'delivered', deliveredAt: new Date(), receivedBy },
    });

    this.audit('delivery_note.delivered', noteId, { receivedBy }, actor, req);
    return updated;
  }

  // ------------------------------------------------------------------ helpers

  private async recalculate(tx: Prisma.TransactionClient, invoiceId: string) {
    const items = await tx.salesInvoiceItem.findMany({ where: { invoiceId } });

    const subtotal = items.reduce((s, i) => s.plus(D(i.unitPrice).mul(i.quantity)), ZERO);
    const discountAmount = items.reduce((s, i) => s.plus(D(i.discountAmount)), ZERO);
    const taxAmount = items.reduce((s, i) => s.plus(D(i.taxAmount)), ZERO);
    const totalAmount = subtotal.minus(discountAmount).plus(taxAmount);

    return tx.salesInvoice.update({
      where: { id: invoiceId },
      data: { subtotal, discountAmount, taxAmount, totalAmount },
      include: { items: true, customer: true },
    });
  }

  private async requireDraft(invoiceId: string) {
    const invoice = await this.prisma.salesInvoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Sales invoice not found');
    if (invoice.status !== DocumentStatus.DRAFT) {
      throw new ConflictException(
        `Only draft invoices can be modified (current: ${invoice.status}). Issue a credit note instead.`,
      );
    }
    return invoice;
  }

  /** Zero means no limit — the common case, and not something to block on. */
  private async assertCreditLimit(customerId: string, invoiceTotal: Prisma.Decimal, excludeInvoiceId: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found');

    const limit = D(customer.creditLimit);
    if (limit.lessThanOrEqualTo(ZERO)) return;

    const open = await this.prisma.salesInvoice.findMany({
      where: {
        customerId,
        id: { not: excludeInvoiceId },
        status: { in: [DocumentStatus.POSTED, DocumentStatus.PARTIALLY_PAID] },
      },
      select: { totalAmount: true, paidAmount: true },
    });

    const outstanding = open.reduce(
      (sum, inv) => sum.plus(D(inv.totalAmount).minus(D(inv.paidAmount))),
      ZERO,
    );

    if (outstanding.plus(invoiceTotal).greaterThan(limit)) {
      throw new ConflictException(
        `Credit limit exceeded for "${customer.name}": outstanding ${outstanding} + this invoice ${invoiceTotal} > limit ${limit}`,
      );
    }
  }
}
