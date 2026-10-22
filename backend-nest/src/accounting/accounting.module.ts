import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExchangeRateController } from './exchange-rate.controller';
import { ExchangeRateService } from './exchange-rate.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';

@Module({
  imports: [PrismaModule],
  controllers: [AccountingController, ExchangeRateController],
  providers: [AccountingService, ExchangeRateService, TransactionAuditService],
  exports: [AccountingService, ExchangeRateService, TransactionAuditService],
})
export class AccountingModule {}
