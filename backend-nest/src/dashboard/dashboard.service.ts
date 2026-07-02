import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import {
  formatFactoryLocalTime,
  monthDateRange,
  toFactoryDateKey,
  utcTimestampToLocalMinutes,
} from '../common/utils/timezone.util';
import { resolveSalary } from '../common/utils/salary-resolution.util';

const GRACE_PERIOD_MINUTES = 5;
const DEFAULT_SCHEDULED_START = '08:00';
const STANDARD_WORKING_DAYS = 26;

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof val === 'object' && '$numberDecimal' in (val as Record<string, unknown>)) {
    const n = Number((val as { $numberDecimal: string }).$numberDecimal);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof val === 'object' && 'toNumber' in (val as Record<string, unknown>)) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return 0;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private parseClockMinutes(time: string): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? DEFAULT_SCHEDULED_START).slice(0, 5));
    if (!match) return 8 * 60;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  private calcMinutesLate(
    checkInTimestamp: Date,
    scheduledStart: string | null,
    shiftPairMinutesLate?: number | null,
  ): number {
    if (
      typeof shiftPairMinutesLate === 'number' &&
      Number.isFinite(shiftPairMinutesLate) &&
      shiftPairMinutesLate > 0
    ) {
      return Math.max(0, Math.floor(shiftPairMinutesLate) - GRACE_PERIOD_MINUTES);
    }

    const scheduled = this.parseClockMinutes(scheduledStart ?? DEFAULT_SCHEDULED_START);
    const actual = utcTimestampToLocalMinutes(checkInTimestamp);
    const diff = actual - scheduled;
    return diff > GRACE_PERIOD_MINUTES ? diff - GRACE_PERIOD_MINUTES : 0;
  }

  private employeeTotalSalary(
    employee: {
      hourlyRate: Prisma.Decimal;
      baseSalary?: Prisma.Decimal | null;
      livingAllowance?: Prisma.Decimal | null;
      workDaysInPeriod: number;
      hoursPerDay: number;
    },
    salary:
      | {
          baseSalary?: Prisma.Decimal | null;
          lumpSumSalary?: Prisma.Decimal | null;
          livingAllowance?: Prisma.Decimal | null;
          responsibilityAllowance?: Prisma.Decimal | null;
          extraEffortAllowance?: Prisma.Decimal | null;
          productionIncentive?: Prisma.Decimal | null;
          transportAllowance?: Prisma.Decimal | null;
        }
      | null
      | undefined,
  ): number {
    return resolveSalary(employee, salary as any).monthlyTotal;
  }

  async getHomeStats() {
    const today = toFactoryDateKey();

    return this.shortCache.getOrSetJson(`dashboard:home-stats:${today}`, 60, async () =>
      this.buildHomeStats(today),
    );
  }

  private async buildHomeStats(today: string) {
    const now = new Date();
    const { start: monthStart, end: monthEnd } = monthDateRange(now.getFullYear(), now.getMonth());

    const [
      totalEmployees,
      todayAttendanceRecords,
      salaryAggregate,
      absentEmployees,
      allActiveWithSalaries,
      monthAttendanceGrouped,
    ] = await Promise.all([
      this.prisma.employee.count({ where: { status: 'active' } }),

      this.prisma.attendanceRecord.findMany({
        where: { date: today },
        select: {
          employeeId: true,
          type: true,
          timestamp: true,
          shiftPair: true,
          employee: {
            select: {
              name: true,
              employeeId: true,
              scheduledStart: true,
              department: true,
              scheduledEnd: true,
              hourlyRate: true,
              baseSalary: true,
              livingAllowance: true,
              workDaysInPeriod: true,
              hoursPerDay: true,
              employeeSalary: {
                select: {
                  baseSalary: true,
                  lumpSumSalary: true,
                  livingAllowance: true,
                  responsibilityAllowance: true,
                  extraEffortAllowance: true,
                  productionIncentive: true,
                  transportAllowance: true,
                },
              },
            },
          },
        },
        orderBy: { timestamp: 'asc' },
        take: 2000,
      }),

      this.prisma.employeeSalary.aggregate({
        _sum: {
          baseSalary: true,
          lumpSumSalary: true,
          livingAllowance: true,
          responsibilityAllowance: true,
          extraEffortAllowance: true,
          productionIncentive: true,
          transportAllowance: true,
        },
      }),

      this.prisma.employee.findMany({
        where: {
          status: 'active',
          attendanceRecords: {
            none: { date: today, type: 'IN' },
          },
        },
        select: {
          employeeId: true,
          name: true,
          department: true,
          scheduledStart: true,
        },
        take: 500,
      }),

      this.prisma.employee.findMany({
        where: { status: 'active' },
        select: {
          employeeId: true,
          hourlyRate: true,
          baseSalary: true,
          livingAllowance: true,
          workDaysInPeriod: true,
          hoursPerDay: true,
          employeeSalary: {
            select: {
              baseSalary: true,
              lumpSumSalary: true,
              livingAllowance: true,
              responsibilityAllowance: true,
              extraEffortAllowance: true,
              productionIncentive: true,
              transportAllowance: true,
            },
          },
        },
      }),

      this.prisma.attendanceRecord.groupBy({
        by: ['employeeId', 'date'],
        where: {
          type: 'IN',
          date: { gte: monthStart, lte: monthEnd },
        },
      }),
    ]);

    const presentMap = new Map<string, { name: string; department: string | null; checkIn: string }>();
    for (const rec of todayAttendanceRecords) {
      if (rec.type === 'IN' && !presentMap.has(rec.employeeId)) {
        presentMap.set(rec.employeeId, {
          name: rec.employee.name,
          department: rec.employee.department,
          checkIn: formatFactoryLocalTime(rec.timestamp),
        });
      }
    }

    const presentCount = presentMap.size;
    const absentCount = Math.max(0, totalEmployees - presentCount);

    type LateEntry = {
      employeeId: string;
      name: string;
      scheduledStart: string;
      checkIn: string;
      minutesLate: number;
    };

    const firstInMap = new Map<
      string,
      {
        timestamp: Date;
        scheduledStart: string | null;
        shiftPairMinutesLate: number | null;
        name: string;
      }
    >();

    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'IN') continue;
      if (firstInMap.has(rec.employeeId)) continue;
      const sp = rec.shiftPair as Record<string, unknown> | null;
      firstInMap.set(rec.employeeId, {
        timestamp: rec.timestamp,
        scheduledStart: rec.employee.scheduledStart ?? null,
        shiftPairMinutesLate: sp?.minutesLate !== null && sp?.minutesLate !== undefined ? Number(sp.minutesLate) : null,
        name: rec.employee.name,
      });
    }

    const lateEmployees: LateEntry[] = [];
    let totalLateMinutes = 0;

    for (const [employeeId, info] of firstInMap) {
      const minutesLate = this.calcMinutesLate(
        info.timestamp,
        info.scheduledStart,
        info.shiftPairMinutesLate,
      );
      if (minutesLate > 0) {
        lateEmployees.push({
          employeeId,
          name: info.name,
          scheduledStart: info.scheduledStart || DEFAULT_SCHEDULED_START,
          checkIn: formatFactoryLocalTime(info.timestamp),
          minutesLate,
        });
        totalLateMinutes += minutesLate;
      }
    }

    type OvertimeEntry = {
      employeeId: string;
      name: string;
      department: string | null;
      scheduledEnd: string;
      actualCheckOut: string;
      overtimeMinutes: number;
      overtimePay: number;
    };

    const overtimeEmployees: OvertimeEntry[] = [];
    let totalOvertimeMinutes = 0;

    // Track last OUT record per employee (in case of multiple punches)
    const lastOutMap = new Map<string, typeof todayAttendanceRecords[number]>();
    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'OUT') continue;
      lastOutMap.set(rec.employeeId, rec);
    }

    for (const rec of lastOutMap.values()) {
      const scheduledEnd = rec.employee.scheduledEnd || '16:00';

      // Prefer shiftPair.overtimeMinutes (from biometric pairing) when available,
      // otherwise fall back to computing checkOut - scheduledEnd directly.
      const shiftPair = rec.shiftPair as Record<string, unknown> | null;
      const shiftPairOvertimeMinutes =
        shiftPair?.overtimeMinutes !== null && shiftPair?.overtimeMinutes !== undefined ? toNum(shiftPair.overtimeMinutes) : null;

      let overtimeMinutes: number;
      if (shiftPairOvertimeMinutes !== null && shiftPairOvertimeMinutes > 0) {
        overtimeMinutes = Math.round(shiftPairOvertimeMinutes);
      } else {
        const match = /^(\d{1,2}):(\d{2})$/.exec(scheduledEnd.slice(0, 5));
        const scheduledEndMinutes = match
          ? Number(match[1]) * 60 + Number(match[2])
          : 16 * 60;
        const checkOutLocalMinutes = utcTimestampToLocalMinutes(rec.timestamp);
        overtimeMinutes = Math.max(0, checkOutLocalMinutes - scheduledEndMinutes);
      }

      if (overtimeMinutes <= 0) continue;

      const overtimeHours = overtimeMinutes / 60;
      const resolved = resolveSalary(rec.employee, rec.employee.employeeSalary);
      const overtimePay = Number((resolved.hourlyRate * overtimeHours * 1.5).toFixed(2));

      overtimeEmployees.push({
        employeeId: rec.employeeId,
        name: rec.employee.name,
        department: rec.employee.department,
        scheduledEnd,
        actualCheckOut: formatFactoryLocalTime(rec.timestamp),
        overtimeMinutes,
        overtimePay,
      });
      totalOvertimeMinutes += overtimeMinutes;
    }

    const sumBase = toNum(salaryAggregate._sum?.baseSalary);
    const sumLumpSum = toNum(salaryAggregate._sum?.lumpSumSalary);
    const sumLiving = toNum(salaryAggregate._sum?.livingAllowance);
    const sumResponsibility = toNum(salaryAggregate._sum?.responsibilityAllowance);
    const sumExtraEffort = toNum(salaryAggregate._sum?.extraEffortAllowance);
    const sumProductionIncentive = toNum(salaryAggregate._sum?.productionIncentive);
    const sumTransport = toNum(salaryAggregate._sum?.transportAllowance);
    const totalDueSalaries =
      sumBase +
      sumLumpSum +
      sumLiving +
      sumResponsibility +
      sumExtraEffort +
      sumProductionIncentive +
      sumTransport;

    const attendanceDaysMap = new Map<string, number>();
    for (const row of monthAttendanceGrouped) {
      attendanceDaysMap.set(row.employeeId, (attendanceDaysMap.get(row.employeeId) ?? 0) + 1);
    }

    let totalReceivedSalaries = 0;
    for (const emp of allActiveWithSalaries) {
      const empTotalSalary = this.employeeTotalSalary(emp, emp.employeeSalary);
      if (empTotalSalary <= 0) continue;

      const workDays = emp.workDaysInPeriod || STANDARD_WORKING_DAYS;
      const attendedDays = attendanceDaysMap.get(emp.employeeId) ?? 0;
      totalReceivedSalaries +=
        empTotalSalary * Math.min(attendedDays, workDays) / workDays;
    }

    return {
      totalEmployees,
      attendance: {
        count: presentCount,
        employees: Array.from(presentMap.values()),
      },
      absence: {
        count: absentCount,
        employees: absentEmployees.map((emp) => ({
          employeeId: emp.employeeId,
          name: emp.name,
          department: emp.department,
          scheduledStart: emp.scheduledStart,
        })),
      },
      totalDueSalaries: Number(totalDueSalaries.toFixed(2)),
      totalReceivedSalaries: Number(totalReceivedSalaries.toFixed(2)),
      lateness: {
        totalMinutes: totalLateMinutes,
        count: lateEmployees.length,
        employees: lateEmployees,
      },
      overtime: {
        totalMinutes: totalOvertimeMinutes,
        count: overtimeEmployees.length,
        employees: overtimeEmployees,
      },
      reportDate: today,
    };
  }
}
