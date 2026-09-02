import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { runUnscoped, runWithTenant } from '../src/common/tenant/tenant-context';

const T = 'd0d0d0d0-0000-4000-8000-00000000000d';
const TIMEOUT = 120_000;

/**
 * Product list sorting.
 *
 * The list was hardcoded to `createdAt desc`, so the UI could only ever reorder
 * the rows it had already downloaded. Sorting now happens in SQL across the
 * whole result set, which is what makes "cheapest product" mean the cheapest
 * product rather than the cheapest of the current page.
 */
describe('Inventory product sorting (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let inventory: InventoryService;

  const asT = <R>(fn: () => Promise<R>): Promise<R> =>
    runWithTenant({ tenantId: T, bypass: false, actor: 'e2e' }, async () => await fn());

  const namesFor = async (sortBy?: string, sortDir?: string) => {
    const res = (await asT(() =>
      inventory.listProducts({ page: 1, limit: 10, sortBy, sortDir } as never),
    )) as { data: { name: string }[] };
    return res.data.map((p) => p.name);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    inventory = moduleRef.get(InventoryService);

    await runUnscoped('e2e-sort-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: T } });
      await prisma.tenant.create({
        data: { id: T, name: 'Sorting', code: `SORT-${Date.now()}`, status: 'active' },
      });
    });

    await asT(async () => {
      await prisma.product.deleteMany({});
      await prisma.product.createMany({
        data: [
          // Distinct createdAt values: inserted in one statement they would all
          // share a timestamp, and "newest first" would then be an arbitrary
          // tie-break rather than something a test can assert.
          { sku: 'S-C', name: 'Zeta', category: 'c', unitPrice: new Prisma.Decimal(300), costPrice: new Prisma.Decimal(1), createdAt: new Date('2026-01-01T00:00:00Z') },
          { sku: 'S-A', name: 'Alpha', category: 'a', unitPrice: new Prisma.Decimal(100), costPrice: new Prisma.Decimal(1), createdAt: new Date('2026-01-02T00:00:00Z') },
          { sku: 'S-B', name: 'Mid', category: 'b', unitPrice: new Prisma.Decimal(200), costPrice: new Prisma.Decimal(1), createdAt: new Date('2026-01-03T00:00:00Z') },
        ],
      });
    });
  }, TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-sort-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: T } });
    });
    await moduleRef?.close();
  }, TIMEOUT);

  it('sorts by name ascending and descending', async () => {
    expect(await namesFor('name', 'asc')).toEqual(['Alpha', 'Mid', 'Zeta']);
    expect(await namesFor('name', 'desc')).toEqual(['Zeta', 'Mid', 'Alpha']);
  }, TIMEOUT);

  it('sorts by price, not by insertion order', async () => {
    expect(await namesFor('unitPrice', 'asc')).toEqual(['Alpha', 'Mid', 'Zeta']);
    expect(await namesFor('unitPrice', 'desc')).toEqual(['Zeta', 'Mid', 'Alpha']);
  }, TIMEOUT);

  it('sorts by sku and category', async () => {
    expect(await namesFor('sku', 'asc')).toEqual(['Alpha', 'Mid', 'Zeta']);
    expect(await namesFor('category', 'desc')).toEqual(['Zeta', 'Mid', 'Alpha']);
  }, TIMEOUT);

  it('defaults to newest first when no sort is given', async () => {
    // Unchanged behaviour: no sort given still means newest first.
    expect(await namesFor()).toEqual(['Mid', 'Alpha', 'Zeta']);
  }, TIMEOUT);

  it('keeps each sort order in its own cache entry', async () => {
    // Two orderings back to back must not serve one another's cached page.
    const asc = await namesFor('name', 'asc');
    const desc = await namesFor('name', 'desc');
    expect(asc).not.toEqual(desc);
  }, TIMEOUT);
});
