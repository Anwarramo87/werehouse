import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { DailyLogsController } from './daily-logs.controller';
import { DailyLogsService } from './daily-logs.service';
import { PublicAttendanceController } from './public-attendance.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AttendanceController, DailyLogsController, PublicAttendanceController],
  providers: [AttendanceService, DailyLogsService],
  exports: [AttendanceService, DailyLogsService],
})
export class AttendanceModule {}
