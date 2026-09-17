import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ShortCacheService } from '../cache/short-cache.service';
import { runUnscoped, runWithTenant } from '../tenant/tenant-context';
import {
  ALL_PAGE_KEYS,
  MODULES,
  isKnownPage,
  moduleState,
  pageKeysForModule,
} from './catalogue';

/** How long a factory's entitlements are cached. Short, because a Super Admin
 *  turning a module off expects it to take effect while they are still looking. */
const CACHE_TTL_SECONDS = 30;

export interface TenantEntitlementView {
  tenantId: string;
  enabledPages: string[];
  modules: Array<{
    key: string;
    label: string;
    description: string;
    state: 'all' | 'none' | 'partial';
    pages: Array<{ key: string; route: string; label: string; enabled: boolean }>;
  }>;
}

export type SubscriptionStatus = 'active' | 'expired' | 'none';

export interface SubscriptionView {
  plan: string;
  startsAt: string;
  endsAt: string;
  status: SubscriptionStatus;
  /** Whole days left while active, 0 or negative once past the end. */
  daysLeft: number;
}

@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ShortCacheService,
  ) {}

  private cacheKey(tenantId: string) {
    return `entitlements:${tenantId}`;
  }

  /**
   * The subscription row of one factory, if the Super Admin ever set one.
   * Missing table (migration not deployed) reads as "no subscription", same
   * fail-open rule as the entitlement tables.
   */
  private async subscriptionRowFor(tenantId: string): Promise<{
    plan: string;
    startsAt: Date;
    endsAt: Date;
  } | null> {
    try {
      return await runUnscoped('subscription-read', () =>
        this.prisma.tenantSubscription.findUnique({
          where: { tenantId },
          select: { plan: true, startsAt: true, endsAt: true },
        }),
      );
    } catch (error) {
      if (this.isMissingTable(error)) {
        this.logger.warn(
          'tenant_subscriptions is missing — run `prisma migrate deploy`. ' +
            'Subscriptions are ignored until it exists.',
        );
        return null;
      }
      throw error;
    }
  }

  subscriptionViewFor(
    row: { plan: string; startsAt: Date; endsAt: Date } | null,
    now: Date = new Date(),
  ): SubscriptionView | null {
    if (!row) return null;
    const active = now >= row.startsAt && now <= row.endsAt;
    const daysLeft = Math.floor((row.endsAt.getTime() - now.getTime()) / 86400000);
    return {
      plan: row.plan,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      status: active ? 'active' : 'expired',
      daysLeft,
    };
  }

  /**
   * The page keys a factory currently holds.
   *
   * A factory with no row yet is treated as fully entitled rather than fully
   * locked out. A missing row means "nobody has configured this factory", and
   * the safe reading of that is the access it had before entitlements existed —
   * failing closed here would silently dark-launch a blackout on any factory
   * created outside the normal path.
   *
   * The single exception is an EXPIRED subscription: while a subscription row
   * exists and now is past its end, the factory holds nothing — every gated
   * surface (guard, sidebar, dashboard, departments) derives from here, so one
   * check closes them all and only the always-available routes survive.
   */
  async enabledPagesFor(tenantId: string): Promise<Set<string>> {
    const cached = await this.cache.getJson<string[]>(this.cacheKey(tenantId));
    if (cached) return new Set(cached);

    const row = await runUnscoped('entitlements-read', async () => {
      try {
        return await this.prisma.tenantEntitlement.findUnique({
          where: { tenantId },
          select: { enabledPages: true },
        });
      } catch (error) {
        // The table does not exist yet: the code has shipped ahead of its
        // migration. PageAccessGuard consults this on every gated request, so
        // rethrowing would turn one missing migration into a 500 on every
        // endpoint in the product. Treat it as "not configured", which is the
        // same reading a missing ROW already gets, and say so loudly once.
        if (this.isMissingTable(error)) {
          this.logger.warn(
            'tenant_entitlements is missing — run `prisma migrate deploy`. ' +
              'Every factory is treated as fully entitled until it exists.',
          );
          return null;
        }
        throw error;
      }
    });

    const now = new Date();
    const subscription = await this.subscriptionRowFor(tenantId);
    const expired = subscription !== null && now > subscription.endsAt;

    const pages = expired ? [] : (row?.enabledPages ?? ALL_PAGE_KEYS);
    await this.cache.setJson(this.cacheKey(tenantId), pages, CACHE_TTL_SECONDS);
    return new Set(pages);
  }

  /**
   * Prisma's "table does not exist" (P2021), plus the raw Postgres 42P01 it
   * wraps, since the adapter does not always translate it.
   */
  private isMissingTable(error: unknown): boolean {
    const code = (error as { code?: string })?.code;
    if (code === 'P2021' || code === '42P01') return true;

    const message = error instanceof Error ? error.message : String(error);
    return /does not exist in the current database|relation .* does not exist/i.test(message);
  }

  async isPageEnabled(tenantId: string, pageKey: string): Promise<boolean> {
    return (await this.enabledPagesFor(tenantId)).has(pageKey);
  }

  /**
   * Every factory, with a one-line summary of what it holds.
   *
   * Read unscoped by design: this is the overseer's list, and it is the only
   * place in the codebase that is supposed to see across factories. Callers are
   * gated by SuperAdminGuard.
   */
  async listTenants() {
    const baseSelect = {
      id: true,
      name: true,
      code: true,
      status: true,
      createdAt: true,
      _count: { select: { users: true, employees: true } },
    } as const;

    type TenantRow = {
      id: string;
      name: string;
      code: string;
      status: string;
      createdAt: Date;
      _count: { users: number; employees: number };
      entitlement?: {
        enabledPages: string[];
        updatedAt: Date;
        updatedBy: string | null;
      } | null;
    };

    // Joining `entitlement` fails outright when the table has not been created
    // yet, which took the whole factories screen down with a 500 rather than
    // showing the factories and saying entitlements were unconfigured. Retry
    // without the relation instead; same rule as enabledPagesFor.
    const tenants = await runUnscoped('tenant-overview', async (): Promise<TenantRow[]> => {
      try {
        return (await this.prisma.tenant.findMany({
          orderBy: { name: 'asc' },
          select: {
            ...baseSelect,
            entitlement: { select: { enabledPages: true, updatedAt: true, updatedBy: true } },
          },
        })) as TenantRow[];
      } catch (error) {
        if (!this.isMissingTable(error)) throw error;

        this.logger.warn(
          'tenant_entitlements is missing — run `prisma migrate deploy`. ' +
            'Listing factories as fully entitled until it exists.',
        );

        return (await this.prisma.tenant.findMany({
          orderBy: { name: 'asc' },
          select: baseSelect,
        })) as TenantRow[];
      }
    });

    // Subscriptions in one query (own try/catch: the table may not exist yet
    // on deployments that have not run the migration — same rule as above).
    let subscriptions: Array<{ tenantId: string; plan: string; startsAt: Date; endsAt: Date }> = [];
    try {
      subscriptions = await runUnscoped('subscription-overview', () =>
        this.prisma.tenantSubscription.findMany({
          select: { tenantId: true, plan: true, startsAt: true, endsAt: true },
        }),
      );
    } catch (error) {
      if (!this.isMissingTable(error)) throw error;
    }
    const subscriptionByTenant = new Map(subscriptions.map((s) => [s.tenantId, s]));
    const now = new Date();

    return tenants.map((tenant) => {
      // A factory with no row yet is fully entitled — same rule as
      // enabledPagesFor, kept in step deliberately. An EXPIRED subscription
      // empties the set here too, so the overseer list never disagrees with
      // what the factory actually sees.
      const subRow = subscriptionByTenant.get(tenant.id) ?? null;
      const subscription = this.subscriptionViewFor(subRow, now);
      const expired = subscription !== null && subscription.status === 'expired';
      const enabled = expired
        ? new Set<string>()
        : new Set(tenant.entitlement?.enabledPages ?? ALL_PAGE_KEYS);

      return {
        id: tenant.id,
        name: tenant.name,
        code: tenant.code,
        status: tenant.status,
        createdAt: tenant.createdAt,
        users: tenant._count.users,
        employees: tenant._count.employees,
        enabledPageCount: enabled.size,
        totalPageCount: ALL_PAGE_KEYS.length,
        modules: MODULES.map((module) => ({
          key: module.key,
          label: module.label,
          state: moduleState(module.key, enabled),
        })),
        entitlementsUpdatedAt: tenant.entitlement?.updatedAt ?? null,
        entitlementsUpdatedBy: tenant.entitlement?.updatedBy ?? null,
        subscription,
      };
    });
  }

  /**
   * Every employee across every factory, for the overseer's roster.
   *
   * Three things this deliberately does NOT do, each of them a cost the audit
   * measured on the per-factory pages:
   *   - no `photo`: a base64 data URL averages ~41 KB, so a 200-row page would
   *     be ~8 MB of JSON
   *   - no pay fields: this is a roster, not a payroll report
   *   - no dashboard fan-out: two queries total, not the 22 a factory dashboard
   *     costs
   *
   * Hard-capped at 200 rows a page regardless of what the caller asks for.
   */
  async listAllEmployees(params: {
    page?: number;
    limit?: number;
    search?: string;
    tenantId?: string;
    status?: string;
  }) {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 50)), 200);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (params.tenantId) where.tenantId = params.tenantId;
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { employeeId: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total, tenants] = await runUnscoped('all-employees', async () =>
      Promise.all([
        this.prisma.employee.findMany({
          where,
          orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
          skip,
          take: limit,
          select: {
            id: true,
            employeeId: true,
            name: true,
            department: true,
            jobTitle: true,
            status: true,
            tenantId: true,
            employmentStartDate: true,
          },
        }),
        this.prisma.employee.count({ where }),
        this.prisma.tenant.findMany({ select: { id: true, name: true, code: true } }),
      ]),
    );

    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    // Grouped server-side so the client is not left joining two lists to
    // discover which factory a row belongs to.
    const groups = new Map<string, { tenant: unknown; employees: unknown[] }>();
    for (const row of rows) {
      const key = row.tenantId ?? 'unassigned';
      if (!groups.has(key)) {
        groups.set(key, {
          tenant: tenantById.get(key) ?? { id: null, name: 'بدون مصنع', code: '—' },
          employees: [],
        });
      }
      groups.get(key)!.employees.push(row);
    }

    return {
      groups: [...groups.values()],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /** Accounts belonging to one factory, for the Super Admin's management panel. */
  async listUsersFor(tenantId: string) {
    const users = await runUnscoped('tenant-users', () =>
      this.prisma.user.findMany({
        where: { tenantId },
        orderBy: { username: 'asc' },
        select: {
          id: true,
          username: true,
          email: true,
          status: true,
          lastLogin: true,
          createdAt: true,
          role: { select: { id: true, name: true } },
          // Never the passwordHash, and never the permission matrix: this is a
          // roster of who can sign in, not a copy of the credential store.
        },
      }),
    );

    return users;
  }

  /** The full catalogue annotated with what this factory holds — what the UI renders. */
  async viewFor(tenantId: string): Promise<TenantEntitlementView> {
    const enabled = await this.enabledPagesFor(tenantId);

    return {
      tenantId,
      enabledPages: [...enabled],
      modules: MODULES.map((module) => ({
        key: module.key,
        label: module.label,
        description: module.description,
        state: moduleState(module.key, enabled),
        pages: module.pages.map((page) => ({
          key: page.key,
          route: page.route,
          label: page.label,
          enabled: enabled.has(page.key),
        })),
      })),
    };
  }

  /**
   * Replaces a factory's page list wholesale.
   *
   * Unknown keys are rejected rather than stored: a typo that silently persists
   * would look like a granted page that never works, and would survive every
   * later edit.
   */
  async setPages(
    tenantId: string,
    pageKeys: string[],
    actor?: string,
  ): Promise<TenantEntitlementView> {
    const unknown = pageKeys.filter((key) => !isKnownPage(key));
    if (unknown.length) {
      throw new BadRequestException(`Unknown page keys: ${unknown.join(', ')}`);
    }

    const unique = [...new Set(pageKeys)];

    // Written under the factory's own scope so the row is stamped and filtered
    // like every other tenant-scoped row, rather than relying on the caller's
    // super-admin bypass to do the right thing.
    await runWithTenant({ tenantId, bypass: false, actor: actor ?? 'superadmin' }, () =>
      this.prisma.tenantEntitlement.upsert({
        where: { tenantId },
        create: { tenantId, enabledPages: unique, updatedBy: actor ?? null },
        update: { enabledPages: unique, updatedBy: actor ?? null },
      }),
    );

    await this.cache.del(this.cacheKey(tenantId));
    this.logger.log(
      `Entitlements for factory ${tenantId} set to ${unique.length} pages by ${actor ?? 'unknown'}`,
    );

    return this.viewFor(tenantId);
  }

  /** Enables or disables every page in a module, leaving other modules alone. */
  async setModule(
    tenantId: string,
    moduleKey: string,
    enabled: boolean,
    actor?: string,
  ): Promise<TenantEntitlementView> {
    const keys = pageKeysForModule(moduleKey);
    if (keys.length === 0) {
      throw new BadRequestException(`Unknown module: ${moduleKey}`);
    }

    const current = await this.enabledPagesFor(tenantId);
    for (const key of keys) {
      if (enabled) current.add(key);
      else current.delete(key);
    }

    return this.setPages(tenantId, [...current], actor);
  }

  /** Turns one page on or off without touching the rest of its module. */
  async setPage(
    tenantId: string,
    pageKey: string,
    enabled: boolean,
    actor?: string,
  ): Promise<TenantEntitlementView> {
    if (!isKnownPage(pageKey)) {
      throw new BadRequestException(`Unknown page: ${pageKey}`);
    }

    const current = await this.enabledPagesFor(tenantId);
    if (enabled) current.add(pageKey);
    else current.delete(pageKey);

    return this.setPages(tenantId, [...current], actor);
  }

  /** This factory's subscription view, or null when the Super Admin never set one. */
  async getSubscription(tenantId: string): Promise<SubscriptionView | null> {
    const row = await this.subscriptionRowFor(tenantId);
    return this.subscriptionViewFor(row);
  }

  /**
   * (Re)starts a factory's subscription. months=1 → شهر, months=12 → سنة,
   * starting now; or pass an explicit endsAt ISO date. Writes are audited by
   * the controller. The factory entitlement cache is dropped so expiry and
   * renewal take effect on the next request (≤30s via TTL otherwise).
   */
  async setSubscription(
    tenantId: string,
    input: { months?: number; endsAt?: string },
    actor?: string,
  ): Promise<SubscriptionView> {
    const now = new Date();
    let startsAt = now;
    let endsAt: Date;
    let plan: string;

    if (input.months !== undefined) {
      if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) {
        throw new BadRequestException('months must be an integer between 1 and 60');
      }
      endsAt = new Date(now);
      endsAt.setMonth(endsAt.getMonth() + input.months);
      plan = input.months === 12 ? 'yearly' : input.months === 1 ? 'monthly' : 'custom';
    } else if (input.endsAt !== undefined) {
      endsAt = new Date(input.endsAt);
      if (Number.isNaN(endsAt.getTime())) {
        throw new BadRequestException('endsAt must be a valid ISO date');
      }
      plan = 'custom';
    } else {
      throw new BadRequestException('Provide months or endsAt');
    }

    const row = await runWithTenant(
      { tenantId, bypass: false, actor: actor ?? 'superadmin' },
      () =>
        this.prisma.tenantSubscription.upsert({
          where: { tenantId },
          create: { tenantId, plan, startsAt, endsAt, updatedBy: actor ?? null },
          update: { plan, startsAt, endsAt, updatedBy: actor ?? null },
        }),
    );

    await this.cache.del(this.cacheKey(tenantId));
    this.logger.log(
      `Subscription for factory ${tenantId} set to ${plan} until ${endsAt.toISOString()} by ${actor ?? 'unknown'}`,
    );

    const view = this.subscriptionViewFor(row, new Date());
    if (!view) throw new BadRequestException('Could not read back subscription');
    return view;
  }

  // ── per-admin entitlements ─────────────────────────────────────────────
  //
  // One row per admin account (userId). Effective access for an admin =
  // factory pages that THE USER ALSO holds. A missing row (or a missing
  // table, handled like the factory one) means "inherit the whole factory
  // grant", so a factory with no per-user configuration keeps behaving
  // exactly as it always has. This is what the Super Admin UI wrote the
  // "each admin has his own permissions" screen against.

  private userCacheKey(userId: string): string {
    return `user-entitlements:${userId}`;
  }

  /**
   * The pages one admin account effectively holds — independent per-admin.
   * A missing row (first time) inherits the factory grant for backward
   * compatibility, but once the superadmin touches this admin (any toggle),
   * the row becomes the source of truth and is NOT clamped by the factory.
   * This is what "each admin has his own permissions" means.
   */
  async enabledPagesForUser(
    userId: string,
    tenantId: string,
  ): Promise<Set<string>> {
    const cached = await this.cache.getJson<string[]>(this.userCacheKey(userId));
    if (cached) return new Set(cached);

    const row = await runUnscoped('user-entitlements-read', async () => {
      try {
        return await this.prisma.userEntitlement.findUnique({
          where: { userId },
          select: { enabledPages: true },
        });
      } catch (error) {
        if (this.isMissingTable(error)) {
          this.logger.warn(
            'user_entitlements is missing — run `prisma migrate deploy`. ' +
              'Every admin inherits their factory grant until it exists.',
          );
          return null;
        }
        throw error;
      }
    });

    // No per-admin row yet → inherit factory (first-time default)
    if (!row) {
      const factory = await this.enabledPagesFor(tenantId);
      await this.cache.setJson(this.userCacheKey(userId), [...factory], CACHE_TTL_SECONDS);
      return factory;
    }

    // Has a row → this admin's own list is the truth (no factory clamp)
    const effective = new Set(row.enabledPages);
    await this.cache.setJson(this.userCacheKey(userId), [...effective], CACHE_TTL_SECONDS);
    return effective;
  }

  /** Whether one admin account may reach one page. */
  async isPageEnabledForUser(
    userId: string,
    tenantId: string,
    pageKey: string,
  ): Promise<boolean> {
    return (await this.enabledPagesForUser(userId, tenantId)).has(pageKey);
  }

  /** The catalogue view computed against one admin's effective pages. */
  async viewForUser(
    userId: string,
    tenantId: string,
  ): Promise<TenantEntitlementView> {
    const enabled = await this.enabledPagesForUser(userId, tenantId);
    return {
      tenantId,
      enabledPages: [...enabled],
      modules: MODULES.map((module) => ({
        key: module.key,
        label: module.label,
        description: module.description,
        state: moduleState(module.key, enabled),
        pages: module.pages.map((page) => ({
          key: page.key,
          route: page.route,
          label: page.label,
          enabled: enabled.has(page.key),
        })),
      })),
    };
  }

  /**
   * Replaces one admin's page list wholesale — no factory clamp.
   * The superadmin decides exactly what this admin sees.
   */
  async setUserPages(
    tenantId: string,
    userId: string,
    pageKeys: string[],
    actor?: string,
  ): Promise<TenantEntitlementView> {
    const unknown = pageKeys.filter((key) => !isKnownPage(key));
    if (unknown.length) {
      throw new BadRequestException(`Unknown page keys: ${unknown.join(', ')}`);
    }

    const unique = [...new Set(pageKeys)];

    await runWithTenant(
      { tenantId, bypass: false, actor: actor ?? 'superadmin' },
      () =>
        this.prisma.userEntitlement.upsert({
          where: { userId },
          create: {
            userId,
            tenantId,
            enabledPages: unique,
            updatedBy: actor ?? null,
          },
          update: { enabledPages: unique, updatedBy: actor ?? null },
        }),
    );

    await this.cache.del(this.userCacheKey(userId));
    this.logger.log(
      `Per-admin entitlements for ${userId} in factory ${tenantId} set to ` +
        `${unique.length} pages by ${actor ?? 'unknown'}`,
    );

    return this.viewForUser(userId, tenantId);
  }

  /** Toggles a whole module for one admin, leaving other pages alone. */
  async setUserModule(
    tenantId: string,
    userId: string,
    moduleKey: string,
    enabled: boolean,
    actor?: string,
  ): Promise<TenantEntitlementView> {
    const keys = pageKeysForModule(moduleKey);
    if (keys.length === 0) {
      throw new BadRequestException(`Unknown module: ${moduleKey}`);
    }

    const current = await this.enabledPagesForUser(userId, tenantId);
    for (const key of keys) {
      if (enabled) current.add(key);
      else current.delete(key);
    }

    return this.setUserPages(tenantId, userId, [...current], actor);
  }

  /** Turns one page on or off for one admin. */
  async setUserPage(
    tenantId: string,
    userId: string,
    pageKey: string,
    enabled: boolean,
    actor?: string,
  ): Promise<TenantEntitlementView> {
    if (!isKnownPage(pageKey)) {
      throw new BadRequestException(`Unknown page: ${pageKey}`);
    }

    const current = await this.enabledPagesForUser(userId, tenantId);
    if (enabled) current.add(pageKey);
    else current.delete(pageKey);

    return this.setUserPages(tenantId, userId, [...current], actor);
  }
}
