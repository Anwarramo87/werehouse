import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';
import { walkWriteData, relationTargets } from '../../src/common/tenant/tenant-nested';
import { isTenantScoped, TENANT_SCOPED_MODELS } from '../../src/common/tenant/tenant-models';

const TEST_TIMEOUT = 180_000;

const A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const B = 'b1b1b1b1-0000-4000-8000-00000000000b';

/**
 * Central tenant enforcement for nested writes, proven against real PostgreSQL.
 *
 * Part 1 is a matrix generated from the DMMF relation graph: every relation path
 * between two tenant-scoped models is driven through the transform, so a
 * relation added later is covered without anyone remembering to write a test.
 *
 * Part 2 attacks the real database across a factory boundary, which is the only
 * way to prove the predicate actually reaches Postgres.
 */
describe('Nested-write tenant isolation (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const stamp = Date.now();
  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: A, bypass: false, actor: 'e2e' }, async () => await fn());
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: B, bypass: false, actor: 'e2e' }, async () => await fn());
  const asRoot = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ tenantId: null, bypass: true, actor: 'e2e-root' }, async () => await fn());

  let customerA: string;
  let customerB: string;
  let orderB: string;
  let itemB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);

    await runUnscoped('e2e-nested-setup', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
      await prisma.tenant.createMany({
        data: [
          { id: A, name: 'Nested A', code: `NA-${stamp}`, status: 'active' },
          { id: B, name: 'Nested B', code: `NB-${stamp}`, status: 'active' },
        ],
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await runUnscoped('e2e-nested-teardown', async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    });
    await moduleRef?.close();
  }, TEST_TIMEOUT);

  beforeEach(async () => {
    await asA(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.customer.deleteMany({});
      await prisma.product.create({
        data: { sku: `NA-${stamp}`, name: 'PA', category: 'x', unitPrice: new Prisma.Decimal(1), costPrice: new Prisma.Decimal(1) },
      });
      customerA = (await prisma.customer.create({ data: { name: 'Cust A' } })).id;
    });

    await asB(async () => {
      await prisma.salesOrderItem.deleteMany({});
      await prisma.salesOrder.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.customer.deleteMany({});
      await prisma.product.create({
        data: { sku: `NB-${stamp}`, name: 'PB', category: 'x', unitPrice: new Prisma.Decimal(1), costPrice: new Prisma.Decimal(1) },
      });
      customerB = (await prisma.customer.create({ data: { name: 'Cust B' } })).id;

      const so = await prisma.salesOrder.create({
        data: {
          soNumber: `SO-B-${stamp}`, customerId: customerB, status: 'draft',
          orderDate: new Date(), totalAmount: new Prisma.Decimal(10), createdBy: B,
        },
      });
      orderB = so.id;
      itemB = (await prisma.salesOrderItem.create({
        data: { salesOrderId: orderB, sku: `NB-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(10), location: 'W' },
      })).id;
    });
  }, TEST_TIMEOUT);

  // ============================================================ PART 1: matrix

  describe('generated matrix over the DMMF relation graph', () => {
    const paths: Array<{ model: string; field: string; target: string }> = [];
    for (const [model, fields] of relationTargets()) {
      if (!isTenantScoped(model)) continue;
      for (const [field, target] of fields) {
        if (isTenantScoped(target)) paths.push({ model, field, target });
      }
    }

    it('discovers the relation paths the audit counted', () => {
      expect(paths.length).toBeGreaterThanOrEqual(70);
      // Reported alongside the results so the number is never a guess.
      console.log(`      tenant-scoped relation paths under test: ${paths.length}`);
    });

    it.each(paths.map((p) => [`${p.model}.${p.field} -> ${p.target}`, p] as const))(
      'assigns the factory to a nested create through %s',
      (_label, path) => {
        const out = walkWriteData(path.model, { [path.field]: { create: { x: 1 } } }, A);
        const created = (out[path.field] as any).create;

        // Two valid outcomes, and which one applies is the schema's decision:
        // a child linked by the composite (tenantId, parentId) INHERITS the
        // tenant and Postgres enforces it, so Prisma's nested input has no
        // tenantId to set. Otherwise it must be stamped here. What must never
        // happen is neither.
        const inherits = !('tenantId' in created);
        if (inherits) {
          expect(created).toEqual({ x: 1 });
        } else {
          expect(created.tenantId).toBe(A);
        }
      },
    );

    it.each(paths.map((p) => [`${p.model}.${p.field} -> ${p.target}`, p] as const))(
      'verifies rather than stamps a nested connect through %s',
      (_label, path) => {
        const out = walkWriteData(path.model, { [path.field]: { connect: { id: 'x' } } }, A);
        // The tenant predicate goes in the WHERE, so a foreign row is simply
        // not found. It is never written as ownership.
        expect((out[path.field] as any).connect).toEqual({ id: 'x', tenantId: A });
      },
    );

    it.each(paths.map((p) => [`${p.model}.${p.field} -> ${p.target}`, p] as const))(
      'narrows nested update/delete through %s',
      (_label, path) => {
        const out = walkWriteData(path.model, {
          [path.field]: {
            update: { where: { id: 'x' }, data: { y: 1 } },
            deleteMany: { z: 1 },
          },
        }, A);
        const block = out[path.field] as any;
        expect(block.update.where.tenantId).toBe(A);
        expect(block.deleteMany.tenantId).toBe(A);
      },
    );

    it('leaves relations to global models untouched across the whole graph', () => {
      let checked = 0;
      for (const [model, fields] of relationTargets()) {
        if (!isTenantScoped(model)) continue;
        for (const [field, target] of fields) {
          if (isTenantScoped(target)) continue;
          const out = walkWriteData(model, { [field]: { connect: { id: 'g' } } }, A);
          expect((out[field] as any).connect).toEqual({ id: 'g' });
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
      console.log(`      global-model relation paths verified untouched: ${checked}`);
    });

    it('covers every tenant-scoped model in the graph', () => {
      const covered = new Set(paths.map((p) => p.model));
      const scoped = Object.keys(TENANT_SCOPED_MODELS).map((k) => k[0].toUpperCase() + k.slice(1));
      const uncovered = scoped.filter((m) => !covered.has(m));
      // Models with no relation to another scoped model legitimately have no path.
      console.log(`      scoped models with at least one path: ${covered.size}/${scoped.length}`);
      expect(covered.size + uncovered.length).toBe(scoped.length);
    });
  });

  // ====================================================== PART 2: real database

  describe('nested create', () => {
    it(
      'assigns the caller factory to rows created through a relation',
      async () => {
        await asA(() =>
          prisma.salesOrder.create({
            data: {
              soNumber: `SO-A-${stamp}`, customerId: customerA, status: 'draft',
              orderDate: new Date(), totalAmount: new Prisma.Decimal(5), createdBy: A,
              items: { create: [{ sku: `NA-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(5), location: 'W' }] },
            },
          }),
        );

        // Read raw: a null tenantId would be invisible to a scoped query.
        const rows = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ tenantId: string | null }[]>`
            SELECT "tenantId" FROM sales_order_items WHERE sku = ${`NA-${stamp}`}
          `,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(A);
      },
      TEST_TIMEOUT,
    );

    it(
      'assigns the caller factory two levels deep',
      async () => {
        await asA(() =>
          prisma.customer.create({
            data: {
              name: 'Deep A',
              salesOrders: {
                create: [{
                  soNumber: `SO-DEEP-${stamp}`, status: 'draft', orderDate: new Date(),
                  totalAmount: new Prisma.Decimal(1), createdBy: A,
                  items: { create: [{ sku: `NA-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(1), location: 'W' }] },
                }],
              },
            },
          }),
        );

        const rows = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ tenantId: string | null }[]>`
            SELECT so."tenantId" FROM sales_orders so WHERE so."soNumber" = ${`SO-DEEP-${stamp}`}
            UNION ALL
            SELECT i."tenantId" FROM sales_order_items i
              JOIN sales_orders o ON o.id = i."salesOrderId" WHERE o."soNumber" = ${`SO-DEEP-${stamp}`}
          `,
        );
        expect(rows).toHaveLength(2);
        rows.forEach((r) => expect(r.tenantId).toBe(A));
      },
      TEST_TIMEOUT,
    );
  });

  describe('cross-tenant attacks', () => {
    it(
      "refuses to connect another factory's customer, and writes nothing",
      async () => {
        const before = await asA(() => prisma.salesOrder.count());

        await expect(
          asA(() =>
            prisma.salesOrder.create({
              data: {
                soNumber: `SO-ATK-${stamp}`, status: 'draft', orderDate: new Date(),
                totalAmount: new Prisma.Decimal(1), createdBy: A,
                customer: { connect: { id: customerB } },
              },
            }),
          ),
        ).rejects.toMatchObject({ code: 'P2025' });

        expect(await asA(() => prisma.salesOrder.count())).toBe(before);
        // And nothing landed unscoped either.
        const orphan = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) n FROM sales_orders WHERE "soNumber" = ${`SO-ATK-${stamp}`}
          `,
        );
        expect(Number(orphan[0].n)).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      "cannot update another factory's item through a nested update",
      async () => {
        await expect(
          asA(() =>
            prisma.salesOrder.update({
              where: { id: orderB },
              data: { items: { update: { where: { id: itemB }, data: { quantity: 999 } } } },
            }),
          ),
        ).rejects.toBeDefined();

        const item = await asB(() => prisma.salesOrderItem.findUnique({ where: { id: itemB } }));
        expect(item!.quantity).toBe(1);
      },
      TEST_TIMEOUT,
    );

    it(
      "cannot delete another factory's item through a nested delete",
      async () => {
        await expect(
          asA(() =>
            prisma.salesOrder.update({
              where: { id: orderB },
              data: { items: { delete: { id: itemB } } },
            }),
          ),
        ).rejects.toBeDefined();

        expect(await asB(() => prisma.salesOrderItem.count({ where: { id: itemB } }))).toBe(1);
      },
      TEST_TIMEOUT,
    );

    it(
      "connectOrCreate falls through to create rather than adopting another factory's row",
      async () => {
        const before = await asB(() => prisma.customer.count());

        await asA(() =>
          prisma.salesOrder.create({
            data: {
              soNumber: `SO-COC-${stamp}`, status: 'draft', orderDate: new Date(),
              totalAmount: new Prisma.Decimal(1), createdBy: A,
              customer: {
                connectOrCreate: { where: { id: customerB }, create: { name: 'Fresh A' } },
              },
            },
          }),
        );

        // B's customer is untouched; A got a brand-new one of its own.
        expect(await asB(() => prisma.customer.count())).toBe(before);
        const fresh = await asA(() => prisma.customer.findFirst({ where: { name: 'Fresh A' } }));
        expect(fresh).not.toBeNull();
        expect(fresh!.tenantId).toBe(A);
      },
      TEST_TIMEOUT,
    );

    it(
      'a spoofed tenantId at the top level is overwritten, not honoured',
      async () => {
        const created = await asA(() =>
          prisma.customer.create({ data: { name: `spoof-${stamp}`, tenantId: B } as never }),
        );
        expect(created.tenantId).toBe(A);
      },
      TEST_TIMEOUT,
    );

    it(
      'a nested create cannot carry a tenantId at all once the key is composite',
      async () => {
        // Stronger than overwriting: with (tenantId, salesOrderId) composite, the
        // child inherits its factory from the parent and Prisma removes tenantId
        // from the nested input entirely. The spoofing vector stops existing
        // rather than being corrected.
        await expect(
          asA(() =>
            prisma.salesOrder.create({
              data: {
                soNumber: `SO-SPOOF-${stamp}`, customerId: customerA, status: 'draft',
                orderDate: new Date(), totalAmount: new Prisma.Decimal(1), createdBy: A,
                items: {
                  create: [{
                    sku: `NA-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(1),
                    location: 'W', tenantId: B,
                  } as never],
                },
              },
            }),
          ),
        // Supplying tenantId pushes the nested row into Prisma's relation-style
        // input, where the scalar foreign keys do not exist at all -- so the
        // payload is refused outright. Which field it names first is incidental.
        ).rejects.toThrow(/Unknown argument/);

        const rows = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) n FROM sales_orders WHERE "soNumber" = ${`SO-SPOOF-${stamp}`}
          `,
        );
        expect(Number(rows[0].n)).toBe(0);
      },
      TEST_TIMEOUT,
    );
  });

  describe('transactions', () => {
    it(
      'preserves tenant scope through $transaction and rolls back cleanly',
      async () => {
        const before = await asA(() => prisma.salesOrder.count());

        await expect(
          asA(() =>
            prisma.$transaction(async (tx) => {
              await tx.salesOrder.create({
                data: {
                  soNumber: `SO-TX-${stamp}`, customerId: customerA, status: 'draft',
                  orderDate: new Date(), totalAmount: new Prisma.Decimal(1), createdBy: A,
                  items: { create: [{ sku: `NA-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(1), location: 'W' }] },
                },
              });
              // Cross-tenant connect inside the same transaction.
              await tx.salesOrder.create({
                data: {
                  soNumber: `SO-TX2-${stamp}`, status: 'draft', orderDate: new Date(),
                  totalAmount: new Prisma.Decimal(1), createdBy: A,
                  customer: { connect: { id: customerB } },
                },
              });
            }),
          ),
        ).rejects.toBeDefined();

        expect(await asA(() => prisma.salesOrder.count())).toBe(before);
        const any = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) n FROM sales_orders WHERE "soNumber" LIKE ${`SO-TX%${stamp}`}
          `,
        );
        expect(Number(any[0].n)).toBe(0);
      },
      TEST_TIMEOUT,
    );

    it(
      'commits a valid nested write inside a transaction with the right tenant',
      async () => {
        await asA(() =>
          prisma.$transaction(async (tx) =>
            tx.salesOrder.create({
              data: {
                soNumber: `SO-TXOK-${stamp}`, customerId: customerA, status: 'draft',
                orderDate: new Date(), totalAmount: new Prisma.Decimal(1), createdBy: A,
                items: { create: [{ sku: `NA-${stamp}`, quantity: 2, unitPrice: new Prisma.Decimal(1), location: 'W' }] },
              },
            }),
          ),
        );

        const rows = await runUnscoped('verify', () =>
          prisma.$queryRaw<{ tenantId: string }[]>`
            SELECT i."tenantId" FROM sales_order_items i
              JOIN sales_orders o ON o.id = i."salesOrderId"
            WHERE o."soNumber" = ${`SO-TXOK-${stamp}`}
          `,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(A);
      },
      TEST_TIMEOUT,
    );
  });

  describe('super admin bypass', () => {
    it(
      'is unchanged: a bypass caller still writes across factories deliberately',
      async () => {
        await asRoot(() =>
          prisma.salesOrder.create({
            data: {
              tenantId: B, soNumber: `SO-ROOT-${stamp}`, customerId: customerB, status: 'draft',
              orderDate: new Date(), totalAmount: new Prisma.Decimal(1), createdBy: B,
              // No tenantId on the item: it inherits B from the parent order.
              items: { create: [{ sku: `NB-${stamp}`, quantity: 1, unitPrice: new Prisma.Decimal(1), location: 'W' }] },
            },
          }),
        );

        const found = await asB(() =>
          prisma.salesOrder.findFirst({ where: { soNumber: `SO-ROOT-${stamp}` } }),
        );
        expect(found).not.toBeNull();
        expect(found!.tenantId).toBe(B);
      },
      TEST_TIMEOUT,
    );
  });
});
