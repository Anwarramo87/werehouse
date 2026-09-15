import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { ShortCacheService } from '../cache/short-cache.service';
import { currentTenant, runUnscoped } from './tenant-context';
import { SUPERADMIN_ROLE } from './tenant.constants';

/** Header naming the factory a super admin wants to look at. */
export const FACTORY_SCOPE_HEADER = 'x-factory-id';

const TENANT_EXISTS_TTL_SECONDS = 60;

/**
 * Lets the overseer view any factory through the ordinary endpoints.
 *
 * The alternative was a parallel set of cross-factory controllers — a second
 * employees list, a second payroll report, a second attendance view — each one
 * a copy that would drift from the original the first time either changed. This
 * instead narrows the request's scope to the named factory, so
 * `GET /employees` run by the overseer with `x-factory-id: <acme>` returns
 * exactly what Acme's own admin would see, from exactly the same code.
 *
 * ── Why an interceptor and not a guard ──────────────────────────────────────
 * Global guards run BEFORE controller-scoped ones, so a guard here would fire
 * before JwtAuthGuard had populated `request.user` and would have no identity to
 * check. Global interceptors run after every guard, which is exactly the window
 * needed.
 *
 * ── Why mutation rather than runWithTenant ──────────────────────────────────
 * `next.handle()` returns a cold Observable subscribed to later, outside any
 * AsyncLocalStorage frame this method could open. The scope object is instead
 * mutated in place — the same mechanism JwtStrategy already uses, since every
 * frame in the request holds the same object reference.
 *
 * The adopted scope deliberately sets `bypass: false`. The overseer looking at
 * one factory should see precisely that factory, and any write it makes is
 * stamped with that factory rather than landing unattributed.
 */
@Injectable()
export class FactoryScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ShortCacheService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const requested = this.readHeader(request);

    if (!requested) {
      return next.handle();
    }

    const user = request.user;
    const roles: string[] = Array.isArray(user?.roles) ? user.roles : [];
    const isSuperAdmin = roles.includes(SUPERADMIN_ROLE) || user?.role === SUPERADMIN_ROLE;

    if (!isSuperAdmin) {
      // A factory admin sending this header is trying to read another factory.
      // Refuse loudly rather than ignoring it, so the attempt is visible.
      throw new ForbiddenException('Only the super admin may view another factory');
    }

    if (!(await this.tenantExists(requested))) {
      throw new NotFoundException(`Factory ${requested} not found`);
    }

    const scope = currentTenant();
    if (scope) {
      scope.tenantId = requested;
      scope.bypass = false;
      scope.actor = `superadmin:${user?.username ?? 'unknown'}@${requested}`;
    }

    // Mirrored onto the request so handlers reading user.tenantId — the
    // assistant, the entitlements endpoint — agree with the Prisma scope
    // instead of disagreeing with it.
    if (request.user) {
      request.user = { ...request.user, tenantId: requested };
    }

    return next.handle();
  }

  private readHeader(request: { headers?: Record<string, unknown> }): string | null {
    const raw = request.headers?.[FACTORY_SCOPE_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Cached: this runs on every request the overseer makes while drilled in. */
  private async tenantExists(tenantId: string): Promise<boolean> {
    const key = `tenant-exists:${tenantId}`;
    const cached = await this.cache.getJson<boolean>(key);
    if (cached !== null && cached !== undefined) return cached;

    const found = await runUnscoped('factory-scope-check', () =>
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
    );

    const exists = Boolean(found);
    await this.cache.setJson(key, exists, TENANT_EXISTS_TTL_SECONDS);
    return exists;
  }
}
