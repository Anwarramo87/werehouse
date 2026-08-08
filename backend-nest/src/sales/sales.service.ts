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
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { CreateSalesPaymentDto } from './dto/create-sales-payment.dto';
import { SalesOrderQueryDto } from './dto/sales-order-query.dto';

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private invalidateCustomerCaches() {
    return this.shortCache.invalidatePrefix('sales:customers');
  }

  private invalidateOrderCaches() {
    return Promise.all([
      this.shortCache.invalidatePrefix('sales:orders'),
      this.inventory.invalidateCaches(),
    ]);
  }

  // ---------------------------------------------------------------- customers

  async listCustomers(query: { page?: string | number; limit?: string | number; search?: string; status?: string }) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.CustomerWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status) where.status = query.status;

    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return paginatedResponse(customers, page, limit, total);
  }

  async getCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async createCustomer(dto: CreateCustomerDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Customer name is required');

    const existing = await this.prisma.customer.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) throw new ConflictException('Customer already exists');

    const customer = await this.prisma.customer.create({
      data: {
        name,
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        taxNumber: dto.taxNumber,
      },
    });
    await this.invalidateCustomerCaches();

    return { message: 'Customer created successfully', customer };
  }

  async updateCustomer(customerId: string, dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!existing) throw new NotFoundException('Customer not found');

    const name = dto.name?.trim();
    if (name) {
      const collision = await this.prisma.customer.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, NOT: { id: customerId } },
      });
      if (collision) throw new ConflictException('Customer name already exists');
    }

    const customer = await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        name: name ?? undefined,
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        taxNumber: dto.taxNumber,
        status: dto.status,
      },
    });
    await this.invalidateCustomerCaches();

    return { message: 'Customer updated', customer };
  }

  async removeCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { _count: { select: { salesOrders: true } } },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer._count.salesOrders > 0) {
      throw new BadRequestException(
        `لا يمكن حذف العميل "${customer.name}" لأنه مرتبط بـ ${customer._count.salesOrders} أمر مبيعات.`,
      );
    }

    await this.prisma.customer.delete({ where: { id: customerId } });
    await this.invalidateCustomerCaches();
    return { message: 'Customer deleted' };
  }

  // -------------------------------------------------------------- sales orders

  private async generateSoNumber(): Promise<string> {
    const now = new Date();
    const y = now.getFullYear().toString().slice(-2);
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const prefix = `SO-${y}${m}${d}-`;

    const last = await this.prisma.salesOrder.findFirst({
      where: { soNumber: { startsWith: prefix } },
      orderBy: { soNumber: 'desc' },
      select: { soNumber: true },
    });

    const seq = last ? parseInt(last.soNumber.slice(prefix.length), 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  async listSalesOrders(query: SalesOrderQueryDto) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.SalesOrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.search) {
      where.OR = [
        { soNumber: { contains: query.search, mode: 'insensitive' } },
        { customer: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.salesOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, name: true } },
          items: { include: { product: { select: { sku: true, name: true } } } },
          _count: { select: { payments: true } },
        },
      }),
      this.prisma.salesOrder.count({ where }),
    ]);

    return paginatedResponse(orders, page, limit, total);
  }

  async getSalesOrder(salesOrderId: string) {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        customer: true,
        items: { include: { product: { select: { sku: true, name: true } } } },
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    return order;
  }

  async createSalesOrder(dto: CreateSalesOrderDto, userId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Customer not found');

    const skus = dto.items.map((item) => item.sku);
    const productCount = await this.prisma.product.count({
      where: { sku: { in: skus } },
    });
    if (productCount !== new Set(skus).size) {
      throw new BadRequestException('One or more SKUs do not exist');
    }

    const soNumber = await this.generateSoNumber();

    const order = await this.prisma.$transaction(async (tx) => {
      const totalAmount = dto.items.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        0,
      );

      return tx.salesOrder.create({
        data: {
          soNumber,
          customerId: dto.customerId,
          status: 'draft',
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          totalAmount: new Prisma.Decimal(totalAmount),
          createdBy: userId,
          items: {
            create: dto.items.map((item) => ({
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: new Prisma.Decimal(item.unitPrice),
              location: item.location,
            })),
          },
        },
        include: {
          customer: { select: { id: true, name: true } },
          items: true,
        },
      });
    });

    await this.invalidateOrderCaches();
    return { message: 'Sales order created successfully', order };
  }

  async updateSalesOrder(salesOrderId: string, dto: UpdateSalesOrderDto, userId: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Sales order not found');
    if (existing.status !== 'draft') {
      throw new BadRequestException('Only draft sales orders can be edited');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      if (dto.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
        if (!customer) throw new NotFoundException('Customer not found');
      }

      if (dto.items && dto.items.length > 0) {
        const skus = dto.items.map((item) => item.sku);
        const productCount = await tx.product.count({ where: { sku: { in: skus } } });
        if (productCount !== new Set(skus).size) {
          throw new BadRequestException('One or more SKUs do not exist');
        }

        await tx.salesOrderItem.deleteMany({ where: { salesOrderId } });
        await tx.salesOrderItem.createMany({
          data: dto.items.map((item) => ({
            salesOrderId,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: new Prisma.Decimal(item.unitPrice),
            location: item.location,
          })),
        });
      }

      const totalAmount = dto.items && dto.items.length > 0
        ? dto.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
        : existing.items.reduce((sum, item) => sum + item.quantity * Number(item.unitPrice), 0);

      const updated = await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: {
          customerId: dto.customerId,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : undefined,
          totalAmount: new Prisma.Decimal(totalAmount),
          createdBy: userId,
        },
        include: {
          customer: { select: { id: true, name: true } },
          items: true,
        },
      });

      return updated;
    });

    await this.invalidateOrderCaches();
    return { message: 'Sales order updated', order };
  }

  async confirmSalesOrder(salesOrderId: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Sales order not found');
    if (existing.status === 'cancelled') {
      throw new BadRequestException('A cancelled sales order cannot be confirmed');
    }
    if (existing.status === 'confirmed' || existing.status === 'delivered') {
      throw new BadRequestException('Sales order is already processed');
    }

    // Reserve stock per item. Each reserveStock call is atomic; if one fails the
    // order stays in draft and the caller can retry after fixing stock.
    for (const item of existing.items) {
      await this.inventory.reserveStock({
        sku: item.sku,
        location: item.location,
        quantity: item.quantity,
        reason: `Sales order ${existing.soNumber} confirmed`,
      });
    }

    const order = await this.prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: 'confirmed' },
      include: { items: true },
    });

    await this.invalidateOrderCaches();
    return { message: 'Sales order confirmed and stock reserved', order };
  }

  async deliverSalesOrder(salesOrderId: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Sales order not found');
    if (existing.status !== 'confirmed') {
      throw new BadRequestException('Only confirmed sales orders can be delivered');
    }

    // Decrease quantity then release the reservation: net effect is quantity -qty,
    // reserved -qty, available unchanged.
    for (const item of existing.items) {
      await this.inventory.adjustStock({
        sku: item.sku,
        location: item.location,
        change: -item.quantity,
        reason: `Sales order ${existing.soNumber} delivered`,
      });
      await this.inventory.releaseReservation({
        sku: item.sku,
        location: item.location,
        quantity: item.quantity,
        reason: `Sales order ${existing.soNumber} delivered`,
      });
    }

    const order = await this.prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: 'delivered' },
      include: { items: true },
    });

    await this.invalidateOrderCaches();
    return { message: 'Sales order delivered and stock deducted', order };
  }

  async cancelSalesOrder(salesOrderId: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Sales order not found');
    if (existing.status === 'delivered') {
      throw new BadRequestException('A delivered sales order cannot be cancelled');
    }
    if (existing.status === 'cancelled') {
      throw new BadRequestException('Sales order is already cancelled');
    }

    if (existing.status === 'confirmed') {
      for (const item of existing.items) {
        await this.inventory.releaseReservation({
          sku: item.sku,
          location: item.location,
          quantity: item.quantity,
          reason: `Sales order ${existing.soNumber} cancelled`,
        });
      }
    }

    const order = await this.prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: 'cancelled' },
      include: { items: true },
    });

    await this.invalidateOrderCaches();
    return { message: 'Sales order cancelled', order };
  }

  async removeSalesOrder(salesOrderId: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: { payments: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Sales order not found');
    if (existing.status === 'confirmed' || existing.status === 'delivered') {
      throw new BadRequestException('A processed sales order cannot be deleted');
    }
    if (existing.payments.length > 0) {
      throw new BadRequestException('A sales order with payments cannot be deleted');
    }

    await this.prisma.salesOrder.delete({ where: { id: salesOrderId } });
    await this.invalidateOrderCaches();
    return { message: 'Sales order deleted' };
  }

  // ------------------------------------------------------------------ payments

  async createPayment(dto: CreateSalesPaymentDto, userId: string) {
    const order = await this.prisma.salesOrder.findUnique({ where: { id: dto.salesOrderId } });
    if (!order) throw new NotFoundException('Sales order not found');
    if (order.status === 'cancelled') {
      throw new BadRequestException('Cannot record a payment on a cancelled sales order');
    }

    const remaining = Number(order.totalAmount) - Number(order.paidAmount);
    if (dto.amount > remaining) {
      throw new BadRequestException(
        `Payment exceeds remaining balance (${remaining.toFixed(2)})`,
      );
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.salesPayment.create({
        data: {
          salesOrderId: dto.salesOrderId,
          amount: new Prisma.Decimal(dto.amount),
          method: dto.method ?? 'cash',
          paidBy: userId,
          notes: dto.notes,
        },
      });

      const updatedOrder = await tx.salesOrder.update({
        where: { id: dto.salesOrderId },
        data: { paidAmount: { increment: dto.amount } },
      });

      return { created, updatedOrder };
    });

    await this.invalidateOrderCaches();
    return { message: 'Payment recorded', ...payment };
  }

  async removePayment(paymentId: string) {
    const payment = await this.prisma.salesPayment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.salesPayment.delete({ where: { id: paymentId } });
      await tx.salesOrder.update({
        where: { id: payment.salesOrderId },
        data: { paidAmount: { decrement: payment.amount } },
      });
    });

    await this.invalidateOrderCaches();
    return { message: 'Payment deleted' };
  }
}
