import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { QcStatus } from '@prisma/client';
import { Request } from 'express';
import { QualityService } from './quality.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { RecordInspectionDto } from './dto/record-inspection.dto';

@ApiTags('quality')
@ApiCookieAuth()
@Controller('quality')
@UseGuards(JwtAuthGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('inventory.quality')
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get('inspections')
  @Permissions('view_inventory')
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: QcStatus,
    @Query('sku') sku?: string,
  ) {
    return this.quality.list({ page, limit, status, sku });
  }

  /** The inspector's queue: open inspections plus everything in quarantine. */
  @Get('pending')
  @Permissions('view_inventory')
  pending() {
    return this.quality.pending();
  }

  @Get('inspections/:inspectionId')
  @Permissions('view_inventory')
  get(@Param('inspectionId') inspectionId: string) {
    return this.quality.get(inspectionId);
  }

  @Post('inspections')
  @Permissions('edit_inventory')
  create(
    @Body() dto: CreateInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.quality.create(dto, user, req);
  }

  @Post('inspections/:inspectionId/record')
  @Permissions('edit_inventory')
  record(
    @Param('inspectionId') inspectionId: string,
    @Body() dto: RecordInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.quality.record(inspectionId, dto, user, req);
  }
}
