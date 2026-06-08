import { Module } from '@nestjs/common';
import { TransportationController } from './transportation.controller';
import { TransportationService } from './transportation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DiscountsModule } from '../discounts/discounts.module';

@Module({
  imports: [PrismaModule, DiscountsModule],
  controllers: [TransportationController],
  providers: [TransportationService],
  exports: [TransportationService],
})
export class TransportationModule {}
