import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller';
import { SalaryService } from './salary.service';
import { SalaryPublicController } from './salary.public.controller';
import { PrismaService } from '../prisma/prisma.service';

const controllers: any[] = [SalaryController];
if (process.env.NODE_ENV !== 'production') {
  controllers.push(SalaryPublicController);
}

@Module({
  controllers,
  providers: [SalaryService, PrismaService],
  exports: [SalaryService],
})
export class SalaryModule {}
