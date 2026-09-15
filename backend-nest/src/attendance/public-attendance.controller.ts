import {
  Body,
  Controller,
  Post,
  Get,
  Param,
  Logger,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeviceApiKeyGuard } from '../common/guards/device-api-key.guard';
import { toFactoryDateKey } from '../common/utils/timezone.util';
import { checkLeaveConflictForAttendance } from '../common/utils/leave-attendance-conflict.util';
import { runUnscoped, runWithTenant } from '../common/tenant/tenant-context';
import { DevicePunchDto } from './dto/device-punch.dto';

function formatTimeHHmm(value: Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', hour12: false });
}

@ApiTags('attendance')
@Controller('attendance/public')
@UseGuards(DeviceApiKeyGuard)
export class PublicAttendanceController {
  private readonly logger = new Logger(PublicAttendanceController.name);

  // Block only accidental double-scans (two identical punches within this window).
  // Legitimate repeated IN/OUT punches (e.g. multiple shifts, hours apart) are always allowed.
  private static readonly ANTI_DOUBLE_SCAN_MS = 60_000; // 1 minute

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregationService: AttendanceAggregationService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Which factory this badge belongs to.
   *
   * A punch arrives authenticated by a device key, not a session, so nothing
   * upstream established a tenant -- and every model this controller touches is
   * tenant-scoped, so an unwrapped write throws inside the Prisma extension and
   * the device gets a 500 for every scan. The badge number is the only identity
   * on the wire, so the factory is resolved from it.
   *
   * Employee numbers are unique per factory, not globally, so a number carried
   * by two factories is genuinely ambiguous: refuse rather than guess, which
   * would post one factory's attendance onto another's payroll.
   */
  private async resolveTenantForEmployee(employeeId: string): Promise<string> {
    const matches = await runUnscoped('device-punch-tenant', async () =>
      this.prisma.employee.findMany({
        where: { employeeId },
        select: { tenantId: true },
        take: 2,
      }),
    );

    if (matches.length === 0) {
      throw new BadRequestException(`Unknown employee ${employeeId}`);
    }

    if (matches.length > 1) {
      this.logger.error(
        `Employee number ${employeeId} exists in more than one factory; refusing the punch`,
      );
      throw new BadRequestException(
        `Employee number ${employeeId} is ambiguous across factories`,
      );
    }

    const tenantId = matches[0].tenantId;
    if (!tenantId) {
      throw new BadRequestException(`Employee ${employeeId} belongs to no factory`);
    }

    return tenantId;
  }

  private async safeGetEmployeeName(employeeId: string): Promise<string> {
    try {
      const employee = await this.prisma.employee.findFirst({
        where: { employeeId },
        select: { name: true },
      });
      return employee?.name || employeeId;
    } catch {
      return employeeId;
    }
  }

  @Post('check-in')
  @ApiOperation({ summary: 'Check-in an employee' })
  async checkIn(@Body() dto: DevicePunchDto) {
    const employeeId = dto.employeeId.trim();
    const tenantId = await this.resolveTenantForEmployee(employeeId);

    return runWithTenant(
      { tenantId, bypass: false, actor: 'device:check-in' },
      async () => await this.performCheckIn(employeeId),
    );
  }

