import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [],
  controllers: [InventoryController],
  providers: [InventoryService, AuditService],
  exports: [InventoryService],
})
export class InventoryModule {}
