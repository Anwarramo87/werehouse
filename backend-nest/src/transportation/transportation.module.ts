import { Module } from '@nestjs/common';
import { TransportationController } from './transportation.controller';
import { TransportationService } from './transportation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';

@Module({
  imports: [PrismaModule, DiscountsModule],
  controllers: [TransportationController],
  providers: [TransportationService, TransactionAuditService],
  exports: [TransportationService],
})
export class TransportationModule {}
