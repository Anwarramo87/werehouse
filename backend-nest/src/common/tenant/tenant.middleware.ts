import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { runWithTenant } from './tenant-context';
import { SUPERADMIN_ROLE } from './tenant.constants';

/**
 * Establishes the tenant scope for the lifetime of a request.
 *
 * Runs before the JWT guard, so `req.user` is not populated yet -- the scope is
 * therefore opened lazily-but-eagerly here from whatever the guard will later
 * verify. To avoid trusting unverified input we do NOT read the tenant from
 * headers or the body; JwtStrategy re-stamps the scope from the verified token
 * (see setRequestTenant) before any controller runs.
 *
 * Until that happens the scope stays empty, which makes the Prisma extension
 * fail closed rather than fall back to "see everything".
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    runWithTenant({ tenantId: null, bypass: false, actor: 'unauthenticated' }, () =>
      next(),
    );
  }
}

/**
 * Called from JwtStrategy.validate once the token signature has been verified.
 * Mutates the scope object in place: AsyncLocalStorage hands every frame in
 * this request the same object reference, so the update is visible downstream
 * without re-entering storage.run().
 */
export function setRequestTenant(
  scope: { tenantId: string | null; bypass: boolean; actor?: string },
  payload: { role?: string; tenantId?: string | null; username?: string },
) {
  const isSuperadmin = payload.role === SUPERADMIN_ROLE;
  scope.bypass = isSuperadmin;
  scope.tenantId = isSuperadmin ? null : (payload.tenantId ?? null);
  scope.actor = payload.username ?? 'unknown';
}
