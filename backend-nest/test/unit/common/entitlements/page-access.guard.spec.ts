import { ForbiddenException } from '@nestjs/common';
import { PageAccessGuard } from '../../../../src/common/entitlements/page-access.guard';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';

/** Minimal ExecutionContext — the guard only reads the request's user. */
const contextFor = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as never;

const reflectorReturning = (pageKey: string | undefined) =>
  ({ getAllAndOverride: () => pageKey }) as never;

const entitlementsWith = (enabled: string[]) =>
  ({
    // The guard checks the per-admin grant (which falls back to the factory
    // grant when the admin has no row), not the factory grant directly.
    isPageEnabledForUser: jest.fn(async (_userId: string, _tenantId: string, key: string) =>
      enabled.includes(key),
    ),
  }) as never;

/*
 * Entitlements answer "what did this FACTORY buy". Permissions answer "what may
 * this PERSON do". Both must pass — an admin holding every permission in the
 * system still cannot reach a module their factory does not have.
 */
describe('PageAccessGuard', () => {
  const admin = {
    userId: 'bbbbbbb2-0000-4000-8000-00000000000b',
    tenantId: ACME,
    roles: ['admin'],
    permissions: ['view_inventory'],
  };

  it('admits a factory that holds the page', async () => {
    const guard = new PageAccessGuard(
      reflectorReturning('inventory.batches'),
      entitlementsWith(['inventory.batches']),
    );

    await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
  });

  it('refuses a factory that does not, however privileged the user', async () => {
    const guard = new PageAccessGuard(
      reflectorReturning('inventory.batches'),
      entitlementsWith(['hr.employees']),
    );

    // Every permission in the world does not buy a module.
    const superPermissioned = { ...admin, permissions: ['view_inventory', 'edit_inventory'] };
    await expect(guard.canActivate(contextFor(superPermissioned))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('leaves un-annotated endpoints alone', async () => {
    // Auth, health and the assistant carry no page key and must stay reachable,
    // or a factory could be locked out of its own login.
    const guard = new PageAccessGuard(reflectorReturning(undefined), entitlementsWith([]));
    await expect(guard.canActivate(contextFor(admin))).resolves.toBe(true);
  });

  it('lets the overseer through without consulting entitlements', async () => {
    const entitlements = entitlementsWith([]);
    const guard = new PageAccessGuard(reflectorReturning('inventory.batches'), entitlements);

    await expect(
      guard.canActivate(contextFor({ tenantId: null, roles: ['superadmin'] })),
    ).resolves.toBe(true);

    // It never asked: the super admin is not buying anything.
    expect(
      (entitlements as unknown as { isPageEnabledForUser: jest.Mock }).isPageEnabledForUser,
    ).not.toHaveBeenCalled();
  });

  it('recognises the overseer from a singular role too', async () => {
    const guard = new PageAccessGuard(
      reflectorReturning('inventory.batches'),
      entitlementsWith([]),
    );

    await expect(
      guard.canActivate(contextFor({ tenantId: null, role: 'superadmin' })),
    ).resolves.toBe(true);
  });

  it('fails closed when the request carries no user', async () => {
    // JwtAuthGuard did not run, or admitted nobody. Either way this is a wiring
    // mistake, and guessing in the caller's favour would be the wrong guess.
    const guard = new PageAccessGuard(
      reflectorReturning('inventory.batches'),
      entitlementsWith(['inventory.batches']),
    );

    await expect(guard.canActivate(contextFor(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('fails closed for a non-superadmin with no factory', async () => {
    const guard = new PageAccessGuard(
      reflectorReturning('inventory.batches'),
      entitlementsWith(['inventory.batches']),
    );

    await expect(
      guard.canActivate(contextFor({ tenantId: null, roles: ['admin'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/*
 * The code can reach production before its migration does — Railway's
 * preDeployCommand has silently not run before. PageAccessGuard consults the
 * entitlements table on EVERY gated request, so a missing table must not become
 * a 500 on every endpoint in the product.
 */
describe('EntitlementsService.enabledPagesFor — before its migration runs', () => {
  const cacheStub = () =>
    ({ getJson: jest.fn(async () => null), setJson: jest.fn(async () => undefined) }) as never;

  const prismaThrowing = (error: unknown) =>
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

  it('treats a missing table as "fully entitled", like a missing row', async () => {
    const { EntitlementsService } = await import(
      '../../../../src/common/entitlements/entitlements.service'
    );
    const { ALL_PAGE_KEYS } = await import(
      '../../../../src/common/entitlements/catalogue'
    );

    const error = Object.assign(new Error('relation "tenant_entitlements" does not exist'), {
      code: '42P01',
    });
    const service = new EntitlementsService(prismaThrowing(error), cacheStub());

    const pages = await service.enabledPagesFor('aaaaaaa1-0000-4000-8000-00000000000a');

    expect(pages.size).toBe(ALL_PAGE_KEYS.length);
  });

  it('recognises Prisma’s own P2021 code too', async () => {
    const { EntitlementsService } = await import(
      '../../../../src/common/entitlements/entitlements.service'
    );

    const error = Object.assign(new Error('The table does not exist'), { code: 'P2021' });
    const service = new EntitlementsService(prismaThrowing(error), cacheStub());

    await expect(
      service.enabledPagesFor('aaaaaaa1-0000-4000-8000-00000000000a'),
    ).resolves.toBeInstanceOf(Set);
  });

  it('still rethrows a genuine database failure', async () => {
    // Failing open on a missing table is a deploy-ordering allowance. Failing
    // open on a dead connection would hide a real outage behind full access.
    const { EntitlementsService } = await import(
      '../../../../src/common/entitlements/entitlements.service'
    );

    const error = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    const service = new EntitlementsService(prismaThrowing(error), cacheStub());

    await expect(
      service.enabledPagesFor('aaaaaaa1-0000-4000-8000-00000000000a'),
    ).rejects.toThrow(/Connection terminated/);
  });
});
