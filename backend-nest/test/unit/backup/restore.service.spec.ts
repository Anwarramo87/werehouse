import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { runWithTenant } from '../../../src/common/tenant/tenant-context';
import { RestoreService } from '../../../src/backup/restore.service';
import { checksumOf } from '../../../src/backup/snapshot.codec';
import { RESTORE_ORDER } from '../../../src/backup/snapshot.model-graph';
import { SNAPSHOT_FORMAT_VERSION, SnapshotFile } from '../../../src/backup/snapshot.types';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

/** Builds a structurally valid snapshot with a correct checksum and counts. */
function makeSnapshot(
  data: Record<string, Record<string, unknown>[]>,
  overrides: Partial<SnapshotFile['manifest']> = {},
): SnapshotFile {
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  return {
    manifest: {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      createdAt: '2026-08-30T00:00:00.000Z',
      tenantId: TENANT,
      tenantName: 'Factory One',
      schemaVersion: '20260823190000_multi_tenancy',
      createdBy: 'superadmin',
      modelOrder: [...RESTORE_ORDER],
      counts,
      checksum: checksumOf(data),
      ...overrides,
    },
    data,
  };
}

type DelegateMock = {
  findMany: jest.Mock;
  createMany: jest.Mock;
  deleteMany: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

function makeDelegate(existingRows: Record<string, unknown>[] = []): DelegateMock {
  return {
    findMany: jest.fn().mockResolvedValue(existingRows),
    createMany: jest.fn().mockImplementation(({ data }) => ({ count: data.length })),
    deleteMany: jest.fn().mockResolvedValue({ count: existingRows.length }),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(existingRows.length),
  };
}

describe('RestoreService', () => {
  let service: RestoreService;
  let tx: Record<string, DelegateMock>;
  let transactionCallCount: number;

  const superadmin = { userId: 'u1', username: 'root', role: 'superadmin', roles: ['superadmin'] };
  const admin = { userId: 'u2', username: 'manager', role: 'admin', roles: ['admin'], tenantId: TENANT };

  const prismaMock = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ migration_name: '20260823190000_multi_tenancy' }]),
    $transaction: jest.fn(),
  };

  const asTenant = <T>(fn: () => Promise<T>, tenantId: string | null = TENANT, bypass = false) =>
    runWithTenant({ tenantId, bypass, actor: 'test' }, fn);

  beforeEach(async () => {
    jest.clearAllMocks();
    transactionCallCount = 0;

    tx = {};
    for (const model of RESTORE_ORDER) tx[model] = makeDelegate();

    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { migration_name: '20260823190000_multi_tenancy' },
    ]);
    // Mirrors Prisma: the callback runs, and anything it throws aborts the
    // transaction and propagates. Nothing is committed on the throw path.
    prismaMock.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      transactionCallCount += 1;
      return fn(tx);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [RestoreService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get(RestoreService);
  });

  // ------------------------------------------------------------- validation

  describe('validate mode', () => {
    it('accepts a well-formed snapshot and touches nothing', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1', sku: 'A' }] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.valid).toBe(true);
      expect(report.errors).toEqual([]);
      expect(transactionCallCount).toBe(0);
      expect(tx.product.createMany).not.toHaveBeenCalled();
    });

    it('rejects a modified file via the checksum', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1', sku: 'A' }] });
      snapshot.data.product[0].sku = 'TAMPERED';

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/Checksum mismatch/);
    });

    it('rejects an unsupported format version', async () => {
      const snapshot = makeSnapshot({ product: [] }, { formatVersion: 99 });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.errors.join(' ')).toMatch(/Unsupported snapshot format version 99/);
    });

    it('refuses to drop rows belonging to an unknown model', async () => {
      const data = { product: [], somethingNew: [{ id: 'x' }] };
      const snapshot = makeSnapshot(data);

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/Unknown model "somethingNew" carries 1 rows/);
    });

    it('tolerates an unknown model that carries nothing', async () => {
      const snapshot = makeSnapshot({ product: [], legacyThing: [] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.valid).toBe(true);
      expect(report.warnings.join(' ')).toMatch(/Unknown model "legacyThing"/);
    });

    it('refuses a snapshot carrying global models', async () => {
      const snapshot = makeSnapshot({ role: [{ id: 'r1', name: 'admin' }] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.errors.join(' ')).toMatch(/global model "role"/);
    });

    it('rejects rows with no id, which could not be matched', async () => {
      const snapshot = makeSnapshot({ product: [{ sku: 'no-id' }] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.errors.join(' ')).toMatch(/row 0 has no string `id`/);
    });

    it('catches a manifest count that disagrees with the payload', async () => {
      const data = { product: [{ id: 'p1' }] };
      const snapshot = makeSnapshot(data);
      snapshot.manifest.counts.product = 5;

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.errors.join(' ')).toMatch(/declares 5 rows .* carries 1/);
    });

    it('warns when the snapshot predates the current migration', async () => {
      prismaMock.$queryRawUnsafe.mockResolvedValue([{ migration_name: '20260901_add_manufacturing' }]);
      const snapshot = makeSnapshot({ product: [] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'validate', strategy: 'merge' }, admin),
      );

      expect(report.warnings.join(' ')).toMatch(/taken at migration .* database is at/);
    });
  });

  // ------------------------------------------------------- tenant boundaries

  describe('tenant isolation', () => {
    it("refuses another factory's snapshot", async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] }, { tenantId: OTHER_TENANT });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin),
      );

      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/belongs to factory .* you are signed in to/);
      expect(transactionCallCount).toBe(0);
    });

    it('refuses a global snapshot for a tenant-scoped caller', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] }, { tenantId: null });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin),
      );

      expect(report.errors.join(' ')).toMatch(/Only the Super Admin can restore it/);
    });

    it('lets the super admin restore any snapshot', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] }, { tenantId: OTHER_TENANT });

      const report = await asTenant(
        () => service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, superadmin),
        null,
        true,
      );

      expect(report.valid).toBe(true);
      expect(transactionCallCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------ dry run

  describe('dryRun', () => {
    it('performs the real writes and then rolls back', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1', sku: 'A' }] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'dryRun', strategy: 'merge' }, admin),
      );

      // The writes really happened inside the transaction...
      expect(tx.product.createMany).toHaveBeenCalled();
      // ...and the transaction was abandoned rather than committed.
      expect(report.rolledBack).toBe(true);
      expect(report.mode).toBe('dryRun');
      expect(report.totals.created).toBe(1);
    });

    it('reports the same counts a subsequent apply would produce', async () => {
      const snapshot = makeSnapshot({
        product: [{ id: 'p1' }, { id: 'p2' }],
        customer: [{ id: 'c1' }],
      });

      const dry = await asTenant(() =>
        service.restore(snapshot, { mode: 'dryRun', strategy: 'merge' }, admin),
      );

      jest.clearAllMocks();
      for (const model of RESTORE_ORDER) tx[model] = makeDelegate();
      prismaMock.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
        fn(tx),
      );
      prismaMock.$queryRawUnsafe.mockResolvedValue([
        { migration_name: '20260823190000_multi_tenancy' },
      ]);

      const applied = await asTenant(() =>
        service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin),
      );

      expect(applied.totals).toEqual(dry.totals);
      expect(applied.rolledBack).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------- merge

  describe('merge strategy', () => {
    it('creates rows that are absent and updates rows that exist', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1', sku: 'A' }, { id: 'p2', sku: 'B' }] });
      // p1 already exists; p2 does not.
      tx.product.findMany.mockResolvedValue([{ id: 'p1' }]);

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin),
      );

      const product = report.perModel.find((m) => m.model === 'product');
      expect(product).toMatchObject({ inSnapshot: 2, existing: 1, created: 1, updated: 1 });

      expect(tx.product.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [{ id: 'p2', sku: 'B' }], skipDuplicates: true }),
      );
      expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { sku: 'A' } });
    });

    it('never deletes anything', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      const report = await asTenant(() =>
        service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin),
      );

      for (const model of RESTORE_ORDER) {
        expect(tx[model].deleteMany).not.toHaveBeenCalled();
      }
      expect(report.totals.deleted).toBe(0);
    });

    it('writes parents before children', async () => {
      const order: string[] = [];
      for (const model of ['product', 'stockLevel'] as const) {
        tx[model].createMany.mockImplementation(({ data }: { data: unknown[] }) => {
          order.push(model);
          return { count: data.length };
        });
      }

      const snapshot = makeSnapshot({
        stockLevel: [{ id: 's1', sku: 'A' }],
        product: [{ id: 'p1', sku: 'A' }],
      });

      await asTenant(() => service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin));

      expect(order).toEqual(['product', 'stockLevel']);
    });
  });

  // ------------------------------------------------------------------ replace

  describe('replace strategy', () => {
    it('is refused for anyone below the super admin', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      await expect(
        asTenant(() => service.restore(snapshot, { mode: 'apply', strategy: 'replace' }, admin)),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(transactionCallCount).toBe(0);
    });

    it('requires an exact confirmation string on apply', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      await expect(
        asTenant(
          () =>
            service.restore(
              snapshot,
              { mode: 'apply', strategy: 'replace', confirm: 'yes please' },
              superadmin,
            ),
          null,
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not require confirmation for a dry run', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      const report = await asTenant(
        () => service.restore(snapshot, { mode: 'dryRun', strategy: 'replace' }, superadmin),
        null,
        true,
      );

      expect(report.rolledBack).toBe(true);
    });

    it('clears children before parents, then inserts parents before children', async () => {
      const sequence: string[] = [];
      for (const model of ['product', 'stockLevel'] as const) {
        tx[model].deleteMany.mockImplementation(() => {
          sequence.push(`delete:${model}`);
          return { count: 1 };
        });
        tx[model].createMany.mockImplementation(({ data }: { data: unknown[] }) => {
          sequence.push(`insert:${model}`);
          return { count: data.length };
        });
      }

      const snapshot = makeSnapshot({
        product: [{ id: 'p1' }],
        stockLevel: [{ id: 's1' }],
      });

      await asTenant(
        () =>
          service.restore(
            snapshot,
            { mode: 'apply', strategy: 'replace', confirm: `REPLACE ${TENANT}` },
            superadmin,
          ),
        null,
        true,
      );

      expect(sequence).toEqual([
        'delete:stockLevel',
        'delete:product',
        'insert:product',
        'insert:stockLevel',
      ]);
    });

    it('scopes every delete to the snapshot tenant, never the whole table', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }], customer: [{ id: 'c1' }] });

      await asTenant(
        () =>
          service.restore(
            snapshot,
            { mode: 'apply', strategy: 'replace', confirm: `REPLACE ${TENANT}` },
            superadmin,
          ),
        null,
        true,
      );

      // Regression guard. `replace` is superadmin-only, and a superadmin runs
      // with bypass:true — the tenant extension adds no predicate for them. A
      // bare deleteMany({}) here would empty the table for every factory.
      for (const model of ['product', 'customer']) {
        expect(tx[model].deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
        expect(tx[model].deleteMany).not.toHaveBeenCalledWith({});
      }
    });

    it('refuses a global snapshot, which would clear every factory at once', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] }, { tenantId: null });

      await expect(
        asTenant(
          () =>
            service.restore(
              snapshot,
              { mode: 'apply', strategy: 'replace', confirm: 'REPLACE ALL' },
              superadmin,
            ),
          null,
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      for (const model of RESTORE_ORDER) {
        expect(tx[model].deleteMany).not.toHaveBeenCalled();
      }
    });

    it('scopes the merge existence check to the snapshot tenant', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      await asTenant(
        () => service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, superadmin),
        null,
        true,
      );

      expect(tx.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['p1'] }, tenantId: TENANT },
        }),
      );
    });

    it('only clears models the snapshot actually covers', async () => {
      const snapshot = makeSnapshot({ product: [{ id: 'p1' }] });

      await asTenant(
        () =>
          service.restore(
            snapshot,
            { mode: 'apply', strategy: 'replace', confirm: `REPLACE ${TENANT}` },
            superadmin,
          ),
        null,
        true,
      );

      expect(tx.product.deleteMany).toHaveBeenCalled();
      // A snapshot that says nothing about payroll must not wipe payroll.
      expect(tx.payrollRun.deleteMany).not.toHaveBeenCalled();
      expect(tx.employee.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ failure

  describe('failure handling', () => {
    it('propagates a mid-restore failure so the transaction aborts', async () => {
      const snapshot = makeSnapshot({
        product: [{ id: 'p1' }],
        customer: [{ id: 'c1' }],
      });
      tx.customer.createMany.mockRejectedValue(new Error('constraint violation'));

      await expect(
        asTenant(() => service.restore(snapshot, { mode: 'apply', strategy: 'merge' }, admin)),
      ).rejects.toThrow('constraint violation');
    });
  });
});
