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
import { SalesInvoicesService } from './sales-invoices.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { UpdateSalesInvoiceDto } from './dto/update-sales-invoice.dto';
import { SalesInvoiceQueryDto } from './dto/sales-invoice-query.dto';
import { CreateSalesInvoicePaymentDto } from './dto/create-sales-invoice-payment.dto';

@ApiTags('sales-invoices')
@ApiCookieAuth()
@Controller('sales/invoices')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('sales.invoices')
export class SalesInvoicesController {
  constructor(private readonly invoices: SalesInvoicesService) {}

  @Get()
  @Permissions('view_sales')
  list(@Query() query: SalesInvoiceQueryDto) {
    return this.invoices.list(query);
  }

  // Literal routes first: `delivery-notes` must not be read as an invoice id.
  @Get('delivery-notes')
  @Permissions('view_sales')
  listDeliveryNotes(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
  ) {
    return this.invoices.listDeliveryNotes({ page, limit, customerId, status });
  }

  @Post('delivery-notes/:noteId/delivered')
  @Permissions('edit_sales')
  markDelivered(
    @Param('noteId') noteId: string,
    @Body() body: { receivedBy?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.markDelivered(noteId, body?.receivedBy ?? '', user, req);
  }

  @Get('from-order/:salesOrderId')
  @Permissions('view_sales')
  fromOrder(@Param('salesOrderId') salesOrderId: string) {
    return this.invoices.fromSalesOrder(salesOrderId);
  }

  @Get(':invoiceId')
  @Permissions('view_sales')
  get(@Param('invoiceId') invoiceId: string) {
    return this.invoices.get(invoiceId);
  }

  @Post()
  @Permissions('edit_sales')
  create(
    @Body() dto: CreateSalesInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.create(dto, user, req);
  }

  @Put(':invoiceId')
  @Permissions('edit_sales')
  update(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: UpdateSalesInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.update(invoiceId, dto, user, req);
  }

  @Delete(':invoiceId')
  @Permissions('edit_sales')
  remove(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.remove(invoiceId, user, req);
  }

  /** Deducts stock via FEFO, issues the delivery note, freezes COGS. */
  @Post(':invoiceId/post')
  @Permissions('edit_sales')
  post(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.post(invoiceId, user, req);
  }

  @Post(':invoiceId/cancel')
  @Permissions('edit_sales')
  cancel(
    @Param('invoiceId') invoiceId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.cancel(invoiceId, body?.reason ?? 'Cancelled by user', user, req);
  }

  @Post(':invoiceId/payments')
  @Permissions('edit_sales')
  addPayment(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreateSalesInvoicePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.addPayment(invoiceId, dto, user, req);
  }
}
