import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { InventoryService } from './inventory.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateProductDto } from './dto/create-product.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ReserveStockDto } from './dto/reserve-stock.dto';
import { InventoryProductsQueryDto } from './dto/inventory-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

@ApiTags('inventory')
@ApiCookieAuth()
@Controller('inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ------------------------------------------------------------------ products

  @Get('products')
  @Permissions('view_inventory')
  listProducts(@Query() query: InventoryProductsQueryDto) {
    return this.inventoryService.listProducts(query);
  }

  @Post('products')
  @Permissions('edit_inventory')
  createProduct(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.createProduct(dto, user, req);
  }

  @Get('products/:productId')
  @Permissions('view_inventory')
  getProduct(@Param('productId') productId: string) {
    return this.inventoryService.getProduct(productId);
  }

  @Put('products/:productId')
  @Permissions('edit_inventory')
  updateProduct(
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.updateProduct(productId, dto, user, req);
  }

  @Delete('products/:productId')
  @Permissions('edit_inventory')
  deleteProduct(
    @Param('productId') productId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.deleteProduct(productId, user, req);
  }

  @Get('categories')
  @Permissions('view_inventory')
  listCategories() {
    return this.inventoryService.listCategories();
  }

  // --------------------------------------------------------------------- stock

  @Get('stock')
  @Permissions('view_inventory')
  listStock(@Query() query: { sku?: string; location?: string }) {
    return this.inventoryService.listStock(query);
  }

  @Get('stock/:sku')
  @Permissions('view_inventory')
  stockBySku(@Param('sku') sku: string) {
    return this.inventoryService.stockBySku(sku);
  }

  @Post('stock/adjust')
  @Permissions('edit_inventory')
  adjustStock(
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.adjustStock(dto, user, req);
  }

  @Post('stock/reserve')
  @Permissions('edit_inventory')
  reserveStock(
    @Body() dto: ReserveStockDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.reserveStock(dto, user, req);
  }

  @Post('stock/release')
  @Permissions('edit_inventory')
  releaseReservation(
    @Body() dto: ReserveStockDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.releaseReservation(dto, user, req);
  }

  // ---------------------------------------------------------------- movements

  @Get('movements')
  @Permissions('view_inventory')
  listMovements(@Query() query: StockMovementQueryDto) {
    return this.inventoryService.listMovements(query);
  }

  // ------------------------------------------------------------- low stock / stats

  @Get('alerts/low-stock')
  @Permissions('view_inventory')
  lowStock(@Query() query: { page?: number; limit?: number }) {
    return this.inventoryService.lowStockAlerts(query);
  }

  @Get('stats')
  @Permissions('view_inventory')
  stats() {
    return this.inventoryService.stats();
  }

  // --------------------------------------------------------------- warehouses

  @Get('warehouses')
  @Permissions('view_inventory')
  listWarehouses() {
    return this.inventoryService.listWarehouses();
  }

  @Post('warehouses')
  @Permissions('edit_inventory')
  createWarehouse(
    @Body() dto: CreateWarehouseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.createWarehouse(dto, user, req);
  }

  @Put('warehouses/:warehouseId')
  @Permissions('edit_inventory')
  updateWarehouse(
    @Param('warehouseId') warehouseId: string,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.updateWarehouse(warehouseId, dto, user, req);
  }

  @Delete('warehouses/:warehouseId')
  @Permissions('edit_inventory')
  removeWarehouse(
    @Param('warehouseId') warehouseId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.inventoryService.removeWarehouse(warehouseId, user, req);
  }
}
