import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginatedResponse, paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { CreateProductDto } from './dto/create-product.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ReserveStockDto } from './dto/reserve-stock.dto';
import { InventoryProductsQueryDto } from './dto/inventory-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ShortCacheService } from '../common/cache/short-cache.service';

type LowStockAlert = {
  sku: string;
  name: string;
  available: number;
  reorderLevel: number;
};

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

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private async invalidateInventoryCaches() {
    await Promise.all([
      this.shortCache.invalidatePrefix('inventory:stats'),
      this.shortCache.invalidatePrefix('inventory:alerts:low-stock'),
    ]);
  }

  async listProducts(query: InventoryProductsQueryDto) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.ProductWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { sku: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginatedResponse(products, page, limit, total);
  }

  async createProduct(dto: CreateProductDto) {
    const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
    if (existing) throw new BadRequestException('SKU already exists');

    const product = await this.prisma.product.create({
      data: {
        ...dto,
        unitPrice: new Prisma.Decimal(dto.unitPrice),
        costPrice: new Prisma.Decimal(dto.costPrice),
        reorderLevel: dto.reorderLevel || 10,
        status: 'active',
      },
    });

    await this.invalidateInventoryCaches();

    return { message: 'Product created successfully', product };
  }

  async getProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    const stockLevels = await this.prisma.stockLevel.findMany({ where: { sku: product.sku } });
    return { product, stockLevels };
  }

  async updateProduct(productId: string, dto: UpdateProductDto) {
    const { sku: _ignoredSku, ...safeDto } = dto;

    const existing = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!existing) throw new NotFoundException('Product not found');

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...safeDto,
        unitPrice:
          safeDto.unitPrice !== undefined ? new Prisma.Decimal(safeDto.unitPrice) : undefined,
        costPrice:
          safeDto.costPrice !== undefined ? new Prisma.Decimal(safeDto.costPrice) : undefined,
        reorderLevel: safeDto.reorderLevel,
        status: safeDto.status,
      },
    });

    await this.invalidateInventoryCaches();

    return { message: 'Product updated successfully', product };
  }

  async stockBySku(sku: string) {
    const stockLevels = await this.prisma.stockLevel.findMany({ where: { sku } });
    return { sku, locations: stockLevels.length, stockLevels };
  }

  async adjustStock(dto: AdjustStockDto) {
    const rows = await this.prisma.$queryRaw<StockLevelRow[]>`
      INSERT INTO stock_levels (id, sku, location, quantity, reserved, available, "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid(),
        ${dto.sku},
        ${dto.location},
        GREATEST(0, ${dto.change}),
        0,
        GREATEST(0, ${dto.change}),
        NOW(),
        NOW()
      )
      ON CONFLICT (sku, location) DO UPDATE SET
        quantity = GREATEST(0, stock_levels.quantity + ${dto.change}),
        available = GREATEST(
          0,
          GREATEST(0, stock_levels.quantity + ${dto.change}) - stock_levels.reserved
        ),
        "updatedAt" = NOW()
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;

    const updated = rows[0];
    if (!updated) {
      throw new BadRequestException('Stock adjustment failed');
    }

    await this.invalidateInventoryCaches();

    return { message: 'Stock adjusted successfully', stockLevel: updated };
  }

  async reserveStock(dto: ReserveStockDto) {
    const rows = await this.prisma.$queryRaw<StockLevelRow[]>`
      UPDATE stock_levels
      SET
        reserved = reserved + ${dto.quantity},
        available = available - ${dto.quantity},
        "updatedAt" = NOW()
      WHERE sku = ${dto.sku}
        AND location = ${dto.location}
        AND available >= ${dto.quantity}
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;

    if (rows.length === 0) {
      await this.assertStockLevelExistsOrThrow(dto.sku, dto.location);
      throw new BadRequestException('Insufficient stock available');
    }

    await this.invalidateInventoryCaches();

    return { message: 'Stock reserved successfully', stockLevel: rows[0] };
  }

  async releaseReservation(dto: ReserveStockDto) {
    const rows = await this.prisma.$queryRaw<StockLevelRow[]>`
      UPDATE stock_levels
      SET
        reserved = reserved - ${dto.quantity},
        available = available + ${dto.quantity},
        "updatedAt" = NOW()
      WHERE sku = ${dto.sku}
        AND location = ${dto.location}
        AND reserved >= ${dto.quantity}
      RETURNING id, sku, location, quantity, reserved, available, "createdAt", "updatedAt"
    `;

    if (rows.length === 0) {
      await this.assertStockLevelExistsOrThrow(dto.sku, dto.location);
      throw new BadRequestException('Cannot release more than reserved');
    }

    await this.invalidateInventoryCaches();

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
        }));

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
      const [totalProducts, stock] = await Promise.all([
        this.prisma.product.count(),
        this.prisma.stockLevel.findMany(),
      ]);

      return {
        totalProducts,
        totalStockRecords: stock.length,
        totalQuantity: stock.reduce((s: number, x: (typeof stock)[number]) => s + x.quantity, 0),
        totalReserved: stock.reduce((s: number, x: (typeof stock)[number]) => s + x.reserved, 0),
      };
    });
  }

  async deleteProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    // delete related stock levels first
    await this.prisma.stockLevel.deleteMany({ where: { sku: product.sku } });

    await this.prisma.product.delete({ where: { id: productId } });

    await this.invalidateInventoryCaches();

    return { message: 'Product deleted successfully' };
  }
}
