import { Module } from '@nestjs/common';
import { FulfillmentController } from './fulfillment.controller';
import { PickingService } from './picking.service';
import { ShippingService } from './shipping.service';
import { BatchesModule } from '../batches/batches.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [BatchesModule, NotificationsModule],
  controllers: [FulfillmentController],
  providers: [PickingService, ShippingService],
  exports: [PickingService, ShippingService],
})
export class FulfillmentModule {}
