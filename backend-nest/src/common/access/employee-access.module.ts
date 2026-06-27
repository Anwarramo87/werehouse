import { Global, Module } from '@nestjs/common';
import { EmployeeAccessService } from '../services/employee-access.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [EmployeeAccessService],
  exports: [EmployeeAccessService],
})
export class EmployeeAccessModule {}
