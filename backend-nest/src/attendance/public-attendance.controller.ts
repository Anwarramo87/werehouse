import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AttendanceService } from './attendance.service';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { PrismaService } from '../prisma/prisma.service';

const TIMEZONE_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3 Saudi Arabia

@ApiTags('attendance')
@Controller('attendance/public')
export class PublicAttendanceController {
  private readonly logger = new Logger(PublicAttendanceController.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly prisma: PrismaService,
    private readonly aggregationService: AttendanceAggregationService,
  ) {}

  private getLocalNow(): Date {
    return new Date(Date.now() + TIMEZONE_OFFSET_MS);
  }

  private getLocalDateKey(): string {
    const local = this.getLocalNow();
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const d = String(local.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private getLocalTimestamp(): Date {
    return new Date(Date.now());
  }

  @Post('check-in')
  @ApiOperation({ summary: 'Check-in an employee' })
  async checkIn(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const dateKey = this.getLocalDateKey();
    const now = this.getLocalTimestamp();

    const existingIn = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        type: 'IN',
        date: dateKey,
      },
    });

    if (existingIn) {
      throw new BadRequestException('Employee already checked in today');
    }

    const record = await this.prisma.attendanceRecord.create({
      data: {
        employeeId,
        timestamp: now,
        type: 'IN',
        date: dateKey,
        source: 'device',
        verified: true,
      },
    });

    // ── Real-time aggregation: re-calculate missing minutes immediately ──
    // Fire-and-forget so the check-in response is not blocked.
    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `⚠️ Real-time aggregation failed (check-in) for ${employeeId}: ${err.message}`,
        ),
      );

    return {
      message: 'Check-in successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
    };
  }

  @Post('check-out')
  @ApiOperation({ summary: 'Check-out an employee' })
  async checkOut(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const dateKey = this.getLocalDateKey();
    const now = this.getLocalTimestamp();

    const existingOut = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        type: 'OUT',
        date: dateKey,
      },
    });

    if (existingOut) {
      throw new BadRequestException('Employee already checked out today');
    }

    const existingIn = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        type: 'IN',
        date: dateKey,
      },
    });

    if (!existingIn) {
      throw new BadRequestException('Employee must check in first');
    }

    const hoursWorked = (now.getTime() - existingIn.timestamp.getTime()) / (1000 * 60 * 60);

    const record = await this.prisma.$transaction(async (tx) => {
      const outRecord = await tx.attendanceRecord.create({
        data: {
          employeeId,
          timestamp: now,
          type: 'OUT',
          date: dateKey,
          source: 'device',
          verified: true,
          shiftPair: {
            inRecordId: existingIn.id,
            outRecordId: undefined,
            hoursWorked,
          },
        },
      });

      await tx.attendanceRecord.update({
        where: { id: existingIn.id },
        data: {
          shiftPair: {
            inRecordId: existingIn.id,
            outRecordId: outRecord.id,
            hoursWorked,
          },
        },
      });

      return outRecord;
    });

    // ── Real-time aggregation: re-calculate missing minutes immediately ──
    // Fires AFTER the transaction commits, ensuring the OUT punch is visible.
    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `⚠️ Real-time aggregation failed (check-out) for ${employeeId}: ${err.message}`,
        ),
      );

    return {
      message: 'Check-out successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
    };
  }

  @Get('employee/:employeeId/today')
  @ApiOperation({ summary: 'Get today\'s attendance for an employee' })
  async getTodayAttendance(@Param('employeeId') employeeId: string) {
    const dateKey = this.getLocalDateKey();

    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'asc' },
    });

    return { employeeId, date: dateKey, records };
  }
}