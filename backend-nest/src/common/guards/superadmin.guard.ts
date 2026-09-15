import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SUPERADMIN_ROLE } from '../tenant/tenant.constants';

/**
 * Admits only the platform overseer.
 *
 * Deliberately separate from PermissionsGuard rather than expressed as a
 * permission. Permissions are per-factory grants, and a factory admin's role row
 * is editable; being the super admin is not a grant, it is an identity. Keeping
 * the two mechanisms apart means no amount of permission editing can promote
 * someone into cross-factory access.
 *
 * The role name is read from `request.user`, which JwtStrategy populates from
 * the database on every cache miss -- never from anything the caller sent.
 *
 * Use with JwtAuthGuard, which must run first to populate `request.user`:
 *
 *   @UseGuards(JwtAuthGuard, SuperAdminGuard)
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      // JwtAuthGuard did not run, or ran and admitted nobody. Either way this
      // is a wiring mistake, and failing closed is the only safe reading.
      throw new ForbiddenException('This operation is restricted to the super admin');
    }

    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    const isSuperAdmin = roles.includes(SUPERADMIN_ROLE) || user.role === SUPERADMIN_ROLE;

    if (!isSuperAdmin) {
      throw new ForbiddenException('This operation is restricted to the super admin');
    }

    return true;
  }
}
