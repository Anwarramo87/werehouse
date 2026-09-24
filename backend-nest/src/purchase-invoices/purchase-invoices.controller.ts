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
import { PurchaseInvoicesService } from './purchase-invoices.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreatePurchaseInvoiceDto } from './dto/create-purchase-invoice.dto';
import { UpdatePurchaseInvoiceDto } from './dto/update-purchase-invoice.dto';
import { PurchaseInvoiceQueryDto } from './dto/purchase-invoice-query.dto';
import { AddLandedCostDto } from './dto/add-landed-cost.dto';
import { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';

@ApiTags('purchase-invoices')
@ApiCookieAuth()
@Controller('purchasing/invoices')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('purchasing.invoices')
export class PurchaseInvoicesController {
  constructor(private readonly invoices: PurchaseInvoicesService) {}

  @Get()
  @Permissions('view_purchasing')
  list(@Query() query: PurchaseInvoiceQueryDto) {
    return this.invoices.list(query);
  }

  /** Draft payload prefilled from a PO — the "bill this order" button. */
  @Get('from-order/:purchaseOrderId')
  @Permissions('view_purchasing')
  fromOrder(@Param('purchaseOrderId') purchaseOrderId: string) {
    return this.invoices.fromPurchaseOrder(purchaseOrderId);
  }

  @Get(':invoiceId')
  @Permissions('view_purchasing')
  get(@Param('invoiceId') invoiceId: string) {
    return this.invoices.get(invoiceId);
  }

  @Post()
  @Permissions('edit_purchasing')
  create(
    @Body() dto: CreatePurchaseInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.create(dto, user, req);
  }

  @Put(':invoiceId')
  @Permissions('edit_purchasing')
  update(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: UpdatePurchaseInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.update(invoiceId, dto, user, req);
  }

  @Delete(':invoiceId')
  @Permissions('edit_purchasing')
  remove(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.remove(invoiceId, user, req);
  }

  /** Moves stock, creates batches, revalues cost. The point of no return. */
  @Post(':invoiceId/post')
  @Permissions('edit_purchasing')
  post(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.post(invoiceId, user, req);
  }

  @Post(':invoiceId/cancel')
  @Permissions('edit_purchasing')
  cancel(
    @Param('invoiceId') invoiceId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.cancel(invoiceId, body?.reason ?? 'Cancelled by user', user, req);
  }

  @Post(':invoiceId/landed-costs')
  @Permissions('edit_purchasing')
  addLandedCost(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: AddLandedCostDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.addLandedCost(invoiceId, dto, user, req);
  }

  @Delete(':invoiceId/landed-costs/:landedCostId')
  @Permissions('edit_purchasing')
  removeLandedCost(
    @Param('invoiceId') invoiceId: string,
    @Param('landedCostId') landedCostId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.removeLandedCost(invoiceId, landedCostId, user, req);
  }

  @Post(':invoiceId/payments')
  @Permissions('edit_purchasing')
  addPayment(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreatePurchasePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.addPayment(invoiceId, dto, user, req);
  }
}
