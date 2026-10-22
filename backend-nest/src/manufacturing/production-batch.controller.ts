import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ProductionStageType } from '@prisma/client';
import { ProductionBatchService } from './production-batch.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import {
  CalculateProductionCostDto,
  CompleteStageDto,
  CreateProductionBatchDto,
  CreateProductionWarehouseDto,
  CreateStockTransferDto,
  ProductionBatchQueryDto,
  ReturnStageDto,
  StartStageDto,
} from './dto/production-batch.dto';
import {
  PERM_CREATE_PRODUCTION,
  PERM_EDIT_PRODUCTION,
  PERM_MANAGE_PRODUCTION_WAREHOUSES,
  PERM_POST_PRODUCTION,
  PERM_PRINT_PRODUCTION,
  PERM_TRANSFER_STOCK,
  PERM_VIEW_PRODUCTION,
} from '../common/permissions/permission.constants';

/**
 * دفعة الإنتاج ومراحلها ومستودعاتها الفرعية.
 *
 * The permissions are split the way the brief asks: a production manager may
 * run batches, stages and warehouses, an accountant may READ the production
 * (to cost it) but may not run a stage, and neither of them may close a
 * financial period from here.
 */
@ApiTags('production-batches')
@ApiCookieAuth()
@Controller('manufacturing')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('production.stages')
export class ProductionBatchController {
  constructor(private readonly batches: ProductionBatchService) {}

  // ── dashboard ────────────────────────────────────────────────────────────

  /** GET /api/manufacturing/dashboard — لوحة الإنتاج */
  @Get('dashboard')
  @Permissions(PERM_VIEW_PRODUCTION)
  dashboard() {
    return this.batches.dashboard();
  }

  // ── batches ──────────────────────────────────────────────────────────────

  /** GET /api/manufacturing/batches — بحث وتصفية حسب الرقم أو المنتج أو المرحلة */
  @Get('batches')
  @Permissions(PERM_VIEW_PRODUCTION)
  list(@Query() query: ProductionBatchQueryDto) {
    return this.batches.listBatches(query);
  }

  /** POST /api/manufacturing/batches — إنشاء دفعة إنتاج برقم فريد تلقائي */
  @Post('batches')
  @Permissions(PERM_CREATE_PRODUCTION)
  create(
    @Body() dto: CreateProductionBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.createBatch(dto, user.userId);
  }

  /** GET /api/manufacturing/batches/:id — تفاصيل الدفعة وخط السير */
  @Get('batches/:id')
  @Permissions(PERM_VIEW_PRODUCTION)
  get(@Param('id') id: string) {
    return this.batches.getBatch(id);
  }

  // ── stages ───────────────────────────────────────────────────────────────

  /** POST /api/manufacturing/batches/:id/stages/:stage/start — استلام الدفعة */
  @Post('batches/:id/stages/:stage/start')
  @Permissions(PERM_EDIT_PRODUCTION)
  startStage(
    @Param('id') id: string,
    @Param('stage') stage: ProductionStageType,
    @Body() dto: StartStageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.startStage(id, stage, dto, user.userId);
  }

  /** POST /api/manufacturing/batches/:id/stages/:stage/complete — إنجاز المرحلة */
  @Post('batches/:id/stages/:stage/complete')
  @Permissions(PERM_EDIT_PRODUCTION)
  completeStage(
    @Param('id') id: string,
    @Param('stage') stage: ProductionStageType,
    @Body() dto: CompleteStageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.completeStage(id, stage, dto, user.userId);
  }

  /** POST /api/manufacturing/batches/:id/stages/return — إرجاع موثّق لمرحلة سابقة */
  @Post('batches/:id/stages/return')
  @Permissions(PERM_POST_PRODUCTION)
  returnStage(
    @Param('id') id: string,
    @Body() dto: ReturnStageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.returnToStage(id, dto, user.userId);
  }

  // ── costing ──────────────────────────────────────────────────────────────

  /** POST /api/manufacturing/batches/:id/cost — احتساب تكاليف الدفعة */
  @Post('batches/:id/cost')
  @Permissions(PERM_EDIT_PRODUCTION)
  calculateCost(
    @Param('id') id: string,
    @Body() dto: CalculateProductionCostDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.calculateCost(id, dto, user.userId);
  }

  /** POST /api/manufacturing/batches/:id/cost/lock — قفل التكلفة */
  @Post('batches/:id/cost/lock')
  @Permissions(PERM_POST_PRODUCTION)
  lockCost(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.batches.lockCost(id, user.userId);
  }

  /** POST /api/manufacturing/batches/:id/cost/unlock — فتح قفل التكلفة */
  @Post('batches/:id/cost/unlock')
  @Permissions(PERM_EDIT_PRODUCTION)
  unlockCost(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.batches.unlockCost(id, user.userId);
  }

  /** GET /api/manufacturing/batches/:id/cost-report — تقرير تكلفة الدفعة */
  @Get('batches/:id/cost-report')
  @Permissions(PERM_PRINT_PRODUCTION)
  costReport(@Param('id') id: string) {
    return this.batches.costReport(id);
  }

  // ── sub-warehouses ───────────────────────────────────────────────────────

  /** GET /api/manufacturing/warehouses — المستودعات الفرعية وأرصدتها */
  @Get('warehouses')
  @Permissions(PERM_VIEW_PRODUCTION)
  listWarehouses() {
    return this.batches.listWarehouses();
  }

  /** POST /api/manufacturing/warehouses — إنشاء مستودع إنتاج */
  @Post('warehouses')
  @Permissions(PERM_MANAGE_PRODUCTION_WAREHOUSES)
  createWarehouse(
    @Body() dto: CreateProductionWarehouseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.createWarehouse(dto, user.userId);
  }

  /** GET /api/manufacturing/warehouses/balances — أرصدة كل مستودع */
  @Get('warehouses/balances')
  @Permissions(PERM_VIEW_PRODUCTION)
  balances(@Query('warehouseId') warehouseId?: string) {
    return this.batches.warehouseBalances(warehouseId);
  }

  // ── stock transfers ──────────────────────────────────────────────────────

  /** POST /api/manufacturing/transfers — نقل مخزون بين المستودعات */
  @Post('transfers')
  @Permissions(PERM_TRANSFER_STOCK)
  createTransfer(
    @Body() dto: CreateStockTransferDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.createTransfer(dto, user.userId);
  }

  /** GET /api/manufacturing/transfers — سجل حركات النقل */
  @Get('transfers')
  @Permissions(PERM_VIEW_PRODUCTION)
  listTransfers(
    @Query() query: { sku?: string; from?: string; to?: string },
  ) {
    return this.batches.listTransfers(query);
  }
}
