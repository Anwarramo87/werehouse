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
import {
  PERM_CANCEL_PURCHASING,
  PERM_DELETE_PURCHASING,
  PERM_EDIT_PURCHASING,
  PERM_POST_PURCHASING,
  PERM_PRINT_PURCHASING,
  PERM_VIEW_PURCHASING,
} from '../common/permissions/permission.constants';

@ApiTags('purchase-invoices')
@ApiCookieAuth()
@Controller('purchasing/invoices')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage(['purchasing.orders', 'purchasing.invoices'])
export class PurchaseInvoicesController {
  constructor(private readonly invoices: PurchaseInvoicesService) {}

  @Get()
  @Permissions(PERM_VIEW_PURCHASING)
  list(@Query() query: PurchaseInvoiceQueryDto) {
    return this.invoices.list(query);
  }

  /** Draft payload prefilled from a PO — the "bill this order" button. */
  @Get('from-order/:purchaseOrderId')
  @Permissions(PERM_VIEW_PURCHASING)
  fromOrder(@Param('purchaseOrderId') purchaseOrderId: string) {
    return this.invoices.fromPurchaseOrder(purchaseOrderId);
  }

  @Get(':invoiceId')
  @Permissions(PERM_VIEW_PURCHASING)
  get(@Param('invoiceId') invoiceId: string) {
    return this.invoices.get(invoiceId);
  }

  @Post()
  @Permissions(PERM_EDIT_PURCHASING)
  create(
    @Body() dto: CreatePurchaseInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.create(dto, user, req);
  }

  @Put(':invoiceId')
  @Permissions(PERM_EDIT_PURCHASING)
  update(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: UpdatePurchaseInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.update(invoiceId, dto, user, req);
  }

  @Delete(':invoiceId')
  @Permissions(PERM_DELETE_PURCHASING)
  remove(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.remove(invoiceId, user, req);
  }

  /** Moves stock, creates batches, revalues cost. The point of no return. */
  @Post(':invoiceId/post')
  @Permissions(PERM_POST_PURCHASING)
  post(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.post(invoiceId, user, req);
  }

  @Post(':invoiceId/cancel')
  @Permissions(PERM_CANCEL_PURCHASING)
  cancel(
    @Param('invoiceId') invoiceId: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.cancel(invoiceId, body?.reason ?? 'Cancelled by user', user, req);
  }

  @Post(':invoiceId/landed-costs')
  @Permissions(PERM_EDIT_PURCHASING)
  addLandedCost(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: AddLandedCostDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.addLandedCost(invoiceId, dto, user, req);
  }

  @Delete(':invoiceId/landed-costs/:landedCostId')
  @Permissions(PERM_EDIT_PURCHASING)
  removeLandedCost(
    @Param('invoiceId') invoiceId: string,
    @Param('landedCostId') landedCostId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.removeLandedCost(invoiceId, landedCostId, user, req);
  }

  @Post(':invoiceId/payments')
  @Permissions(PERM_EDIT_PURCHASING)
  addPayment(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CreatePurchasePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.invoices.addPayment(invoiceId, dto, user, req);
  }

  /**
   * Print/export payload for one invoice.
   *
   * The currency is explicit in every money field, including the exchange
   * rate and the rate's date, so a printed USD invoice states what it was
   * priced at rather than showing a bare converted number.
   */
  @Get(':invoiceId/print')
  @Permissions(PERM_PRINT_PURCHASING)
  print(@Param('invoiceId') invoiceId: string) {
    return this.invoices.printPayload(invoiceId);
  }
}
