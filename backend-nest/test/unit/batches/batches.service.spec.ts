import { BadRequestException, ConflictException } from '@nestjs/common';
import { BatchStatus, Prisma } from '@prisma/client';
import { BatchesService, SELLABLE_BATCH_STATUSES } from '../../../src/batches/batches.service';
import { BarcodeService } from '../../../src/common/wms/barcode.service';
import { runWithTenant } from '../../../src/common/tenant/tenant-context';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const TENANT = { tenantId: 'tenant-1', bypass: false };

interface CandidateRow {
  batchId: string;
  batchNumber: string;
  sku: string;
  location: string;
  available: number;
  unitCost: Prisma.Decimal;
  expiryDate: Date | null;
}

/**
 * FEFO decides which physical goods leave the building. Two properties carry
 * real consequences and are pinned here: the draw is ordered by expiry, and a
 * frozen batch is genuinely excluded rather than merely flagged.
 */
describe('BatchesService — allocation', () => {
  /**
   * The candidate query is raw SQL, so the fake returns rows in the order the
   * real `ORDER BY b."expiryDate" ASC NULLS LAST` would produce. What is under
   * test is how the allocator consumes that order and where it stops.
   */
  const makeService = (rows: CandidateRow[], blocked: Array<Record<string, unknown>> = []) => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      productBatch: { findMany: jest.fn().mockResolvedValue(blocked) },
    };
    return new BatchesService(
      prisma as never,
      {} as never,
      new BarcodeService(),
      {} as never,
    );
  };

  const row = (
    batchNumber: string,
    available: number,
    expiryDays: number | null,
    cost = 10,
  ): CandidateRow => ({
    batchId: `id-${batchNumber}`,
    batchNumber,
    sku: 'SKU-1',
    location: 'BIN-1',
    available,
    unitCost: D(cost),
    expiryDate: expiryDays === null ? null : new Date(Date.now() + expiryDays * 86_400_000),
  });

  it('draws from the batch expiring soonest first', async () => {
    const service = makeService([row('SOON', 100, 10), row('LATER', 100, 200)]);

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 50 }),
    );

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0].batchNumber).toBe('SOON');
    expect(plan.shortfall).toBe(0);
  });

  it('spills into the next batch when the first cannot cover the line', async () => {
    const service = makeService([row('SOON', 30, 10), row('LATER', 100, 200)]);

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 80 }),
    );

    expect(plan.allocations.map((a) => [a.batchNumber, a.quantity])).toEqual([
      ['SOON', 30],
      ['LATER', 50],
    ]);
    expect(plan.allocated).toBe(80);
    expect(plan.shortfall).toBe(0);
  });

  it('reports the shortfall instead of over-allocating', async () => {
    const service = makeService([row('ONLY', 20, 10)]);

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 100 }),
    );

    expect(plan.allocated).toBe(20);
    expect(plan.shortfall).toBe(80);
  });

  it('carries each batch cost through, so COGS reflects the lots actually drawn', async () => {
    const service = makeService([row('CHEAP', 40, 10, 6), row('DEAR', 100, 200, 9)]);

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 60 }),
    );

    const cogs = plan.allocations.reduce(
      (sum, a) => sum.plus(a.unitCost.mul(a.quantity)),
      D(0),
    );
    // 40 × 6 + 20 × 9 = 420 — not 60 × the product's average.
    expect(cogs.toString()).toBe('420');
  });

  it('explains what is being held back, not just that stock is short', async () => {
    // "No stock" and "all your stock is quarantined" call for different actions.
    const service = makeService(
      [],
      [
        {
          batchNumber: 'HELD',
          status: BatchStatus.QUARANTINE,
          quantity: 500,
          quarantineReason: 'قيد فحص الجودة',
        },
      ],
    );

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 10 }),
    );

    expect(plan.shortfall).toBe(10);
    expect(plan.blocked).toEqual([
      { batchNumber: 'HELD', status: BatchStatus.QUARANTINE, quantity: 500, reason: 'قيد فحص الجودة' },
    ]);
  });

  it('labels a frozen batch even when it carries no stored reason', async () => {
    const service = makeService(
      [],
      [{ batchNumber: 'OLD', status: BatchStatus.EXPIRED, quantity: 5, quarantineReason: null }],
    );

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 1 }),
    );

    expect(plan.blocked[0].reason).toBe('منتهية الصلاحية');
  });

  it('only ever considers sellable statuses', async () => {
    // The guarantee is structural: the query filters on this list, so a batch
    // in any other state cannot reach the allocator at all.
    expect(SELLABLE_BATCH_STATUSES).toEqual([BatchStatus.AVAILABLE, BatchStatus.NEAR_EXPIRY]);
    expect(SELLABLE_BATCH_STATUSES).not.toContain(BatchStatus.QUARANTINE);
    expect(SELLABLE_BATCH_STATUSES).not.toContain(BatchStatus.EXPIRED);
    expect(SELLABLE_BATCH_STATUSES).not.toContain(BatchStatus.REJECTED);
  });

  it('passes the requested strategy through to the caller', async () => {
    const service = makeService([row('A', 10, 5)]);

    const plan = await runWithTenant(TENANT, () =>
      service.allocate({ sku: 'SKU-1', quantity: 5, strategy: 'FIFO' }),
    );

    expect(plan.strategy).toBe('FIFO');
  });

  it('rejects a non-positive quantity', async () => {
    const service = makeService([row('A', 10, 5)]);

    await expect(
      runWithTenant(TENANT, () => service.allocate({ sku: 'SKU-1', quantity: 0 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to allocate outside a factory scope', async () => {
    // The super admin has no factory of its own; a stock draw has to name one.
    const service = makeService([row('A', 10, 5)]);

    await expect(service.allocate({ sku: 'SKU-1', quantity: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('BatchesService — consumption', () => {
  /**
   * `consumeWithin` re-checks availability with a conditional UPDATE instead of
   * trusting the earlier plan. Between proposing and consuming, another order
   * may have taken the same units.
   */
  it('fails loudly when the units disappeared between plan and commit', async () => {
    const service = new BatchesService(
      {} as never,
      {} as never,
      new BarcodeService(),
      {} as never,
    );

    const tx = {
      // Zero rows updated: the conditional predicate `available >= qty` failed.
      $executeRaw: jest.fn().mockResolvedValue(0),
      productBatch: { update: jest.fn() },
    };

    await expect(
      runWithTenant(TENANT, () =>
        service.consumeWithin(
          tx as never,
          [
            {
              batchId: 'b1',
              batchNumber: 'RACED',
              sku: 'SKU-1',
              location: 'BIN-1',
              quantity: 10,
              unitCost: D(5),
              expiryDate: null,
            },
          ],
          { reason: 'test' },
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // Nothing else may run once the guard trips.
    expect(tx.productBatch.update).not.toHaveBeenCalled();
  });
});
