import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SUPERADMIN_ROLE } from '../tenant/tenant.constants';
import { AuthenticatedUser } from '../types/authenticated-user.types';

/**
 * Second-stage access control for endpoints addressed to a *specific* employee.
 *
 * `PermissionsGuard` has already run by the time anything here is called: it
 * decided whether the caller may use the endpoint at all. This service answers
 * the narrower question of whether they may see *this* employee, and exists so
 * that a member of staff with no HR permissions can still read their own
 * attendance and payslips.
 *
 * The rule, in order:
 *   1. Super Admin -- allowed. Stated explicitly here so this service agrees with
 *      PermissionsGuard, which grants the same exemption and nothing broader.
 *   2. Holds one of the requested permissions -- allowed, any employee.
 *   3. The record is the caller's own linked employee -- allowed (self-service).
 *   4. Otherwise -- refused.
 *
 * Tenant isolation is NOT enforced here and must not be: every query below runs
 * through the tenant-extended Prisma client, which narrows to the caller's
 * factory automatically and fails closed when no scope is set. An Admin of one
 * factory asking about another factory's employee finds nothing.
 */
@Injectable()
export class EmployeeAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Super Admin, the one principal allowed to see across factories.
   *
   * This replaces an `isAdmin()` check that matched the role *name* `'admin'`
   * and returned true for every permission list it was ever asked about. That
   * predated the decision to stop letting a factory Admin bypass
   * `PermissionsGuard`, and quietly kept the bypass alive on the three endpoints
   * that use this service -- a factory Admin would have satisfied a request for
   * `manage_salary` on the strength of their role name alone. Admins now pass
   * the same way everyone else does: by holding the permission.
   */
  isSuperAdmin(user: AuthenticatedUser | undefined): boolean {
    if (!user) return false;
    return user.role === SUPERADMIN_ROLE || (user.roles?.includes(SUPERADMIN_ROLE) ?? false);
  }

  hasAnyPermission(user: AuthenticatedUser | undefined, permissions: string[]): boolean {
    if (!user) return false;
    if (this.isSuperAdmin(user)) return true;
    return permissions.some((permission) => user.permissions?.includes(permission));
  }

  async assertCanAccessEmployee(
    user: AuthenticatedUser | undefined,
    employeeId: string,
    permissions: string[],
  ): Promise<void> {
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (this.hasAnyPermission(user, permissions)) {
      return;
    }

    // Self-service fallback. Tenant-narrowed by the Prisma extension, so this
    // can only ever match an employee inside the caller's own factory.
    const linked = await this.prisma.employee.findFirst({
      where: {
        employeeId,
        userId: user.userId,
      },
      select: { employeeId: true },
    });

    if (linked) {
      return;
    }

    throw new ForbiddenException('You cannot access this employee record');
  }
}
