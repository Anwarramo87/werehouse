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
import { currentTenant } from '../common/tenant/tenant-context';
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
      this.shortCache.invalidatePrefix('inventory:products'),
      this.shortCache.invalidatePrefix('inventory:product:'),
      this.shortCache.invalidatePrefix('inventory:categories'),
      this.shortCache.invalidatePrefix('inventory:movements'),
      this.shortCache.invalidatePrefix('inventory:warehouses'),
    ]);
  }

  private productsCacheKey(query: InventoryProductsQueryDto) {
    const {
      page = 1,
      limit = 50,
      search = '',
      category = '',
      status = '',
      sortBy = '',
      sortDir = '',
    } = query;
    // Sort belongs in the key: without it, two differently-ordered requests
    // would serve each other's cached page.
    return `inventory:products:${page}:${limit}:${search}:${category}:${status}:${sortBy}:${sortDir}`;
  }

  private movementsCacheKey(query: StockMovementQueryDto) {
    const { page = 1, limit = 25, sku = '', type = '', location = '' } = query;
    return `inventory:movements:${page}:${limit}:${sku}:${type}:${location}`;
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

  /**
   * Derives selling price and profit % on cost from user input.
   * - profitPercent given  → price = cost × (1 + pct/100), profit stored as-is.
   * - price given (cost unchanged) → profit = (price − cost) ÷ cost × 100.
   * Storing the derived profit keeps the pricing panel consistent everywhere.
   */
  private resolvePricing(
    cost: Prisma.Decimal,
    price: Prisma.Decimal | undefined,
    profitPercent: number | undefined,
  ): { unitPrice: Prisma.Decimal; profitPercent: Prisma.Decimal | null } {
    if (profitPercent != null && cost.gt(0)) {
      const pct = new Prisma.Decimal(profitPercent);
      const unitPrice = cost
        .mul(new Prisma.Decimal(100).add(pct).div(100))
        .toDP(2);
      return { unitPrice, profitPercent: pct.toDP(3) };
    }
    const unitPrice = price ?? cost;
    const derived = cost.gt(0)
      ? unitPrice.minus(cost).div(cost).mul(100).toDP(3)
      : new Prisma.Decimal(0);
    return { unitPrice, profitPercent: derived };
  }

  private withMargin<T extends {
    costPrice: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    profitPercent: Prisma.Decimal | null;
  }>(product: T): T & { profitPercent: Prisma.Decimal; marginPercent: Prisma.Decimal } {
    const marginPercent = product.unitPrice.gt(0)
      ? product.unitPrice.minus(product.costPrice).div(product.unitPrice).mul(100).toDP(1)
      : new Prisma.Decimal(0);
    return {
      ...product,
      profitPercent: product.profitPercent ?? new Prisma.Decimal(0),
      marginPercent,
    };
  }

  async listProducts(query: InventoryProductsQueryDto) {
    return this.shortCache.getOrSetJson(this.productsCacheKey(query), 15, async () => {
      const { page, limit, skip } = resolvePagination(query, { defaultLimit: 50, maxLimit: 200 });

      const where: Prisma.ProductWhereInput = {};
      if (query.category) where.category = query.category;
      if (query.status) where.status = query.status;
      if (query.productType) where.productType = query.productType as 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED';
      if (query.search) {
        where.OR = [
          { sku: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ];
      }

      // The DTO whitelists the column, so this cannot name anything arbitrary.
      // Newest-first stays the default, which is what the list showed before.
      const orderBy: Prisma.ProductOrderByWithRelationInput = query.sortBy
        ? { [query.sortBy]: query.sortDir ?? 'asc' }
        : { createdAt: 'desc' };

      const [products, total, stockMap] = await Promise.all([
        this.prisma.product.findMany({
          where,
          orderBy,
          skip,
          take: limit,
        }),
        this.prisma.product.count({ where }),
        this.stockSummaryBySku(),
      ]);

      const enriched = products.map((product) => {
        const stock = stockMap.get(product.sku) ?? { quantity: 0, reserved: 0, available: 0 };
        return {
          ...this.withMargin(product),
          totalQuantity: stock.quantity,
          totalReserved: stock.reserved,
          totalAvailable: stock.available,
        };
      });

      return paginatedResponse(enriched, page, limit, total);
    });
  }

  async getProduct(productId: string) {
    return this.shortCache.getOrSetJson(`inventory:product:${productId}`, 15, async () => {
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

      return { product: this.withMargin(product), stockLevels, recentMovements };
    });
  }

  async createProduct(dto: CreateProductDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.product.findFirst({ where: { sku: dto.sku } });
    if (existing) throw new ConflictException('SKU already exists');

    const costPrice = new Prisma.Decimal(dto.costPrice ?? 0);
    const pricing = this.resolvePricing(
      costPrice,
      dto.unitPrice != null ? new Prisma.Decimal(dto.unitPrice) : undefined,
      dto.profitPercent,
    );

    const product = await this.prisma.product.create({
      data: {
        sku: dto.sku,
        name: dto.name,
        category: dto.category,
        costPrice,
        unitPrice: pricing.unitPrice,
        profitPercent: pricing.profitPercent,
        reorderLevel: dto.reorderLevel ?? 10,
        unit: dto.unit,
        photo: dto.photo,
        productType: dto.productType ?? 'FINISHED',
        batchTracked: dto.batchTracked ?? false,
        status: 'active',
      },
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.product.create', 'product', product.id, { sku: product.sku, name: product.name }, actor, req);

    return { message: 'Product created successfully', product: this.withMargin(product) };
  }

  async updateProduct(productId: string, dto: UpdateProductDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!existing) throw new NotFoundException('Product not found');

    const { sku: _ignoredSku, profitPercent: dtoProfit, ...safeDto } = dto;

    const costPrice =
      dto.costPrice != null ? new Prisma.Decimal(dto.costPrice) : existing.costPrice;
    const unitPrice =
      dto.unitPrice != null ? new Prisma.Decimal(dto.unitPrice) : existing.unitPrice;
    const pricing = this.resolvePricing(costPrice, unitPrice, dtoProfit);

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...safeDto,
        costPrice,
        unitPrice: pricing.unitPrice,
        profitPercent: pricing.profitPercent,
        reorderLevel: safeDto.reorderLevel,
        status: safeDto.status,
      },
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.product.update', 'product', product.id, { sku: product.sku }, actor, req);

    return { message: 'Product updated successfully', product: this.withMargin(product) };
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
    return this.shortCache.getOrSetJson('inventory:categories', 60, async () => {
      const rows = await this.prisma.product.findMany({
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      });
      return rows.map((row) => row.category);
    });
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

  /**
   * The stock mutation itself, executed inside a caller-supplied transaction.
   *
   * Split out of `adjustStock` so that operations which must be atomic with a
   * stock change -- a goods receipt, for instance -- can enrol it in their own
   * transaction instead of committing the paperwork and the stock separately.
   * `adjustStock` below still opens its own transaction, so the standalone
   * behaviour is unchanged.
   *
   * Validation that must observe the same snapshot as the write (product exists,
   * sufficient stock on hand) is performed HERE, inside the transaction, rather
   * than by the caller beforehand.
   *
   * Returns the updated row; the caller owns cache invalidation and audit,
   * neither of which is transactional.
   */
  async applyStockChangeWithin(
    tx: Prisma.TransactionClient,
    input: {
      sku: string;
      location: string;
      change: number;
      type?: StockMovementType;
      reason?: string | null;
      referenceType?: string;
      referenceId?: string;
      createdById?: string;
    },
  ): Promise<{ stockLevel: StockLevelRow; type: StockMovementType }> {
    const change = Math.round(Number(input.change));
    if (!Number.isFinite(change) || change === 0) {
      throw new BadRequestException('Change must be a non-zero number');
    }

    const tenantId = this.requireTenantId('Stock adjustment');

    const product = await tx.product.findFirst({
      where: { sku: input.sku },
      select: { sku: true },
    });
    if (!product) throw new NotFoundException(`Product with SKU "${input.sku}" not found`);

    const type: StockMovementType =
      input.type ?? (change > 0 ? StockMovementType.IN : StockMovementType.OUT);

    // Block going below zero on hand for deductions.
    if (change < 0) {
      const current = await tx.stockLevel.findFirst({
        where: { sku: input.sku, location: input.location },
        select: { quantity: true },
      });
      if (!current) throw new NotFoundException('Stock level not found');
      if (current.quantity + change < 0) {
        throw new BadRequestException('Insufficient stock on hand');
      }
    }

    // ON CONFLICT must name a real unique index. The only one on this table is
    // ("tenantId", sku, location) -- the previous (sku, location) target did
    // not exist, so this statement failed outright.
    const rows = await tx.$queryRaw<StockLevelRow[]>`
      INSERT INTO stock_levels (id, "tenantId", sku, location, quantity, reserved, available, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${input.sku}, ${input.location}, ${Math.max(0, change)}, 0, ${Math.max(0, change)}, NOW(), NOW())
      ON CONFLICT ("tenantId", sku, location) DO UPDATE SET
        quantity = GREATEST(0, stock_levels.quantity + ${change}),
        available = GREATEST(0, GREATEST(0, stock_levels.quantity + ${change}) - stock_levels.reserved),
        "updatedAt" = NOW()
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;
    const updated = rows[0];
    if (!updated) throw new BadRequestException('Stock adjustment failed');

    await tx.stockMovement.create({
      data: {
        sku: input.sku,
        type,
        quantity: change,
        location: input.location,
        reason: input.reason || null,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        createdById: input.createdById,
      },
    });

    return { stockLevel: updated, type };
  }

  async adjustStock(dto: AdjustStockDto, actor?: Actor, req?: Request) {
    const change = Math.round(Number(dto.change));

    const { stockLevel, type } = await this.prisma.$transaction((tx) =>
      this.applyStockChangeWithin(tx as Prisma.TransactionClient, {
        sku: dto.sku,
        location: dto.location,
        change: dto.change,
        type: dto.type,
        reason: dto.reason,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        createdById: actor?.userId,
      }),
    );

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

  /**
   * Reserves stock inside a caller-supplied transaction.
   *
   * Split out for the same reason as `applyStockChangeWithin`: confirming a
   * sales order has to reserve every line and flip the order's status as one
   * unit. The conditional UPDATE (`available >= quantity`) is what makes it
   * safe under concurrency -- two callers racing for the last unit cannot both
   * match the predicate.
   */
  async reserveStockWithin(
    tx: Prisma.TransactionClient,
    input: {
      sku: string;
      location: string;
      quantity: number;
      reason?: string;
      referenceId?: string;
      createdById?: string;
    },
  ): Promise<StockLevelRow> {
    const quantity = Math.round(Number(input.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const tenantId = this.requireTenantId('Stock reservation');

    const rows = await tx.$queryRaw<StockLevelRow[]>`
      UPDATE stock_levels
      SET reserved = reserved + ${quantity}, available = available - ${quantity}, "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}::uuid
        AND sku = ${input.sku} AND location = ${input.location} AND available >= ${quantity}
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;

    if (rows.length === 0) {
      const existing = await tx.stockLevel.findFirst({
        where: { sku: input.sku, location: input.location },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(
          `Stock level not found for SKU "${input.sku}" at "${input.location}"`,
        );
      }
      throw new BadRequestException('Insufficient stock available');
    }

    await tx.stockMovement.create({
      data: {
        sku: input.sku,
        type: StockMovementType.RESERVE,
        quantity,
        location: input.location,
        reason: input.reason || 'Reserved',
        referenceId: input.referenceId,
        createdById: input.createdById,
      },
    });

    return rows[0];
  }

  /** Releases a reservation inside a caller-supplied transaction. */
  async releaseReservationWithin(
    tx: Prisma.TransactionClient,
    input: {
      sku: string;
      location: string;
      quantity: number;
      reason?: string;
      referenceId?: string;
      createdById?: string;
    },
  ): Promise<StockLevelRow> {
    const quantity = Math.round(Number(input.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive number');
    }

    const tenantId = this.requireTenantId('Reservation release');

    const rows = await tx.$queryRaw<StockLevelRow[]>`
      UPDATE stock_levels
      SET reserved = reserved - ${quantity}, available = available + ${quantity}, "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}::uuid
        AND sku = ${input.sku} AND location = ${input.location} AND reserved >= ${quantity}
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;

    if (rows.length === 0) {
      const existing = await tx.stockLevel.findFirst({
        where: { sku: input.sku, location: input.location },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(
          `Stock level not found for SKU "${input.sku}" at "${input.location}"`,
        );
      }
      throw new BadRequestException('Cannot release more than reserved');
    }

    await tx.stockMovement.create({
      data: {
        sku: input.sku,
        type: StockMovementType.RELEASE,
        quantity: -quantity,
        location: input.location,
        reason: input.reason || 'Released',
        referenceId: input.referenceId,
        createdById: input.createdById,
      },
    });

    return rows[0];
  }

  async reserveStock(dto: ReserveStockDto, actor?: Actor, req?: Request) {
    const quantity = Math.round(Number(dto.quantity));

    const rows = await this.prisma.$transaction((tx) =>
      this.reserveStockWithin(tx as Prisma.TransactionClient, {
        sku: dto.sku,
        location: dto.location,
        quantity: dto.quantity,
        reason: dto.reason,
        referenceId: dto.referenceId,
        createdById: actor?.userId,
      }).then((row) => [row]),
    );

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

    const rows = await this.prisma.$transaction((tx) =>
      this.releaseReservationWithin(tx as Prisma.TransactionClient, {
        sku: dto.sku,
        location: dto.location,
        quantity: dto.quantity,
        reason: dto.reason,
        referenceId: dto.referenceId,
        createdById: actor?.userId,
      }).then((row) => [row]),
    );

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

  /**
   * The factory these stock rows belong to.
   *
   * The three stock mutations below are raw SQL, and raw SQL does NOT pass
   * through the Prisma tenant extension -- nothing narrows their WHERE clause
   * for us. Without an explicit tenantId a `WHERE sku = ... AND location = ...`
   * matches the same SKU in every other factory and silently rewrites their
   * stock, so the id is threaded in by hand here and asserted before use.
   */
  private requireTenantId(operation: string): string {
    const scope = currentTenant();
    const tenantId = scope?.tenantId;
    if (!tenantId) {
      // The super admin has no factory of its own; a stock mutation has to name
      // the factory it applies to, so there is nothing sensible to write here.
      throw new BadRequestException(
        `${operation} must be performed from within a factory account`,
      );
    }
    return tenantId;
  }

  private async assertStockLevelExistsOrThrow(sku: string, location: string) {
    const stock = await this.prisma.stockLevel.findFirst({
      where: { sku, location },
      select: { id: true },
    });
    if (!stock) {
      throw new NotFoundException('Stock level not found');
    }
  }

  // ---------------------------------------------------------------- movements

  async listMovements(query: StockMovementQueryDto) {
    return this.shortCache.getOrSetJson(this.movementsCacheKey(query), 10, async () => {
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
        }),
        this.prisma.stockMovement.count({ where }),
      ]);

      // Movements no longer carry a foreign key to Product: an SKU is only
      // unique within a factory now, and a composite FK with onDelete SetNull
      // would try to null tenantId. Keeping `sku` denormalized also means the
      // movement history survives a product being deleted, which is what an
      // audit trail should do. Resolve the display names in one extra query.
      const skus = [...new Set(movements.map((m) => m.sku).filter((s): s is string => !!s))];
      const products = skus.length
        ? await this.prisma.product.findMany({
            where: { sku: { in: skus } },
            select: { sku: true, name: true },
          })
        : [];
      const nameBySku = new Map(products.map((p) => [p.sku, p.name]));

      const enriched = movements.map((m) => ({
        ...m,
        product: m.sku ? { name: nameBySku.get(m.sku) ?? null } : null,
      }));

      return paginatedResponse(enriched, page, limit, total);
    });
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
    return this.shortCache.getOrSetJson('inventory:warehouses', 60, async () => {
      const warehouses = await this.prisma.warehouse.findMany({ orderBy: { name: 'asc' } });
      return warehouses;
    });
  }

  async createWarehouse(dto: CreateWarehouseDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.warehouse.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException('Warehouse code already exists');

    const warehouse = await this.prisma.warehouse.create({
      data: { name: dto.name, code: dto.code, address: dto.address, status: 'active' },
    });

    await this.invalidateInventoryCaches();
    this.audit('inventory.warehouse.create', 'warehouse', warehouse.id, { name: warehouse.name, code: warehouse.code }, actor, req);

    return { message: 'Warehouse created successfully', warehouse };
  }

  async updateWarehouse(warehouseId: string, dto: UpdateWarehouseDto, actor?: Actor, req?: Request) {
    const existing = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!existing) throw new NotFoundException('Warehouse not found');

    if (dto.code && dto.code !== existing.code) {
      const collision = await this.prisma.warehouse.findFirst({ where: { code: dto.code } });
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

    await this.invalidateInventoryCaches();
    this.audit('inventory.warehouse.update', 'warehouse', warehouse.id, { name: warehouse.name }, actor, req);

    return { message: 'Warehouse updated successfully', warehouse };
  }

  async removeWarehouse(warehouseId: string, actor?: Actor, req?: Request) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    await this.prisma.warehouse.delete({ where: { id: warehouseId } });
    await this.invalidateInventoryCaches();
    this.audit('inventory.warehouse.delete', 'warehouse', warehouseId, { name: warehouse.name }, actor, req);

    return { message: 'Warehouse deleted successfully' };
  }
}
