import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceiveGoodsDto, ReceiveGoodsItemDto } from './dto/receive-goods.dto';
import { PurchaseOrderQueryDto } from './dto/purchase-order-query.dto';

const VALID_PO_STATUSES = ['draft', 'sent', 'received', 'cancelled'];

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private invalidateSupplierCaches() {
    return this.shortCache.invalidatePrefix('purchasing:suppliers');
  }

  private invalidatePoCaches() {
    return Promise.all([
      this.shortCache.invalidatePrefix('purchasing:orders'),
      this.inventory.invalidateCaches(),
    ]);
  }

  // ---------------------------------------------------------------- suppliers

  async listSuppliers(query: { page?: string | number; limit?: string | number; search?: string; status?: string }) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.SupplierWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status) where.status = query.status;

    const [suppliers, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return paginatedResponse(suppliers, page, limit, total);
  }

  async getSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  async createSupplier(dto: CreateSupplierDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Supplier name is required');

    const existing = await this.prisma.supplier.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) throw new ConflictException('Supplier already exists');

    const supplier = await this.prisma.supplier.create({
      data: {
        name,
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        taxNumber: dto.taxNumber,
      },
    });
    await this.invalidateSupplierCaches();

    return { message: 'Supplier created successfully', supplier };
  }

  async updateSupplier(supplierId: string, dto: UpdateSupplierDto) {
    const existing = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!existing) throw new NotFoundException('Supplier not found');

    const name = dto.name?.trim();
    if (name) {
      const collision = await this.prisma.supplier.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, NOT: { id: supplierId } },
      });
      if (collision) throw new ConflictException('Supplier name already exists');
    }

    const supplier = await this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        name: name ?? undefined,
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        taxNumber: dto.taxNumber,
        status: dto.status,
      },
    });
    await this.invalidateSupplierCaches();

    return { message: 'Supplier updated', supplier };
  }

  async removeSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      include: { _count: { select: { purchaseOrders: true } } },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (supplier._count.purchaseOrders > 0) {
      throw new BadRequestException(
        `لا يمكن حذف المورد "${supplier.name}" لأنه مرتبط بـ ${supplier._count.purchaseOrders} أمر شراء.`,
      );
    }

    await this.prisma.supplier.delete({ where: { id: supplierId } });
    await this.invalidateSupplierCaches();
    return { message: 'Supplier deleted' };
  }

  // ------------------------------------------------------------ purchase orders

  private async generatePoNumber(): Promise<string> {
    const now = new Date();
    const y = now.getFullYear().toString().slice(-2);
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const prefix = `PO-${y}${m}${d}-`;

    const last = await this.prisma.purchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    });

    const seq = last ? parseInt(last.poNumber.slice(prefix.length), 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  async listPurchaseOrders(query: PurchaseOrderQueryDto) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.PurchaseOrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.search) {
      where.OR = [
        { poNumber: { contains: query.search, mode: 'insensitive' } },
        { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { sku: true, name: true } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return paginatedResponse(orders, page, limit, total);
  }

  async getPurchaseOrder(purchaseOrderId: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        supplier: true,
        items: { include: { product: { select: { sku: true, name: true } } } },
        goodsReceipts: { include: { items: true } },
      },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    return order;
  }

  async createPurchaseOrder(dto: CreatePurchaseOrderDto, userId: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const skus = dto.items.map((item) => item.sku);
    const productCount = await this.prisma.product.count({
      where: { sku: { in: skus } },
    });
    if (productCount !== new Set(skus).size) {
      throw new BadRequestException('One or more SKUs do not exist');
    }

    const poNumber = await this.generatePoNumber();

    const order = await this.prisma.$transaction(async (tx) => {
      const totalAmount = dto.items.reduce(
        (sum, item) => sum + item.quantity * item.unitCost,
        0,
      );

      return tx.purchaseOrder.create({
        data: {
          poNumber,
          supplierId: dto.supplierId,
          status: 'draft',
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          totalAmount: new Prisma.Decimal(totalAmount),
          createdBy: userId,
          items: {
            create: dto.items.map((item) => ({
              sku: item.sku,
              quantity: item.quantity,
              unitCost: new Prisma.Decimal(item.unitCost),
            })),
          },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: true,
        },
      });
    });

    await this.invalidatePoCaches();
    return { message: 'Purchase order created successfully', order };
  }

  async updatePurchaseOrder(purchaseOrderId: string, dto: UpdatePurchaseOrderDto, userId: string) {
    const existing = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Purchase order not found');
    if (existing.status !== 'draft') {
      throw new BadRequestException('Only draft purchase orders can be edited');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      if (dto.supplierId) {
        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier) throw new NotFoundException('Supplier not found');
      }

      if (dto.items && dto.items.length > 0) {
        const skus = dto.items.map((item) => item.sku);
        const productCount = await tx.product.count({ where: { sku: { in: skus } } });
        if (productCount !== new Set(skus).size) {
          throw new BadRequestException('One or more SKUs do not exist');
        }

        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId } });
        await tx.purchaseOrderItem.createMany({
          data: dto.items.map((item) => ({
            purchaseOrderId,
            sku: item.sku,
            quantity: item.quantity,
            unitCost: new Prisma.Decimal(item.unitCost),
          })),
        });
      }

      const totalAmount = dto.items && dto.items.length > 0
        ? dto.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
        : existing.items.reduce((sum, item) => sum + item.quantity * Number(item.unitCost), 0);

      const updated = await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: {
          supplierId: dto.supplierId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : undefined,
          totalAmount: new Prisma.Decimal(totalAmount),
          createdBy: userId,
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: true,
        },
      });

      return updated;
    });

    await this.invalidatePoCaches();
    return { message: 'Purchase order updated', order };
  }

  async changePurchaseOrderStatus(purchaseOrderId: string, status: string) {
    if (!VALID_PO_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid status. Allowed: ${VALID_PO_STATUSES.join(', ')}`);
    }

    const existing = await this.prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!existing) throw new NotFoundException('Purchase order not found');

    if (status === 'cancelled') {
      if (existing.status === 'received') {
        throw new BadRequestException('A received purchase order cannot be cancelled');
      }
    }

    const order = await this.prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status },
      include: { items: true },
    });

    await this.invalidatePoCaches();
    return { message: 'Purchase order status updated', order };
  }

  async receiveGoods(purchaseOrderId: string, dto: ReceiveGoodsDto, userId: string) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Purchase order not found');
    if (order.status === 'cancelled') {
      throw new BadRequestException('Cannot receive goods on a cancelled purchase order');
    }

    const itemById = new Map(order.items.map((item) => [item.id, item]));
    const receiptItems: ReceiveGoodsItemDto[] = [];
    const stockAdjustments: Array<{ sku: string; location: string; change: number }> = [];

    for (const incoming of dto.items) {
      const orderItem = itemById.get(incoming.purchaseOrderItemId);
      if (!orderItem) {
        throw new BadRequestException(`Purchase order item not found: ${incoming.purchaseOrderItemId}`);
      }

      const remaining = orderItem.quantity - orderItem.receivedQuantity;
      if (incoming.quantity > remaining) {
        throw new BadRequestException(
          `Cannot receive more than the remaining quantity for SKU ${orderItem.sku}. Remaining: ${remaining}`,
        );
      }

      receiptItems.push(incoming);
      stockAdjustments.push({
        sku: orderItem.sku,
        location: incoming.location,
        change: incoming.quantity,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const receiptNumber = `GR-${Date.now()}`;

      for (const incoming of receiptItems) {
        await tx.purchaseOrderItem.update({
          where: { id: incoming.purchaseOrderItemId },
          data: { receivedQuantity: { increment: incoming.quantity } },
        });
      }

      const receipt = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          purchaseOrderId,
          receivedBy: userId,
          notes: dto.notes,
          items: {
            create: receiptItems.map((item) => {
              const orderItem = itemById.get(item.purchaseOrderItemId)!;
              return {
                purchaseOrderItemId: item.purchaseOrderItemId,
                sku: orderItem.sku,
                quantity: item.quantity,
                location: item.location,
                unitCost: orderItem.unitCost,
              };
            }),
          },
        },
        include: { items: true },
      });

      const allReceived = order.items.every(
        (item) => item.receivedQuantity + receiptItems
          .filter((r) => r.purchaseOrderItemId === item.id)
          .reduce((sum, r) => sum + r.quantity, 0) >= item.quantity,
      );

      const updatedOrder = await tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { status: allReceived ? 'received' : 'sent' },
        include: { items: true },
      });

      return { receipt, updatedOrder };
    });

    // Update stock outside the transaction: each adjustment is atomic itself.
    for (const adj of stockAdjustments) {
      await this.inventory.adjustStock({
        sku: adj.sku,
        location: adj.location,
        change: adj.change,
        reason: `Purchase order ${order.poNumber} received`,
      });
    }

    await this.invalidatePoCaches();
    return { message: 'Goods received successfully', ...result };
  }

  async removePurchaseOrder(purchaseOrderId: string) {
    const existing = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { goodsReceipts: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Purchase order not found');
    if (existing.status === 'received') {
      throw new BadRequestException('A received purchase order cannot be deleted');
    }
    if (existing.goodsReceipts.length > 0) {
      throw new BadRequestException('A purchase order with goods receipts cannot be deleted');
    }

    await this.prisma.purchaseOrder.delete({ where: { id: purchaseOrderId } });
    await this.invalidatePoCaches();
    return { message: 'Purchase order deleted' };
  }
}
