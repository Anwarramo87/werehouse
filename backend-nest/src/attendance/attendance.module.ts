import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { DailyLogsController } from './daily-logs.controller';
import { DailyLogsService } from './daily-logs.service';

@Module({
  imports: [],
  controllers: [AttendanceController, DailyLogsController],
  providers: [AttendanceService, DailyLogsService],
  exports: [AttendanceService, DailyLogsService],
})
export class AttendanceModule {}
