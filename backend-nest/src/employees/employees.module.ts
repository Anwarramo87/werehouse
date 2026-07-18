import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { ShortCacheModule } from '../common/cache/short-cache.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ShortCacheModule, NotificationsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
