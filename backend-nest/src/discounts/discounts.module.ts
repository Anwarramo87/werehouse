import { Module } from '@nestjs/common';
import { AdvancesModule } from '../advances/advances.module';
import { BonusesModule } from '../bonuses/bonuses.module';
import { DiscountsController } from './discounts.controller';
import { DiscountsService } from './discounts.service';

@Module({
  imports: [AdvancesModule, BonusesModule],
  controllers: [DiscountsController],
  providers: [DiscountsService],
  exports: [DiscountsService],
})
export class DiscountsModule {}