  private async performCheckIn(employeeId: string) {
    const dateKey = toFactoryDateKey();
    const now = new Date();

    // Allow multiple check-ins per day (multiple shifts / re-entries).
    // Only block an accidental double-scan: two consecutive IN punches within a short window.
    const lastRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (lastRecord && lastRecord.type.toUpperCase() === 'IN') {
      const gapMs = now.getTime() - new Date(lastRecord.timestamp).getTime();
      if (gapMs < PublicAttendanceController.ANTI_DOUBLE_SCAN_MS) {
        throw new BadRequestException(
          'Double check-in detected — please wait a moment before scanning again',
        );
      }
    }

    // ── Check leave conflict BEFORE any DB write ──
    const warning = await checkLeaveConflictForAttendance(this.prisma, employeeId, dateKey);

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

    const employeeName = await this.safeGetEmployeeName(employeeId);
    void this.notifications.create({
      type: 'CHECK_IN',
      severity: 'INFO',
      title: 'تسجيل دخول',
      message: `قام ${employeeName} بالدخول (${formatTimeHHmm(now)}).`,
      employeeId,
      employeeName,
      entityType: 'attendance',
      entityId: record.id,
      metadata: { type: 'IN', date: dateKey, source: 'device' },
    });

    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `Real-time aggregation failed (check-in) for ${employeeId}: ${err.message}`,
        ),
      );

    return {
      message: 'Check-in successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
      warning: warning ?? undefined,
    };
  }

  @Post('check-out')
  @ApiOperation({ summary: 'Check-out an employee' })
  async checkOut(@Body() dto: DevicePunchDto) {
    const employeeId = dto.employeeId.trim();
    const tenantId = await this.resolveTenantForEmployee(employeeId);

    return runWithTenant(
      { tenantId, bypass: false, actor: 'device:check-out' },
      async () => await this.performCheckOut(employeeId),
    );
  }

  private async performCheckOut(employeeId: string) {
    const dateKey = toFactoryDateKey();
    const now = new Date();

    // Block only accidental double-scans: two consecutive OUT punches within a short window.
    const lastRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (lastRecord && lastRecord.type.toUpperCase() === 'OUT') {
      const gapMs = now.getTime() - new Date(lastRecord.timestamp).getTime();
      if (gapMs < PublicAttendanceController.ANTI_DOUBLE_SCAN_MS) {
        throw new BadRequestException(
          'Double check-out detected — please wait a moment before scanning again',
        );
      }
    }

    // Pair this check-out with the most recent check-in of the day.
    // We intentionally allow several OUTs after one IN (e.g. a forgotten re-check-in
    // or a double end-of-day scan): every OUT is stored and the salary calc pairs each
    // IN with the LAST OUT before the next IN.
    const existingIn = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, type: 'IN', date: dateKey },
      orderBy: { timestamp: 'desc' },
    });

    if (!existingIn) {
      throw new BadRequestException('Employee must check in first');
    }

    const hoursWorked = (now.getTime() - existingIn.timestamp.getTime()) / (1000 * 60 * 60);

    // ── Check leave conflict BEFORE any DB write ──
    const warning = await checkLeaveConflictForAttendance(this.prisma, employeeId, dateKey);

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

    const employeeName = await this.safeGetEmployeeName(employeeId);
    void this.notifications.create({
      type: 'CHECK_OUT',
      severity: 'INFO',
      title: 'تسجيل خروج',
      message: `قام ${employeeName} بالخروج (${formatTimeHHmm(now)}).`,
      employeeId,
      employeeName,
      entityType: 'attendance',
      entityId: record.id,
      metadata: { type: 'OUT', date: dateKey, source: 'device' },
    });

    this.aggregationService
      .aggregateEmployeeDay(employeeId, dateKey)
      .catch((err) =>
        this.logger.error(
          `Real-time aggregation failed (check-out) for ${employeeId}: ${err.message}`,
        ),
      );

    return {
      message: 'Check-out successful',
      employeeId,
      timestamp: record.timestamp,
      date: dateKey,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      warning: warning ?? undefined,
    };
  }

  @Get('employee/:employeeId/today')
  @ApiOperation({ summary: "Get today's attendance for an employee" })
  async getTodayAttendance(@Param('employeeId') employeeId: string) {
    const tenantId = await this.resolveTenantForEmployee(employeeId);
    const dateKey = toFactoryDateKey();

    const records = await runWithTenant(
      { tenantId, bypass: false, actor: 'device:today' },
      async () =>
        await this.prisma.attendanceRecord.findMany({
          where: { employeeId, date: dateKey },
          orderBy: { timestamp: 'asc' },
        }),
    );

    return { employeeId, date: dateKey, records };
  }
}
