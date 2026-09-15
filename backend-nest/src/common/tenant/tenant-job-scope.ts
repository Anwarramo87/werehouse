import { TenantScope, currentTenant, runWithTenant } from './tenant-context';

/**
 * The tenant scope, flattened so it survives a trip through Redis.
 *
 * A queued job runs in a worker, with no request and therefore no
 * AsyncLocalStorage scope, so `requireScope()` fails closed on the worker's
 * very first query -- every payroll run and every import dispatched through
 * BullMQ threw before it did any work. The enqueuing request knows the factory;
 * the job has to carry it.
 */
export interface SerializedTenantScope {
  tenantId: string | null;
  bypass: boolean;
}

/** Captures the scope of the request that is enqueuing a job. */
export function captureTenantScope(): SerializedTenantScope {
  const scope = currentTenant();
  return {
    tenantId: scope?.tenantId ?? null,
    bypass: scope?.bypass ?? false,
  };
}

/**
 * Re-establishes a captured scope inside a worker.
 *
 * Jobs enqueued by an older build carry no scope. Restoring them as
 * "no factory" keeps the failure loud and local to that job rather than
 * silently running it across every factory.
 */
export function runInCapturedTenant<T>(
  captured: SerializedTenantScope | undefined,
  actor: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: TenantScope = {
    tenantId: captured?.tenantId ?? null,
    bypass: captured?.bypass ?? false,
    actor,
  };

  return runWithTenant(scope, async () => await fn());
}
