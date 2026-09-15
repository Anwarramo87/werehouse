import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PricingService } from './pricing.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateTaxRateDto } from './dto/create-tax-rate.dto';
import { UpdateTaxRateDto } from './dto/update-tax-rate.dto';
import { CreatePriceTierDto } from './dto/create-price-tier.dto';
import { UpdatePriceTierDto } from './dto/update-price-tier.dto';
import { UpsertProductPriceDto } from './dto/upsert-product-price.dto';
import { QuoteDto } from './dto/quote.dto';

@ApiTags('pricing')
@ApiCookieAuth()
@Controller('pricing')
@UseGuards(JwtAuthGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('sales.pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  // -------------------------------------------------------------- tax rates

  @Get('tax-rates')
  @Permissions('view_sales')
  listTaxRates() {
    return this.pricing.listTaxRates();
  }

  @Post('tax-rates')
  @Permissions('edit_sales')
  createTaxRate(@Body() dto: CreateTaxRateDto) {
    return this.pricing.createTaxRate(dto);
  }

  @Put('tax-rates/:taxRateId')
  @Permissions('edit_sales')
  updateTaxRate(@Param('taxRateId') taxRateId: string, @Body() dto: UpdateTaxRateDto) {
    return this.pricing.updateTaxRate(taxRateId, dto);
  }

  @Delete('tax-rates/:taxRateId')
  @Permissions('edit_sales')
  deleteTaxRate(@Param('taxRateId') taxRateId: string) {
    return this.pricing.deleteTaxRate(taxRateId);
  }

  // ------------------------------------------------------------- price tiers

  @Get('tiers')
  @Permissions('view_sales')
  listTiers() {
    return this.pricing.listPriceTiers();
  }

  @Post('tiers')
  @Permissions('edit_sales')
  createTier(@Body() dto: CreatePriceTierDto) {
    return this.pricing.createPriceTier(dto);
  }

  @Put('tiers/:tierId')
  @Permissions('edit_sales')
  updateTier(@Param('tierId') tierId: string, @Body() dto: UpdatePriceTierDto) {
    return this.pricing.updatePriceTier(tierId, dto);
  }

  @Delete('tiers/:tierId')
  @Permissions('edit_sales')
  deleteTier(@Param('tierId') tierId: string) {
    return this.pricing.deletePriceTier(tierId);
  }

  // ---------------------------------------------------------- product prices

  @Get('product-prices')
  @Permissions('view_sales')
  listProductPrices(@Query('sku') sku?: string, @Query('priceTierId') priceTierId?: string) {
    return this.pricing.listProductPrices(sku, priceTierId);
  }

  @Post('product-prices')
  @Permissions('edit_sales')
  upsertProductPrice(@Body() dto: UpsertProductPriceDto) {
    return this.pricing.upsertProductPrice(dto);
  }

  @Delete('product-prices/:priceId')
  @Permissions('edit_sales')
  deleteProductPrice(@Param('priceId') priceId: string) {
    return this.pricing.deleteProductPrice(priceId);
  }

  // ------------------------------------------------------------------ engine

  /** Prices a basket without persisting anything — drives the invoice screen. */
  @Post('quote')
  @Permissions('view_sales')
  quote(@Body() dto: QuoteDto) {
    return this.pricing.quote(dto);
  }

  @Post('seed-defaults')
  @Permissions('edit_sales')
  seedDefaults() {
    return this.pricing.seedDefaults();
  }
}
