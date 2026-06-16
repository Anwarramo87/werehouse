import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { DailyLogsController } from './daily-logs.controller';
import { DailyLogsService } from './daily-logs.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { PublicAttendanceController } from './public-attendance.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { AttendanceAggregationController } from './attendance-aggregation.controller';

@Module({
  imports: [RealtimeModule, PrismaModule],
  controllers: [
    AttendanceController,
    DailyLogsController,
    PublicAttendanceController,
    AttendanceAggregationController,
  ],
  providers: [AttendanceService, DailyLogsService, AttendanceAggregationService],
  exports: [AttendanceService, DailyLogsService, AttendanceAggregationService],
})
export class AttendanceModule {}
