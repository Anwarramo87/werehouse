import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { appendFileSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { EntitlementsService } from '../common/entitlements/entitlements.service';
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
    private readonly entitlements: EntitlementsService,
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

  /**
   * Home KPIs scoped to what the CALLER may see — not the whole factory.
   *
   * An admin with HR disabled must not see employee counts or names on the
   * dashboard (that was leaking the roster through totalEmployees/absence
   * lists even while the sidebar and API correctly refused the pages).
   * Sections the caller holds no page for come back zeroed, so the dashboard
   * never discloses what entitlements hide. The overseer (no tenant) keeps
   * the full view.
   *
   * The cache key carries tenant+user: the previous day-only key served one
   * factory's numbers to every other factory for 30s.
   */
  async getHomeStats(actor?: { userId?: string; tenantId?: string | null } | null) {
    const today = toFactoryDateKey();
    const tenantId = actor?.tenantId ?? null;
    const userId = actor?.userId ?? null;

    let pages: Set<string> | null = null;
    if (tenantId && userId) {
      pages = await this.entitlements.enabledPagesForUser(userId, tenantId);
    }

    const canSeeEmployees = !pages || pages.has('hr.employees');
    const canSeeAttendance = !pages || pages.has('hr.attendance');
    const canSeePayroll =
      !pages || pages.has('payroll.reports') || pages.has('payroll.settings');

    const scope = { canSeeEmployees, canSeeAttendance, canSeePayroll };
    const cacheKey = `dashboard:home-stats:${today}:${tenantId ?? 'none'}:${userId ?? 'none'}`;

    // TTL قصير (30s) — تُبطَّل الكاش فوراً عند أي تغيير في الحضور/الموظفين/الرواتب
    // عبر ShortCacheService.invalidatePrefix('dashboard:home-stats:')
    return this.shortCache.getOrSetJson(cacheKey, 30, async () =>
      this.buildHomeStats(today, scope),
    );
  }

  private async buildHomeStats(
    today: string,
    scope: { canSeeEmployees: boolean; canSeeAttendance: boolean; canSeePayroll: boolean },
  ) {
    const { canSeeEmployees, canSeeAttendance, canSeePayroll } = scope;
    const now = new Date();
    const { start: monthStart, end: monthEnd } = monthDateRange(now.getFullYear(), now.getMonth());

    const timers: Array<{ name: string; ms: number }> = [];
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const s = Date.now();
      const result = await fn();
      timers.push({ name, ms: Date.now() - s });
      return result;
    };

    const [
      totalEmployees,
      todayAttendanceRecords,
      salaryAggregate,
      absentEmployees,
      allActiveWithSalaries,
      todayLeaves,
      todayOvertimeLogs,
    ] = await Promise.all([
      timed('employee.count', () => this.prisma.employee.count({ where: { status: 'active' } })),

      timed('attendanceRecord.findMany(today)', () =>
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
      ),

      timed('employeeSalary.aggregate', () =>
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
      ),

      timed('employee.findMany(absent)', () =>
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
            attendanceRecords: {
              where: { type: 'IN' },
              orderBy: { timestamp: 'desc' },
              take: 1,
              select: { timestamp: true, date: true },
            },
          },
          take: 500,
        }),
      ),

      timed('employee.findMany(allActive+salary)', () =>
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
      ),

      timed('leaveRequest.findMany(today)', () =>
        this.prisma.leaveRequest.findMany({
          where: {
            status: 'APPROVED',
            startDate: { lte: new Date(`${today}T23:59:59Z`) },
            endDate: { gte: new Date(`${today}T00:00:00Z`) },
          },
          select: { employeeId: true },
        }),
      ),

      timed('dailyAttendanceLog.findMany(todayOvertime)', () =>
        this.prisma.dailyAttendanceLog.findMany({
          where: {
            date: new Date(`${today}T00:00:00.000Z`),
            recordType: 'OVERTIME_MINUTES',
          },
          select: {
            employeeId: true,
            value: true,
            employee: {
              select: {
                name: true,
                employeeId: true,
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
          take: 2000,
        }),
      ),
    ]);

    const presentMap = new Map<
      string,
      { name: string; department: string | null; checkIn: string; checkOut: string | null }
    >();
    for (const rec of todayAttendanceRecords) {
      // سجل بـ tenantId = NULL لا يمكنه مطابقة موظف (العلاقة مركّبة) — تجاهله بدل الانهيار
      if (!rec.employee) continue;
      if (rec.type === 'IN' && !presentMap.has(rec.employeeId)) {
        presentMap.set(rec.employeeId, {
          name: rec.employee!.name,
          department: rec.employee!.department,
          checkIn: formatFactoryLocalTime(rec.timestamp),
          checkOut: null,
        });
      }
      if (rec.type === 'OUT' && presentMap.has(rec.employeeId)) {
        presentMap.get(rec.employeeId)!.checkOut = formatFactoryLocalTime(rec.timestamp);
      }
    }

    const presentCount = presentMap.size;
    const onLeaveIds = new Set(todayLeaves.map((l) => l.employeeId));
    const absentCount = Math.max(0, totalEmployees - presentCount - onLeaveIds.size);
    const absentNotOnLeave = absentEmployees.filter((emp) => !onLeaveIds.has(emp.employeeId));

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
      // سجل بـ tenantId = NULL لا يمكنه مطابقة موظف (العلاقة مركّبة) — تجاهله بدل الانهيار
      if (!rec.employee) continue;
      if (rec.type !== 'IN') continue;
      if (firstInMap.has(rec.employeeId)) continue;
      const sp = rec.shiftPair as Record<string, unknown> | null;
      firstInMap.set(rec.employeeId, {
        timestamp: rec.timestamp,
        scheduledStart: rec.employee!.scheduledStart ?? null,
        shiftPairMinutesLate:
          sp?.minutesLate !== null && sp?.minutesLate !== undefined ? Number(sp.minutesLate) : null,
        name: rec.employee!.name,
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
    const lastOutMap = new Map<string, (typeof todayAttendanceRecords)[number]>();
    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'OUT') continue;
      if (!rec.employee) continue;
      lastOutMap.set(rec.employeeId, rec);
    }

    const overtimeEmployeeIds = new Set<string>();

    for (const log of todayOvertimeLogs) {
      if (!log.employee) continue;
      const overtimeMinutes = Math.round(toNum(log.value));
      if (overtimeMinutes <= 0) continue;

      const lastOut = lastOutMap.get(log.employeeId);
      const scheduledEnd = log.employee!.scheduledEnd || '16:00';
      const resolved = resolveSalary(log.employee!, log.employee!.employeeSalary);
      const overtimeHours = overtimeMinutes / 60;
      const overtimePay = Number((resolved.hourlyRate * overtimeHours * 1.5).toFixed(2));

      overtimeEmployees.push({
        employeeId: log.employeeId,
        name: log.employee!.name,
        department: log.employee!.department,
        scheduledEnd,
        actualCheckOut: lastOut ? formatFactoryLocalTime(lastOut.timestamp) : scheduledEnd,
        overtimeMinutes,
        overtimePay,
      });
      totalOvertimeMinutes += overtimeMinutes;
      overtimeEmployeeIds.add(log.employeeId);
    }

    for (const rec of lastOutMap.values()) {
      if (overtimeEmployeeIds.has(rec.employeeId)) continue;

      const scheduledEnd = rec.employee!.scheduledEnd || '16:00';

      // Prefer shiftPair.overtimeMinutes (from biometric pairing) when available,
      // otherwise fall back to computing checkOut - scheduledEnd directly.
      const shiftPair = rec.shiftPair as Record<string, unknown> | null;
      const shiftPairOvertimeMinutes =
        shiftPair?.overtimeMinutes !== null && shiftPair?.overtimeMinutes !== undefined
          ? toNum(shiftPair.overtimeMinutes)
          : null;

      let overtimeMinutes: number;
      if (shiftPairOvertimeMinutes !== null && shiftPairOvertimeMinutes > 0) {
        overtimeMinutes = Math.round(shiftPairOvertimeMinutes);
      } else {
        const match = /^(\d{1,2}):(\d{2})$/.exec(scheduledEnd.slice(0, 5));
        const scheduledEndMinutes = match ? Number(match[1]) * 60 + Number(match[2]) : 16 * 60;
        const checkOutLocalMinutes = utcTimestampToLocalMinutes(rec.timestamp);
        overtimeMinutes = Math.max(0, checkOutLocalMinutes - scheduledEndMinutes);
      }

      if (overtimeMinutes <= 0) continue;

      const overtimeHours = overtimeMinutes / 60;
      const resolved = resolveSalary(rec.employee!, rec.employee!.employeeSalary);
      const overtimePay = Number((resolved.hourlyRate * overtimeHours * 1.5).toFixed(2));

      overtimeEmployees.push({
        employeeId: rec.employeeId,
        name: rec.employee!.name,
        department: rec.employee!.department,
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

    let totalReceivedSalaries = 0;
    for (const emp of allActiveWithSalaries) {
      const empTotalSalary = this.employeeTotalSalary(emp, emp.employeeSalary);
      if (empTotalSalary <= 0) continue;

      // إجمالي المقبوض = مجموع الرواتب الشهرية الكاملة المستحقة
      // (رقم ثابت لا يتأثر بعدد أيام الحضور الفعلية)
      totalReceivedSalaries += empTotalSalary;
    }

    // Log per-query timing so we can identify which query is the bottleneck.
    // Only writes when DASHBOARD_PROFILE_LOG is set (dev/diagnostics); no-op elsewhere.
    const profileLogPath = process.env.DASHBOARD_PROFILE_LOG;
    const totalMs = timers.reduce((a, t) => a + t.ms, 0);
    const summary = timers.map((t) => `${t.name}=${t.ms}ms`).join(' | ');
    const pool = this.prisma.getPoolStats();
    if (profileLogPath) {
      try {
        appendFileSync(
          profileLogPath,
          `[${new Date().toISOString()}] TOTAL=${totalMs}ms | pool: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} | ${summary}\n`,
        );
      } catch {
        /* ignore */
      }
    }

    // Sections the caller holds no page for are zeroed — names, counts and
    // pay figures must never leak through the dashboard while the sidebar,
    // the gate and the API all refuse the underlying pages.
    const showRoster = canSeeEmployees;
    const showAttendance = canSeeAttendance;
    const showAbsence = canSeeEmployees && canSeeAttendance;

    return {
      totalEmployees: showRoster ? totalEmployees : 0,
      attendance: {
        count: showAttendance ? presentCount : 0,
        employees: showAttendance ? Array.from(presentMap.values()) : [],
      },
      absence: {
        count: showAbsence ? absentCount : 0,
        employees: showAbsence
          ? absentNotOnLeave.map((emp) => ({
              employeeId: emp.employeeId,
              name: emp.name,
              department: emp.department,
              scheduledStart: emp.scheduledStart,
              lastWorkDay: emp.attendanceRecords?.[0]?.date ?? null,
              lastCheckIn: emp.attendanceRecords?.[0]?.timestamp
                ? formatFactoryLocalTime(emp.attendanceRecords[0].timestamp)
                : null,
            }))
          : [],
      },
      totalDueSalaries: canSeePayroll ? Number(totalDueSalaries.toFixed(2)) : 0,
      totalReceivedSalaries: canSeePayroll ? Number(totalReceivedSalaries.toFixed(2)) : 0,
      lateness: {
        totalMinutes: showAttendance ? totalLateMinutes : 0,
        count: showAttendance ? lateEmployees.length : 0,
        employees: showAttendance ? lateEmployees : [],
      },
      overtime: {
        totalMinutes: showAttendance ? totalOvertimeMinutes : 0,
        count: showAttendance ? overtimeEmployees.length : 0,
        employees: showAttendance
          ? overtimeEmployees.map((e) => ({
              ...e,
              // Pay figures are salary data, not attendance data.
              overtimePay: canSeePayroll ? e.overtimePay : 0,
            }))
          : [],
      },
      reportDate: today,
    };
  }
}
