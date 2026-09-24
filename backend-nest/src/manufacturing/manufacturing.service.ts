import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Prisma, ProductionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CostingService } from '../common/wms/costing.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import {
  CreateBOMDto,
  UpdateBOMDto,
  CreateProductionOrderDto,
  CompleteProductionOrderDto,
  ProductionOrderQueryDto,
} from './dto/manufacturing.dto';

@Injectable()
export class ManufacturingService {
  private readonly logger = new Logger(ManufacturingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly costing: CostingService,
    private readonly docNum: DocumentNumberService,
  ) {}

  /** الموقع الافتراضي لتسوية حركات التصنيع */
  private readonly DEFAULT_LOCATION = 'MAIN';

  /**
   * يحلّ الموقع الفعلي لصنف ما:
   * 1. الموقع المُفضَّل إذا كان يحوي رصيداً فعلياً لهذا الصنف،
   * 2. وإلا أول موقع يحوي رصيداً له،
   * 3. وإلا الموقع الافتراضي.
   * هذا يمنع ظاهرة "الموقع الوهمي" (WH-A القديمة بينما الأرصدة في MAIN).
   */
  private async resolveLocation(
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
  // BOM — Bill of Materials
  // =========================================================================

  /** إنشاء BOM جديدة للمنتج النهائي */
  async createBOM(dto: CreateBOMDto, userId: string) {
    // التحقق من وجود المنتج النهائي
    const product = await this.prisma.product.findFirst({
      where: { sku: dto.productSku },
      select: { sku: true, name: true, productType: true },
    });
    if (!product) throw new NotFoundException(`المنتج ${dto.productSku} غير موجود`);

    // التحقق من وجود مواد خام
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('يجب تحديد مادة خام واحدة على الأقل');
    }

    // التحقق من وجود كل المواد الخام
    const materialSkus = dto.items.map((i) => i.materialSku);
    const materials = await this.prisma.product.findMany({
      where: { sku: { in: materialSkus } },
      select: { sku: true, name: true, costPrice: true },
    });
    const foundSkus = new Set(materials.map((m) => m.sku));
    const missing = materialSkus.filter((s) => !foundSkus.has(s));
    if (missing.length > 0) {
      throw new NotFoundException(`المواد التالية غير موجودة: ${missing.join(', ')}`);
    }

    // تعطيل أي BOM نشطة سابقة لنفس المنتج
    await this.prisma.bOM.updateMany({
      where: { productSku: dto.productSku, isActive: true },
      data: { isActive: false },
    });

    // جلب أعلى رقم إصدار موجود
    const lastBom = await this.prisma.bOM.findFirst({
      where: { productSku: dto.productSku },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (lastBom?.version ?? 0) + 1;

    const bom = await this.prisma.bOM.create({
      data: {
        productSku: dto.productSku,
        version,
        isActive: true,
        notes: dto.notes,
        createdBy: userId,
        items: {
          create: dto.items.map((item) => ({
            materialSku: item.materialSku,
            quantity: new Prisma.Decimal(item.quantity),
            unit: item.unit ?? 'قطعة',
            wastePercent: new Prisma.Decimal(item.wastePercent ?? 0),
            notes: item.notes,
          })),
        },
      },
      include: { items: true },
    });

    return { ...bom, calculatedCost: await this.calculateBOMCost(bom.id) };
  }

  /** قائمة كل الـBOMs النشطة (لاستخدامها في dropdown إنشاء أمر الإنتاج) */
  async listActiveBOMs() {
    const boms = await this.prisma.bOM.findMany({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
      include: {
        product: { select: { name: true, sku: true } },
        items: { select: { materialSku: true, quantity: true } },
      },
    });
    return boms.map((b) => ({
      id: b.id,
      productSku: b.productSku,
      version: b.version,
      productName: b.product?.name ?? b.productSku,
      itemCount: b.items.length,
    }));
  }

  /** جلب الـBOM النشطة لمنتج معين مع تكلفتها المحسوبة */
  async getBOMForProduct(productSku: string) {
    const bom = await this.prisma.bOM.findFirst({
      where: { productSku, isActive: true },
      include: {
        items: true,
        product: { select: { name: true, unitPrice: true, costPrice: true } },
      },
      orderBy: { version: 'desc' },
    });
    if (!bom) throw new NotFoundException(`لا توجد BOM نشطة للمنتج ${productSku}`);
    const calculatedCost = await this.calculateBOMCost(bom.id);
    return { ...bom, calculatedCost };
  }

  /** جلب كل BOMs (نشطة وغير نشطة) لمنتج */
  async listBOMsForProduct(productSku: string) {
    const boms = await this.prisma.bOM.findMany({
      where: { productSku },
      include: { items: true },
      orderBy: { version: 'desc' },
    });
    return boms;
  }

  /** تعديل BOM موجودة */
  async updateBOM(bomId: string, dto: UpdateBOMDto) {
    const bom = await this.prisma.bOM.findFirst({ where: { id: bomId } });
    if (!bom) throw new NotFoundException('BOM غير موجودة');

    return this.prisma.$transaction(async (tx) => {
      if (dto.items && dto.items.length > 0) {
        // حذف البنود القديمة وإعادة الإنشاء
        await tx.bOMItem.deleteMany({ where: { bomId } });
        await tx.bOMItem.createMany({
          data: dto.items.map((item) => ({
            bomId,
            materialSku: item.materialSku,
            quantity: new Prisma.Decimal(item.quantity),
            unit: item.unit ?? 'قطعة',
            wastePercent: new Prisma.Decimal(item.wastePercent ?? 0),
            notes: item.notes,
          })),
        });
      }
      return tx.bOM.update({
        where: { id: bomId },
        data: {
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: { items: true },
      });
    });
  }

  /**
   * حساب تكلفة BOM من أسعار المواد الحالية في النظام
   * materialCost = Σ (quantity × (1 + wastePercent/100) × costPrice)
   */
  async calculateBOMCost(bomId: string): Promise<{
    materialCost: number;
    breakdown: Array<{ sku: string; name: string; quantity: number; unitCost: number; totalCost: number }>;
  }> {
    const bom = await this.prisma.bOM.findFirst({
      where: { id: bomId },
      include: { items: true },
    });
    if (!bom) return { materialCost: 0, breakdown: [] };

    const skus = bom.items.map((i) => i.materialSku);
    const materials = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, costPrice: true },
    });
    const costMap = new Map(materials.map((m) => [m.sku, m]));

    let totalMaterialCost = 0;
    const breakdown: Array<{ sku: string; name: string; quantity: number; unitCost: number; totalCost: number }> = [];

    for (const item of bom.items) {
      const material = costMap.get(item.materialSku);
      const unitCost = Number(material?.costPrice ?? 0);
      const effectiveQty = Number(item.quantity) * (1 + Number(item.wastePercent) / 100);
      const totalCost = effectiveQty * unitCost;
      totalMaterialCost += totalCost;
      breakdown.push({
        sku: item.materialSku,
        name: material?.name ?? item.materialSku,
        quantity: effectiveQty,
        unitCost,
        totalCost,
      });
    }

    return { materialCost: totalMaterialCost, breakdown };
  }

