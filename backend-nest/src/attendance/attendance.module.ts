import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { DailyLogsController } from './daily-logs.controller';
import { DailyLogsService } from './daily-logs.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [AttendanceController, DailyLogsController],
  providers: [AttendanceService, DailyLogsService],
  exports: [AttendanceService, DailyLogsService],
})
export class AttendanceModule {}
