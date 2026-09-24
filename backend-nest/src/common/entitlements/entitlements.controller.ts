import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { IsArray, IsBoolean, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { SuperAdminGuard } from '../guards/superadmin.guard';
import { SetSubscriptionDto } from './dto/set-subscription.dto';
import { SetUserSubscriptionDto } from './dto/set-user-subscription.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { AuthenticatedUser } from '../types/authenticated-user.types';
import { AuditService } from '../services/audit.service';
import { ALWAYS_AVAILABLE_ROUTES, MODULES } from './catalogue';
import { EntitlementsService } from './entitlements.service';
import { TenantBackupService } from '../../backup/tenant-backup.service';

class SetPagesDto {
  @IsArray()
  @IsString({ each: true })
  pageKeys!: string[];
}

class ToggleDto {
  @IsString()
  key!: string;

  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true' || value === 1) return true;
    if (value === false || value === 'false' || value === 0) return false;
    return value;
  })
  @IsBoolean()
  enabled!: boolean;
}

@ApiTags('entitlements')
@ApiCookieAuth()
@Controller('entitlements')
@UseGuards(JwtAuthGuard)
export class EntitlementsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What the signed-in user's own factory holds.
   *
   * The frontend nav renders from this, so the menu and the API agree on one
   * source of truth instead of drifting apart in two hard-coded lists.
   */
  @Get('me')
  @ApiOperation({ summary: 'Modules and pages enabled for my factory' })
  async mine(@CurrentUser() user: AuthenticatedUser) {
    // The overseer belongs to no factory and is not gated by entitlements; it
    // gets the whole catalogue so its own navigation is complete.
    if (!user.tenantId) {
      return {
        tenantId: null,
        enabledPages: MODULES.flatMap((m) => m.pages.map((p) => p.key)),
        alwaysAvailable: ALWAYS_AVAILABLE_ROUTES,
        modules: MODULES.map((m) => ({
          key: m.key,
          label: m.label,
          description: m.description,
          state: 'all' as const,
          pages: m.pages.map((p) => ({ ...p, enabled: true })),
        })),
      };
    }

    // Per-admin view: this admin's own pages (superadmin sees all via bypass
    // in the guard; factory admins see exactly what was toggled for them).
    const view = await this.entitlements.viewForUser(user.userId, user.tenantId);
    return { ...view, alwaysAvailable: ALWAYS_AVAILABLE_ROUTES };
  }
}

