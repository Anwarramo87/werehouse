/**
 * The overseer role. Sees every factory, owns tenant management and the global
 * backup. There is exactly one class of these -- it is not a per-factory role.
 */
export const SUPERADMIN_ROLE = 'superadmin';

/**
 * The per-factory owner. Has the same screens as the Super Admin but every
 * query is silently narrowed to their own factory by the Prisma extension.
 */
export const TENANT_ADMIN_ROLE = 'admin';

/**
 * Permissions a factory Admin must never hold.
 *
 * `manage_roles` is withheld deliberately: Role rows are global (shared by all
 * factories), so an Admin able to edit a role could grant themselves anything
 * and escalate across the whole system.
 */
export const SUPERADMIN_ONLY_PERMISSIONS = ['manage_roles', 'manage_tenants'];

/** Permission gating tenant (factory) CRUD. Held only by the Super Admin. */
export const MANAGE_TENANTS = 'manage_tenants';
