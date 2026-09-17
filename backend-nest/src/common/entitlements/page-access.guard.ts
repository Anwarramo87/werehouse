import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SUPERADMIN_ROLE } from '../tenant/tenant.constants';
import { EntitlementsService } from './entitlements.service';
import { REQUIRES_PAGE_KEY } from './requires-page.decorator';

/**
 * Refuses a request whose factory has not been sold the page behind it.
 *
 * Runs after JwtAuthGuard (which populates `request.user`) and alongside
 * PermissionsGuard. The two answer different questions and both must pass:
 * entitlements are what the FACTORY bought, permissions are what the PERSON may
 * do with it. A factory admin holding every permission in the system still
 * cannot reach a module their factory does not have.
 */
@Injectable()
export class PageAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const pageKey = this.reflector.getAllAndOverride<string>(REQUIRES_PAGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Un-annotated endpoints are not gated by entitlements. Deliberate: this
    // guard governs sellable surface area, and applying it to everything would
    // make auth, health and the assistant unreachable for want of a page key.
    if (!pageKey) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user) {
      throw new ForbiddenException('This module is not enabled for your factory');
    }

    // The overseer is not buying anything; it inspects every factory.
    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    if (roles.includes(SUPERADMIN_ROLE) || user.role === SUPERADMIN_ROLE) {
      return true;
    }

    if (!user.tenantId) {
      throw new ForbiddenException('This module is not enabled for your factory');
    }

    // Effective access = the FACTORY grant AND the per-admin grant. The
    // per-user check internally falls back to the whole factory grant when
    // this admin has no row, so keeping this single call here preserves the
    // "factory bought it = every admin may use it" behaviour for factories
    // that never touch per-admin entitlements.
    if (
      !(await this.entitlements.isPageEnabledForUser(
        user.userId,
        user.tenantId,
        pageKey,
      ))
    ) {
      throw new ForbiddenException('This module is not enabled for your factory');
    }

    return true;
  }
}
