import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';
import { isTenantScoped } from '../../src/common/tenant/tenant-models';

const TEST_TIMEOUT = 180_000;
const A = 'a0a0a0a0-0000-4000-8000-00000000000a';
const B = 'b0b0b0b0-0000-4000-8000-00000000000b';

/**
 * Scalar foreign-key tenant isolation.
 *
 * Nested `connect` was already verified by the tenant extension, but the
 * equivalent written as a plain scalar -- `salesOrder.create({ customerId:
 * <another factory's customer> })` -- bypassed it entirely: the database FK
 * checked that the row existed, never whose it was. Fourteen of those relations
 * now use the tenant-composite key `(tenantId, xId)`, so Postgres itself refuses
 * the reference and no application code can forget to.
 *
 * These tests attack across the boundary for real; the guarantee is only worth
 * what the database actually enforces.
 */
describe('Scalar FK tenant isolation (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const stamp = Date.now();
  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: A, bypass: false, actor: 'e2e' }, async () => await fn());
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: B, bypass: false, actor: 'e2e' }, async () => await fn());
  const asRoot = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: null, bypass: true, actor: 'e2e-root' }, async () => await fn());

  let custA: string;
  let custB: string;
  let supB: string;
  let orderA: string;

  const soData = (extra: Record<string, unknown>) => ({
    soNumber: `SF-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'draft',
    orderDate: new Date(),
    totalAmount: new Prisma.Decimal(1),
    createdBy: A,
    ...extra,
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);

    await runUnscoped('e2e-sfk-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
      await prisma.tenant.createMany({
        data: [
          { id: A, name: 'SFK A', code: `SFA-${stamp}`, status: 'active' },
          { id: B, name: 'SFK B', code: `SFB-${stamp}`, status: 'active' },
        ],
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-sfk-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  beforeEach(async () => {
    await asA(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.customer.deleteMany({});
      custA = (await prisma.customer.create({ data: { name: 'Cust A' } })).id;
      orderA = (await prisma.salesOrder.create({ data: soData({ customerId: custA }) })).id;
    });
    await asB(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.customer.deleteMany({});
      await prisma.supplier.deleteMany({});
      custB = (await prisma.customer.create({ data: { name: 'Cust B' } })).id;
      supB = (await prisma.supplier.create({ data: { name: 'Sup B' } })).id;
    });
  }, TEST_TIMEOUT);

  // ------------------------------------------------------------------ allowed

  it(
    'allows a scalar FK to a record in the caller factory',
    async () => {
      const created = await asA(() => prisma.salesOrder.create({ data: soData({ customerId: custA }) }));
      expect(created.customerId).toBe(custA);
      expect(created.tenantId).toBe(A);
    },
    TEST_TIMEOUT,
  );

  it(
    'allows a nested connect within the caller factory',
    async () => {
      const created = await asA(() =>
        prisma.salesOrder.create({
          data: {
            ...soData({}),
            customer: { connect: { id: custA } },
          } as never,
        }),
      );
      expect(created.customerId).toBe(custA);
    },
    TEST_TIMEOUT,
  );

  // ------------------------------------------------------------------ refused

  describe('cross-factory references are refused', () => {
    it(
      'create with a foreign customerId',
      async () => {
        const before = await asA(() => prisma.salesOrder.count());
        await expect(
          asA(() => prisma.salesOrder.create({ data: soData({ customerId: custB }) })),
        ).rejects.toMatchObject({ code: 'P2003' });
        expect(await asA(() => prisma.salesOrder.count())).toBe(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'create with a foreign supplierId',
      async () => {
        await expect(
          asA(() =>
            prisma.purchaseOrder.create({
              data: {
                poNumber: `PF-${stamp}`, supplierId: supB, status: 'draft',
                orderDate: new Date(), totalAmount: new Prisma.Decimal(1), createdBy: A,
              },
            }),
          ),
        ).rejects.toMatchObject({ code: 'P2003' });
      },
      TEST_TIMEOUT,
    );

    it(
      'nested connect to a foreign customer',
      async () => {
        await expect(
          asA(() =>
            prisma.salesOrder.create({
              data: { ...soData({}), customer: { connect: { id: custB } } } as never,
            }),
          ),
        ).rejects.toMatchObject({ code: 'P2025' });
      },
      TEST_TIMEOUT,
    );

    it(
      'createMany with a foreign customerId',
      async () => {
        const before = await asA(() => prisma.salesOrder.count());
        await expect(
          asA(() =>
            prisma.salesOrder.createMany({
              data: [soData({ customerId: custA }), soData({ customerId: custB })] as never,
            }),
          ),
        ).rejects.toBeDefined();
        // All-or-nothing: the valid row must not survive the rejected batch.
        expect(await asA(() => prisma.salesOrder.count())).toBe(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'update pointing an existing order at a foreign customer',
      async () => {
        await expect(
          asA(() => prisma.salesOrder.update({ where: { id: orderA }, data: { customerId: custB } })),
        ).rejects.toMatchObject({ code: 'P2003' });

        const after = await asA(() => prisma.salesOrder.findUnique({ where: { id: orderA } }));
        expect(after!.customerId).toBe(custA);
      },
      TEST_TIMEOUT,
    );

    it(
      'updateMany pointing orders at a foreign customer',
      async () => {
        await expect(
          asA(() => prisma.salesOrder.updateMany({ where: {}, data: { customerId: custB } })),
        ).rejects.toBeDefined();

        const after = await asA(() => prisma.salesOrder.findUnique({ where: { id: orderA } }));
        expect(after!.customerId).toBe(custA);
      },
      TEST_TIMEOUT,
    );

    it(
      'upsert creating with a foreign customerId',
      async () => {
        await expect(
          asA(() =>
            prisma.salesOrder.upsert({
              where: { id: '00000000-0000-4000-8000-000000000999' },
              create: soData({ customerId: custB }) as never,
              update: {},
            }),
          ),
        ).rejects.toBeDefined();
      },
      TEST_TIMEOUT,
    );

    it(
      'inside a transaction, and the whole transaction rolls back',
      async () => {
        const before = await asA(() => prisma.salesOrder.count());

        await expect(
          asA(() =>
            prisma.$transaction(async (tx) => {
              await tx.salesOrder.create({ data: soData({ customerId: custA }) });
              await tx.salesOrder.create({ data: soData({ customerId: custB }) });
            }),
          ),
        ).rejects.toBeDefined();

        expect(await asA(() => prisma.salesOrder.count())).toBe(before);
      },
      TEST_TIMEOUT,
    );
  });

  // ------------------------------------------------------------- other rules

  it(
    'still overwrites a spoofed tenantId rather than trusting it',
    async () => {
      const created = await asA(() =>
        prisma.customer.create({ data: { name: `spoof-${stamp}`, tenantId: B } as never }),
      );
      expect(created.tenantId).toBe(A);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves relations to global models working',
    async () => {
      // Role is global: a user may reference any role regardless of factory.
      const role = await runUnscoped('e2e-sfk', () =>
        prisma.role.findFirst({ select: { id: true } }),
      );
      if (!role) return;

      const user = await asA(() =>
        prisma.user.create({
          data: {
            username: `sfk-${stamp}`,
            passwordHash: 'x',
            roleId: role.id,
          },
        }),
      );
      expect(user.roleId).toBe(role.id);
      expect(user.tenantId).toBe(A);
    },
    TEST_TIMEOUT,
  );

  it(
    'preserves the super admin bypass',
    async () => {
      const created = await asRoot(() =>
        prisma.salesOrder.create({
          data: { ...soData({ customerId: custB }), tenantId: B, createdBy: B } as never,
        }),
      );
      expect(created.tenantId).toBe(B);
      expect(created.customerId).toBe(custB);
    },
    TEST_TIMEOUT,
  );

  // ------------------------------------------------------- schema-level guard

  describe('schema guard', () => {
    /**
     * Fails if someone adds a nineteenth tenant-to-tenant relation without a
     * tenant-composite key. The four exceptions are relations whose
     * `onDelete: SetNull` would null `tenantId` along with the foreign key, which
     * a composite key cannot express -- they are covered by the extension's
     * nested-write verification instead.
     */
    const SET_NULL_EXCEPTIONS = new Set([
      'Employee.user',
      'Employee.departmentEntity',
      'PayrollReceipt.payrollRun',
      'RehireRecord.previousTermination',
    ]);

    /**
     * Relations added by the WMS extension that predate the composite-FK
     * hardening migration. They are enforced by the tenant extension at the app
     * layer (every query and write carries tenantId), but the database FK
     * itself is scalar, so an off-by-one in the extension could cross
     * factories. Kept as an exact, explicit list so this guard still fails if
     * a NEW tenant-to-tenant scalar relation appears, or when these are
     * retrofitted to (id, tenantId) composite keys and this list must shrink
     * with the schema. See SCALE_BACKLOG.md.
     */
    const TRACKED_NON_COMPOSITE = new Set([
      'AccountMapping.account',
      'BatchStockLevel.batch',
      'Customer.priceTier',
      'CycleCountItem.batch',
      'CycleCountItem.cycleCount',
      'DeliveryNote.salesInvoice',
      'DeliveryNoteItem.deliveryNote',
      'IntegrationSyncLog.connection',
      'LandedCost.purchaseInvoice',
      'Package.shipment',
      'PackageItem.package',
      'PickListItem.batch',
      'PickListItem.pickList',
      'Product.taxRate',
      'ProductPrice.priceTier',
      'PurchaseInvoice.purchaseOrder',
      'PurchaseInvoice.supplier',
      'PurchaseInvoiceItem.invoice',
      'PurchasePayment.purchaseInvoice',
      'PutawayTask.batch',
      'SalesInvoice.customer',
      'SalesInvoice.priceTier',
      'SalesInvoice.salesOrder',
      'SalesInvoiceItem.batch',
      'SalesInvoiceItem.invoice',
      'Shipment.carrier',
      'Shipment.salesInvoice',
      'StorageBin.zone',
      'WarehouseZone.warehouse',
    ]);

    it('every tenant-to-tenant relation is composite, or a documented exception', () => {
      const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8').replace(/\r/g, '');
      const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
      const offenders: string[] = [];
      let m: RegExpExecArray | null;

      while ((m = modelRe.exec(schema))) {
        const model = m[1];
        if (!isTenantScoped(model)) continue;

        const relRe = /(\w+)\s+(\w+)(\?|\[\])?\s+@relation\(([^)]*)\)/g;
        let r: RegExpExecArray | null;
        while ((r = relRe.exec(m[2]))) {
          const [, field, target, , args] = r;
          const fields = args.match(/fields:\s*\[([^\]]*)\]/);
          if (!fields || !isTenantScoped(target)) continue;

          const carriesTenant = fields[1].split(',').some((f) => f.trim() === 'tenantId');
          const key = `${model}.${field}`;
          if (!carriesTenant && !SET_NULL_EXCEPTIONS.has(key)) offenders.push(key);
        }
      }

      expect([...offenders].sort()).toEqual([...TRACKED_NON_COMPOSITE].sort());
    });

    it('the documented exceptions are still exactly the SetNull relations', () => {
      // Each exception is justified only by its onDelete: SetNull. If one is
      // ever changed to Cascade or Restrict it can carry a composite key, and it
      // should be moved out of this list rather than left unprotected.
      const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8').replace(/\r/g, '');
      const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
      const found = new Set<string>();
      let m: RegExpExecArray | null;

      while ((m = modelRe.exec(schema))) {
        const model = m[1];
        const relRe = /(\w+)\s+(\w+)(\?|\[\])?\s+@relation\(([^)]*)\)/g;
        let r: RegExpExecArray | null;
        while ((r = relRe.exec(m[2]))) {
          const key = `${model}.${r[1]}`;
          if (SET_NULL_EXCEPTIONS.has(key) && /onDelete: SetNull/.test(r[4])) found.add(key);
        }
      }

      expect([...found].sort()).toEqual([...SET_NULL_EXCEPTIONS].sort());
    });
  });
});
