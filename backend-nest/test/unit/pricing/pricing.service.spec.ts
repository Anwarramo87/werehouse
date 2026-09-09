import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService } from '../../../src/pricing/pricing.service';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/**
 * The pricing engine decides what a customer is charged, so its precedence
 * rules and its tax-after-discount ordering are pinned here. Getting either
 * wrong produces invoices that are quietly, systematically wrong.
 */
describe('PricingService', () => {
  const RETAIL = { id: 'tier-retail', code: 'RETAIL', name: 'مفرق', discountPercent: D(0), isActive: true, isDefault: true };
  const WHOLESALE = { id: 'tier-ws', code: 'WHOLESALE', name: 'جملة', discountPercent: D(15), isActive: true, isDefault: false };

  const makeService = (opts: {
    tier?: typeof WHOLESALE | null;
    tierPrices?: Array<{ sku: string; priceTierId: string; price: Prisma.Decimal; minQuantity: number }>;
    productTaxRate?: number | null;
    defaultTaxRate?: number | null;
    knownSkus?: string[];
  }) => {
    const skus = opts.knownSkus ?? ['SKU-1'];

    const prisma = {
      product: {
        findMany: jest.fn(async ({ where }: { where: { sku: { in: string[] } } }) =>
          where.sku.in
            .filter((sku) => skus.includes(sku))
            .map((sku) => ({
              sku,
              unitPrice: D(1000),
              taxRate:
                opts.productTaxRate === null || opts.productTaxRate === undefined
                  ? null
                  : { rate: D(opts.productTaxRate) },
            })),
        ),
      },
      taxRate: {
        findFirst: jest.fn(async () =>
          opts.defaultTaxRate === null || opts.defaultTaxRate === undefined
            ? null
            : { rate: D(opts.defaultTaxRate) },
        ),
      },
      priceTier: { findFirst: jest.fn(async () => opts.tier ?? null) },
      customer: { findFirst: jest.fn(async () => null) },
      productPrice: { findMany: jest.fn(async () => opts.tierPrices ?? []) },
    };

    return new PricingService(prisma as never);
  };

  describe('quote — price precedence', () => {
    it('uses the list price when no tier applies', async () => {
      const service = makeService({ tier: null });

      const quote = await service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }] });

      expect(quote.lines[0].unitPrice.toString()).toBe('1000');
      expect(quote.lines[0].priceSource).toBe('list');
    });

    it("applies the tier's blanket discount when it has no explicit price", async () => {
      const service = makeService({ tier: WHOLESALE });

      const quote = await service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }] });

      expect(quote.lines[0].unitPrice.toString()).toBe('850');
      expect(quote.lines[0].priceSource).toBe('tier:WHOLESALE:15%');
    });

    it('prefers an explicit tier price over the blanket discount', async () => {
      const service = makeService({
        tier: WHOLESALE,
        tierPrices: [{ sku: 'SKU-1', priceTierId: WHOLESALE.id, price: D(700), minQuantity: 1 }],
      });

      const quote = await service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }] });

      expect(quote.lines[0].unitPrice.toString()).toBe('700');
      expect(quote.lines[0].priceSource).toContain('qty>=1');
    });

    it('takes the deepest quantity break the line qualifies for', async () => {
      // Rows arrive ordered by minQuantity descending, as the query returns them.
      const service = makeService({
        tier: WHOLESALE,
        tierPrices: [
          { sku: 'SKU-1', priceTierId: WHOLESALE.id, price: D(600), minQuantity: 100 },
          { sku: 'SKU-1', priceTierId: WHOLESALE.id, price: D(700), minQuantity: 50 },
          { sku: 'SKU-1', priceTierId: WHOLESALE.id, price: D(800), minQuantity: 1 },
        ],
      });

      const small = await service.quote({ items: [{ sku: 'SKU-1', quantity: 10 }] });
      expect(small.lines[0].unitPrice.toString()).toBe('800');

      const medium = await service.quote({ items: [{ sku: 'SKU-1', quantity: 60 }] });
      expect(medium.lines[0].unitPrice.toString()).toBe('700');

      const large = await service.quote({ items: [{ sku: 'SKU-1', quantity: 150 }] });
      expect(large.lines[0].unitPrice.toString()).toBe('600');
    });

    it('lets an explicit line price override every rule', async () => {
      const service = makeService({
        tier: WHOLESALE,
        tierPrices: [{ sku: 'SKU-1', priceTierId: WHOLESALE.id, price: D(700), minQuantity: 1 }],
      });

      const quote = await service.quote({
        items: [{ sku: 'SKU-1', quantity: 1, unitPrice: 123 }],
      });

      expect(quote.lines[0].unitPrice.toString()).toBe('123');
      expect(quote.lines[0].priceSource).toBe('manual');
    });
  });

  describe('quote — tax and discount ordering', () => {
    it('charges tax on the discounted amount, not the gross', async () => {
      // 1000 gross, 10% line discount => 900 net, 10% tax => 90, total 990.
      const service = makeService({ tier: RETAIL, productTaxRate: 10 });

      const quote = await service.quote({
        items: [{ sku: 'SKU-1', quantity: 1, discountPercent: 10 }],
      });

      const line = quote.lines[0];
      expect(line.discountAmount.toString()).toBe('100');
      expect(line.lineSubtotal.toString()).toBe('900');
      expect(line.taxAmount.toString()).toBe('90');
      expect(line.lineTotal.toString()).toBe('990');
    });

    it('adds a percentage and an absolute discount together', async () => {
      const service = makeService({ tier: RETAIL, productTaxRate: 0 });

      const quote = await service.quote({
        items: [{ sku: 'SKU-1', quantity: 1, discountPercent: 10, discountAmount: 50 }],
      });

      expect(quote.lines[0].discountAmount.toString()).toBe('150');
    });

    it("falls back to the factory's default tax when the product has none", async () => {
      const service = makeService({ tier: RETAIL, productTaxRate: null, defaultTaxRate: 11 });

      const quote = await service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }] });

      expect(quote.lines[0].taxRate.toString()).toBe('11');
      expect(quote.lines[0].taxAmount.toString()).toBe('110');
    });

    it('charges no tax when neither the product nor the factory defines one', async () => {
      const service = makeService({ tier: RETAIL, productTaxRate: null, defaultTaxRate: null });

      const quote = await service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }] });

      expect(quote.lines[0].taxAmount.toString()).toBe('0');
    });

    it('rejects a discount larger than the line itself', async () => {
      const service = makeService({ tier: RETAIL });

      await expect(
        service.quote({ items: [{ sku: 'SKU-1', quantity: 1, discountAmount: 5000 }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('totals the basket from its lines', async () => {
      const service = makeService({
        tier: RETAIL,
        productTaxRate: 10,
        knownSkus: ['SKU-1', 'SKU-2'],
      });

      const quote = await service.quote({
        items: [
          { sku: 'SKU-1', quantity: 2 },
          { sku: 'SKU-2', quantity: 1, discountPercent: 50 },
        ],
      });

      // 2000 + 1000 gross, 500 discount, tax 10% of 2500 = 250.
      expect(quote.subtotal.toString()).toBe('3000');
      expect(quote.discountAmount.toString()).toBe('500');
      expect(quote.taxAmount.toString()).toBe('250');
      expect(quote.total.toString()).toBe('2750');
    });
  });

  describe('quote — input validation', () => {
    it('names the unknown SKUs rather than failing vaguely', async () => {
      const service = makeService({ tier: RETAIL, knownSkus: ['SKU-1'] });

      await expect(
        service.quote({ items: [{ sku: 'SKU-1', quantity: 1 }, { sku: 'GHOST', quantity: 1 }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an empty basket', async () => {
      const service = makeService({ tier: RETAIL });
      await expect(service.quote({ items: [] })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
