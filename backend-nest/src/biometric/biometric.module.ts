import { Module } from '@nestjs/common';
import { BiometricService } from './biometric.service';
import { BiometricController } from './biometric.controller';
import { DuplicateHandlingService } from './duplicate-handling.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BiometricController],
  providers: [BiometricService, DuplicateHandlingService],
  exports: [BiometricService],
})
export class BiometricModule {}
