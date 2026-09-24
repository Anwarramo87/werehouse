import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Prisma, RepMovementType, RepSaleStatus, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import {
  CreateRepresentativeDto,
  UpdateRepresentativeDto,
  TransferStockToRepDto,
  TransferStockFromRepDto,
  CreateRepSaleDto,
  CreateRepCollectionDto,
  CreateRepReturnDto,
  CreateSettlementDto,
  AssignCustomersDto,
  AssignProductsDto,
  CreateRepRouteDto,
  RepQueryDto,
  RepSaleQueryDto,
} from './dto/representatives.dto';

@Injectable()
export class RepresentativesService {
  private readonly logger = new Logger(RepresentativesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly docNum: DocumentNumberService,
  ) {}

  /** الموقع الافتراضي لمخازن الواجهة (كان مُرمَّزاً بـ WH-A بينما الأرصدة في MAIN) */
  private readonly DEFAULT_LOCATION = 'MAIN';

  /**
   * يحلّ الموقع الفعلي الذي يحوي رصيد صنف في المخزن الرئيسي:
   * الموقع المُفضَّل إن وُجد له رصيد، وإلا أول موقع يحوي رصيداً، وإلا الافتراضي.
   */
  private async resolveWarehouseLocation(
    tx: Prisma.TransactionClient,
    sku: string,
    preferred?: string,
  ): Promise<string> {
    if (preferred) {
      const row = await tx.stockLevel.findFirst({
        where: { sku, location: preferred },
        select: { id: true },
      });
      if (row) return preferred;
    }
    const anyRow = await tx.stockLevel.findFirst({
      where: { sku },
      select: { location: true },
      orderBy: { updatedAt: 'desc' },
    });
    return anyRow?.location ?? this.DEFAULT_LOCATION;
  }

  // =========================================================================
  // ADMIN — Representative CRUD
  // =========================================================================

  async createRepresentative(dto: CreateRepresentativeDto, _adminUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, tenantId: true, representative: { select: { id: true } } },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (user.representative) throw new ConflictException('هذا المستخدم مرتبط بمندوب آخر');

