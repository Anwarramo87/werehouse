import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  SUPERADMIN_ONLY_PERMISSIONS,
  SUPERADMIN_ROLE,
} from '../tenant/tenant.constants';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      throw new ForbiddenException(
        'This endpoint requires explicit permissions configuration',
      );
    }

    const request = context.switchToHttp().getRequest();
    const userRoles: string[] = request.user?.roles || [];

    // Only the Super Admin bypasses permission checks. A factory `admin` used
    // to land here too, which made the two roles indistinguishable -- it now
    // falls through to the explicit permission list below, and its queries are
    // narrowed to its own factory by the Prisma tenant extension.
    if (userRoles.includes(SUPERADMIN_ROLE)) {
      return true;
    }

    const userPermissions: string[] = request.user?.permissions || [];

    // Defence in depth: these permissions are meaningless outside the Super
    // Admin and must never be satisfied by a tenant-scoped principal, even if
    // one is somehow attached to their role.
    const wantsSuperadminOnly = requiredPermissions.some((p) =>
      SUPERADMIN_ONLY_PERMISSIONS.includes(p),
    );
    if (wantsSuperadminOnly) {
      throw new ForbiddenException('This operation is restricted to the super admin');
    }
    const hasPermission = requiredPermissions.some((p) =>
      userPermissions.includes(p),
    );

    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions for this operation');
    }

    return true;
  }
}
