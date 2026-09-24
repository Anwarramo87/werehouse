import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SnapshotService } from '../../src/backup/snapshot.service';
import { RestoreService } from '../../src/backup/restore.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';
import { RESTORE_ORDER } from '../../src/backup/snapshot.model-graph';
import { SnapshotFile } from '../../src/backup/snapshot.types';

const TEST_TIMEOUT = 180_000;

/**
 * Proves a backup round-trips against real PostgreSQL.
 *
 * Two throwaway tenants are created and dropped by this file:
 *   A — the subject of every snapshot and restore.
 *   B — a bystander that must be byte-identical at the end. B exists to catch
 *       restores that leak across factory boundaries; the `replace` path is Super
 *       Admin only, and a Super Admin's queries carry no tenant predicate of
 *       their own, so "did we clear the whole table" is a real failure mode and
 *       not a hypothetical one.
 *
 * Live data is never in reach: both tenants are created here and removed by the
 * cascade in afterAll.
 */
describe('Backup snapshot → restore round trip (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let snapshots: SnapshotService;
  let restores: RestoreService;

  const tenantA = '9e57a0de-0000-4000-8000-00000000000a';
  const tenantB = '9e57a0de-0000-4000-8000-00000000000b';
  const stamp = Date.now();

  const sku = `E2E-BK-${stamp}`;
  const skuB = `E2E-BK-B-${stamp}`;

  // More significant digits than a float carries safely. If anything in the
  // pipeline routes through Number(), these assertions fail.
  const exactPrice = '12345678.91';
  const exactCost = '9876543.21';
  const exactRate = '1234.57';

  const binaryKey = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xde, 0xad, 0xbe, 0xef]);
  const jsonMetadata = {
    nested: { list: [1, 2, 3], flag: true },
    arabic: 'قيمة',
    nullInside: null,
  };
  const fixedDate = new Date('2026-03-15T08:45:30.000Z');

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantA, bypass: false, actor: 'e2e' }, async () => await fn());
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: tenantB, bypass: false, actor: 'e2e' }, async () => await fn());
  /** Super Admin: bypass true, exactly as TenantMiddleware would set it. */
  const asRoot = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: null, bypass: true, actor: 'e2e-root' }, async () => await fn());

  const superadmin = {
    userId: '9e57a0de-0000-4000-8000-0000000000ff',
    username: 'e2e-superadmin',
    role: 'superadmin',
    roles: ['superadmin'],
    tenantId: null,
  };
  const adminA = {
    userId: '9e57a0de-0000-4000-8000-0000000000fa',
    username: 'e2e-admin-a',
    role: 'admin',
    roles: ['admin'],
    tenantId: tenantA,
  };

  let snapshot: SnapshotFile;
  let userAId: string;
  let productAId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    prisma = moduleRef.get(PrismaService);
    snapshots = moduleRef.get(SnapshotService);
    restores = moduleRef.get(RestoreService);

    await runUnscoped('e2e-backup-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, name: 'E2E Factory A', code: `E2E-A-${stamp}`, status: 'active' },
          { id: tenantB, name: 'E2E Factory B', code: `E2E-B-${stamp}`, status: 'active' },
        ],
      });
    });

    // ---- Factory A: representative data spanning the relationship graph ----
    await asA(async () => {
      const department = await prisma.department.create({
        data: { name: 'الإنتاج', manager: null, tenantId: tenantA },
      });

      const user = await prisma.user.create({
        data: {
          username: `e2e-user-${stamp}`,
          email: `e2e-${stamp}@test.local`,
          passwordHash: 'not-a-real-hash',
          status: 'active',
        },
      });
      userAId = user.id;

      // Bytes column.
      await prisma.biometricCredential.create({
        data: {
          userId: user.id,
          keyId: `key-${stamp}`,
          publicKeyDer: binaryKey,
          deviceName: 'E2E Reader',
        },
      });

      await prisma.employee.create({
        data: {
          employeeId: `E2E-EMP-${stamp}`,
          name: 'علي المُختبِر',
          hourlyRate: new Prisma.Decimal(exactRate),
          departmentId: department.id,
          userId: user.id,
        },
      });

      const product = await prisma.product.create({
        data: {
          sku,
          name: 'مادة خام للاختبار',
          category: 'raw',
          unitPrice: new Prisma.Decimal(exactPrice),
          costPrice: new Prisma.Decimal(exactCost),
          reorderLevel: 25,
          status: 'active',
          photo: null, // null must stay null, not become ''
          createdAt: fixedDate,
        },
      });
      productAId = product.id;

      await prisma.warehouse.create({
        data: { name: 'مستودع الاختبار', code: `WH-${stamp}`, status: 'active' },
      });
      await prisma.stockLevel.create({
        data: { sku, location: 'WH-E2E', quantity: 100, reserved: 10, available: 90 },
      });

      const supplier = await prisma.supplier.create({
        data: { name: 'مورّد الاختبار', email: null, status: 'active' },
      });
      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: `PO-${stamp}`,
          supplierId: supplier.id,
          status: 'sent',
          orderDate: new Date('2026-03-01T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('55555.55'),
          createdBy: user.id,
        },
      });
      await prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId: po.id,
          sku,
          quantity: 10,
          unitCost: new Prisma.Decimal('5555.55'),
        },
      });

      const customer = await prisma.customer.create({
        data: { name: 'زبون الاختبار', status: 'active' },
      });
      const so = await prisma.salesOrder.create({
        data: {
          soNumber: `SO-${stamp}`,
          customerId: customer.id,
          status: 'confirmed',
          orderDate: new Date('2026-03-02T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('77777.77'),
          createdBy: user.id,
        },
      });
      await prisma.salesOrderItem.create({
        data: { salesOrderId: so.id, sku, quantity: 3, unitPrice: new Prisma.Decimal('25925.92') },
      });

      const account = await prisma.account.create({
        data: { code: `1000-${stamp}`, name: 'الصندوق', type: 'asset' },
      });
      const entry = await prisma.journalEntry.create({
        data: {
          entryNumber: `JE-${stamp}`,
          entryDate: new Date('2026-03-03T00:00:00.000Z'),
          description: 'قيد اختبار',
          createdBy: user.id,
        },
      });
      await prisma.journalEntryLine.create({
        data: {
          journalEntryId: entry.id,
          accountId: account.id,
          debit: new Prisma.Decimal('1000.00'),
          credit: new Prisma.Decimal('0'),
        },
      });

      // Json column + timestamps.
      await prisma.notification.create({
        data: {
          type: 'ABSENT',
          severity: 'WARNING',
          title: 'إشعار اختبار',
          message: 'رسالة',
          metadata: jsonMetadata,
          dedupeKey: `dedupe-${stamp}`,
          createdAt: fixedDate,
        },
      });

      await prisma.auditLog.create({
        data: {
          action: 'e2e.seed',
          actorUsername: 'e2e',
          targetType: 'product',
          targetId: product.id,
          metadata: { seeded: true },
        },
      });
    });

    // ---- Factory B: the bystander ----
    await asB(async () => {
      await prisma.product.create({
        data: {
          sku: skuB,
          name: 'BYSTANDER',
          category: 'raw',
          unitPrice: new Prisma.Decimal('1.00'),
          costPrice: new Prisma.Decimal('1.00'),
          status: 'active',
        },
      });
      await prisma.customer.create({ data: { name: 'BYSTANDER CUSTOMER', status: 'active' } });
      await prisma.warehouse.create({
        data: { name: 'BYSTANDER WH', code: `WHB-${stamp}`, status: 'active' },
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-backup-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  // ------------------------------------------------------------------ snapshot

  describe('snapshot', () => {
    it(
      'covers all tenant-scoped models',
      async () => {
        snapshot = await asA(() => snapshots.createSnapshot({ username: 'e2e' }));

        // The catalog grows as models are added; compare it against what the
        // snapshot actually contains rather than a hard-coded count.
        expect(RESTORE_ORDER.length).toBe(Object.keys(snapshot.data).length);
        for (const model of RESTORE_ORDER) {
          expect(snapshot.data).toHaveProperty(model);
          expect(Array.isArray(snapshot.data[model])).toBe(true);
        }
        expect(Object.keys(snapshot.manifest.counts).length).toBe(RESTORE_ORDER.length);
      },
      TEST_TIMEOUT,
    );

    it(
      'row counts match the database exactly',
      async () => {
        for (const model of ['product', 'customer', 'salesOrder', 'journalEntryLine', 'employee']) {
          const dbCount = await asA(() =>
            (prisma as unknown as Record<string, { count: (a?: unknown) => Promise<number> }>)[
              model
            ].count(),
          );
          expect(snapshot.manifest.counts[model]).toBe(dbCount);
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'contains no rows belonging to the other factory',
      async () => {
        const allRows = Object.values(snapshot.data).flat();
        expect(allRows.length).toBeGreaterThan(0);

        for (const row of allRows) {
          if ('tenantId' in row && row.tenantId !== null) {
            expect(row.tenantId).toBe(tenantA);
          }
        }
        const skus = snapshot.data.product.map((p) => p.sku);
        expect(skus).toContain(sku);
        expect(skus).not.toContain(skuB);
      },
      TEST_TIMEOUT,
    );

    it(
      'carries an accurate checksum',
      async () => {
        const { checksumOf } = await import('../../src/backup/snapshot.codec');
        expect(snapshot.manifest.checksum).toHaveLength(64);
        expect(snapshot.manifest.checksum).toBe(checksumOf(snapshot.data));
      },
      TEST_TIMEOUT,
    );

    it(
      'preserves Decimal, Bytes, Json, null and timestamps on the way out',
      async () => {
        const product = snapshot.data.product.find((p) => p.sku === sku)!;
        expect(product.unitPrice).toBe(exactPrice);
        expect(product.costPrice).toBe(exactCost);
        expect(product.photo).toBeNull();
        expect(product.createdAt).toBe(fixedDate.toISOString());

        const employee = snapshot.data.employee[0];
        expect(employee.hourlyRate).toBe(exactRate);

        const credential = snapshot.data.biometricCredential[0];
        expect(credential.publicKeyDer).toEqual({ $bytes: binaryKey.toString('base64') });

        const notification = snapshot.data.notification[0];
        expect(notification.metadata).toEqual(jsonMetadata);

        const supplier = snapshot.data.supplier[0];
        expect(supplier.email).toBeNull();
      },
      TEST_TIMEOUT,
    );
  });

  // ---------------------------------------------------------------- validation

  describe('validation', () => {
    it(
      'accepts the snapshot it just produced',
      async () => {
        const report = await asA(() =>
          restores.restore(snapshot, { mode: 'validate', strategy: 'merge' }, adminA),
        );
        expect(report.valid).toBe(true);
        expect(report.errors).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      'refuses a tampered checksum and writes nothing',
      async () => {
        const tampered = JSON.parse(JSON.stringify(snapshot)) as SnapshotFile;
        tampered.data.product[0].unitPrice = '1.00';

        const report = await asA(() =>
          restores.restore(tampered, { mode: 'apply', strategy: 'merge' }, adminA),
        );

        expect(report.valid).toBe(false);
        expect(report.errors.join(' ')).toMatch(/Checksum mismatch/);

        const row = await asA(() => prisma.product.findFirst({ where: { sku } }));
        expect(row?.unitPrice.toFixed()).toBe(exactPrice);
      },
      TEST_TIMEOUT,
    );

    it(
      'refuses an unknown model that carries rows',
      async () => {
        const bad = JSON.parse(JSON.stringify(snapshot)) as SnapshotFile;
        (bad.data as Record<string, unknown[]>).somethingNew = [{ id: 'x' }];
        const { checksumOf } = await import('../../src/backup/snapshot.codec');
        bad.manifest.checksum = checksumOf(bad.data);
        bad.manifest.counts.somethingNew = 1;

        const report = await asA(() =>
          restores.restore(bad, { mode: 'apply', strategy: 'merge' }, adminA),
        );
        expect(report.valid).toBe(false);
        expect(report.errors.join(' ')).toMatch(/Unknown model "somethingNew"/);
      },
      TEST_TIMEOUT,
    );

    it(
      "refuses another factory's snapshot",
      async () => {
        const report = await asB(() =>
          restores.restore(snapshot, { mode: 'apply', strategy: 'merge' }, {
            ...adminA,
            tenantId: tenantB,
          }),
        );
        expect(report.valid).toBe(false);
        expect(report.errors.join(' ')).toMatch(/belongs to factory/);
      },
      TEST_TIMEOUT,
    );
  });

  // ------------------------------------------------------------------- dry run

  /**
   * Removes the product together with everything that references it, children
   * first. The product cannot be deleted on its own: purchase_order_items,
   * sales_order_items and stock_levels all point at it through
   * `(tenantId, sku)` with onDelete: Restrict. Deleting the whole subtree is
   * also the stronger test — restoring it again only succeeds if the parent is
   * inserted before its children.
   */
  const deleteProductSubtree = () =>
    asA(async () => {
      await prisma.salesOrderItem.deleteMany({ where: { sku } });
      await prisma.purchaseOrderItem.deleteMany({ where: { sku } });
      await prisma.stockLevel.deleteMany({ where: { sku } });
      await prisma.product.deleteMany({ where: { sku } });
    });

  const subtreeCounts = () =>
    asA(async () => ({
      product: await prisma.product.count({ where: { sku } }),
      stockLevel: await prisma.stockLevel.count({ where: { sku } }),
      purchaseOrderItem: await prisma.purchaseOrderItem.count({ where: { sku } }),
      salesOrderItem: await prisma.salesOrderItem.count({ where: { sku } }),
    }));

  describe('dry run', () => {
    it(
      'reports the work and leaves the database untouched',
      async () => {
        await deleteProductSubtree();
        const before = await subtreeCounts();
        expect(before).toEqual({
          product: 0,
          stockLevel: 0,
          purchaseOrderItem: 0,
          salesOrderItem: 0,
        });

        const report = await asA(() =>
          restores.restore(
            JSON.parse(JSON.stringify(snapshot)),
            { mode: 'dryRun', strategy: 'merge' },
            adminA,
          ),
        );

        expect(report.rolledBack).toBe(true);
        // The rows really were written inside the transaction before it was
        // abandoned — 4 subtree rows at minimum.
        expect(report.totals.created).toBeGreaterThanOrEqual(4);

        // ...and none of it survived the rollback.
        expect(await subtreeCounts()).toEqual(before);
      },
      TEST_TIMEOUT,
    );
  });

  // --------------------------------------------------------------------- merge

  describe('merge restore', () => {
    it(
      'restores the deleted subtree parent-first, with every value intact',
      async () => {
        // Still deleted from the dry-run test above.
        expect(await subtreeCounts()).toEqual({
          product: 0,
          stockLevel: 0,
          purchaseOrderItem: 0,
          salesOrderItem: 0,
        });

        const report = await asA(() =>
          restores.restore(
            JSON.parse(JSON.stringify(snapshot)),
            { mode: 'apply', strategy: 'merge' },
            adminA,
          ),
        );

        expect(report.valid).toBe(true);
        expect(report.errors).toEqual([]);

        // Children could only land if the parent was inserted first.
        expect(await subtreeCounts()).toEqual({
          product: 1,
          stockLevel: 1,
          purchaseOrderItem: 1,
          salesOrderItem: 1,
        });

        const product = await asA(() => prisma.product.findFirst({ where: { sku } }));
        expect(product).not.toBeNull();
        expect(product!.id).toBe(productAId); // id preserved, not regenerated
        expect(product!.tenantId).toBe(tenantA);
        expect(product!.name).toBe('مادة خام للاختبار');
        expect(product!.reorderLevel).toBe(25);
        expect(product!.unitPrice.toFixed()).toBe(exactPrice);
        expect(product!.costPrice.toFixed()).toBe(exactCost);
        expect(product!.photo).toBeNull();
        expect(product!.createdAt.toISOString()).toBe(fixedDate.toISOString());
      },
      TEST_TIMEOUT,
    );

    it(
      'keeps binary, JSON and relationships consistent',
      async () => {
        const credential = await asA(() =>
          prisma.biometricCredential.findFirst({ where: { keyId: `key-${stamp}` } }),
        );
        expect(Buffer.compare(Buffer.from(credential!.publicKeyDer), binaryKey)).toBe(0);
        expect(credential!.userId).toBe(userAId);

        const notification = await asA(() =>
          prisma.notification.findFirst({ where: { dedupeKey: `dedupe-${stamp}` } }),
        );
        expect(notification!.metadata).toEqual(jsonMetadata);
        expect(notification!.createdAt.toISOString()).toBe(fixedDate.toISOString());

        // Foreign keys still resolve through a join.
        const line = await asA(() =>
          prisma.journalEntryLine.findFirst({ include: { journalEntry: true, account: true } }),
        );
        expect(line?.journalEntry?.entryNumber).toBe(`JE-${stamp}`);
        expect(line?.account?.code).toBe(`1000-${stamp}`);
        expect(line!.debit.toFixed()).toBe('1000');

        const item = await asA(() =>
          prisma.salesOrderItem.findFirst({ include: { salesOrder: true } }),
        );
        expect(item?.salesOrder?.soNumber).toBe(`SO-${stamp}`);
      },
      TEST_TIMEOUT,
    );

    it(
      'is idempotent — a second apply creates nothing',
      async () => {
        const report = await asA(() =>
          restores.restore(
            JSON.parse(JSON.stringify(snapshot)),
            { mode: 'apply', strategy: 'merge' },
            adminA,
          ),
        );

        expect(report.totals.created).toBe(0);
        expect(report.totals.deleted).toBe(0);
        expect(await asA(() => prisma.product.count({ where: { sku } }))).toBe(1);
      },
      TEST_TIMEOUT,
    );
  });

  // ------------------------------------------------------------------- replace

  describe('replace protection', () => {
    it(
      'is refused for a non-superadmin',
      async () => {
        await expect(
          asA(() =>
            restores.restore(
              JSON.parse(JSON.stringify(snapshot)),
              { mode: 'apply', strategy: 'replace' },
              adminA,
            ),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
      TEST_TIMEOUT,
    );

    it(
      'is refused without the exact confirmation string',
      async () => {
        await expect(
          asRoot(() =>
            restores.restore(
              JSON.parse(JSON.stringify(snapshot)),
              { mode: 'apply', strategy: 'replace', confirm: 'yes' },
              superadmin,
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
      TEST_TIMEOUT,
    );

    it(
      'is refused for a global snapshot, which would clear every factory',
      async () => {
        const global = JSON.parse(JSON.stringify(snapshot)) as SnapshotFile;
        global.manifest.tenantId = null;

        await expect(
          asRoot(() =>
            restores.restore(
              global,
              { mode: 'apply', strategy: 'replace', confirm: 'REPLACE ALL' },
              superadmin,
            ),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
      TEST_TIMEOUT,
    );

    it(
      'replaces factory A without touching factory B',
      async () => {
        const bBefore = await asB(async () => ({
          products: await prisma.product.count(),
          customers: await prisma.customer.count(),
          warehouses: await prisma.warehouse.count(),
          sku: (await prisma.product.findFirst({ where: { sku: skuB } }))?.name,
        }));
        expect(bBefore.products).toBe(1);

        const report = await asRoot(() =>
          restores.restore(
            JSON.parse(JSON.stringify(snapshot)),
            { mode: 'apply', strategy: 'replace', confirm: `REPLACE ${tenantA}` },
            superadmin,
          ),
        );

        expect(report.valid).toBe(true);
        expect(report.totals.deleted).toBeGreaterThan(0);
        expect(report.totals.created).toBeGreaterThan(0);

        // A is intact...
        const productA = await asA(() => prisma.product.findFirst({ where: { sku } }));
        expect(productA!.unitPrice.toFixed()).toBe(exactPrice);
        expect(await asA(() => prisma.product.count())).toBe(1);

        // ...and B was never in scope. This is the regression guard for a
        // Super-Admin replace clearing every factory's tables.
        const bAfter = await asB(async () => ({
          products: await prisma.product.count(),
          customers: await prisma.customer.count(),
          warehouses: await prisma.warehouse.count(),
          sku: (await prisma.product.findFirst({ where: { sku: skuB } }))?.name,
        }));
        expect(bAfter).toEqual(bBefore);
      },
      TEST_TIMEOUT,
    );
  });

  // --------------------------------------------------------------- audit trail

  describe('audit', () => {
    it(
      'restores audit rows as ordinary data',
      async () => {
        const seeded = await asA(() => prisma.auditLog.findFirst({ where: { action: 'e2e.seed' } }));
        expect(seeded).not.toBeNull();
        expect(seeded!.metadata).toEqual({ seeded: true });
        expect(snapshot.data.auditLog.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT,
    );
  });
});
