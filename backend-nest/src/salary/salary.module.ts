import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller';
import { SalaryService } from './salary.service';
import { SalaryPublicController } from './salary.public.controller';

const controllers: any[] = [SalaryController];
// Only expose the public testing controller in non-production environments
if (process.env.NODE_ENV !== 'production') {
  controllers.push(SalaryPublicController);
}

@Module({
  controllers,
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
