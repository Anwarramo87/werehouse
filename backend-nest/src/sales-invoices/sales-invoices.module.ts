import { Module } from '@nestjs/common';
import { SalesInvoicesController } from './sales-invoices.controller';
import { SalesInvoicesService } from './sales-invoices.service';
import { BatchesModule } from '../batches/batches.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [BatchesModule, InventoryModule, PricingModule, IntegrationsModule],
  controllers: [SalesInvoicesController],
  providers: [SalesInvoicesService, AuditService],
  exports: [SalesInvoicesService],
})
export class SalesInvoicesModule {}
