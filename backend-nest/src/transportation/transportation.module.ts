import { Module } from '@nestjs/common';
import { TransportationController } from './transportation.controller';
import { TransportationService } from './transportation.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TransportationController],
  providers: [TransportationService],
  exports: [TransportationService],
})
export class TransportationModule {}
