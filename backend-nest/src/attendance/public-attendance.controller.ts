import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AttendanceService } from './attendance.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('attendance')
@Controller('attendance')
export class PublicAttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('check-in')
  @ApiOperation({ summary: 'Check-in an employee' })
  async checkIn(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);

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

    return {
      message: 'Check-in successful',
      employeeId,
      timestamp: record.timestamp,
    };
  }

  @Post('check-out')
  @ApiOperation({ summary: 'Check-out an employee' })
  async checkOut(@Body() dto: { employeeId: string }) {
    const { employeeId } = dto;

    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);

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

    return {
      message: 'Check-out successful',
      employeeId,
      timestamp: record.timestamp,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
    };
  }

  @Get('employee/:employeeId/today')
  @ApiOperation({ summary: 'Get today\'s attendance for an employee' })
  async getTodayAttendance(@Param('employeeId') employeeId: string) {
    const today = new Date().toISOString().slice(0, 10);

    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, date: today },
      orderBy: { timestamp: 'asc' },
    });

    return { employeeId, date: today, records };
  }
}