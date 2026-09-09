import { Module } from '@nestjs/common';
import { PurchaseInvoicesController } from './purchase-invoices.controller';
import { PurchaseInvoicesService } from './purchase-invoices.service';
import { BatchesModule } from '../batches/batches.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [BatchesModule, InventoryModule, IntegrationsModule],
  controllers: [PurchaseInvoicesController],
  providers: [PurchaseInvoicesService, AuditService],
  exports: [PurchaseInvoicesService],
})
export class PurchaseInvoicesModule {}
