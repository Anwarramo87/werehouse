import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import {
  FACTORY_SCOPE_HEADER,
  FactoryScopeInterceptor,
} from '../../../../src/common/tenant/factory-scope.interceptor';
import { currentTenant, runWithTenant } from '../../../../src/common/tenant/tenant-context';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';
const RIVAL = 'bbbbbbb2-0000-4000-8000-00000000000b';

const prismaWith = (existingTenantIds: string[]) =>
  ({
    tenant: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        existingTenantIds.includes(where.id) ? { id: where.id } : null,
      ),
    },
  }) as never;

/** Cache that never hits, so every test exercises the real lookup. */
const missingCache = () =>
  ({
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
  }) as never;

const contextFor = (request: Record<string, unknown>) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as never;

const nextHandler = () => ({ handle: () => of('ok') }) as never;

/*
 * The overseer views a factory through the ORDINARY endpoints, by adopting that
 * factory's scope for the request. The alternative — a parallel set of
 * cross-factory controllers — would be a second copy of every list that drifts
 * from the original the first time either changes.
 */
describe('FactoryScopeInterceptor', () => {
  const superAdmin = { username: 'overseer', roles: ['superadmin'], tenantId: null };
  const factoryAdmin = { username: 'acme-admin', roles: ['admin'], tenantId: ACME };

  it('does nothing when no factory is named', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([ACME]), missingCache());
    const request = { headers: {}, user: factoryAdmin };

    await runWithTenant({ tenantId: ACME, bypass: false }, async () => {
      await interceptor.intercept(contextFor(request), nextHandler());
      expect(currentTenant()?.tenantId).toBe(ACME);
    });
  });

  it('narrows the overseer to the factory it named', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([RIVAL]), missingCache());
    const request = { headers: { [FACTORY_SCOPE_HEADER]: RIVAL }, user: superAdmin };

    // Starts as the overseer: no factory, bypassing scope entirely.
    await runWithTenant({ tenantId: null, bypass: true }, async () => {
      await interceptor.intercept(contextFor(request), nextHandler());

      const scope = currentTenant();
      expect(scope?.tenantId).toBe(RIVAL);
      // bypass off is the point: looking at one factory should show exactly
      // that factory, and any write lands attributed to it.
      expect(scope?.bypass).toBe(false);
      expect(scope?.actor).toContain('overseer');
    });
  });

  it('mirrors the adopted factory onto the request user', async () => {
    // So handlers reading user.tenantId agree with the Prisma scope rather than
    // disagreeing with it.
    const interceptor = new FactoryScopeInterceptor(prismaWith([RIVAL]), missingCache());
    const request: Record<string, unknown> = {
      headers: { [FACTORY_SCOPE_HEADER]: RIVAL },
      user: superAdmin,
    };

    await runWithTenant({ tenantId: null, bypass: true }, async () => {
      await interceptor.intercept(contextFor(request), nextHandler());
    });

    expect((request.user as { tenantId: string }).tenantId).toBe(RIVAL);
  });

  it('refuses a factory admin trying to name another factory', async () => {
    // Refused loudly rather than ignored, so the attempt is visible.
    const interceptor = new FactoryScopeInterceptor(prismaWith([RIVAL]), missingCache());
    const request = { headers: { [FACTORY_SCOPE_HEADER]: RIVAL }, user: factoryAdmin };

    await runWithTenant({ tenantId: ACME, bypass: false }, async () => {
      await expect(
        interceptor.intercept(contextFor(request), nextHandler()),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // And the scope is untouched by the attempt.
      expect(currentTenant()?.tenantId).toBe(ACME);
    });
  });

  it('refuses an anonymous request that names a factory', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([RIVAL]), missingCache());
    const request = { headers: { [FACTORY_SCOPE_HEADER]: RIVAL }, user: undefined };

    await expect(
      interceptor.intercept(contextFor(request), nextHandler()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a factory that does not exist', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([ACME]), missingCache());
    const request = { headers: { [FACTORY_SCOPE_HEADER]: 'no-such-factory' }, user: superAdmin };

    await expect(
      interceptor.intercept(contextFor(request), nextHandler()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ignores a blank header rather than treating it as a factory', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([ACME]), missingCache());
    const request = { headers: { [FACTORY_SCOPE_HEADER]: '   ' }, user: superAdmin };

    await runWithTenant({ tenantId: null, bypass: true }, async () => {
      await interceptor.intercept(contextFor(request), nextHandler());
      expect(currentTenant()?.bypass).toBe(true);
    });
  });

  it('leaves non-http contexts alone', async () => {
    const interceptor = new FactoryScopeInterceptor(prismaWith([ACME]), missingCache());
    const wsContext = { getType: () => 'ws' } as never;

    await expect(
      interceptor.intercept(wsContext, nextHandler()),
    ).resolves.toBeDefined();
  });
});
