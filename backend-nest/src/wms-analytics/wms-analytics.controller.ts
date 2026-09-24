import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { WmsAnalyticsService } from './wms-analytics.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

const toInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

@ApiTags('wms-analytics')
@ApiCookieAuth()
@Controller('wms/analytics')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('inventory.analytics')
export class WmsAnalyticsController {
  constructor(private readonly analytics: WmsAnalyticsService) {}

  /** The KPI board: turnover, fulfilment speed, accuracy, expiry, receiving. */
  @Get('kpis')
  @Permissions('view_inventory')
  kpis(@Query('days') days?: string) {
    return this.analytics.kpis(toInt(days, 90));
  }

  @Get('turnover')
  @Permissions('view_inventory')
  turnover(@Query('days') days?: string) {
    return this.analytics.inventoryTurnover(toInt(days, 90));
  }

  @Get('fulfillment')
  @Permissions('view_inventory')
  fulfillment(@Query('days') days?: string) {
    return this.analytics.fulfillmentSpeed(toInt(days, 90));
  }

  @Get('accuracy')
  @Permissions('view_inventory')
  accuracy(@Query('days') days?: string) {
    return this.analytics.orderAccuracy(toInt(days, 90));
  }

  /** Demand forecast plus reorder-point advice. */
  @Get('forecast')
  @Permissions('view_inventory')
  forecast(@Query('leadTimeDays') leadTimeDays?: string, @Query('horizonDays') horizonDays?: string) {
    return this.analytics.forecast({
      leadTimeDays: toInt(leadTimeDays, 14),
      horizonDays: toInt(horizonDays, 30),
    });
  }

  @Get('suppliers')
  @Permissions('view_purchasing')
  suppliers(@Query('days') days?: string) {
    return this.analytics.supplierPerformance(toInt(days, 180));
  }
}
