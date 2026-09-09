import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllocationMethod, DocumentStatus, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { BatchesService } from '../batches/batches.service';
import { InventoryService } from '../inventory/inventory.service';
import { CostingService } from '../common/wms/costing.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { AuditService } from '../common/services/audit.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreatePurchaseInvoiceDto } from './dto/create-purchase-invoice.dto';
import { UpdatePurchaseInvoiceDto } from './dto/update-purchase-invoice.dto';
import { PurchaseInvoiceQueryDto } from './dto/purchase-invoice-query.dto';
import { AddLandedCostDto } from './dto/add-landed-cost.dto';
import { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import { WebhookDispatchService } from '../common/wms/webhook-dispatch.service';
import { LedgerPostingService } from '../common/wms/ledger-posting.service';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

@Injectable()
export class PurchaseInvoicesService {
  private readonly logger = new Logger(PurchaseInvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BatchesService,
    private readonly inventory: InventoryService,
    private readonly costing: CostingService,
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
        targetType: 'purchase_invoice',
        targetId: targetId ?? undefined,
        metadata,
      },
      req,
    );
  }

  // ------------------------------------------------------------------ queries

  async list(query: PurchaseInvoiceQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.PurchaseInvoiceWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.search) {
      where.OR = [
        { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
        { supplierInvoiceNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
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
      this.prisma.purchaseInvoice.findMany({
        where,
        orderBy: { invoiceDate: 'desc' },
        skip,
        take: limit,
        include: {
          supplier: { select: { id: true, name: true } },
          _count: { select: { items: true, payments: true } },
        },
      }),
      this.prisma.purchaseInvoice.count({ where }),
    ]);

    return paginatedResponse(
      invoices.map((inv) => ({ ...inv, balance: D(inv.totalAmount).minus(D(inv.paidAmount)) })),
      page,
      limit,
      total,
    );
  }

  async get(invoiceId: string) {
    const invoice = await this.prisma.purchaseInvoice.findFirst({
      where: { id: invoiceId },
      include: {
        supplier: true,
        items: { orderBy: { createdAt: 'asc' } },
        landedCosts: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
      },
    });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');

    return { ...invoice, balance: D(invoice.totalAmount).minus(D(invoice.paidAmount)) };
  }

  // ------------------------------------------------------------------- create

  async create(dto: CreatePurchaseInvoiceDto, actor: Actor, req?: Request) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const supplier = await this.prisma.supplier.findFirst({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');

    if (dto.supplierInvoiceNumber) {
      // The supplier's own number is the human duplicate check: paying the
      // same paper invoice twice is the failure this catches.
      const duplicate = await this.prisma.purchaseInvoice.findFirst({
        where: {
          supplierId: dto.supplierId,
          supplierInvoiceNumber: dto.supplierInvoiceNumber,
          status: { not: DocumentStatus.CANCELLED },
        },
        select: { id: true, invoiceNumber: true },
      });
      if (duplicate) {
        throw new ConflictException(
          `Supplier invoice "${dto.supplierInvoiceNumber}" is already recorded as ${duplicate.invoiceNumber}`,
        );
      }
    }

    await this.assertProductsExist(dto.items.map((i) => i.sku));

    const invoice = await this.prisma.$transaction(async (tx) => {
      const invoiceNumber = await this.documentNumbers.next(tx, 'purchaseInvoice', tenantId);

      const created = await tx.purchaseInvoice.create({
        data: {
          invoiceNumber,
          supplierInvoiceNumber: dto.supplierInvoiceNumber ?? null,
          supplierId: dto.supplierId,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          goodsReceiptId: dto.goodsReceiptId ?? null,
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          currency: dto.currency ?? 'SYP',
          notes: dto.notes ?? null,
          createdBy: actor?.userId ?? dto.supplierId,
          items: {
            create: dto.items.map((item) => {
              const totals = this.lineTotals(item);
              return {
                purchaseOrderItemId: item.purchaseOrderItemId ?? null,
                sku: item.sku,
                batchNumber: item.batchNumber ?? null,
                productionDate: item.productionDate ? new Date(item.productionDate) : null,
                expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
                quantity: item.quantity,
                unitCost: D(item.unitCost),
                discountPercent: D(item.discountPercent ?? 0),
                discountAmount: totals.discountAmount,
                taxRate: D(item.taxRate ?? 0),
                taxAmount: totals.taxAmount,
                lineTotal: totals.lineTotal,
                finalUnitCost: D(item.unitCost),
                location: item.location ?? 'WH-A',
              };
            }),
          },
        },
        include: { items: true },
      });

      return this.recalculate(tx, created.id);
    });

    this.audit('purchase_invoice.create', invoice.id, { invoiceNumber: invoice.invoiceNumber }, actor, req);
    return invoice;
  }

  /** Pre-fills an invoice from a purchase order — quantities, costs, lines. */
  async fromPurchaseOrder(purchaseOrderId: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId },
      include: { items: true, supplier: true, goodsReceipts: { include: { items: true } } },
    });
    if (!order) throw new NotFoundException('Purchase order not found');

    // Bill what actually arrived, not what was ordered — the received figure
    // is the one the supplier can substantiate.
    const receivedBySku = new Map<string, { quantity: number; location: string }>();
    for (const receipt of order.goodsReceipts) {
      for (const item of receipt.items) {
        const current = receivedBySku.get(item.sku);
        receivedBySku.set(item.sku, {
          quantity: (current?.quantity ?? 0) + item.quantity,
          location: item.location,
        });
      }
    }

    return {
      supplierId: order.supplierId,
      supplierName: order.supplier?.name ?? null,
      purchaseOrderId: order.id,
      poNumber: order.poNumber,
      invoiceDate: new Date().toISOString().slice(0, 10),
      items: order.items.map((item) => {
        const received = receivedBySku.get(item.sku);
        return {
          purchaseOrderItemId: item.id,
          sku: item.sku,
          quantity: received?.quantity ?? item.receivedQuantity ?? item.quantity,
          unitCost: item.unitCost,
          discountPercent: item.discountPercent,
          taxRate: item.taxRate,
          location: received?.location ?? 'WH-A',
        };
      }),
    };
  }

  async update(invoiceId: string, dto: UpdatePurchaseInvoiceDto, actor: Actor, req?: Request) {
    const invoice = await this.requireDraft(invoiceId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.purchaseInvoice.update({
        where: { id: invoiceId },
        data: {
          supplierInvoiceNumber: dto.supplierInvoiceNumber,
          invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : undefined,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          notes: dto.notes,
        },
      });

      if (dto.items) {
        await this.assertProductsExist(dto.items.map((i) => i.sku));
        await tx.purchaseInvoiceItem.deleteMany({ where: { invoiceId } });
        for (const item of dto.items) {
          const totals = this.lineTotals(item);
          await tx.purchaseInvoiceItem.create({
            data: {
              invoiceId,
              purchaseOrderItemId: item.purchaseOrderItemId ?? null,
              sku: item.sku,
              batchNumber: item.batchNumber ?? null,
              productionDate: item.productionDate ? new Date(item.productionDate) : null,
              expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
              quantity: item.quantity,
              unitCost: D(item.unitCost),
              discountPercent: D(item.discountPercent ?? 0),
              discountAmount: totals.discountAmount,
              taxRate: D(item.taxRate ?? 0),
              taxAmount: totals.taxAmount,
              lineTotal: totals.lineTotal,
              finalUnitCost: D(item.unitCost),
              location: item.location ?? 'WH-A',
            },
          });
        }
      }

      return this.recalculate(tx, invoiceId);
    });

    this.audit('purchase_invoice.update', invoiceId, { ...dto, items: dto.items?.length }, actor, req);
    return updated;
  }

  async remove(invoiceId: string, actor: Actor, req?: Request) {
    await this.requireDraft(invoiceId);
    await this.prisma.purchaseInvoice.delete({ where: { id: invoiceId } });
    this.audit('purchase_invoice.delete', invoiceId, undefined, actor, req);
    return { message: 'Draft purchase invoice deleted' };
  }

  // ------------------------------------------------------------- landed costs

  async addLandedCost(invoiceId: string, dto: AddLandedCostDto, actor: Actor, req?: Request) {
    await this.requireDraft(invoiceId);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.landedCost.create({
        data: {
          purchaseInvoiceId: invoiceId,
          type: dto.type,
          description: dto.description ?? null,
          amount: D(dto.amount),
          allocationMethod: dto.allocationMethod ?? AllocationMethod.VALUE,
        },
      });
      return this.recalculate(tx, invoiceId);
    });

    this.audit('purchase_invoice.landed_cost.add', invoiceId, { ...dto }, actor, req);
    return result;
  }

  async removeLandedCost(invoiceId: string, landedCostId: string, actor: Actor, req?: Request) {
    await this.requireDraft(invoiceId);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.landedCost.deleteMany({ where: { id: landedCostId, purchaseInvoiceId: invoiceId } });
      return this.recalculate(tx, invoiceId);
    });

    this.audit('purchase_invoice.landed_cost.remove', invoiceId, { landedCostId }, actor, req);
    return result;
  }

  // -------------------------------------------------------------------- post

  /**
   * Posts the invoice: the single moment stock, batches and cost all move.
   *
   * For every line, in one transaction:
   *   1. the product is revalued (weighted average, *before* the units land)
   *   2. the batch is created or topped up, with its landed unit cost
   *   3. both stock ledgers are incremented
   *   4. the linked PO line's received quantity catches up
   *
   * Posting is irreversible by design — `cancel` writes a reversal instead of
   * editing history, because an audited stock ledger that can be rewritten is
   * not an audit trail.
   */
  async post(invoiceId: string, actor: Actor, req?: Request) {
    const invoice = await this.prisma.purchaseInvoice.findFirst({
      where: { id: invoiceId },
      include: { items: true, landedCosts: true },
    });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');
    if (invoice.status !== DocumentStatus.DRAFT) {
      throw new ConflictException(`Only draft invoices can be posted (current: ${invoice.status})`);
    }
    if (invoice.items.length === 0) {
      throw new BadRequestException('Cannot post an invoice with no lines');
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Landed costs are allocated first: a batch's unit cost has to include
        // freight from the moment it exists, or the first sale off it reports
        // a margin that is quietly too high.
        const allocated = await this.allocateLandedCosts(tx, invoiceId);

        for (const item of invoice.items) {
          const share = allocated.get(item.id) ?? ZERO;
          const finalUnitCost = D(item.unitCost)
            .plus(item.quantity > 0 ? share.div(item.quantity) : ZERO)
            .toDecimalPlaces(4);

          await tx.purchaseInvoiceItem.update({
            where: { id: item.id },
            data: { allocatedLandedCost: share, finalUnitCost },
          });

          await this.costing.applyInboundCost(tx, {
            sku: item.sku,
            quantityIn: item.quantity,
            unitCost: finalUnitCost,
            referenceType: 'purchase_invoice',
            referenceId: invoiceId,
            createdById: actor?.userId,
          });

          const product = await tx.product.findFirst({
            where: { sku: item.sku },
            select: { batchTracked: true, name: true },
          });

          if (product?.batchTracked || item.batchNumber) {
            const batchNumber =
              item.batchNumber ?? `${invoice.invoiceNumber}-${item.sku}`.slice(0, 64);

            await this.batches.receiveIntoBatchWithin(tx, {
              sku: item.sku,
              batchNumber,
              location: item.location,
              quantity: item.quantity,
              unitCost: finalUnitCost,
              productionDate: item.productionDate,
              expiryDate: item.expiryDate,
              supplierId: invoice.supplierId,
              purchaseInvoiceId: invoiceId,
              reason: `Purchase invoice ${invoice.invoiceNumber}`,
              referenceType: 'purchase_invoice',
              referenceId: invoiceId,
              createdById: actor?.userId,
            });
          } else {
            await this.inventory.applyStockChangeWithin(tx, {
              sku: item.sku,
              location: item.location,
              change: item.quantity,
              reason: `Purchase invoice ${invoice.invoiceNumber}`,
              referenceType: 'purchase_invoice',
              referenceId: invoiceId,
              createdById: actor?.userId,
            });
          }

          // Keeps the originating PO honest when the invoice, not a separate
          // GRN, is what recorded the arrival.
          if (item.purchaseOrderItemId) {
            await tx.purchaseOrderItem.updateMany({
              where: { id: item.purchaseOrderItemId },
              data: { receivedQuantity: { increment: item.quantity } },
            });
          }
        }

        if (invoice.purchaseOrderId) {
          const poItems = await tx.purchaseOrderItem.findMany({
            where: { purchaseOrderId: invoice.purchaseOrderId },
          });
          const allReceived = poItems.every((i) => i.receivedQuantity >= i.quantity);
          if (allReceived) {
            await tx.purchaseOrder.updateMany({
              where: { id: invoice.purchaseOrderId },
              data: { status: 'received' },
            });
          }
        }

        await tx.purchaseInvoice.update({
          where: { id: invoiceId },
          data: {
            status: DocumentStatus.POSTED,
            postedAt: new Date(),
            postedBy: actor?.userId ?? null,
          },
        });

        const totals = await this.recalculate(tx, invoiceId);

        // Books move with the goods, in the same transaction. An unmapped
        // chart of accounts skips the entry rather than blocking the receipt.
        const goodsValue = D(totals.subtotal)
          .minus(D(totals.discountAmount))
          .plus(D(totals.landedCostTotal));

        await this.ledger.postWithin(tx, currentTenant()?.tenantId ?? null, {
          description: `فاتورة شراء ${invoice.invoiceNumber}`,
          entryDate: invoice.invoiceDate,
          sourceType: 'purchase_invoice',
          sourceId: invoiceId,
          sourceRef: `purchase_invoice:post:${invoiceId}`,
          createdBy: actor?.userId ?? invoice.createdBy,
          lines: this.ledger.purchaseInvoiceLines({
            goodsValue,
            taxAmount: D(totals.taxAmount),
            payableTotal: D(totals.totalAmount),
          }),
        });

        return totals;
      },
      { timeout: 30_000 },
    );

    await this.inventory.invalidateCaches();

    // Fired after the commit, never inside it: an event announcing goods that
    // then roll back is worse than a late one.
    this.webhooks.emit('invoice.posted', {
      kind: 'purchase',
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      supplierId: invoice.supplierId,
      total: invoice.totalAmount.toString(),
      lines: invoice.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    });
    this.webhooks.emit('stock.changed', {
      reason: 'purchase_invoice_posted',
      reference: invoice.invoiceNumber,
      skus: [...new Set(invoice.items.map((i) => i.sku))],
    });

    this.audit(
      'purchase_invoice.post',
      invoiceId,
      { invoiceNumber: invoice.invoiceNumber, lines: invoice.items.length },
      actor,
      req,
    );

    return { message: 'Purchase invoice posted — stock, batches and cost updated', invoice: result };
  }

  /**
   * Reverses a posted invoice by taking the goods back out of stock.
   *
   * Deliberately not a delete: the original movements stay, and the reversal
   * adds its own, so the ledger reads as what happened rather than as what we
   * wish had happened.
   */
  async cancel(invoiceId: string, reason: string, actor: Actor, req?: Request) {
    const invoice = await this.prisma.purchaseInvoice.findFirst({
      where: { id: invoiceId },
      include: { items: true },
    });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');
    if (invoice.status === DocumentStatus.CANCELLED) {
      throw new ConflictException('Invoice is already cancelled');
    }

    if (invoice.status === DocumentStatus.DRAFT) {
      await this.prisma.purchaseInvoice.update({
        where: { id: invoiceId },
        data: { status: DocumentStatus.CANCELLED, notes: reason },
      });
      this.audit('purchase_invoice.cancel', invoiceId, { reason, wasDraft: true }, actor, req);
      return { message: 'Draft invoice cancelled' };
    }

    await this.prisma.$transaction(
      async (tx) => {
        for (const item of invoice.items) {
          await this.inventory.applyStockChangeWithin(tx, {
            sku: item.sku,
            location: item.location,
            change: -item.quantity,
            reason: `Reversal of purchase invoice ${invoice.invoiceNumber}: ${reason}`,
            referenceType: 'purchase_invoice_reversal',
            referenceId: invoiceId,
            createdById: actor?.userId,
          });

          if (item.batchNumber) {
            const batch = await tx.productBatch.findFirst({
              where: { sku: item.sku, batchNumber: item.batchNumber },
            });
            if (batch) {
              await tx.productBatch.update({
                where: { id: batch.id },
                data: { quantity: { decrement: item.quantity } },
              });
              await tx.batchStockLevel.updateMany({
                where: { batchId: batch.id, location: item.location },
                data: {
                  quantity: { decrement: item.quantity },
                  available: { decrement: item.quantity },
                },
              });
            }
          }
        }

        await tx.purchaseInvoice.update({
          where: { id: invoiceId },
          data: { status: DocumentStatus.CANCELLED, notes: reason },
        });

        const goodsValue = D(invoice.subtotal)
          .minus(D(invoice.discountAmount))
          .plus(D(invoice.landedCostTotal));

        await this.ledger.postWithin(tx, currentTenant()?.tenantId ?? null, {
          description: `عكس فاتورة شراء ${invoice.invoiceNumber} — ${reason}`,
          entryDate: new Date(),
          sourceType: 'purchase_invoice',
          sourceId: invoiceId,
          sourceRef: `purchase_invoice:reverse:${invoiceId}`,
          createdBy: actor?.userId ?? invoice.createdBy,
          lines: this.ledger.reverse(
            this.ledger.purchaseInvoiceLines({
              goodsValue,
              taxAmount: D(invoice.taxAmount),
              payableTotal: D(invoice.totalAmount),
            }),
          ),
        });
      },
      { timeout: 30_000 },
    );

    await this.inventory.invalidateCaches();

    this.webhooks.emit('invoice.cancelled', {
      kind: 'purchase',
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      reason,
    });
    this.webhooks.emit('stock.changed', {
      reason: 'purchase_invoice_reversed',
      reference: invoice.invoiceNumber,
      skus: [...new Set(invoice.items.map((i) => i.sku))],
    });

    this.audit('purchase_invoice.cancel', invoiceId, { reason, reversed: true }, actor, req);
    return { message: 'Posted invoice reversed and cancelled' };
  }

  // ---------------------------------------------------------------- payments

  async addPayment(invoiceId: string, dto: CreatePurchasePaymentDto, actor: Actor, req?: Request) {
    const invoice = await this.prisma.purchaseInvoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');
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

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.purchasePayment.create({
        data: {
          purchaseInvoiceId: invoiceId,
          amount,
          method: dto.method ?? 'cash',
          paidBy: actor?.userId ?? invoice.createdBy,
          notes: dto.notes ?? null,
        },
      });
      return this.recalculate(tx, invoiceId);
    });

    this.audit('purchase_invoice.payment', invoiceId, { amount: dto.amount }, actor, req);
    return result;
  }

  // ----------------------------------------------------------------- helpers

  /** Line arithmetic in one place, so create and update cannot disagree. */
  private lineTotals(item: {
    quantity: number;
    unitCost: number;
    discountPercent?: number;
    taxRate?: number;
  }) {
    const gross = D(item.unitCost).mul(item.quantity);
    const discountAmount = gross.mul(D(item.discountPercent ?? 0)).div(HUNDRED).toDecimalPlaces(2);
    const net = gross.minus(discountAmount);
    const taxAmount = net.mul(D(item.taxRate ?? 0)).div(HUNDRED).toDecimalPlaces(2);
    return { gross, discountAmount, taxAmount, lineTotal: net.plus(taxAmount) };
  }

  private async allocateLandedCosts(tx: Prisma.TransactionClient, invoiceId: string) {
    const [items, costs] = await Promise.all([
      tx.purchaseInvoiceItem.findMany({ where: { invoiceId } }),
      tx.landedCost.findMany({ where: { purchaseInvoiceId: invoiceId } }),
    ]);

    const totals = new Map<string, Prisma.Decimal>(items.map((i) => [i.id, ZERO]));
    if (costs.length === 0) return totals;

    const skus = [...new Set(items.map((i) => i.sku))];
    const products = await tx.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, weightKg: true },
    });
    const weightBySku = new Map(products.map((p) => [p.sku, D(p.weightKg ?? 0)]));

    const lines = items.map((item) => ({
      id: item.id,
      value: D(item.unitCost).mul(item.quantity),
      quantity: item.quantity,
      weightKg: (weightBySku.get(item.sku) ?? ZERO).mul(item.quantity),
    }));

    for (const cost of costs) {
      const shares = this.costing.allocate(cost.allocationMethod, D(cost.amount), lines);
      for (const [lineId, share] of shares) {
        totals.set(lineId, (totals.get(lineId) ?? ZERO).plus(share));
      }
    }

    return totals;
  }

  /**
   * Recomputes the header from its lines and rows.
   *
   * Header totals are derived, never entered, so any path that touches lines,
   * landed costs or payments ends here — that is what keeps `paidAmount` and
   * `status` from disagreeing with the payments actually recorded.
   */
  private async recalculate(tx: Prisma.TransactionClient, invoiceId: string) {
    const [items, costs, payments, invoice] = await Promise.all([
      tx.purchaseInvoiceItem.findMany({ where: { invoiceId } }),
      tx.landedCost.findMany({ where: { purchaseInvoiceId: invoiceId } }),
      tx.purchasePayment.findMany({ where: { purchaseInvoiceId: invoiceId } }),
      tx.purchaseInvoice.findFirstOrThrow({ where: { id: invoiceId } }),
    ]);

    const subtotal = items.reduce((s, i) => s.plus(D(i.unitCost).mul(i.quantity)), ZERO);
    const discountAmount = items.reduce((s, i) => s.plus(D(i.discountAmount)), ZERO);
    const taxAmount = items.reduce((s, i) => s.plus(D(i.taxAmount)), ZERO);
    const landedCostTotal = costs.reduce((s, c) => s.plus(D(c.amount)), ZERO);
    const paidAmount = payments.reduce((s, p) => s.plus(D(p.amount)), ZERO);
    const totalAmount = subtotal.minus(discountAmount).plus(taxAmount).plus(landedCostTotal);

    let status = invoice.status;
    if (status === DocumentStatus.POSTED || status === DocumentStatus.PARTIALLY_PAID || status === DocumentStatus.PAID) {
      if (paidAmount.greaterThanOrEqualTo(totalAmount) && totalAmount.greaterThan(ZERO)) {
        status = DocumentStatus.PAID;
      } else if (paidAmount.greaterThan(ZERO)) {
        status = DocumentStatus.PARTIALLY_PAID;
      } else {
        status = DocumentStatus.POSTED;
      }
    }

    return tx.purchaseInvoice.update({
      where: { id: invoiceId },
      data: { subtotal, discountAmount, taxAmount, landedCostTotal, totalAmount, paidAmount, status },
      include: { items: true, landedCosts: true, payments: true, supplier: true },
    });
  }

  private async requireDraft(invoiceId: string) {
    const invoice = await this.prisma.purchaseInvoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');
    if (invoice.status !== DocumentStatus.DRAFT) {
      throw new ConflictException(
        `Only draft invoices can be modified (current: ${invoice.status}). Cancel and re-issue instead.`,
      );
    }
    return invoice;
  }

  private async assertProductsExist(skus: string[]) {
    const unique = [...new Set(skus)];
    const found = await this.prisma.product.findMany({
      where: { sku: { in: unique } },
      select: { sku: true },
    });
    const missing = unique.filter((sku) => !found.some((p) => p.sku === sku));
    if (missing.length) throw new NotFoundException(`Unknown SKU(s): ${missing.join(', ')}`);
  }
}
