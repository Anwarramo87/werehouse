import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeeSelfController } from './employee-self.controller';
import { EmployeesService } from './employees.service';
import { ShortCacheModule } from '../common/cache/short-cache.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [ShortCacheModule, NotificationsModule],
  // EmployeeSelfController is listed FIRST so `employees/me` resolves before
  // `employees/:employeeId` can swallow "me" as an employee number.
  controllers: [EmployeeSelfController, EmployeesController],
  providers: [EmployeesService, AuditService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
