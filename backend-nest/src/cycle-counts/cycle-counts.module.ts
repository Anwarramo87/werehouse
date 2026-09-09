import { Module } from '@nestjs/common';
import { CycleCountsController } from './cycle-counts.controller';
import { CycleCountsService } from './cycle-counts.service';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [InventoryModule, NotificationsModule],
  controllers: [CycleCountsController],
  providers: [CycleCountsService, AuditService],
  exports: [CycleCountsService],
})
export class CycleCountsModule {}
