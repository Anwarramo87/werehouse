import { EntitlementsService } from '../../../../src/common/entitlements/entitlements.service';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';

const cacheStub = () =>
  ({ getJson: jest.fn(async () => null), setJson: jest.fn(async () => undefined) }) as never;

const missingTable = () =>
  Object.assign(new Error('relation "tenant_entitlements" does not exist'), { code: '42P01' });

const outage = () =>
  Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1001' });

/*
 * The code can reach production before its migration does — this project's
 * Railway preDeployCommand has silently failed to run before, leaving the
 * database two migrations behind the deployed code for days.
 *
 * The reported symptom: GET /admin/tenants answered 500, because listing
 * factories joined a `tenant_entitlements` table that did not exist yet. The
 * factories themselves were perfectly readable; only the join failed.
 */
describe('EntitlementsService — before its migration runs', () => {
  describe('listTenants', () => {
    it('lists the factories instead of failing the whole screen', async () => {
      let sawRelation = false;
      let attempts = 0;

      const prisma = {
        tenant: {
          findMany: jest.fn(async ({ select }: { select: Record<string, unknown> }) => {
            attempts += 1;
            if ('entitlement' in select) {
              sawRelation = true;
              throw missingTable();
            }
            return [
              {
                id: ACME,
                name: 'Acme Denim',
                code: 'ACME',
                status: 'active',
                createdAt: new Date(),
                _count: { users: 3, employees: 299 },
              },
            ];
          }),
        },
        // listTenants reads subscriptions in a second query; no row here means
        // "nothing configured", which stays fully entitled.
        tenantSubscription: {
          findMany: jest.fn(async () => []),
        },
      } as never;

      const rows = await new EntitlementsService(prisma, cacheStub()).listTenants();

      expect(sawRelation).toBe(true); // tried the join first
      expect(attempts).toBe(2); // then retried without it
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Acme Denim');
      expect(rows[0].employees).toBe(299);
      // Unconfigured reads as fully entitled, not as locked out — the same rule
      // a missing ROW already gets.
      expect(rows[0].enabledPageCount).toBe(rows[0].totalPageCount);
      expect(rows[0].modules.every((m) => m.state === 'all')).toBe(true);
    });

    it('does not mask a real outage as an empty factory list', async () => {
      // Failing open on a missing table is a deploy-ordering allowance. Failing
      // open on a dead connection would hide an outage behind a blank screen.
      const prisma = {
        tenant: {
          findMany: jest.fn(async () => {
            throw outage();
          }),
        },
      } as never;

      await expect(
        new EntitlementsService(prisma, cacheStub()).listTenants(),
      ).rejects.toThrow(/Connection terminated/);
    });
  });

  describe('enabledPagesFor', () => {
    const throwing = (error: unknown) =>
      ({
        tenantEntitlement: {
          findUnique: jest.fn(async () => {
            throw error;
          }),
        },
        // enabledPagesFor also consults the subscription table; a quiet "no
        // row" here keeps these tests about the entitlement table only.
        tenantSubscription: {
          findUnique: jest.fn(async () => null),
        },
      }) as never;

    it('treats a missing table as fully entitled', async () => {
      // PageAccessGuard consults this on EVERY gated request, so rethrowing
      // would turn one missing migration into a 500 on every endpoint.
      const service = new EntitlementsService(throwing(missingTable()), cacheStub());
      const pages = await service.enabledPagesFor(ACME);

      expect(pages.size).toBeGreaterThan(0);
      expect(pages.has('hr.employees')).toBe(true);
    });

    it("recognises Prisma's own P2021 code too", async () => {
      const error = Object.assign(new Error('The table does not exist'), { code: 'P2021' });
      const service = new EntitlementsService(throwing(error), cacheStub());

      await expect(service.enabledPagesFor(ACME)).resolves.toBeInstanceOf(Set);
    });

    it('still rethrows a genuine database failure', async () => {
      const service = new EntitlementsService(throwing(outage()), cacheStub());
      await expect(service.enabledPagesFor(ACME)).rejects.toThrow(/Connection terminated/);
    });
  });
});
