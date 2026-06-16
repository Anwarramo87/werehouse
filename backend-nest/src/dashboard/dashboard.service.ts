import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const GRACE_PERIOD_MINUTES = 5;
const DEFAULT_SCHEDULED_START = '08:00';
const TIMEZONE_OFFSET_MINUTES = 180; // UTC+3
const STANDARD_WORKING_DAYS = 26;

function toNum(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') { const n = Number(val); return Number.isFinite(n) ? n : 0; }
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
  constructor(private readonly prisma: PrismaService) {}

  private todayKey(): string {
    const now = new Date();
    const local = new Date(now.getTime() + TIMEZONE_OFFSET_MINUTES * 60_000);
    return local.toISOString().slice(0, 10);
  }

  /** تحويل HH:mm إلى إجمالي دقائق منذ منتصف الليل */
  private parseClockMinutes(time: string): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? DEFAULT_SCHEDULED_START).slice(0, 5));
    if (!match) return 8 * 60; // افتراضي 08:00
    return Number(match[1]) * 60 + Number(match[2]);
  }

  /**
   * حساب دقائق التأخير مقارنةً بوقت البداية المجدول.
   * يعتمد على shiftPair.minutesLate إن كان محسوباً، وإلا يحسب من الوقت الفعلي.
   * يطرح grace period قبل الإرجاع لأن المطلوب هو التأخير الفعلي بعد المهلة.
   */
  private calcMinutesLate(
    checkInTimestamp: Date,
    scheduledStart: string | null,
    shiftPairMinutesLate?: number | null,
  ): number {
    // إذا كان shiftPair يحمل قيمة محسوبة مسبقاً نستخدمها مباشرة
    if (typeof shiftPairMinutesLate === 'number' && Number.isFinite(shiftPairMinutesLate) && shiftPairMinutesLate > 0) {
      return Math.max(0, Math.floor(shiftPairMinutesLate) - GRACE_PERIOD_MINUTES);
    }

    const scheduled = this.parseClockMinutes(scheduledStart ?? DEFAULT_SCHEDULED_START);
    const actual = checkInTimestamp.getHours() * 60 + checkInTimestamp.getMinutes();
    const diff = actual - scheduled;
    return diff > GRACE_PERIOD_MINUTES ? diff - GRACE_PERIOD_MINUTES : 0;
  }

  async getHomeStats() {
    const today = this.todayKey();

    const [
      totalEmployees,
      todayAttendanceRecords,
      salaryAggregate,
    ] = await Promise.all([
      // إجمالي الموظفين النشطين
      this.prisma.employee.count({ where: { status: 'active' } }),

      // سجلات الحضور لليوم (نحتفظ بالحد الأقصى 10,000 سجل لليوم الواحد)
      this.prisma.attendanceRecord.findMany({
        where: { date: today },
        include: { employee: { select: { name: true, employeeId: true, scheduledStart: true, department: true, scheduledEnd: true } } },
        orderBy: { timestamp: 'asc' },
        take: 10000,
      }),

      // تجميع الرواتب عبر قاعدة البيانات بدلاً من جلب كل السجلات
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
    ]);

    const salaryAgg = salaryAggregate as {
      _sum?: {
        baseSalary?: Prisma.Decimal | null;
        lumpSumSalary?: Prisma.Decimal | null;
        livingAllowance?: Prisma.Decimal | null;
        responsibilityAllowance?: Prisma.Decimal | null;
        extraEffortAllowance?: Prisma.Decimal | null;
        productionIncentive?: Prisma.Decimal | null;
        transportAllowance?: Prisma.Decimal | null;
      };
    };

    // ─── حضور اليوم ───────────────────────────────────────────────────────
    const presentMap = new Map<string, { name: string; department: string | null; checkIn: string }>();
    for (const rec of todayAttendanceRecords) {
      if (rec.type === 'IN' && !presentMap.has(rec.employeeId)) {
        const inLocalHours = rec.timestamp.getUTCHours() + 3;
        const inLocalMins = rec.timestamp.getUTCMinutes();
        const checkIn = `${String(inLocalHours % 24).padStart(2, '0')}:${String(inLocalMins).padStart(2, '0')}`;
        presentMap.set(rec.employeeId, {
          name: rec.employee.name,
          department: rec.employee.department,
          checkIn,
        });
      }
    }
    const presentEmployees = Array.from(presentMap.values());
    const presentCount = presentEmployees.length;

    // ─── الغياب ──────────────────────────────────────────────────────────
    const absentCount = Math.max(0, totalEmployees - presentCount);
    const absentEmployees: { employeeId: string; name: string; department: string | null; scheduledStart: string | null }[] = [];

    if (absentCount > 0) {
      const presentIds = Array.from(presentMap.keys());
      const allActiveEmployees = await this.prisma.employee.findMany({
        where: { status: 'active' },
        select: { employeeId: true, name: true, department: true, scheduledStart: true },
      });
      const presentSet = new Set(presentIds);
      for (const emp of allActiveEmployees) {
        if (!presentSet.has(emp.employeeId)) {
          absentEmployees.push({
            employeeId: emp.employeeId,
            name: emp.name,
            department: emp.department,
            scheduledStart: emp.scheduledStart,
          });
        }
      }
    }

    // ─── التأخير ──────────────────────────────────────────────────────────
    type LateEntry = { employeeId: string; name: string; scheduledStart: string; checkIn: string; minutesLate: number };
    const firstInMap = new Map<string, {
      timestamp: Date;
      scheduledStart: string | null;
      shiftPairMinutesLate: number | null;
      name: string;
    }>();

    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'IN') continue;
      if (firstInMap.has(rec.employeeId)) continue;
      const sp = rec.shiftPair as Record<string, unknown> | null;
      firstInMap.set(rec.employeeId, {
        timestamp: rec.timestamp,
        scheduledStart: rec.employee.scheduledStart ?? null,
        shiftPairMinutesLate: sp?.minutesLate != null ? Number(sp.minutesLate) : null,
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
        const inLocalHours = info.timestamp.getUTCHours() + 3;
        const inLocalMins = info.timestamp.getUTCMinutes();
        const checkIn = `${String(inLocalHours % 24).padStart(2, '0')}:${String(inLocalMins).padStart(2, '0')}`;
        lateEmployees.push({
          employeeId,
          name: info.name,
          scheduledStart: info.scheduledStart || DEFAULT_SCHEDULED_START,
          checkIn,
          minutesLate,
        });
        totalLateMinutes += minutesLate;
      }
    }

    // ─── العمل الإضافي ────────────────────────────────────────────────────
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

    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'OUT') continue;
      const shiftPair = rec.shiftPair as Record<string, unknown> | null;
      const hoursWorked = toNum(shiftPair?.hoursWorked);
      const standardHours = 8;
      const overtimeHours = Math.max(0, hoursWorked - standardHours);
      const overtimeMinutes = Math.round(overtimeHours * 60);

      if (overtimeMinutes > 0) {
        const baseSalary = toNum(salaryAgg._sum?.baseSalary);
        const hourlyRate = baseSalary / (STANDARD_WORKING_DAYS * 8);
        const overtimePay = Number((hourlyRate * overtimeHours * 1.5).toFixed(2));

        const outLocalHours = rec.timestamp.getUTCHours() + 3;
        const outLocalMins = rec.timestamp.getUTCMinutes();
        const actualCheckOut = `${String(outLocalHours % 24).padStart(2, '0')}:${String(outLocalMins).padStart(2, '0')}`;

        overtimeEmployees.push({
          employeeId: rec.employeeId,
          name: rec.employee.name,
          department: rec.employee.department,
          scheduledEnd: rec.employee.scheduledEnd || '16:00',
          actualCheckOut,
          overtimeMinutes,
          overtimePay,
        });
        totalOvertimeMinutes += overtimeMinutes;
      }
    }

    // ─── الرواتب المستحقة من التجميعات ─────────────────────────────────
    const sumBase = toNum(salaryAgg._sum?.baseSalary);
    const sumLumpSum = toNum(salaryAgg._sum?.lumpSumSalary);
    const sumLiving = toNum(salaryAgg._sum?.livingAllowance);
    const sumResponsibility = toNum(salaryAgg._sum?.responsibilityAllowance);
    const sumExtraEffort = toNum(salaryAgg._sum?.extraEffortAllowance);
    const sumProductionIncentive = toNum(salaryAgg._sum?.productionIncentive);
    const sumTransport = toNum(salaryAgg._sum?.transportAllowance);
    const totalDueSalaries = sumBase + sumLumpSum + sumLiving + sumResponsibility + sumExtraEffort + sumProductionIncentive + sumTransport;
    
    // ─── اجمالي المقبوض (حساب نسبي حسب أيام الحضور الفعلية) ─────────────
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIndex = now.getMonth();
    const monthStartDate = new Date(Date.UTC(currentYear, currentMonthIndex, 1));
    const monthEndDate = new Date(Date.UTC(currentYear, currentMonthIndex + 1, 0, 23, 59, 59));

    // جلب كل الموظفين النشطين مع رواتبهم
    const allActiveWithSalaries = await this.prisma.employee.findMany({
      where: { status: 'active' },
      select: {
        employeeId: true,
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
    });

    // جلب سجلات الحضور لهذا الشهر (حاضر = IN)
    const monthAttendanceRecords = await this.prisma.attendanceRecord.findMany({
      where: {
        type: 'IN',
        date: {
          gte: monthStartDate.toISOString().slice(0, 10),
          lte: monthEndDate.toISOString().slice(0, 10),
        },
      },
      select: { employeeId: true, date: true },
    });

    // حساب أيام الحضور لكل موظف (بدون تكرار لنفس اليوم)
    const attendanceDaysMap = new Map<string, Set<string>>();
    for (const rec of monthAttendanceRecords) {
      if (!attendanceDaysMap.has(rec.employeeId)) {
        attendanceDaysMap.set(rec.employeeId, new Set());
      }
      attendanceDaysMap.get(rec.employeeId)!.add(rec.date);
    }

    // حساب الرواتب النسبية لكل موظف
    let totalReceivedSalaries = 0;
    for (const emp of allActiveWithSalaries) {
      const salary = emp.employeeSalary;
      if (!salary) continue;

      const empTotalSalary =
        toNum(salary.baseSalary) +
        toNum(salary.lumpSumSalary) +
        toNum(salary.livingAllowance) +
        toNum(salary.responsibilityAllowance) +
        toNum(salary.extraEffortAllowance) +
        toNum(salary.productionIncentive) +
        toNum(salary.transportAllowance);

      const attendedDays = attendanceDaysMap.get(emp.employeeId)?.size ?? 0;
      const proratedSalary = empTotalSalary * Math.min(attendedDays, STANDARD_WORKING_DAYS) / STANDARD_WORKING_DAYS;
      totalReceivedSalaries += proratedSalary;
    }

    return {
      totalEmployees,
      attendance: {
        count: presentCount,
        employees: presentEmployees,
      },
      absence: {
        count: absentCount,
        employees: absentEmployees,
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