  // =========================================================================
  // Production Orders
  // =========================================================================

  /** إنشاء أمر إنتاج جديد */
  async createProductionOrder(dto: CreateProductionOrderDto, userId: string) {
    const bom = await this.prisma.bOM.findFirst({
      where: { id: dto.bomId, isActive: true },
      include: { items: true },
    });
    if (!bom) throw new NotFoundException('BOM غير موجودة أو غير نشطة');

    const orderNumber = await this.prisma.$transaction(async (tx) => {
      return this.docNum.next(tx, 'productionOrder', null);
    });

    const order = await this.prisma.productionOrder.create({
      data: {
        orderNumber,
        bomId: dto.bomId,
        productSku: bom.productSku,
        plannedQty: dto.plannedQty,
        status: ProductionStatus.PLANNED,
        plannedDate: new Date(dto.plannedDate),
        laborCost: new Prisma.Decimal(dto.laborCost ?? 0),
        overheadCost: new Prisma.Decimal(dto.overheadCost ?? 0),
        packagingCost: new Prisma.Decimal(dto.packagingCost ?? 0),
        otherCost: new Prisma.Decimal(dto.otherCost ?? 0),
        notes: dto.notes,
        createdBy: userId,
      },
      include: { bom: { include: { items: true } } },
    });

    // حساب التكلفة التقديرية
    const { materialCost } = await this.calculateBOMCost(dto.bomId);
    const estimatedMaterialCost = materialCost * dto.plannedQty;
    const estimatedTotal =
      estimatedMaterialCost +
      Number(dto.laborCost ?? 0) +
      Number(dto.overheadCost ?? 0) +
      Number(dto.packagingCost ?? 0) +
      Number(dto.otherCost ?? 0);

    return { ...order, estimatedMaterialCost, estimatedTotal };
  }

