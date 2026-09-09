import { Module } from '@nestjs/common';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';
import { ExpiryService } from './expiry.service';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [InventoryModule, NotificationsModule],
  controllers: [BatchesController],
  providers: [BatchesService, ExpiryService, AuditService],
  exports: [BatchesService, ExpiryService],
})
export class BatchesModule {}
