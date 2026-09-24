import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SUPERADMIN_ROLE } from '../tenant/tenant.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { EntitlementsService } from './entitlements.service';

/**
 * Refuses a request when the caller's factory (or their own per-admin window)
 * has no live subscription.
 *
 * Runs after JwtAuthGuard (which populates `request.user`) and before
 * PageAccessGuard. Entitlements answer "which pages did the factory buy";
 * this guard answers "is the time window still open". Both must pass.
 *
 * Fail-open when nothing is configured (no subscription row anywhere) — same
 * rule as the entitlement tables — so existing factories are unaffected until
 * the Super Admin actually sets a window. Only a real, past endsAt locks out.
 * The Super Admin is never gated.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user) {
      // JwtAuthGuard did not run, or ran and admitted nobody. Fail closed.
      throw new ForbiddenException('Authentication required');
    }

    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    if (roles.includes(SUPERADMIN_ROLE) || user.role === SUPERADMIN_ROLE) {
      return true;
    }

    if (!user.tenantId) {
      throw new ForbiddenException('No factory subscription for this account');
    }

    const active = await this.entitlements.isSubscriptionActiveForUser(
      user.userId,
      user.tenantId,
    );
    if (!active) {
      throw new ForbiddenException('Factory subscription has expired');
    }

    return true;
  }
}
