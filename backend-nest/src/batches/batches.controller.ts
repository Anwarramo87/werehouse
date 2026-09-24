import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BatchesService } from './batches.service';
import { ExpiryService } from './expiry.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { BatchQueryDto } from './dto/batch-query.dto';
import { BatchStatusDto } from './dto/batch-status.dto';
import { AllocateBatchDto } from './dto/allocate-batch.dto';
import { BulkScanDto } from './dto/bulk-scan.dto';
import { CreateExpiryRuleDto } from './dto/create-expiry-rule.dto';
import { UpdateExpiryRuleDto } from './dto/update-expiry-rule.dto';

@ApiTags('batches')
@ApiCookieAuth()
@Controller('batches')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('inventory.batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly expiry: ExpiryService,
  ) {}

  // ------------------------------------------------------------------ batches

  @Get()
  @Permissions('view_inventory')
  list(@Query() query: BatchQueryDto) {
    return this.batches.list(query);
  }

  /**
   * Scanner entry point. Declared before `:batchId` so the literal path is not
   * swallowed by the parameterised one.
   */
  @Get('scan/:code')
  @Permissions('view_inventory')
  scan(@Param('code') code: string) {
    return this.batches.findByBarcode(code);
  }

  /**
   * Bulk resolution for an RFID portal or a batched barcode sweep.
   *
   * Declared before `:batchId` so the literal path is not swallowed.
   */
  @Post('scan/bulk')
  @Permissions('view_inventory')
  bulkScan(@Body() dto: BulkScanDto) {
    return this.batches.findManyByBarcode(dto.codes, {
      readerLocation: dto.readerLocation,
      source: dto.source,
    });
  }

  @Post('allocate')
  @Permissions('view_inventory')
  allocate(@Body() dto: AllocateBatchDto) {
    return this.batches.allocate(dto);
  }

  // -------------------------------------------------------------- expiry board
  // The expiry page is sold separately from the batches page, so each handler
  // overrides the class-level inventory.batches requirement.

  @Get('expiry/dashboard')
  @RequiresPage('inventory.expiry')
  @Permissions('view_inventory')
  expiryDashboard(@Query('horizonDays') horizonDays?: string) {
    return this.expiry.dashboard({
      horizonDays: horizonDays ? Number(horizonDays) : undefined,
    });
  }

  @Post('expiry/scan')
  @RequiresPage('inventory.expiry')
  @Permissions('edit_inventory')
  runExpiryScan() {
    return this.expiry.scan();
  }

  @Get('expiry/rules')
  @RequiresPage('inventory.expiry')
  @Permissions('view_inventory')
  listRules() {
    return this.expiry.listRules();
  }

  @Post('expiry/rules')
  @RequiresPage('inventory.expiry')
  @Permissions('edit_inventory')
  createRule(@Body() dto: CreateExpiryRuleDto) {
    return this.expiry.createRule(dto);
  }

  @Put('expiry/rules/:ruleId')
  @RequiresPage('inventory.expiry')
  @Permissions('edit_inventory')
  updateRule(@Param('ruleId') ruleId: string, @Body() dto: UpdateExpiryRuleDto) {
    return this.expiry.updateRule(ruleId, dto);
  }

  @Delete('expiry/rules/:ruleId')
  @RequiresPage('inventory.expiry')
  @Permissions('edit_inventory')
  deleteRule(@Param('ruleId') ruleId: string) {
    return this.expiry.deleteRule(ruleId);
  }

  // ------------------------------------------------------------------- labels

  @Post('labels')
  @Permissions('view_inventory')
  labels(@Body() body: { batchIds: string[] }) {
    return this.batches.labels(body.batchIds ?? []);
  }

  @Get(':batchId/label')
  @Permissions('view_inventory')
  label(@Param('batchId') batchId: string) {
    return this.batches.label(batchId);
  }

  // ------------------------------------------------------------- single batch

  @Get(':batchId')
  @Permissions('view_inventory')
  get(@Param('batchId') batchId: string) {
    return this.batches.get(batchId);
  }

  @Post()
  @Permissions('edit_inventory')
  create(
    @Body() dto: CreateBatchDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.batches.create(dto, user, req);
  }

  @Put(':batchId')
  @Permissions('edit_inventory')
  update(
    @Param('batchId') batchId: string,
    @Body() dto: UpdateBatchDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.batches.update(batchId, dto, user, req);
  }

  @Put(':batchId/status')
  @Permissions('edit_inventory')
  setStatus(
    @Param('batchId') batchId: string,
    @Body() dto: BatchStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.batches.setStatus(batchId, dto, user, req);
  }
}
