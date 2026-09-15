import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PickStatus, ShipmentStatus } from '@prisma/client';
import { PickingService } from './picking.service';
import { ShippingService } from './shipping.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreatePickListDto } from './dto/create-pick-list.dto';
import { RecordPicksDto } from './dto/record-picks.dto';
import { CreateCarrierDto } from './dto/create-carrier.dto';
import { CreatePackageDto } from './dto/create-package.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';

@ApiTags('fulfillment')
@ApiCookieAuth()
@Controller('fulfillment')
@UseGuards(JwtAuthGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('fulfillment.picking')
export class FulfillmentController {
  constructor(
    private readonly picking: PickingService,
    private readonly shipping: ShippingService,
  ) {}

  // ------------------------------------------------------------------ picking

  @Get('pick-lists')
  @Permissions('view_sales')
  listPickLists(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: PickStatus,
    @Query('assignedTo') assignedTo?: string,
  ) {
    return this.picking.list({ page, limit, status, assignedTo });
  }

  @Get('pick-lists/performance')
  @Permissions('view_sales')
  pickPerformance(@Query('days') days?: string) {
    return this.picking.performance(days ? Number(days) : 30);
  }

  @Get('pick-lists/:pickListId')
  @Permissions('view_sales')
  getPickList(@Param('pickListId') pickListId: string) {
    return this.picking.get(pickListId);
  }

  @Post('pick-lists')
  @Permissions('edit_sales')
  createPickList(@Body() dto: CreatePickListDto, @CurrentUser() user: AuthenticatedUser) {
    return this.picking.create(dto, user);
  }

  @Post('pick-lists/:pickListId/assign')
  @Permissions('edit_sales')
  assign(@Param('pickListId') pickListId: string, @Body() body: { userId: string }) {
    return this.picking.assign(pickListId, body.userId);
  }

  @Post('pick-lists/:pickListId/start')
  @Permissions('edit_sales')
  start(@Param('pickListId') pickListId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.picking.start(pickListId, user);
  }

  @Post('pick-lists/:pickListId/record')
  @Permissions('edit_sales')
  recordPicks(
    @Param('pickListId') pickListId: string,
    @Body() dto: RecordPicksDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.picking.recordPicks(pickListId, dto, user);
  }

  @Post('pick-lists/:pickListId/cancel')
  @Permissions('edit_sales')
  cancelPickList(@Param('pickListId') pickListId: string, @Body() body: { reason?: string }) {
    return this.picking.cancel(pickListId, body?.reason);
  }

  // ----------------------------------------------------------------- carriers

  @Get('carriers')
  @RequiresPage('fulfillment.shipments') // carriers belong to the shipments page
  @Permissions('view_sales')
  listCarriers() {
    return this.shipping.listCarriers();
  }

  @Post('carriers')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  createCarrier(@Body() dto: CreateCarrierDto) {
    return this.shipping.createCarrier(dto);
  }

  @Put('carriers/:carrierId')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  updateCarrier(@Param('carrierId') carrierId: string, @Body() dto: Partial<CreateCarrierDto>) {
    return this.shipping.updateCarrier(carrierId, dto);
  }

  // ----------------------------------------------------------------- packages

  @Get('packages')
  @RequiresPage('fulfillment.shipments')
  @Permissions('view_sales')
  listPackages(
    @Query('shipmentId') shipmentId?: string,
    @Query('salesOrderId') salesOrderId?: string,
  ) {
    return this.shipping.listPackages(shipmentId, salesOrderId);
  }

  @Post('packages')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  createPackage(@Body() dto: CreatePackageDto, @CurrentUser() user: AuthenticatedUser) {
    return this.shipping.createPackage(dto, user);
  }

  // ---------------------------------------------------------------- shipments

  @Get('shipments')
  @RequiresPage('fulfillment.shipments')
  @Permissions('view_sales')
  listShipments(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: ShipmentStatus,
    @Query('carrierId') carrierId?: string,
  ) {
    return this.shipping.listShipments({ page, limit, status, carrierId });
  }

  @Get('shipments/:shipmentId')
  @RequiresPage('fulfillment.shipments')
  @Permissions('view_sales')
  getShipment(@Param('shipmentId') shipmentId: string) {
    return this.shipping.getShipment(shipmentId);
  }

  @Post('shipments')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  createShipment(@Body() dto: CreateShipmentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.shipping.createShipment(dto, user);
  }

  /** Renders the shipping label (Code128 SVG + payload) and marks it LABELED. */
  @Post('shipments/:shipmentId/label')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  generateLabel(
    @Param('shipmentId') shipmentId: string,
    @Body() body: { format?: 'code128' | 'qr' },
  ) {
    return this.shipping.generateLabel(shipmentId, body?.format ?? 'code128');
  }

  @Put('shipments/:shipmentId/status')
  @RequiresPage('fulfillment.shipments')
  @Permissions('edit_sales')
  updateStatus(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: UpdateShipmentStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shipping.updateStatus(shipmentId, dto, user);
  }
}
