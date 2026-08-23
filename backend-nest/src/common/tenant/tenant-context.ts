import { AsyncLocalStorage } from 'async_hooks';

/**
 * The tenant a unit of work belongs to.
 *
 * `tenantId === null` combined with `bypass === true` is the Super Admin: it
 * sees every factory. `bypass` is never derived from the request — it is set
 * only from a verified JWT whose role is `superadmin` (see TenantMiddleware),
 * so a client cannot ask to escape its own tenant.
 */
export interface TenantScope {
  tenantId: string | null;
  /** Skip tenant filtering entirely. Super Admin only. */
  bypass: boolean;
  /** Who established this scope — used in error messages and audit trails. */
  actor?: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Runs `fn` with `scope` visible to every await'd frame beneath it. */
export function runWithTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Current scope, or undefined outside a request (cron jobs, bootstrap, CLI). */
export function currentTenant(): TenantScope | undefined {
  return storage.getStore();
}

/**
 * Escape hatch for work that legitimately spans every factory: scheduled jobs,
 * the Super Admin's global backup, admin bootstrap. Deliberately verbose —
 * every call site should be easy to find and justify in review.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return storage.run({ tenantId: null, bypass: true, actor: `system:${reason}` }, fn);
}
