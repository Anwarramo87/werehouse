import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { paginatedResponse, paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { AuditService } from '../common/services/audit.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ReserveStockDto } from './dto/reserve-stock.dto';
import { InventoryProductsQueryDto } from './dto/inventory-products-query.dto';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

type StockLevelRow = {
  id: string;
  sku: string;
  location: string;
  quantity: number;
  reserved: number;
  available: number;
  createdAt: Date;
  updatedAt: Date;
};

type LowStockAlert = {
  sku: string;
  name: string;
  available: number;
  reorderLevel: number;
};

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly auditService: AuditService,
  ) {}

  private audit(
    action: string,
    targetType: string,
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
        targetType,
        targetId: targetId ?? undefined,
        metadata,
      },
      req,
    );
  }

  private async invalidateInventoryCaches() {
    await Promise.all([
      this.shortCache.invalidatePrefix('inventory:stats'),
      this.shortCache.invalidatePrefix('inventory:alerts:low-stock'),
    ]);
  }

  /** Kept for backward compatibility (sales / purchasing call this). */
  async invalidateCaches() {
    await this.invalidateInventoryCaches();
  }

  private async stockSummaryBySku() {
    const grouped = await this.prisma.stockLevel.groupBy({
      by: ['sku'],
      _sum: { quantity: true, reserved: true, available: true },
    });
    return new Map(
      grouped.map((entry) => [
        entry.sku,
        {
          quantity: entry._sum.quantity ?? 0,
          reserved: entry._sum.reserved ?? 0,
          available: entry._sum.available ?? 0,
        },
      ]),
    );
  }

  // ------------------------------------------------------------------ products

  async listProducts(query: InventoryProductsQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 50, maxLimit: 200 });

    const where: Prisma.ProductWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { sku: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [products, total, stockMap] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
      this.stockSummaryBySku(),
    ]);

    const enriched = products.map((product) => {
      const stock = stockMap.get(product.sku) ?? { quantity: 0, reserved: 0, available: 0 };
      return { ...product, totalQuantity: stock.quantity, totalReserved: stock.reserved, totalAvailable: stock.available };
    });

    return paginatedResponse(enriched, page, limit, total);
  }

  async getProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    const [stockLevels, recentMovements] = await Promise.all([
      this.prisma.stockLevel.findMany({ where: { sku: product.sku }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.stockMovement.findMany({
        where: { sku: product.sku },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return { product, stockLevels, recentMovements };
  }

  async createProduct(dto: CreateProductDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
    if (existing) throw new ConflictException('SKU already exists');

    const product = await this.prisma.product.create({
      data: {
        sku: dto.sku,
        name: dto.name,
        category: dto.category,
        unitPrice: new Prisma.Decimal(dto.unitPrice),
        costPrice: new Prisma.Decimal(dto.costPrice),
        reorderLevel: dto.reorderLevel ?? 10,
        unit: dto.unit,
        status: 'active',
      },
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.product.create', 'product', product.id, { sku: product.sku, name: product.name }, actor, req);

    return { message: 'Product created successfully', product };
  }

  async updateProduct(productId: string, dto: UpdateProductDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!existing) throw new NotFoundException('Product not found');

    const { sku: _ignoredSku, ...safeDto } = dto;

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...safeDto,
        unitPrice: safeDto.unitPrice !== undefined ? new Prisma.Decimal(safeDto.unitPrice) : undefined,
        costPrice: safeDto.costPrice !== undefined ? new Prisma.Decimal(safeDto.costPrice) : undefined,
        reorderLevel: safeDto.reorderLevel,
        status: safeDto.status,
      },
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.product.update', 'product', product.id, { sku: product.sku }, actor, req);

    return { message: 'Product updated successfully', product };
  }

  async deleteProduct(productId: string, actor?: Actor, req?: Request) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.stockLevel.deleteMany({ where: { sku: product.sku } });
      await tx.product.delete({ where: { id: productId } });
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.product.delete', 'product', productId, { sku: product.sku }, actor, req);

    return { message: 'Product deleted successfully' };
  }

  async listCategories() {
    const rows = await this.prisma.product.findMany({
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((row) => row.category);
  }

  // ------------------------------------------------------------------- stock

  async listStock(query?: { sku?: string; location?: string }) {
    const where: Prisma.StockLevelWhereInput = {};
    if (query?.sku) where.sku = query.sku;
    if (query?.location) where.location = query.location;

    const rows = await this.prisma.stockLevel.findMany({
      where,
      orderBy: [{ sku: 'asc' }, { location: 'asc' }],
      include: { product: { select: { name: true, unit: true } } },
    });

    return { data: rows, total: rows.length };
  }

  async stockBySku(sku: string) {
    const stockLevels = await this.prisma.stockLevel.findMany({ where: { sku }, orderBy: { location: 'asc' } });
    return { sku, locations: stockLevels.length, stockLevels };
  }

  async adjustStock(dto: AdjustStockDto, actor?: Actor, req?: Request) {
    const change = Math.round(Number(dto.change));
    if (!Number.isFinite(change) || change === 0) {
      throw new BadRequestException('Change must be a non-zero number');
    }

    const product = await this.prisma.product.findUnique({ where: { sku: dto.sku }, select: { sku: true } });
    if (!product) throw new NotFoundException(`Product with SKU "${dto.sku}" not found`);

    const type: StockMovementType = dto.type ?? (change > 0 ? StockMovementType.IN : StockMovementType.OUT);

    // Block going below zero on hand for deductions.
    if (change < 0) {
      const current = await this.prisma.stockLevel.findUnique({
        where: { sku_location: { sku: dto.sku, location: dto.location } },
        select: { quantity: true },
      });
      if (!current) throw new NotFoundException('Stock level not found');
      if (current.quantity + change < 0) {
        throw new BadRequestException('Insufficient stock on hand');
      }
    }

    const stockLevel = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StockLevelRow[]>`
        INSERT INTO stock_levels (id, sku, location, quantity, reserved, available, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${dto.sku}, ${dto.location}, ${Math.max(0, change)}, 0, ${Math.max(0, change)}, NOW(), NOW())
        ON CONFLICT (sku, location) DO UPDATE SET
          quantity = GREATEST(0, stock_levels.quantity + ${change}),
          available = GREATEST(0, GREATEST(0, stock_levels.quantity + ${change}) - stock_levels.reserved),
          "updatedAt" = NOW()
        RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
      `;
      const updated = rows[0];
      if (!updated) throw new BadRequestException('Stock adjustment failed');

      await tx.stockMovement.create({
        data: {
          sku: dto.sku,
          type,
          quantity: change,
          location: dto.location,
          reason: dto.reason || null,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdById: actor?.userId,
        },
      });

      return updated;
    });

    await this.invalidateInventoryCaches();
    this.audit(
      'inventory.stock.adjust',
      'stock_level',
      stockLevel.id,
      { sku: dto.sku, location: dto.location, change, type },
      actor,
      req,
    );

    return { message: 'Stock adjusted successfully', stockLevel };
  }

  async reserveStock(dto: ReserveStockDto, actor?: Actor, req?: Request) {
    const quantity = Math.round(Number(dto.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const rows = await this.prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<StockLevelRow[]>`
        UPDATE stock_levels
        SET reserved = reserved + ${quantity}, available = available - ${quantity}, "updatedAt" = NOW()
        WHERE sku = ${dto.sku} AND location = ${dto.location} AND available >= ${quantity}
        RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
      `;
      if (result.length === 0) return result;

      await tx.stockMovement.create({
        data: {
          sku: dto.sku,
          type: StockMovementType.RESERVE,
          quantity,
          location: dto.location,
          reason: dto.reason || 'Reserved',
          referenceId: dto.referenceId,
          createdById: actor?.userId,
        },
      });

      return result;
    });

    if (rows.length === 0) {
      await this.assertStockLevelExistsOrThrow(dto.sku, dto.location);
      throw new BadRequestException('Insufficient stock available');
    }

    await this.invalidateInventoryCaches();
    this.audit(
      'inventory.stock.reserve',
      'stock_level',
      rows[0].id,
      { sku: dto.sku, location: dto.location, quantity },
      actor,
      req,
    );

    return { message: 'Stock reserved successfully', stockLevel: rows[0] };
  }

  async releaseReservation(dto: ReserveStockDto, actor?: Actor, req?: Request) {
    const quantity = Math.round(Number(dto.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const rows = await this.prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<StockLevelRow[]>`
        UPDATE stock_levels
        SET reserved = reserved - ${quantity}, available = available + ${quantity}, "updatedAt" = NOW()
        WHERE sku = ${dto.sku} AND location = ${dto.location} AND reserved >= ${quantity}
        RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
      `;
      if (result.length === 0) return result;

      await tx.stockMovement.create({
        data: {
          sku: dto.sku,
          type: StockMovementType.RELEASE,
          quantity: -quantity,
          location: dto.location,
          reason: dto.reason || 'Released',
          referenceId: dto.referenceId,
          createdById: actor?.userId,
        },
      });

      return result;
    });

    if (rows.length === 0) {
      await this.assertStockLevelExistsOrThrow(dto.sku, dto.location);
      throw new BadRequestException('Cannot release more than reserved');
    }

    await this.invalidateInventoryCaches();
    this.audit(
      'inventory.stock.release',
      'stock_level',
      rows[0].id,
      { sku: dto.sku, location: dto.location, quantity },
      actor,
      req,
    );

    return { message: 'Reservation released successfully', stockLevel: rows[0] };
  }

  private async assertStockLevelExistsOrThrow(sku: string, location: string) {
    const stock = await this.prisma.stockLevel.findUnique({
      where: { sku_location: { sku, location } },
      select: { id: true },
    });
    if (!stock) {
      throw new NotFoundException('Stock level not found');
    }
  }

  // ---------------------------------------------------------------- movements

  async listMovements(query: StockMovementQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25, maxLimit: 100 });

    const where: Prisma.StockMovementWhereInput = {};
    if (query.sku) where.sku = query.sku;
    if (query.type) where.type = query.type as StockMovementType;
    if (query.location) where.location = query.location;

    const [movements, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { product: { select: { name: true } } },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return paginatedResponse(movements, page, limit, total);
  }

  // ------------------------------------------------------------- low stock / stats

  async lowStockAlerts(query?: { page?: number; limit?: number }) {
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(200, Math.max(1, query?.limit ?? 50));
    const skip = (page - 1) * limit;

    return this.shortCache.getOrSetJson('inventory:alerts:low-stock', 20, async () => {
      const [products, stockSums] = await Promise.all([
        this.prisma.product.findMany({
          where: { status: 'active' },
          select: { sku: true, name: true, reorderLevel: true },
        }),
        this.prisma.stockLevel.groupBy({
          by: ['sku'],
          _sum: { available: true },
        }),
      ]);

      const availableBySku = new Map<string, number>(
        stockSums.map((entry) => [entry.sku, entry._sum.available ?? 0]),
      );

      const allAlerts: LowStockAlert[] = products
        .filter((product) => (availableBySku.get(product.sku) ?? 0) < product.reorderLevel)
        .map((product) => ({
          sku: product.sku,
          name: product.name,
          available: availableBySku.get(product.sku) ?? 0,
          reorderLevel: product.reorderLevel,
        }))
        .sort((a, b) => a.available - b.available);

      const total = allAlerts.length;
      const alerts = allAlerts.slice(skip, skip + limit);

      return {
        data: alerts,
        ...paginationMeta(page, limit, total),
      };
    });
  }

  async stats() {
    return this.shortCache.getOrSetJson('inventory:stats', 30, async () => {
      const [totalProducts, stock, lowStockAlerts, warehouses] = await Promise.all([
        this.prisma.product.count(),
        this.prisma.stockLevel.findMany(),
        this.lowStockAlerts({ page: 1, limit: 1 }),
        this.prisma.warehouse.count(),
      ]);

      const totalQuantity = stock.reduce((sum, x) => sum + x.quantity, 0);
      const totalAvailable = stock.reduce((sum, x) => sum + x.available, 0);
      const totalReserved = stock.reduce((sum, x) => sum + x.reserved, 0);

      return {
        totalProducts,
        totalStockRecords: stock.length,
        totalQuantity,
        totalAvailable,
        totalReserved,
        lowStockCount: lowStockAlerts.total,
        totalWarehouses: warehouses,
      };
    });
  }

  // --------------------------------------------------------------- warehouses

  async listWarehouses() {
    const warehouses = await this.prisma.warehouse.findMany({ orderBy: { name: 'asc' } });
    return warehouses;
  }

  async createWarehouse(dto: CreateWarehouseDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.warehouse.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('Warehouse code already exists');

    const warehouse = await this.prisma.warehouse.create({
      data: { name: dto.name, code: dto.code, address: dto.address, status: 'active' },
    });

    this.audit('inventory.warehouse.create', 'warehouse', warehouse.id, { name: warehouse.name, code: warehouse.code }, actor, req);

    return { message: 'Warehouse created successfully', warehouse };
  }

  async updateWarehouse(warehouseId: string, dto: UpdateWarehouseDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!existing) throw new NotFoundException('Warehouse not found');

    if (dto.code && dto.code !== existing.code) {
      const collision = await this.prisma.warehouse.findUnique({ where: { code: dto.code } });
      if (collision) throw new ConflictException('Warehouse code already exists');
    }

    const warehouse = await this.prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        name: dto.name,
        code: dto.code,
        address: dto.address,
        status: dto.status,
      },
    });

    this.audit('inventory.warehouse.update', 'warehouse', warehouse.id, { name: warehouse.name }, actor, req);

    return { message: 'Warehouse updated successfully', warehouse };
  }

  async removeWarehouse(warehouseId: string, actor?: Actor, req?: Request) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    await this.prisma.warehouse.delete({ where: { id: warehouseId } });
    this.audit('inventory.warehouse.delete', 'warehouse', warehouseId, { name: warehouse.name }, actor, req);

    return { message: 'Warehouse deleted successfully' };
  }
}
