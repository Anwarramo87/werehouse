import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaxRateDto } from './dto/create-tax-rate.dto';
import { UpdateTaxRateDto } from './dto/update-tax-rate.dto';
import { CreatePriceTierDto } from './dto/create-price-tier.dto';
import { UpdatePriceTierDto } from './dto/update-price-tier.dto';
import { UpsertProductPriceDto } from './dto/upsert-product-price.dto';
import { QuoteDto } from './dto/quote.dto';

export interface PricedLine {
  sku: string;
  quantity: number;
  /** List price before any tier or line discount. */
  listPrice: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  priceSource: string;
}

export interface QuoteResult {
  priceTier: { id: string; code: string; name: string } | null;
  lines: PricedLine[];
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ taxes

  listTaxRates() {
    return this.prisma.taxRate.findMany({ orderBy: { code: 'asc' } });
  }

  async createTaxRate(dto: CreateTaxRateDto) {
    const existing = await this.prisma.taxRate.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Tax rate "${dto.code}" already exists`);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.taxRate.updateMany({ data: { isDefault: false } });
      return tx.taxRate.create({
        data: {
          code: dto.code,
          name: dto.name,
          rate: D(dto.rate),
          isDefault: dto.isDefault ?? false,
          isActive: dto.isActive ?? true,
        },
      });
    });
  }

  async updateTaxRate(taxRateId: string, dto: UpdateTaxRateDto) {
    const rate = await this.prisma.taxRate.findFirst({ where: { id: taxRateId } });
    if (!rate) throw new NotFoundException('Tax rate not found');

    return this.prisma.$transaction(async (tx) => {
      // Exactly one default: promoting a new one demotes the incumbent in the
      // same transaction, so a lookup never finds two and picks arbitrarily.
      if (dto.isDefault) await tx.taxRate.updateMany({ data: { isDefault: false } });
      return tx.taxRate.update({
        where: { id: taxRateId },
        data: {
          name: dto.name,
          rate: dto.rate === undefined ? undefined : D(dto.rate),
          isDefault: dto.isDefault,
          isActive: dto.isActive,
        },
      });
    });
  }

  async deleteTaxRate(taxRateId: string) {
    const inUse = await this.prisma.product.count({ where: { taxRateId } });
    if (inUse > 0) {
      throw new ConflictException(
        `Tax rate is assigned to ${inUse} product(s). Reassign them before deleting it.`,
      );
    }
    await this.prisma.taxRate.delete({ where: { id: taxRateId } });
    return { message: 'Tax rate deleted' };
  }

  // ------------------------------------------------------------------- tiers

  listPriceTiers() {
    return this.prisma.priceTier.findMany({
      orderBy: { code: 'asc' },
      include: { _count: { select: { prices: true, customers: true } } },
    });
  }

  async createPriceTier(dto: CreatePriceTierDto) {
    const existing = await this.prisma.priceTier.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Price tier "${dto.code}" already exists`);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.priceTier.updateMany({ data: { isDefault: false } });
      return tx.priceTier.create({
        data: {
          code: dto.code,
          name: dto.name,
          discountPercent: D(dto.discountPercent ?? 0),
          isDefault: dto.isDefault ?? false,
          isActive: dto.isActive ?? true,
        },
      });
    });
  }

  async updatePriceTier(tierId: string, dto: UpdatePriceTierDto) {
    const tier = await this.prisma.priceTier.findFirst({ where: { id: tierId } });
    if (!tier) throw new NotFoundException('Price tier not found');

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.priceTier.updateMany({ data: { isDefault: false } });
      return tx.priceTier.update({
        where: { id: tierId },
        data: {
          name: dto.name,
          discountPercent: dto.discountPercent === undefined ? undefined : D(dto.discountPercent),
          isDefault: dto.isDefault,
          isActive: dto.isActive,
        },
      });
    });
  }

  async deletePriceTier(tierId: string) {
    const customers = await this.prisma.customer.count({ where: { priceTierId: tierId } });
    if (customers > 0) {
      throw new ConflictException(
        `Price tier is assigned to ${customers} customer(s). Reassign them before deleting it.`,
      );
    }
    await this.prisma.priceTier.delete({ where: { id: tierId } });
    return { message: 'Price tier deleted' };
  }

  // ------------------------------------------------------------ product price

  listProductPrices(sku?: string, priceTierId?: string) {
    return this.prisma.productPrice.findMany({
      where: { ...(sku ? { sku } : {}), ...(priceTierId ? { priceTierId } : {}) },
      orderBy: [{ sku: 'asc' }, { minQuantity: 'asc' }],
      include: { priceTier: { select: { code: true, name: true } } },
    });
  }

  async upsertProductPrice(dto: UpsertProductPriceDto) {
    const [product, tier] = await Promise.all([
      this.prisma.product.findFirst({ where: { sku: dto.sku }, select: { sku: true } }),
      this.prisma.priceTier.findFirst({ where: { id: dto.priceTierId }, select: { id: true } }),
    ]);
    if (!product) throw new NotFoundException(`Product with SKU "${dto.sku}" not found`);
    if (!tier) throw new NotFoundException('Price tier not found');

    const minQuantity = dto.minQuantity ?? 1;
    const existing = await this.prisma.productPrice.findFirst({
      where: { sku: dto.sku, priceTierId: dto.priceTierId, minQuantity },
    });

    const data = {
      price: D(dto.price),
      validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
      validTo: dto.validTo ? new Date(dto.validTo) : null,
    };

    return existing
      ? this.prisma.productPrice.update({ where: { id: existing.id }, data })
      : this.prisma.productPrice.create({
          data: { sku: dto.sku, priceTierId: dto.priceTierId, minQuantity, ...data },
        });
  }

  async deleteProductPrice(priceId: string) {
    const price = await this.prisma.productPrice.findFirst({ where: { id: priceId } });
    if (!price) throw new NotFoundException('Product price not found');
    await this.prisma.productPrice.delete({ where: { id: priceId } });
    return { message: 'Product price deleted' };
  }

  // --------------------------------------------------------------- the engine

  /**
   * Prices a basket for a customer.
   *
   * Precedence, most specific first:
   *   1. an explicit line price the operator typed (an approved special deal)
   *   2. a tier price row for this SKU whose `minQuantity` the line reaches
   *   3. the tier's blanket discount off the product's list price
   *   4. the product's list price
   *
   * Tax is charged on the *discounted* amount, which is the only order that
   * matches how invoices are assessed.
   */
  async quote(dto: QuoteDto): Promise<QuoteResult> {
    if (!dto.items?.length) throw new BadRequestException('At least one line is required');

    const skus = [...new Set(dto.items.map((i) => i.sku))];

    const [products, defaultTax] = await Promise.all([
      this.prisma.product.findMany({
        where: { sku: { in: skus } },
        include: { taxRate: true },
      }),
      this.prisma.taxRate.findFirst({ where: { isDefault: true, isActive: true } }),
    ]);

    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const missing = skus.filter((sku) => !productBySku.has(sku));
    if (missing.length) {
      throw new NotFoundException(`Unknown SKU(s): ${missing.join(', ')}`);
    }

    const tier = await this.resolveTier(dto.priceTierId, dto.customerId);

    const tierPrices = tier
      ? await this.prisma.productPrice.findMany({
          where: {
            sku: { in: skus },
            priceTierId: tier.id,
            OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }],
            AND: [{ OR: [{ validTo: null }, { validTo: { gte: new Date() } }] }],
          },
          orderBy: { minQuantity: 'desc' },
        })
      : [];

    const lines: PricedLine[] = [];
    let subtotal = ZERO;
    let discountTotal = ZERO;
    let taxTotal = ZERO;

    for (const item of dto.items) {
      const product = productBySku.get(item.sku)!;
      const quantity = Math.max(1, Math.round(item.quantity));
      const listPrice = D(product.unitPrice);

      let unitPrice = listPrice;
      let priceSource = 'list';

      // Best qualifying quantity break: rows are ordered descending, so the
      // first whose threshold the line reaches is the deepest one it earns.
      const break_ = tierPrices.find((p) => p.sku === item.sku && quantity >= p.minQuantity);
      if (break_) {
        unitPrice = D(break_.price);
        priceSource = `tier:${tier?.code}:qty>=${break_.minQuantity}`;
      } else if (tier && !D(tier.discountPercent).isZero()) {
        unitPrice = listPrice
          .mul(HUNDRED.minus(D(tier.discountPercent)))
          .div(HUNDRED)
          .toDecimalPlaces(2);
        priceSource = `tier:${tier.code}:${tier.discountPercent}%`;
      }

      if (item.unitPrice !== undefined) {
        unitPrice = D(item.unitPrice);
        priceSource = 'manual';
      }

      const gross = unitPrice.mul(quantity);

      const linePercent = D(item.discountPercent ?? 0);
      const percentDiscount = gross.mul(linePercent).div(HUNDRED);
      const absoluteDiscount = D(item.discountAmount ?? 0);
      const discountAmount = percentDiscount.plus(absoluteDiscount).toDecimalPlaces(2);

      if (discountAmount.greaterThan(gross)) {
        throw new BadRequestException(
          `Discount on ${item.sku} (${discountAmount}) exceeds the line value (${gross})`,
        );
      }

      const lineSubtotal = gross.minus(discountAmount);

      const rate =
        item.taxRate !== undefined
          ? D(item.taxRate)
          : product.taxRate
            ? D(product.taxRate.rate)
            : defaultTax
              ? D(defaultTax.rate)
              : ZERO;

      const taxAmount = lineSubtotal.mul(rate).div(HUNDRED).toDecimalPlaces(2);
      const lineTotal = lineSubtotal.plus(taxAmount);

      subtotal = subtotal.plus(gross);
      discountTotal = discountTotal.plus(discountAmount);
      taxTotal = taxTotal.plus(taxAmount);

      lines.push({
        sku: item.sku,
        quantity,
        listPrice,
        unitPrice,
        discountPercent: linePercent,
        discountAmount,
        taxRate: rate,
        taxAmount,
        lineSubtotal,
        lineTotal,
        priceSource,
      });
    }

    return {
      priceTier: tier ? { id: tier.id, code: tier.code, name: tier.name } : null,
      lines,
      subtotal,
      discountAmount: discountTotal,
      taxAmount: taxTotal,
      total: subtotal.minus(discountTotal).plus(taxTotal),
    };
  }

  /** Explicit tier wins; otherwise the customer's own; otherwise the default. */
  async resolveTier(priceTierId?: string, customerId?: string) {
    if (priceTierId) {
      const tier = await this.prisma.priceTier.findFirst({
        where: { id: priceTierId, isActive: true },
      });
      if (!tier) throw new NotFoundException('Price tier not found or inactive');
      return tier;
    }

    if (customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: customerId },
        include: { priceTier: true },
      });
      if (customer?.priceTier?.isActive) return customer.priceTier;
    }

    return this.prisma.priceTier.findFirst({ where: { isDefault: true, isActive: true } });
  }

  /** Seeds the tiers and tax rate a fresh factory needs to invoice at all. */
  async seedDefaults() {
    const created: string[] = [];

    const tiers = [
      { code: 'RETAIL', name: 'مفرق', discountPercent: 0, isDefault: true },
      { code: 'WHOLESALE', name: 'جملة', discountPercent: 15, isDefault: false },
      { code: 'DISTRIBUTOR', name: 'موزّع', discountPercent: 25, isDefault: false },
    ];
    for (const tier of tiers) {
      const existing = await this.prisma.priceTier.findFirst({ where: { code: tier.code } });
      if (existing) continue;
      await this.prisma.priceTier.create({
        data: { ...tier, discountPercent: D(tier.discountPercent) },
      });
      created.push(`tier:${tier.code}`);
    }

    const existingTax = await this.prisma.taxRate.findFirst({ where: { code: 'VAT' } });
    if (!existingTax) {
      await this.prisma.taxRate.create({
        data: { code: 'VAT', name: 'ضريبة القيمة المضافة', rate: D(0), isDefault: true },
      });
      created.push('tax:VAT');
    }

    return { message: created.length ? 'Defaults seeded' : 'Defaults already present', created };
  }
}
