import { Prisma } from '@prisma/client';
import { currentTenant } from './tenant-context';
import { isTenantScoped } from './tenant-models';
import { TENANT_COMPOUND_KEYS } from './tenant-compound-keys';
import { stampTenantOnData, walkWriteData } from './tenant-nested';

/** Operations whose `where` must be narrowed to the caller's tenant. */
const FILTERED = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  // upsert belongs here as well as in STAMPED: its `where` locates an existing
  // row and must be tenant-narrowed, while its `create` payload gets stamped.
  'upsert',
]);

/** Operations whose payload must be stamped with the caller's tenant. */
const STAMPED = new Set(['create', 'createMany', 'upsert']);

/**
 * Operations that are not themselves creates, but whose `data` can still carry
 * nested writes -- `update({ where, data: { items: { create: [...] } } })`.
 */
const WALKED = new Set(['update', 'updateMany']);

/**
 * Operations Prisma requires to target a *unique* row. Business keys such as
 * employeeId or sku are only unique within a factory now, so a plain
 * `where: { employeeId }` no longer identifies a row on its own and must be
 * folded into the compound `tenantId_employeeId` form.
 */
const NEEDS_UNIQUE = new Set(['update', 'delete', 'upsert']);

/**
 * Rewrites `{ employeeId: 'E1' }` into `{ tenantId_employeeId: { tenantId,
 * employeeId: 'E1' } }` when the where clause names exactly the business half
 * of a tenant compound key. Anything already addressing `id` (or an existing
 * compound key) is left alone.
 */
function toCompoundWhere(
  model: string,
  where: Record<string, unknown>,
  tenantId: string,
): Record<string, unknown> {
  const key = model[0].toLowerCase() + model.slice(1);
  const candidates = TENANT_COMPOUND_KEYS[key];
  if (!candidates || where.id !== undefined) return where;

  for (const candidate of candidates) {
    if (where[candidate.key] !== undefined) return where;
    const hasAll = candidate.fields.every((f) => where[f] !== undefined);
    if (!hasAll) continue;

    const compound: Record<string, unknown> = { tenantId };
    const rest: Record<string, unknown> = { ...where };
    for (const f of candidate.fields) {
      compound[f] = where[f];
      delete rest[f];
    }
    return { ...rest, [candidate.key]: compound };
  }
  return where;
}

/**
 * Fails closed. Reaching Prisma with no tenant scope at all is a bug -- either
 * the request never passed through TenantMiddleware, or background work forgot
 * to wrap itself in runUnscoped(). Both are far better surfaced as a loud 500
 * than as one factory silently reading another's rows.
 */
function requireScope(model: string, operation: string) {
  const scope = currentTenant();
  if (!scope) {
    throw new Error(
      `Tenant scope missing for ${model}.${operation}(). Requests must pass ` +
        `through TenantMiddleware; background jobs must use runUnscoped(reason, fn).`,
    );
  }
  if (!scope.bypass && !scope.tenantId) {
    throw new Error(
      `Tenant scope is empty for ${model}.${operation}(). A non-superadmin ` +
        `principal must always resolve to a factory.`,
    );
  }
  return scope;
}

export function tenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isTenantScoped(model)) {
            return query(args);
          }

          const scope = requireScope(model, operation);
          // Super Admin sees every factory: leave the query untouched.
          if (scope.bypass) {
            return query(args);
          }

          const tenantId = scope.tenantId as string;
          const next: Record<string, unknown> = { ...(args as object) };

          if (FILTERED.has(operation)) {
            // Prisma's extended-where-unique (GA since v5) allows non-unique
            // fields alongside the unique one, so this is safe for findUnique,
            // update and delete as well as the plain filters.
            let where = { ...((next.where as object) ?? {}), tenantId } as Record<
              string,
              unknown
            >;
            if (NEEDS_UNIQUE.has(operation)) {
              where = toCompoundWhere(model, where, tenantId);
            }
            next.where = where;
          }

          if (STAMPED.has(operation)) {
            if (operation === 'upsert') {
              // `where` was already narrowed + folded by the FILTERED branch.
              next.create = stampTenantOnData(model, (next.create as object) ?? {}, tenantId);
              next.update = walkWriteData(model, (next.update as object) ?? {}, tenantId);
            } else if (operation === 'createMany') {
              // createMany takes flat rows only -- no nested writes to walk.
              const data = (next.data as unknown[]) ?? [];
              next.data = Array.isArray(data)
                ? data.map((row) => ({ ...(row as object), tenantId }))
                : { ...(data as object), tenantId };
            } else {
              next.data = stampTenantOnData(model, (next.data as object) ?? {}, tenantId);
            }
          } else if (WALKED.has(operation)) {
            // update/updateMany are narrowed above but their `data` can still
            // carry nested writes -- items created, connected or deleted through
            // the parent. Those get the same treatment as a create's.
            if (next.data !== undefined) {
              next.data = walkWriteData(model, next.data as object, tenantId);
            }
          }

          return query(next);
        },
      },
    },
  });
}
