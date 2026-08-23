/**
 * Addresses a row by its per-factory business key (employeeId, sku, deviceId,
 * ...) in an operation Prisma types as needing a unique key.
 *
 * Since multi-tenancy landed, those keys are unique only *within* a factory:
 * the real unique is the compound `tenantId_employeeId`. Callers cannot supply
 * the tenant half -- that is exactly what the Prisma tenant extension injects,
 * from the verified JWT, at query time (see toCompoundWhere in
 * tenant-extension.ts). So the object handed to Prisma is genuinely complete at
 * runtime, but incomplete as far as the compiler can see.
 *
 * This helper is the single place that gap is bridged, deliberately: one
 * reviewed cast instead of ~30 scattered `as any` at call sites, and a
 * greppable marker for every query relying on tenant-completed keys.
 */
export function tenantKey<T>(where: Record<string, unknown>): T {
  return where as T;
}