  /** بدء التصنيع — حجز المواد الخام من المخزن (الحجز يُستهلك عند الإتمام) */
  async startProductionOrder(orderId: string, userId: string) {
    const order = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { bom: { include: { items: true } } },
    });
    if (!order) throw new NotFoundException('أمر الإنتاج غير موجود');
    if (order.status !== ProductionStatus.PLANNED) {
      throw new BadRequestException(`لا يمكن بدء أمر بحالة: ${order.status}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const reserved: Array<{ materialSku: string; quantity: number; location: string }> = [];

      // التحقق من توفر المخزون لكل مادة خام ثم حجزه
      for (const item of order.bom.items) {
        const plannedBase = Number(item.quantity) * order.plannedQty;
        const effectiveQty = Math.ceil(
          Number(item.quantity) * order.plannedQty * (1 + Number(item.wastePercent) / 100),
        );

        const stock = await tx.stockLevel.aggregate({
          where: { sku: item.materialSku },
          _sum: { available: true },
        });
        const available = stock._sum.available ?? 0;
        if (available < effectiveQty) {
          throw new BadRequestException(
            `مخزون غير كافٍ للمادة ${item.materialSku}: المتاح ${available}، المطلوب ${effectiveQty}`,
          );
        }

        const location = await this.resolveLocation(tx, item.materialSku, this.DEFAULT_LOCATION);

        // حجز الكمية: إخراجها من المتاح وإدخالها في الاحتياطي
        await tx.stockLevel.updateMany({
          where: { sku: item.materialSku, location },
          data: {
            available: { decrement: effectiveQty },
            reserved: { increment: effectiveQty },
          },
        });

        await tx.stockMovement.create({
          data: {
            sku: item.materialSku,
            type: 'RESERVE',
            quantity: effectiveQty,
            location,
            reason: `حجز لصالح أمر إنتاج ${order.orderNumber}`,
            referenceType: 'production_order',
            referenceId: orderId,
            createdById: userId,
          },
        });

        // لقطة الحجز في جدول الاستهلاك (تُكمل ببيانات التكلفة عند الإتمام)
        await tx.materialConsumption.create({
          data: {
            productionOrderId: orderId,
            materialSku: item.materialSku,
            plannedQty: new Prisma.Decimal(plannedBase),
            actualQty: new Prisma.Decimal(effectiveQty),
            wasteQty: new Prisma.Decimal(Math.max(0, effectiveQty - plannedBase)),
            unitCost: new Prisma.Decimal(0),
            totalCost: new Prisma.Decimal(0),
            location,
          },
        });

        reserved.push({ materialSku: item.materialSku, quantity: effectiveQty, location });
      }

      // تحديث حالة أمر الإنتاج
      const updated = await tx.productionOrder.update({
        where: { id: orderId },
        data: { status: ProductionStatus.IN_PROGRESS, startedAt: new Date() },
      });

      return { ...updated, message: 'تم بدء أمر الإنتاج بنجاح', reserved };
    });
  }

  /** إتمام التصنيع — تسجيل الاستهلاك + إضافة المنتج النهائي للمخزن */
  async completeProductionOrder(
    orderId: string,
    dto: CompleteProductionOrderDto,
    userId: string,
  ) {
    const order = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: { bom: { include: { items: true } } },
    });
    if (!order) throw new NotFoundException('أمر الإنتاج غير موجود');
    if (order.status !== ProductionStatus.IN_PROGRESS) {
      throw new BadRequestException(`لا يمكن إتمام أمر بحالة: ${order.status}`);
    }
    if (dto.actualQty <= 0) throw new BadRequestException('الكمية الفعلية يجب أن تكون أكبر من صفر');

    return this.prisma.$transaction(async (tx) => {
      let totalMaterialCost = 0;

      // الموقع المستهدف؛ يُحل من الموقع الفعلي الذي يحوي رصيد أول مادة خام
      const firstSku = order.bom.items[0]?.materialSku ?? order.productSku;
      const targetLocation = await this.resolveLocation(
        tx,
        firstSku,
        dto.warehouseLocation ?? this.DEFAULT_LOCATION,
      );

      // 1. استهلاك المواد الخام المحجوزة عند البدء + تسجيل الاستهلاك
      for (const item of order.bom.items) {
        const plannedBase = Number(item.quantity) * dto.actualQty;
        const effectiveQty = Math.ceil(
          Number(item.quantity) * dto.actualQty * (1 + Number(item.wastePercent) / 100),
        );

        // لقطة الحجز المسجلة عند بدء الأمر
        const existing = await tx.materialConsumption.findFirst({
          where: { productionOrderId: orderId, materialSku: item.materialSku },
        });
        const reservedQty = existing ? Number(existing.actualQty) : 0;
        const location = existing?.location ?? targetLocation;

        // جلب تكلفة المادة الخام وقت الإنتاج (snapshot)
        const material = await tx.product.findFirst({
          where: { sku: item.materialSku },
          select: { costPrice: true },
        });
        const unitCost = Number(material?.costPrice ?? 0);

        // فرق بين المطلوب فعلياً والمحجوز — حجز إضافي أو إفراج عن زائد
        const delta = effectiveQty - reservedQty;
        if (delta > 0) {
          const level = await tx.stockLevel.findFirst({
            where: { sku: item.materialSku, location },
            select: { available: true },
          });
          const avail = Number(level?.available ?? 0);
          if (avail < delta) {
            throw new BadRequestException(
              `مخزون غير كافٍ للمادة ${item.materialSku}: المتاح ${avail}، المطلوب ${delta}`,
            );
          }
          await tx.stockLevel.updateMany({
            where: { sku: item.materialSku, location },
            data: {
              available: { decrement: delta },
              reserved: { increment: delta },
            },
          });
        } else if (delta < 0) {
          await tx.stockLevel.updateMany({
            where: { sku: item.materialSku, location },
            data: {
              available: { increment: -delta },
              reserved: { decrement: -delta },
            },
          });
        }

        // استهلاك الحجز فعلياً (رصيد الحجز يُنقص فقط؛ المتاح حُسم وقت الحجز)
        const legacyWithoutReservation = !existing;
        await tx.stockLevel.updateMany({
          where: { sku: item.materialSku, location },
          data: {
            quantity: { decrement: effectiveQty },
            reserved: { decrement: effectiveQty },
            ...(legacyWithoutReservation && { available: { decrement: effectiveQty } }),
          },
        });

        // سحب من المخزن عبر StockMovement
        await tx.stockMovement.create({
          data: {
            sku: item.materialSku,
            type: 'OUT',
            quantity: -effectiveQty,
            location,
            reason: `استهلاك في أمر إنتاج ${order.orderNumber}`,
            referenceType: 'production_order',
            referenceId: orderId,
            createdById: userId,
          },
        });

        const totalCost = effectiveQty * unitCost;
        totalMaterialCost += totalCost;

        // تحديث لقطة الاستهلاك بتكلفتها النهائية
        const wasteQty = Math.max(0, effectiveQty - plannedBase);
        const consumptionData = {
          plannedQty: new Prisma.Decimal(plannedBase),
          actualQty: new Prisma.Decimal(effectiveQty),
          wasteQty: new Prisma.Decimal(wasteQty),
          unitCost: new Prisma.Decimal(unitCost),
          totalCost: new Prisma.Decimal(totalCost),
          location,
        };
        if (existing) {
          await tx.materialConsumption.update({
            where: { id: existing.id },
            data: consumptionData,
          });
        } else {
          await tx.materialConsumption.create({
            data: { productionOrderId: orderId, materialSku: item.materialSku, ...consumptionData },
          });
        }
      }

      // 2. حساب تكلفة الوحدة الكاملة
      const laborCost = Number(dto.laborCost ?? order.laborCost ?? 0);
      const overheadCost = Number(dto.overheadCost ?? order.overheadCost ?? 0);
      const packagingCost = Number(dto.packagingCost ?? order.packagingCost ?? 0);
      const otherCost = Number(dto.otherCost ?? order.otherCost ?? 0);
      const totalCost = totalMaterialCost + laborCost + overheadCost + packagingCost + otherCost;
      const unitCost = dto.actualQty > 0 ? totalCost / dto.actualQty : 0;

      // 3. إضافة المنتج النهائي للمخزن
      await tx.stockMovement.create({
        data: {
          sku: order.productSku,
          type: 'IN',
          quantity: dto.actualQty,
          location: targetLocation,
          reason: `إنتاج من أمر ${order.orderNumber}`,
          referenceType: 'production_order',
          referenceId: orderId,
          createdById: userId,
        },
      });

      // 4. تحديث تكلفة المنتج النهائي (Weighted Average) — قبل تحديث الرصيد
      //    حتى لا تُحتسب الكمية الواردة ضمن onHand في طرفي الكسر
      await this.costing.applyInboundCost(tx, {
        sku: order.productSku,
        quantityIn: dto.actualQty,
        unitCost: new Prisma.Decimal(unitCost),
        referenceType: 'production_order',
        referenceId: orderId,
        createdById: userId,
      });

      // 5. إضافة رصيد المنتج النهائي (upsert StockLevel)
      // استخدام findFirst + create/update لتجنب الـnull-tenantId bug
      const existingStockLevel = await tx.stockLevel.findFirst({
        where: { sku: order.productSku, location: targetLocation },
      });
      if (existingStockLevel) {
        await tx.stockLevel.update({
          where: { id: existingStockLevel.id },
          data: {
            quantity: { increment: dto.actualQty },
            available: { increment: dto.actualQty },
          },
        });
      } else {
        await tx.stockLevel.create({
          data: {
            sku: order.productSku,
            location: targetLocation,
            quantity: dto.actualQty,
            available: dto.actualQty,
            reserved: 0,
          },
        });
      }

      // 6. إنشاء الدفعة (Batch) إذا كان المنتج يتتبع دفعات
      let batch: {
        id: string;
        sku: string;
        batchNumber: string;
        quantity: number;
        unitCost: number;
      } | null = null;
      const finishedProduct = await tx.product.findFirst({
        where: { sku: order.productSku },
        select: { batchTracked: true },
      });
      if (finishedProduct?.batchTracked) {
        const batchNumber =
          dto.batchNumber && dto.batchNumber.trim() ? dto.batchNumber.trim() : await this.docNum.next(tx, 'productBatch', null);
        const created = await tx.productBatch.create({
          data: {
            sku: order.productSku,
            batchNumber,
            productionDate: new Date(),
            expiryDate: dto.batchExpiryDate ? new Date(dto.batchExpiryDate) : null,
            status: 'AVAILABLE',
            initialQuantity: dto.actualQty,
            quantity: dto.actualQty,
            unitCost: new Prisma.Decimal(unitCost),
            notes: `منتج من أمر إنتاج ${order.orderNumber}`,
          },
        });
        await tx.batchStockLevel.create({
          data: {
            batchId: created.id,
            sku: order.productSku,
            location: targetLocation,
            quantity: dto.actualQty,
            available: dto.actualQty,
            reserved: 0,
          },
        });
        batch = {
          id: created.id,
          sku: created.sku,
          batchNumber: created.batchNumber,
          quantity: created.quantity,
          unitCost: Number(created.unitCost),
        };
      }

      // 6. تحديث أمر الإنتاج بالتكاليف النهائية
      const completed = await tx.productionOrder.update({
        where: { id: orderId },
        data: {
          status: ProductionStatus.COMPLETED,
          actualQty: dto.actualQty,
          wasteQty: dto.wasteQty ?? 0,
          completedAt: new Date(),
          completedDate: new Date(),
          materialCost: new Prisma.Decimal(totalMaterialCost),
          laborCost: new Prisma.Decimal(laborCost),
          overheadCost: new Prisma.Decimal(overheadCost),
          packagingCost: new Prisma.Decimal(packagingCost),
          otherCost: new Prisma.Decimal(otherCost),
          totalCost: new Prisma.Decimal(totalCost),
          unitCost: new Prisma.Decimal(unitCost),
          notes: dto.notes ?? order.notes,
        },
        include: { consumption: true },
      });

      this.logger.log(
        `Production order ${order.orderNumber} completed: qty=${dto.actualQty}, unitCost=${unitCost.toFixed(4)}, location=${targetLocation}${batch ? `, batch=${batch.batchNumber}` : ''}`,
      );

      return { ...completed, targetLocation, batch };
    });
  }

  /** إلغاء أمر إنتاج — إفراج الحجوزات إن كانت قد بدأت ثم الإلغاء */
  async cancelProductionOrder(orderId: string, userId: string) {
    const order = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('أمر الإنتاج غير موجود');
    if (order.status === ProductionStatus.COMPLETED) {
      throw new BadRequestException('لا يمكن إلغاء أمر إنتاج مكتمل');
    }
    if (order.status === ProductionStatus.CANCELLED) {
      throw new BadRequestException('الأمر ملغى مسبقاً');
    }

    return this.prisma.$transaction(async (tx) => {
      // إفراج المواد الخام المحجوزة عند بدء الأمر
      if (order.status === ProductionStatus.IN_PROGRESS) {
        const consumptions = await tx.materialConsumption.findMany({
          where: { productionOrderId: orderId },
        });
        for (const c of consumptions) {
          const qty = Number(c.actualQty);
          if (qty <= 0) continue;
          await tx.stockLevel.updateMany({
            where: { sku: c.materialSku, location: c.location },
            data: {
              available: { increment: qty },
              reserved: { decrement: qty },
            },
          });
          await tx.stockMovement.create({
            data: {
              sku: c.materialSku,
              type: 'RELEASE',
              quantity: -qty,
              location: c.location,
              reason: `إلغاء أمر إنتاج ${order.orderNumber}`,
              referenceType: 'production_order',
              referenceId: orderId,
              createdById: userId,
            },
          });
        }
      }

      const cancelled = await tx.productionOrder.update({
        where: { id: orderId },
        data: { status: ProductionStatus.CANCELLED },
      });

      return { ...cancelled, message: 'تم إلغاء أمر الإنتاج وإفراج الحجوزات' };
    });
  }

  /** قائمة أوامر الإنتاج */
  async listProductionOrders(query: ProductionOrderQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ProductionOrderWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.productSku && { productSku: query.productSku }),
    };

    const [data, total] = await Promise.all([
      this.prisma.productionOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          bom: { select: { version: true, productSku: true } },
          consumption: true,
        },
      }),
      this.prisma.productionOrder.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /** تفاصيل أمر إنتاج واحد */
  async getProductionOrder(orderId: string) {
    const order = await this.prisma.productionOrder.findFirst({
      where: { id: orderId },
      include: {
        bom: { include: { items: true } },
        consumption: true,
      },
    });
    if (!order) throw new NotFoundException('أمر الإنتاج غير موجود');
    return order;
  }

  /** ملخص إحصائي للتصنيع */
  async getManufacturingSummary() {
    const [byStatus, recentOrders, totalProducts] = await Promise.all([
      this.prisma.productionOrder.groupBy({
        by: ['status'],
        _count: { id: true },
        _sum: { totalCost: true },
      }),
      this.prisma.productionOrder.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          orderNumber: true,
          productSku: true,
          status: true,
          plannedQty: true,
          actualQty: true,
          totalCost: true,
          createdAt: true,
        },
      }),
      this.prisma.bOM.count({ where: { isActive: true } }),
    ]);

    return { byStatus, recentOrders, totalActiveBOMs: totalProducts };
  }
}