    return this.prisma.representative.create({
      data: {
        userId: dto.userId,
        employeeId: dto.employeeId,
        name: dto.name,
        code: dto.code,
        phone: dto.phone,
        email: dto.email,
        status: 'active',
        notes: dto.notes,
      },
      include: { user: { select: { username: true, email: true } } },
    });
  }

  async listRepresentatives(query: RepQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.RepresentativeWhereInput = {
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.representative.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true, email: true } },
          stockItems: { select: { totalValue: true } },
          sales: {
            where: { status: { not: RepSaleStatus.CANCELLED } },
            select: { totalAmount: true, paidAmount: true },
          },
        },
      }),
      this.prisma.representative.count({ where }),
    ]);

    const enriched = data.map((rep) => {
      const stockValue = rep.stockItems.reduce((s, i) => s + Number(i.totalValue), 0);
      const totalSold = rep.sales.reduce((s, i) => s + Number(i.totalAmount), 0);
      const totalCollected = rep.sales.reduce((s, i) => s + Number(i.paidAmount), 0);
      return {
        ...rep,
        stockItems: undefined,
        sales: undefined,
        summary: { stockValue, totalSold, totalCollected, outstanding: totalSold - totalCollected },
      };
    });

    return { data: enriched, total, page, limit };
  }

  async getRepresentative(repId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { id: repId },
      include: {
        user: { select: { username: true, email: true, status: true } },
        routes: true,
        customers: { select: { customerId: true, isActive: true } },
        products: { select: { sku: true, isActive: true } },
        stockItems: { orderBy: { sku: 'asc' } },
      },
    });
    if (!rep) throw new NotFoundException('المندوب غير موجود');

    const [totalSold, totalCollected, pendingReturns] = await Promise.all([
      this.prisma.repSale.aggregate({
        where: { representativeId: repId, status: { not: RepSaleStatus.CANCELLED } },
        _sum: { totalAmount: true },
      }),
      this.prisma.repCollection.aggregate({
        where: { representativeId: repId },
        _sum: { amount: true },
      }),
      this.prisma.repReturn.count({
        where: { representativeId: repId, status: 'pending' },
      }),
    ]);

    const stockValue = rep.stockItems.reduce((s, i) => s + Number(i.totalValue), 0);
    const sold = Number(totalSold._sum.totalAmount ?? 0);
    const collected = Number(totalCollected._sum.amount ?? 0);

    return {
      ...rep,
      summary: { stockValue, totalSold: sold, totalCollected: collected, outstanding: sold - collected, pendingReturns },
    };
  }

  async updateRepresentative(repId: string, dto: UpdateRepresentativeDto) {
    await this.assertRepExists(repId);
    return this.prisma.representative.update({
      where: { id: repId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.status && { status: dto.status }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
  }

  // =========================================================================
  // ADMIN — Assignments
  // =========================================================================

  async assignCustomers(repId: string, dto: AssignCustomersDto) {
    const rep = await this.assertRepExists(repId);
    const tenantId = rep.tenantId;

    await Promise.all(
      dto.customerIds.map((customerId) =>
        this.prisma.repCustomer.upsert({
          where: {
            tenantId_representativeId_customerId: {
              tenantId: tenantId as string,
              representativeId: repId,
              customerId,
            },
          },
          update: { isActive: true },
          create: { representativeId: repId, customerId, isActive: true },
        }),
      ),
    );
    return { assigned: dto.customerIds.length };
  }

  async assignProducts(repId: string, dto: AssignProductsDto) {
    const rep = await this.assertRepExists(repId);
    const tenantId = rep.tenantId;

    await Promise.all(
      dto.skus.map((sku) =>
        this.prisma.repProduct.upsert({
          where: {
            tenantId_representativeId_sku: {
              tenantId: tenantId as string,
              representativeId: repId,
              sku,
            },
          },
          update: { isActive: true },
          create: { representativeId: repId, sku, isActive: true },
        }),
      ),
    );
    return { assigned: dto.skus.length };
  }

  async assignRoute(repId: string, dto: CreateRepRouteDto) {
    await this.assertRepExists(repId);
    return this.prisma.repRoute.create({
      data: {
        representativeId: repId,
        name: dto.name,
        areas: dto.areas ?? [],
        schedule: dto.schedule,
        isActive: true,
      },
    });
  }

  // =========================================================================
  // ADMIN — Stock Transfer: Warehouse → Representative
  // =========================================================================

  async transferStockToRep(repId: string, dto: TransferStockToRepDto, userId: string) {
    const rep = await this.assertRepExists(repId);
    const tenantId = rep.tenantId;
    const preferred = dto.warehouseLocation;

    return this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        // حل الموقع الفعلي للمخزن الرئيسي (يستبعد WH-A الوهمي)
        const location = await this.resolveWarehouseLocation(tx, item.sku, preferred);

        // التحقق من توفر المخزون في الموقع الفعلي
        const stock = await tx.stockLevel.aggregate({
          where: { sku: item.sku, location },
          _sum: { available: true },
        });
        const available = stock._sum.available ?? 0;
        if (available < item.quantity) {
          throw new BadRequestException(
            `مخزون غير كافٍ لـ${item.sku}: متاح ${available}، مطلوب ${item.quantity} (الموقع ${location})`,
          );
        }

        // جلب تكلفة الوحدة الحالية
        const product = await tx.product.findFirst({
          where: { sku: item.sku },
          select: { costPrice: true, name: true },
        });
        const unitCost = Number(product?.costPrice ?? 0);
        const totalValue = unitCost * item.quantity;

        // 1. خصم من المخزن الرئيسي
        await tx.stockMovement.create({
          data: {
            sku: item.sku,
            type: 'OUT',
            quantity: -item.quantity,
            location,
            reason: `تسليم للمندوب ${rep.name} (${rep.code})`,
            referenceType: 'rep_transfer',
            referenceId: repId,
            createdById: userId,
          },
        });
        await tx.stockLevel.updateMany({
          where: { sku: item.sku, location },
          data: {
            quantity: { decrement: item.quantity },
            available: { decrement: item.quantity },
          },
        });

        // 2. إضافة لمخزون المندوب — Weighted Average cost
        // Use findFirst (no composite null issue) and then upsert by tenantId
        const existing = await tx.repStock.findFirst({
          where: { representativeId: repId, sku: item.sku },
        });

        let newUnitCost = unitCost;
        if (existing && Number(existing.quantity) > 0) {
          const oldTotal = Number(existing.quantity) * Number(existing.unitCost);
          const newTotal = item.quantity * unitCost;
          newUnitCost = (oldTotal + newTotal) / (Number(existing.quantity) + item.quantity);
        }

        if (existing) {
          await tx.repStock.update({
            where: { id: existing.id },
            data: {
              quantity: { increment: item.quantity },
              unitCost: new Prisma.Decimal(newUnitCost),
              totalValue: new Prisma.Decimal(
                (Number(existing.quantity) + item.quantity) * newUnitCost,
              ),
            },
          });
        } else {
          await tx.repStock.create({
            data: {
              representativeId: repId,
              sku: item.sku,
              quantity: item.quantity,
              unitCost: new Prisma.Decimal(unitCost),
              totalValue: new Prisma.Decimal(totalValue),
            },
          });
        }

        // 3. تسجيل حركة المندوب
        await tx.repStockMovement.create({
          data: {
            representativeId: repId,
            sku: item.sku,
            type: RepMovementType.RECEIVED,
            quantity: item.quantity,
            unitCost: new Prisma.Decimal(unitCost),
            totalValue: new Prisma.Decimal(totalValue),
            referenceType: 'warehouse_transfer',
            referenceId: location,
            notes: dto.notes,
            createdBy: userId,
          },
        });
      }

      this.logger.log(`Transferred ${dto.items.length} SKUs to rep ${repId} (tenant: ${tenantId})`);
      return { transferred: dto.items.length, repId };
    });
  }

  /** إعادة مخزون من المندوب إلى المخزن الرئيسي — حركات مخزون حقيقية بالاتجاهين */
  async transferStockFromRep(repId: string, dto: TransferStockFromRepDto, userId: string) {
    const rep = await this.assertRepExists(repId);
    const preferred = dto.warehouseLocation;

    return this.prisma.$transaction(async (tx) => {
      const items: Array<{ sku: string; quantity: number; location: string }> = [];

      for (const item of dto.items) {
        const existing = await tx.repStock.findFirst({
          where: { representativeId: repId, sku: item.sku },
        });
        const onHand = existing ? Number(existing.quantity) : 0;
        if (onHand < item.quantity) {
          throw new BadRequestException(
            `لا يملك المندوب ${item.quantity} من ${item.sku} (المتاح ${onHand})`,
          );
        }

        const unitCost = existing ? Number(existing.unitCost) : 0;
        const location = await this.resolveWarehouseLocation(tx, item.sku, preferred);

        // 1. خصم من مخزون المندوب
        if (existing) {
          const newQty = onHand - item.quantity;
          await tx.repStock.update({
            where: { id: existing.id },
            data: {
              quantity: newQty,
              totalValue: new Prisma.Decimal(newQty * unitCost),
            },
          });
        }

        // 2. إضافة للمخزن الرئيسي (حركة مخزون فعلية)
        await tx.stockMovement.create({
          data: {
            sku: item.sku,
            type: 'IN',
            quantity: item.quantity,
            location,
            reason: `إعادة مخزون من المندوب ${rep.name} (${rep.code})`,
            referenceType: 'rep_transfer_back',
            referenceId: repId,
            createdById: userId,
          },
        });
        const level = await tx.stockLevel.findFirst({ where: { sku: item.sku, location } });
        if (level) {
          await tx.stockLevel.update({
            where: { id: level.id },
            data: {
              quantity: { increment: item.quantity },
              available: { increment: item.quantity },
            },
          });
        } else {
          await tx.stockLevel.create({
            data: {
              sku: item.sku,
              location,
              quantity: item.quantity,
              available: item.quantity,
              reserved: 0,
            },
          });
        }

        // 3. تسجيل حركة المندوب (خروج)
        await tx.repStockMovement.create({
          data: {
            representativeId: repId,
            sku: item.sku,
            type: RepMovementType.ADJUSTED,
            quantity: -item.quantity,
            unitCost: new Prisma.Decimal(unitCost),
            totalValue: new Prisma.Decimal(-(unitCost * item.quantity)),
            referenceType: 'warehouse_transfer_back',
            referenceId: location,
            notes: dto.notes,
            createdBy: userId,
          },
        });

        items.push({ sku: item.sku, quantity: item.quantity, location });
      }

      this.logger.log(`Transfer-back ${dto.items.length} SKUs from rep ${repId}`);
      return { transferred: dto.items.length, repId, items };
    });
  }

  // =========================================================================
  // REP-SCOPED — My Profile
  // =========================================================================

  async getMyProfile(userId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { userId },
      include: {
        routes: { where: { isActive: true } },
        customers: { where: { isActive: true }, select: { customerId: true } },
        products: { where: { isActive: true }, select: { sku: true } },
      },
    });
    if (!rep) throw new NotFoundException('لا يوجد سجل مندوب لهذا المستخدم');
    return rep;
  }

  // =========================================================================
  // REP-SCOPED — Stock
  // =========================================================================

  async getMyStock(repId: string) {
    await this.assertRepExists(repId);
    const items = await this.prisma.repStock.findMany({
      where: { representativeId: repId, quantity: { gt: 0 } },
      orderBy: { sku: 'asc' },
    });
    const skus = items.map((i) => i.sku);
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, unit: true },
    });
    const nameMap = new Map(products.map((p) => [p.sku, p]));
    return items.map((i) => ({ ...i, product: nameMap.get(i.sku) ?? null }));
  }

  async getMyStockMovements(repId: string, query: RepSaleQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 30, 100);
    const [data, total] = await Promise.all([
      this.prisma.repStockMovement.findMany({
        where: {
          representativeId: repId,
          ...(query.from && { createdAt: { gte: new Date(query.from) } }),
          ...(query.to && { createdAt: { lte: new Date(query.to) } }),
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.repStockMovement.count({ where: { representativeId: repId } }),
    ]);
    return { data, total, page, limit };
  }

  // =========================================================================
  // REP-SCOPED — Sales
  // =========================================================================

  async createSale(repId: string, dto: CreateRepSaleDto, userId: string) {
    const rep = await this.assertRepExists(repId);

    // التحقق من أن العميل مخصص لهذا المندوب
    const customerAssigned = await this.prisma.repCustomer.findFirst({
      where: { representativeId: repId, customerId: dto.customerId, isActive: true },
    });
    if (!customerAssigned) throw new ForbiddenException('هذا العميل غير مخصص لك');

    // التحقق من كل صنف: مسموح + مخزون كافٍ
    for (const item of dto.items) {
      const allowed = await this.prisma.repProduct.findFirst({
        where: { representativeId: repId, sku: item.sku, isActive: true },
      });
      if (!allowed) throw new ForbiddenException(`المنتج ${item.sku} غير مخصص لك`);

      const stock = await this.prisma.repStock.findFirst({
        where: { representativeId: repId, sku: item.sku },
      });
      if (!stock || Number(stock.quantity) < item.quantity) {
        throw new BadRequestException(
          `مخزون غير كافٍ لـ${item.sku}: متاح ${stock?.quantity ?? 0}، مطلوب ${item.quantity}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const saleNumber = await this.docNum.next(tx, 'repSale', rep.tenantId ?? null);

      let subtotal = 0;
      const saleItemsData: Array<{
        sku: string; quantity: number;
        unitPrice: Prisma.Decimal; unitCost: Prisma.Decimal;
        lineTotal: Prisma.Decimal; discountPercent: Prisma.Decimal; discountAmount: Prisma.Decimal;
      }> = [];

      for (const item of dto.items) {
        const stock = await tx.repStock.findFirst({
          where: { representativeId: repId, sku: item.sku },
        });
        const unitCost = Number(stock?.unitCost ?? 0);
        const discPct = item.discountPercent ?? 0;
        const discAmt = (item.unitPrice * item.quantity * discPct) / 100;
        const lineTotal = item.unitPrice * item.quantity - discAmt;
        subtotal += lineTotal;

        saleItemsData.push({
          sku: item.sku, quantity: item.quantity,
          unitPrice: new Prisma.Decimal(item.unitPrice),
          unitCost: new Prisma.Decimal(unitCost),
          lineTotal: new Prisma.Decimal(lineTotal),
          discountPercent: new Prisma.Decimal(discPct),
          discountAmount: new Prisma.Decimal(discAmt),
        });
      }

      const totalDiscount = Number(dto.discountAmount ?? 0);
      const totalAmount = subtotal - totalDiscount;

      const sale = await tx.repSale.create({
        data: {
          representativeId: repId,
          customerId: dto.customerId,
          saleNumber,
          saleDate: new Date(dto.saleDate),
          subtotal: new Prisma.Decimal(subtotal),
          discountAmount: new Prisma.Decimal(totalDiscount),
          totalAmount: new Prisma.Decimal(totalAmount),
          paidAmount: new Prisma.Decimal(0),
          status: RepSaleStatus.PENDING,
          notes: dto.notes,
          createdBy: userId,
          items: { create: saleItemsData },
        },
        include: { items: true },
      });

      // خصم من مخزون المندوب
      for (const item of dto.items) {
        const si = saleItemsData.find((s) => s.sku === item.sku)!;

        // استخدام findFirst + update لتجنب مشكلة composite null
        const existingStock = await tx.repStock.findFirst({
          where: { representativeId: repId, sku: item.sku },
        });
        if (existingStock) {
          const newQty = Number(existingStock.quantity) - item.quantity;
          await tx.repStock.update({
            where: { id: existingStock.id },
            data: {
              quantity: Math.max(0, newQty),
              totalValue: new Prisma.Decimal(
                Math.max(0, newQty * Number(existingStock.unitCost)),
              ),
            },
          });
        }

        await tx.repStockMovement.create({
          data: {
            representativeId: repId,
            sku: item.sku,
            type: RepMovementType.SOLD,
            quantity: -item.quantity,
            unitCost: si.unitCost,
            totalValue: new Prisma.Decimal(-Number(si.lineTotal)),
            referenceType: 'rep_sale',
            referenceId: sale.id,
            createdBy: userId,
          },
        });
      }

      return sale;
    });
  }

  async getMySales(repId: string, query: RepSaleQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.RepSaleWhereInput = {
      representativeId: repId,
      ...(query.status && { status: query.status as RepSaleStatus }),
      ...(query.from && { saleDate: { gte: new Date(query.from) } }),
      ...(query.to && { saleDate: { lte: new Date(query.to) } }),
    };
    const [data, total] = await Promise.all([
      this.prisma.repSale.findMany({
        where, orderBy: { saleDate: 'desc' },
        skip: (page - 1) * limit, take: limit,
        include: { items: true },
      }),
      this.prisma.repSale.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  // =========================================================================
  // REP-SCOPED — Collections
  // =========================================================================

  async createCollection(repId: string, dto: CreateRepCollectionDto, userId: string) {
    await this.assertRepExists(repId);

    if (dto.saleId) {
      const sale = await this.prisma.repSale.findFirst({
        where: { id: dto.saleId, representativeId: repId },
      });
      if (!sale) throw new ForbiddenException('الفاتورة لا تخصك');
    }

    return this.prisma.$transaction(async (tx) => {
      const collection = await tx.repCollection.create({
        data: {
          representativeId: repId,
          saleId: dto.saleId,
          customerId: dto.customerId,
          amount: new Prisma.Decimal(dto.amount),
          method: dto.method ?? 'cash',
          collectionDate: new Date(dto.collectionDate),
          notes: dto.notes,
          createdBy: userId,
        },
      });

      if (dto.saleId) {
        const sale = await tx.repSale.findUnique({ where: { id: dto.saleId } });
        if (sale) {
          const newPaid = Number(sale.paidAmount) + dto.amount;
          const newStatus =
            newPaid >= Number(sale.totalAmount) ? RepSaleStatus.PAID : RepSaleStatus.PARTIAL;
          await tx.repSale.update({
            where: { id: dto.saleId },
            data: { paidAmount: new Prisma.Decimal(newPaid), status: newStatus },
          });
        }
      }

      return collection;
    });
  }

  async getMyCollections(repId: string, query: RepSaleQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 30, 100);
    const [data, total] = await Promise.all([
      this.prisma.repCollection.findMany({
        where: {
          representativeId: repId,
          ...(query.from && { collectionDate: { gte: new Date(query.from) } }),
          ...(query.to && { collectionDate: { lte: new Date(query.to) } }),
        },
        orderBy: { collectionDate: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.repCollection.count({ where: { representativeId: repId } }),
    ]);
    return { data, total, page, limit };
  }

  // =========================================================================
  // REP-SCOPED — Returns
  // =========================================================================

  async createReturn(repId: string, dto: CreateRepReturnDto, userId: string) {
    await this.assertRepExists(repId);

    if (dto.saleId) {
      const sale = await this.prisma.repSale.findFirst({
        where: { id: dto.saleId, representativeId: repId },
      });
      if (!sale) throw new ForbiddenException('الفاتورة لا تخصك');
    }

    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.repReturn.create({
        data: {
          representativeId: repId,
          saleId: dto.saleId,
          customerId: dto.customerId,
          sku: dto.sku,
          quantity: dto.quantity,
          unitPrice: new Prisma.Decimal(dto.unitPrice),
          totalValue: new Prisma.Decimal(dto.unitPrice * dto.quantity),
          reason: dto.reason,
          returnDate: new Date(dto.returnDate),
          status: 'pending',
          notes: dto.notes,
          createdBy: userId,
        },
      });

      // إعادة المخزون — استخدام findFirst + update بدل upsert بـnull tenantId
      const existingStock = await tx.repStock.findFirst({
        where: { representativeId: repId, sku: dto.sku },
      });
      const unitCost = Number(existingStock?.unitCost ?? dto.unitPrice);

      if (existingStock) {
        const newQty = Number(existingStock.quantity) + dto.quantity;
        await tx.repStock.update({
          where: { id: existingStock.id },
          data: {
            quantity: newQty,
            totalValue: new Prisma.Decimal(newQty * unitCost),
          },
        });
      } else {
        await tx.repStock.create({
          data: {
            representativeId: repId,
            sku: dto.sku,
            quantity: dto.quantity,
            unitCost: new Prisma.Decimal(unitCost),
            totalValue: new Prisma.Decimal(unitCost * dto.quantity),
          },
        });
      }

      await tx.repStockMovement.create({
        data: {
          representativeId: repId,
          sku: dto.sku,
          type: RepMovementType.RETURNED,
          quantity: dto.quantity,
          unitCost: new Prisma.Decimal(unitCost),
          totalValue: new Prisma.Decimal(unitCost * dto.quantity),
          referenceType: 'rep_return',
          referenceId: ret.id,
          createdBy: userId,
        },
      });

      return ret;
    });
  }

  async getMyReturns(repId: string, query: RepSaleQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 30, 100);
    const [data, total] = await Promise.all([
      this.prisma.repReturn.findMany({
        where: {
          representativeId: repId,
          ...(query.from && { returnDate: { gte: new Date(query.from) } }),
          ...(query.to && { returnDate: { lte: new Date(query.to) } }),
        },
        orderBy: { returnDate: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.repReturn.count({ where: { representativeId: repId } }),
    ]);
    return { data, total, page, limit };
  }

  // =========================================================================
  // Settlement
  // =========================================================================

  async createSettlement(repId: string, dto: CreateSettlementDto, userId: string) {
    await this.assertRepExists(repId);

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    const existing = await this.prisma.repSettlement.findFirst({
      where: {
        representativeId: repId, periodStart, periodEnd,
        status: { notIn: [SettlementStatus.CLOSED, SettlementStatus.DISPUTED] },
      },
    });
    if (existing) throw new ConflictException('يوجد تسوية مفتوحة لهذه الفترة');

    const [receivedAgg, salesAgg, collectionsAgg, returnsAgg, stockItems] = await Promise.all([
      this.prisma.repStockMovement.aggregate({
        where: { representativeId: repId, type: RepMovementType.RECEIVED, createdAt: { gte: periodStart, lte: periodEnd } },
        _sum: { totalValue: true },
      }),
      this.prisma.repSale.aggregate({
        where: { representativeId: repId, saleDate: { gte: periodStart, lte: periodEnd }, status: { not: RepSaleStatus.CANCELLED } },
        _sum: { totalAmount: true },
      }),
      this.prisma.repCollection.aggregate({
        where: { representativeId: repId, collectionDate: { gte: periodStart, lte: periodEnd } },
        _sum: { amount: true },
      }),
      this.prisma.repReturn.aggregate({
        where: { representativeId: repId, returnDate: { gte: periodStart, lte: periodEnd }, status: { not: 'rejected' } },
        _sum: { totalValue: true },
      }),
      this.prisma.repStock.findMany({
        where: { representativeId: repId },
        select: { sku: true, quantity: true, unitCost: true },
      }),
    ]);

    const receivedValue = Number(receivedAgg._sum.totalValue ?? 0);
    const soldValue = Number(salesAgg._sum.totalAmount ?? 0);
    const collectedValue = Number(collectionsAgg._sum.amount ?? 0);
    const returnedValue = Number(returnsAgg._sum.totalValue ?? 0);
    const outstandingAmount = soldValue - collectedValue;

    const expectedStock = stockItems.map((s) => ({
      sku: s.sku, expectedQty: Number(s.quantity), unitCost: Number(s.unitCost),
    }));
    const actualStock = dto.actualStock ?? expectedStock.map((e) => ({ sku: e.sku, quantity: e.expectedQty }));

    let stockVarianceValue = 0;
    for (const exp of expectedStock) {
      const actual = actualStock.find((a) => a.sku === exp.sku);
      const diff = exp.expectedQty - (actual?.quantity ?? 0);
      stockVarianceValue += diff * exp.unitCost;
    }

    return this.prisma.repSettlement.create({
      data: {
        representativeId: repId, periodStart, periodEnd,
        receivedValue: new Prisma.Decimal(receivedValue),
        soldValue: new Prisma.Decimal(soldValue),
        collectedValue: new Prisma.Decimal(collectedValue),
        returnedValue: new Prisma.Decimal(returnedValue),
        outstandingAmount: new Prisma.Decimal(outstandingAmount),
        expectedStock, actualStock,
        stockVarianceValue: new Prisma.Decimal(stockVarianceValue),
        varianceReason: dto.varianceReason,
        status: SettlementStatus.SUBMITTED,
        notes: dto.notes,
        createdBy: userId,
      },
    });
  }

  async approveSettlement(settlementId: string, approved: boolean, notes: string | undefined, userId: string) {
    const settlement = await this.prisma.repSettlement.findUnique({ where: { id: settlementId } });
    if (!settlement) throw new NotFoundException('التسوية غير موجودة');
    if (settlement.status !== SettlementStatus.SUBMITTED) {
      throw new BadRequestException('يمكن اعتماد التسويات المقدَّمة فقط');
    }

    return this.prisma.repSettlement.update({
      where: { id: settlementId },
      data: {
        status: approved ? SettlementStatus.APPROVED : SettlementStatus.DISPUTED,
        approvedBy: userId, approvedAt: new Date(),
        notes: notes ?? settlement.notes,
      },
    });
  }

  async getRepSettlements(repId: string) {
    await this.assertRepExists(repId);
    return this.prisma.repSettlement.findMany({
      where: { representativeId: repId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSettlement(settlementId: string) {
    const s = await this.prisma.repSettlement.findUnique({ where: { id: settlementId } });
    if (!s) throw new NotFoundException('التسوية غير موجودة');
    return s;
  }

  // =========================================================================
  // Summary
  // =========================================================================

  async getRepSummary(repId: string) {
    await this.assertRepExists(repId);

    const [stockItems, salesAgg, collAgg, pendingReturns, lastSettlement] = await Promise.all([
      this.prisma.repStock.findMany({
        where: { representativeId: repId },
        select: { quantity: true, totalValue: true },
      }),
      this.prisma.repSale.aggregate({
        where: { representativeId: repId, status: { not: RepSaleStatus.CANCELLED } },
        _sum: { totalAmount: true, paidAmount: true },
      }),
      this.prisma.repCollection.aggregate({
        where: { representativeId: repId },
        _sum: { amount: true },
      }),
      this.prisma.repReturn.count({
        where: { representativeId: repId, status: 'pending' },
      }),
      this.prisma.repSettlement.findFirst({
        where: { representativeId: repId },
        orderBy: { createdAt: 'desc' },
        select: { periodEnd: true, status: true, outstandingAmount: true },
      }),
    ]);

    const stockValue = stockItems.reduce((s, i) => s + Number(i.totalValue), 0);
    const totalSold = Number(salesAgg._sum.totalAmount ?? 0);
    const totalCollected = Number(collAgg._sum.amount ?? 0);

    return {
      stockValue, totalSold, totalCollected,
      outstanding: totalSold - totalCollected,
      pendingReturns, lastSettlement,
    };
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /** Fetches rep with tenantId — used to get the real tenantId for scoped operations */
  private async assertRepExists(repId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { id: repId },
      select: { id: true, name: true, code: true, status: true, tenantId: true },
    });
    if (!rep) throw new NotFoundException('المندوب غير موجود');
    return rep;
  }
}
