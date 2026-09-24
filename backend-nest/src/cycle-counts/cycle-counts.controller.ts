import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CycleCountsService } from './cycle-counts.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateCycleCountDto } from './dto/create-cycle-count.dto';
import { RecordCountDto } from './dto/record-count.dto';
import { CycleCountQueryDto } from './dto/cycle-count-query.dto';

@ApiTags('cycle-counts')
@ApiCookieAuth()
@Controller('cycle-counts')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('inventory.counts')
export class CycleCountsController {
  constructor(private readonly counts: CycleCountsService) {}

  @Get()
  @Permissions('view_inventory')
  list(@Query() query: CycleCountQueryDto) {
    return this.counts.list(query);
  }

  /** Recomputes ABC classes — the input to `scope: 'abc'` counts. */
  @Post('abc-analysis')
  @Permissions('edit_inventory')
  classifyAbc(@Body() body: { days?: number }) {
    return this.counts.classifyAbc(body?.days ?? 90);
  }

  @Get(':countId')
  @Permissions('view_inventory')
  get(@Param('countId') countId: string) {
    return this.counts.get(countId);
  }

  @Get(':countId/variances')
  @Permissions('view_inventory')
  variances(@Param('countId') countId: string) {
    return this.counts.variances(countId);
  }

  @Post()
  @Permissions('edit_inventory')
  create(
    @Body() dto: CreateCycleCountDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.counts.create(dto, user, req);
  }

  @Post(':countId/start')
  @Permissions('edit_inventory')
  start(
    @Param('countId') countId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.counts.start(countId, user, req);
  }

  @Post(':countId/record')
  @Permissions('edit_inventory')
  record(
    @Param('countId') countId: string,
    @Body() dto: RecordCountDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.counts.record(countId, dto, user, req);
  }

  /** Posts the variances to the stock ledger. Irreversible. */
  @Post(':countId/approve')
  @Permissions('edit_inventory')
  approve(
    @Param('countId') countId: string,
    @Body() body: { force?: boolean },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.counts.approve(countId, { force: body?.force }, user, req);
  }

  @Post(':countId/cancel')
  @Permissions('edit_inventory')
  cancel(
    @Param('countId') countId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.counts.cancel(countId, body?.reason ?? 'Cancelled by user', user, req);
  }
}
