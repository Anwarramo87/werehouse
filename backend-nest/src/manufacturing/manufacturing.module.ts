import { Module } from '@nestjs/common';
import { ManufacturingController } from './manufacturing.controller';
import { ManufacturingService } from './manufacturing.service';
import { ProductionBatchController } from './production-batch.controller';
import { ProductionBatchService } from './production-batch.service';
import { WmsCommonModule } from '../common/wms/wms-common.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';

@Module({
  imports: [WmsCommonModule, PrismaModule],
  controllers: [ManufacturingController, ProductionBatchController],
  providers: [ManufacturingService, ProductionBatchService, TransactionAuditService],
  exports: [ManufacturingService, ProductionBatchService],
})
export class ManufacturingModule {}
