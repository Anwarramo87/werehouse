import { ForbiddenException } from '@nestjs/common';
import { SUPERADMIN_ROLE } from '../tenant/tenant.constants';

/**
 * Role hierarchy for account creation.
 *
 * Only the overseer (superadmin) may create admins and superadmins. A factory
 * admin may only create ordinary accounts (employees, department heads and any
 * other non-privileged role). This is enforced server-side on every path that
 * assigns a roleId — POST /auth/users, POST /employees and PATCH /employees —
 * so hiding the options in the UI is a courtesy, never the control.
 */
const PRIVILEGED_ROLE_NAMES = [SUPERADMIN_ROLE, 'admin'];

export function isPrivilegedRoleName(name?: string | null): boolean {
  if (!name) return false;
  return PRIVILEGED_ROLE_NAMES.includes(name.trim().toLowerCase());
}

export type RoleAssignActor = {
  roles?: string[] | null;
  role?: string | null;
} | null | undefined;

export function isSuperadminActor(actor: RoleAssignActor): boolean {
  if (!actor) return false;
  const roles = Array.isArray(actor.roles) ? actor.roles : [];
  return roles.includes(SUPERADMIN_ROLE) || actor.role === SUPERADMIN_ROLE;
}

/**
 * Throws 403 when a non-superadmin tries to hand out a privileged role.
 * Call it with the RESOLVED role name (after id→name lookup), never with raw
 * client input, so a renamed uuid cannot slip past.
 */
export function assertCanAssignRole(
  targetRoleName: string | null | undefined,
  actor: RoleAssignActor,
): void {
  if (isPrivilegedRoleName(targetRoleName) && !isSuperadminActor(actor)) {
    throw new ForbiddenException(
      'Only a superadmin can assign the admin or superadmin role',
    );
  }
}
