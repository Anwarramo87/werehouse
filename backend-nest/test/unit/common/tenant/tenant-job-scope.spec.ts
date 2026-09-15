import {
  captureTenantScope,
  runInCapturedTenant,
} from '../../../../src/common/tenant/tenant-job-scope';
import {
  currentTenant,
  runUnscoped,
  runWithTenant,
} from '../../../../src/common/tenant/tenant-context';

const FACTORY = 'aaaaaaa1-0000-4000-8000-00000000000a';

/*
 * A queued job runs in a worker: no request, no TenantMiddleware, and therefore
 * no AsyncLocalStorage scope. Every model payroll and imports touch is
 * tenant-scoped, so without this hand-off the worker's first query throws
 * inside the Prisma extension and the whole job dies before doing any work.
 */
describe('tenant hand-off across a queue', () => {
  it('captures the enqueuing request’s factory', () => {
    const captured = runWithTenant({ tenantId: FACTORY, bypass: false }, () =>
      captureTenantScope(),
    );

    expect(captured).toEqual({ tenantId: FACTORY, bypass: false });
  });

  it('captures the super admin as a bypass rather than as a factory', () => {
    const captured = runUnscoped('test', () => captureTenantScope());
    expect(captured).toEqual({ tenantId: null, bypass: true });
  });

  it('reports no factory when nothing established a scope', () => {
    expect(captureTenantScope()).toEqual({ tenantId: null, bypass: false });
  });

  it('re-establishes the captured factory inside the worker', async () => {
    const captured = runWithTenant({ tenantId: FACTORY, bypass: false }, () =>
      captureTenantScope(),
    );

    // No ambient scope here — this is what a worker actually looks like.
    expect(currentTenant()).toBeUndefined();

    const seen = await runInCapturedTenant(captured, 'queue:test', async () => {
      await Promise.resolve();
      return currentTenant();
    });

    expect(seen).toMatchObject({ tenantId: FACTORY, bypass: false });
  });

  it('survives an await inside the job', async () => {
    const captured = { tenantId: FACTORY, bypass: false };

    const seen = await runInCapturedTenant(captured, 'queue:test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTenant()?.tenantId;
    });

    expect(seen).toBe(FACTORY);
  });

  it('restores a job queued before this field existed as "no factory"', async () => {
    // Fails closed in the extension rather than running across every factory.
    const seen = await runInCapturedTenant(undefined, 'queue:test', async () =>
      currentTenant(),
    );

    expect(seen).toMatchObject({ tenantId: null, bypass: false });
  });

  it('does not leak the scope back out to the caller', async () => {
    await runInCapturedTenant({ tenantId: FACTORY, bypass: false }, 'queue:test', async () => {
      expect(currentTenant()?.tenantId).toBe(FACTORY);
    });

    expect(currentTenant()).toBeUndefined();
  });
});
