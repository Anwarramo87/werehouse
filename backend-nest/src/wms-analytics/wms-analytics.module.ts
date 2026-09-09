import { Module } from '@nestjs/common';
import { WmsAnalyticsController } from './wms-analytics.controller';
import { WmsAnalyticsService } from './wms-analytics.service';

@Module({
  controllers: [WmsAnalyticsController],
  providers: [WmsAnalyticsService],
  exports: [WmsAnalyticsService],
})
export class WmsAnalyticsModule {}