@ApiTags('entitlements')
@ApiCookieAuth()
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class TenantEntitlementsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly backups: TenantBackupService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every factory, with what each one holds (super admin)' })
  list() {
    return this.entitlements.listTenants();
  }

  @Get('next-code')
  @ApiOperation({ summary: 'Next available sequential factory code (super admin)' })
  async nextCode() {
    return { code: await this.entitlements.getNextFactoryCode() };
  }

  @Post()
  @ApiOperation({
    summary: 'Create a factory (super admin)',
    description:
      'Zero-state: only the Tenant row is written — no departments, users, ' +
      'employees, or seed data. The factory starts with full page access ' +
      'until someone configures entitlements.',
  })
  async create(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const tenant = await this.entitlements.createTenant({
      name: dto.name,
      code: dto.code,
      description: dto.description,
    });
    this.audit.log(
      {
        action: 'factory.create',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenant.id,
        targetTenantId: tenant.id,
        metadata: { name: tenant.name, code: tenant.code },
      },
      req,
    );
    return tenant;
  }

  @Get('employees')
  @ApiOperation({ summary: 'Every employee across every factory (super admin)' })
  allEmployees(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
  ) {
    return this.entitlements.listAllEmployees({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      tenantId,
      status,
    });
  }

  // ── backups ────────────────────────────────────────────────────────────
  @Get('backups')
  @ApiOperation({ summary: 'Recent backup jobs across all factories (super admin)' })
  backupJobs() {
    return this.backups.listJobs();
  }

  @Get(':tenantId/backups')
  @ApiOperation({ summary: "A factory's stored backups (super admin)" })
  async factoryBackups(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return {
      current: this.backups.jobFor(tenantId),
      files: await this.backups.listFiles(tenantId),
    };
  }

  @Get(':tenantId/backups/files/:fileName')
  @ApiOperation({
    summary: 'Download one stored backup (super admin)',
    description:
      'Lets the stored file be pulled off the box without SSH. Storage.read ' +
      'already refuses any path outside the factory backup directory; the ' +
      'pattern guard here is a second, tighter net for a route parameter.',
  })
  async downloadBackupFile(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('fileName') fileName: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!/^snapshot-[\d-]+T[\d-]+(Z)?\.json$/.test(fileName)) {
      throw new BadRequestException('fileName must match snapshot-<stamp>.json');
    }
    const buffer = await this.backups.readFile(tenantId, fileName);
    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    return buffer;
  }

  @Post(':tenantId/backups')
  @ApiOperation({ summary: 'Start a backup for one factory (super admin)' })
  async startBackup(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // Returns as soon as the job is registered: a snapshot walks every model and
    // must not run inside the request.
    const job = await this.backups.enqueue(tenantId, user?.username);
    this.audit.log(
      {
        action: 'backup.start',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { jobId: job.id },
      },
      req,
    );
    return job;
  }

  @Get(':tenantId/users')
  @ApiOperation({ summary: "A factory's user accounts (super admin)" })
  users(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.entitlements.listUsersFor(tenantId);
  }

  @Get(':tenantId/entitlements')
  @ApiOperation({ summary: "A factory's modules and pages (super admin)" })
  view(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.entitlements.viewFor(tenantId);
  }

  @Put(':tenantId/entitlements')
  @ApiOperation({ summary: "Replace a factory's page list (super admin)" })
  async setPages(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetPagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setPages(tenantId, dto.pageKeys, user?.username);
    this.audit.log(
      {
        action: 'entitlements.replace',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { pageCount: dto.pageKeys.length, pageKeys: dto.pageKeys },
      },
      req,
    );
    return result;
  }

  @Put(':tenantId/entitlements/module')
  @ApiOperation({ summary: 'Enable or disable a whole module (super admin)' })
  async setModule(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: ToggleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setModule(
      tenantId,
      dto.key,
      dto.enabled,
      user?.username,
    );
    this.audit.log(
      {
        action: 'entitlements.module',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { module: dto.key, enabled: dto.enabled },
      },
      req,
    );
    return result;
  }

  @Put(':tenantId/entitlements/page')
  @ApiOperation({ summary: 'Enable or disable a single page (super admin)' })
  async setPage(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: ToggleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setPage(
      tenantId,
      dto.key,
      dto.enabled,
      user?.username,
    );
    this.audit.log(
      {
        action: 'entitlements.page',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenantId,
        metadata: { page: dto.key, enabled: dto.enabled },
      },
      req,
    );
    return result;
  }

  // ── subscription (time-boxed factory access) ──────────────────────────

  @Get(':tenantId/subscription')
  @ApiOperation({ summary: "One factory's subscription window (super admin)" })
  subscription(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.entitlements.getSubscription(tenantId);
  }

  @Put(':tenantId/subscription')
  @ApiOperation({ summary: 'Start/extend one factory subscription (super admin)' })
  async setSubscription(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setSubscription(
      tenantId,
      { months: dto.months, endsAt: dto.endsAt, permanent: dto.permanent },
      user?.username,
    );
    this.audit.log(
      {
        action: 'subscription.set',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: tenantId,
        targetTenantId: tenantId,
        metadata: { plan: result.plan, endsAt: result.endsAt },
      },
      req,
    );
    return result;
  }

  // ── per-admin (user-level) ────────────────────────────────────────────
  //
  // One admin of a factory, and the pages THAT ACCOUNT may use. Effective
  // access = factory pages the user also holds, so the Super Admin can now
  // hand a module to a single operator instead of lighting it up for every
  // operator in that factory. With no row the admin inherits the whole
  // factory grant, so factories that never configure per-user keep working
  // exactly as before.

  @Get(':tenantId/users/:userId/entitlements')
  @ApiOperation({ summary: "One admin's own modules and pages (super admin)" })
  viewForUser(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.entitlements.viewForUser(userId, tenantId);
  }

  @Put(':tenantId/users/:userId/entitlements')
  @ApiOperation({ summary: "Replace one admin's page list (super admin)" })
  async setUserPages(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetPagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setUserPages(
      tenantId,
      userId,
      dto.pageKeys,
      user?.username,
    );
    this.audit.log(
      {
        action: 'entitlements.user.replace',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'user',
        targetId: userId,
        targetTenantId: tenantId,
        metadata: { pageCount: dto.pageKeys.length, pageKeys: dto.pageKeys },
      },
      req,
    );
    return result;
  }

  @Put(':tenantId/users/:userId/entitlements/module')
  @ApiOperation({ summary: 'Enable or disable a whole module for one admin (super admin)' })
  async setUserModule(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ToggleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setUserModule(
      tenantId,
      userId,
      dto.key,
      dto.enabled,
      user?.username,
    );
    this.audit.log(
      {
        action: 'entitlements.user.module',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'user',
        targetId: userId,
        targetTenantId: tenantId,
        metadata: { module: dto.key, enabled: dto.enabled },
      },
      req,
    );
    return result;
  }

  @Put(':tenantId/users/:userId/entitlements/page')
  @ApiOperation({ summary: 'Enable or disable a single page for one admin (super admin)' })
  async setUserPage(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ToggleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setUserPage(
      tenantId,
      userId,
      dto.key,
      dto.enabled,
      user?.username,
    );
    this.audit.log(
      {
        action: 'entitlements.user.page',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'user',
        targetId: userId,
        targetTenantId: tenantId,
        metadata: { page: dto.key, enabled: dto.enabled },
      },
      req,
    );
    return result;
  }

  @Get(':tenantId/users/:userId/subscription')
  @ApiOperation({ summary: "One admin's own subscription window (super admin)" })
  userSubscription(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.entitlements.getUserSubscription(userId, tenantId);
  }

  @Put(':tenantId/users/:userId/subscription')
  @ApiOperation({ summary: 'Start/extend one admin subscription (super admin)' })
  async setUserSubscription(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.entitlements.setUserSubscription(
      tenantId,
      userId,
      { months: dto.months, days: dto.days, endsAt: dto.endsAt, permanent: dto.permanent },
      user?.username,
    );
    this.audit.log(
      {
        action: 'subscription.user.set',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'user',
        targetId: userId,
        targetTenantId: tenantId,
        metadata: { plan: result.plan, endsAt: result.endsAt },
      },
      req,
    );
    return result;
  }
}
