import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { SalesService } from './sales.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { CreateSalesPaymentDto } from './dto/create-sales-payment.dto';
import { SalesOrderQueryDto } from './dto/sales-order-query.dto';

@ApiTags('sales')
@ApiCookieAuth()
@Controller('sales')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  // customers
  @Get('customers')
  @Permissions('view_sales')
  listCustomers(@Query() query: { page?: string | number; limit?: string | number; search?: string; status?: string }) {
    return this.salesService.listCustomers(query);
  }

  @Get('customers/:customerId')
  @Permissions('view_sales')
  getCustomer(@Param('customerId') customerId: string) {
    return this.salesService.getCustomer(customerId);
  }

  @Post('customers')
  @Permissions('edit_sales')
  createCustomer(@Body() dto: CreateCustomerDto) {
    return this.salesService.createCustomer(dto);
  }

  @Put('customers/:customerId')
  @Permissions('edit_sales')
  updateCustomer(@Param('customerId') customerId: string, @Body() dto: UpdateCustomerDto) {
    return this.salesService.updateCustomer(customerId, dto);
  }

  @Delete('customers/:customerId')
  @Permissions('edit_sales')
  removeCustomer(@Param('customerId') customerId: string) {
    return this.salesService.removeCustomer(customerId);
  }

  // sales orders
  @Get('orders')
  @Permissions('view_sales')
  listSalesOrders(@Query() query: SalesOrderQueryDto) {
    return this.salesService.listSalesOrders(query);
  }

  @Get('orders/:salesOrderId')
  @Permissions('view_sales')
  getSalesOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.salesService.getSalesOrder(salesOrderId);
  }

  @Post('orders')
  @Permissions('edit_sales')
  createSalesOrder(@Body() dto: CreateSalesOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesService.createSalesOrder(dto, user.userId);
  }

  @Put('orders/:salesOrderId')
  @Permissions('edit_sales')
  updateSalesOrder(
    @Param('salesOrderId') salesOrderId: string,
    @Body() dto: UpdateSalesOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.updateSalesOrder(salesOrderId, dto, user.userId);
  }

  @Post('orders/:salesOrderId/confirm')
  @Permissions('edit_sales')
  confirmSalesOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.salesService.confirmSalesOrder(salesOrderId);
  }

  @Post('orders/:salesOrderId/deliver')
  @Permissions('edit_sales')
  deliverSalesOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.salesService.deliverSalesOrder(salesOrderId);
  }

  @Post('orders/:salesOrderId/cancel')
  @Permissions('edit_sales')
  cancelSalesOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.salesService.cancelSalesOrder(salesOrderId);
  }

  @Delete('orders/:salesOrderId')
  @Permissions('edit_sales')
  removeSalesOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.salesService.removeSalesOrder(salesOrderId);
  }

  // payments
  @Post('payments')
  @Permissions('edit_sales')
  createPayment(@Body() dto: CreateSalesPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesService.createPayment(dto, user.userId);
  }

  @Delete('payments/:paymentId')
  @Permissions('edit_sales')
  removePayment(@Param('paymentId') paymentId: string) {
    return this.salesService.removePayment(paymentId);
  }
}
