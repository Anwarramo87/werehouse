import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ManufacturingService } from './manufacturing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import {
  CreateBOMDto,
  UpdateBOMDto,
  CreateProductionOrderDto,
  CompleteProductionOrderDto,
  ProductionOrderQueryDto,
} from './dto/manufacturing.dto';

@Controller('manufacturing')
@UseGuards(JwtAuthGuard)
export class ManufacturingController {
  constructor(private readonly manufacturing: ManufacturingService) {}

  // -------------------------------------------------------------------------
  // BOM endpoints — IMPORTANT: static routes BEFORE parameterized ones
  // -------------------------------------------------------------------------

  @Post('bom')
  createBOM(@Body() dto: CreateBOMDto, @CurrentUser() user: AuthenticatedUser) {
    return this.manufacturing.createBOM(dto, user.userId);
  }

  /** Static route — must come before :sku to prevent "list" being caught as a sku */
  @Get('bom/list/active')
  listActiveBOMs() {
    return this.manufacturing.listActiveBOMs();
  }

  /** Parameterized — matches any sku EXCEPT "list" (already caught above) */
  @Get('bom/:sku')
  getBOMForProduct(@Param('sku') sku: string) {
    return this.manufacturing.getBOMForProduct(sku);
  }

  @Get('bom/:sku/history')
  listBOMsForProduct(@Param('sku') sku: string) {
    return this.manufacturing.listBOMsForProduct(sku);
  }

  @Put('bom/:id')
  updateBOM(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBOMDto,
  ) {
    return this.manufacturing.updateBOM(id, dto);
  }

  /** Cost calculation — uses BOM UUID not sku */
  @Get('bom/cost/:id')
  calculateBOMCost(@Param('id', ParseUUIDPipe) id: string) {
    return this.manufacturing.calculateBOMCost(id);
  }

  // -------------------------------------------------------------------------
  // Production Order endpoints
  // -------------------------------------------------------------------------

  @Post('orders')
  createOrder(
    @Body() dto: CreateProductionOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.manufacturing.createProductionOrder(dto, user.userId);
  }

  @Get('orders')
  listOrders(@Query() query: ProductionOrderQueryDto) {
    return this.manufacturing.listProductionOrders(query);
  }

  @Get('summary')
  summary() {
    return this.manufacturing.getManufacturingSummary();
  }

  @Get('orders/:id')
  getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.manufacturing.getProductionOrder(id);
  }

  @Patch('orders/:id/start')
  startOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.manufacturing.startProductionOrder(id, user.userId);
  }

  @Patch('orders/:id/complete')
  completeOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteProductionOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.manufacturing.completeProductionOrder(id, dto, user.userId);
  }

  @Patch('orders/:id/cancel')
  cancelOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.manufacturing.cancelProductionOrder(id, user.userId);
  }
}
