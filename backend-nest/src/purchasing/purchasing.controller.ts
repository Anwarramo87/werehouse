import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { PurchasingService } from './purchasing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceiveGoodsDto } from './dto/receive-goods.dto';
import { PurchaseOrderQueryDto } from './dto/purchase-order-query.dto';

@ApiTags('purchasing')
@ApiCookieAuth()
@Controller('purchasing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchasingController {
  constructor(private readonly purchasingService: PurchasingService) {}

  // suppliers
  @Get('suppliers')
  @Permissions('view_purchasing')
  listSuppliers(@Query() query: { page?: string | number; limit?: string | number; search?: string; status?: string }) {
    return this.purchasingService.listSuppliers(query);
  }

  @Get('suppliers/:supplierId')
  @Permissions('view_purchasing')
  getSupplier(@Param('supplierId') supplierId: string) {
    return this.purchasingService.getSupplier(supplierId);
  }

  @Post('suppliers')
  @Permissions('edit_purchasing')
  createSupplier(@Body() dto: CreateSupplierDto) {
    return this.purchasingService.createSupplier(dto);
  }

  @Put('suppliers/:supplierId')
  @Permissions('edit_purchasing')
  updateSupplier(@Param('supplierId') supplierId: string, @Body() dto: UpdateSupplierDto) {
    return this.purchasingService.updateSupplier(supplierId, dto);
  }

  @Delete('suppliers/:supplierId')
  @Permissions('edit_purchasing')
  removeSupplier(@Param('supplierId') supplierId: string) {
    return this.purchasingService.removeSupplier(supplierId);
  }

  // purchase orders
  @Get('purchase-orders')
  @Permissions('view_purchasing')
  listPurchaseOrders(@Query() query: PurchaseOrderQueryDto) {
    return this.purchasingService.listPurchaseOrders(query);
  }

  @Get('purchase-orders/:purchaseOrderId')
  @Permissions('view_purchasing')
  getPurchaseOrder(@Param('purchaseOrderId') purchaseOrderId: string) {
    return this.purchasingService.getPurchaseOrder(purchaseOrderId);
  }

  @Post('purchase-orders')
  @Permissions('edit_purchasing')
  createPurchaseOrder(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchasingService.createPurchaseOrder(dto, user.userId);
  }

  @Put('purchase-orders/:purchaseOrderId')
  @Permissions('edit_purchasing')
  updatePurchaseOrder(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasingService.updatePurchaseOrder(purchaseOrderId, dto, user.userId);
  }

  @Put('purchase-orders/:purchaseOrderId/status')
  @Permissions('edit_purchasing')
  changeStatus(@Param('purchaseOrderId') purchaseOrderId: string, @Body() body: { status: string }) {
    return this.purchasingService.changePurchaseOrderStatus(purchaseOrderId, body.status);
  }

  @Post('purchase-orders/:purchaseOrderId/receive')
  @Permissions('edit_purchasing')
  receiveGoods(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: ReceiveGoodsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasingService.receiveGoods(purchaseOrderId, dto, user.userId);
  }

  @Delete('purchase-orders/:purchaseOrderId')
  @Permissions('edit_purchasing')
  removePurchaseOrder(@Param('purchaseOrderId') purchaseOrderId: string) {
    return this.purchasingService.removePurchaseOrder(purchaseOrderId);
  }
}
