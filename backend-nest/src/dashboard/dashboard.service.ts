import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const GRACE_PERIOD_MINUTES = 15;
const DEFAULT_SCHEDULED_START = '08:00';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
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
        include: { employee: { select: { name: true, employeeId: true, scheduledStart: true } } },
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
    const presentMap = new Map<string, { name: string; checkIn: string }>();
    for (const rec of todayAttendanceRecords) {
      if (rec.type === 'IN' && !presentMap.has(rec.employeeId)) {
        presentMap.set(rec.employeeId, {
          name: rec.employee.name,
          checkIn: rec.timestamp.toISOString(),
        });
      }
    }
    const presentEmployees = Array.from(presentMap.values());
    const presentCount = presentEmployees.length;

    // ─── الغياب ──────────────────────────────────────────────────────────
    const absentCount = Math.max(0, totalEmployees - presentCount);
    const absentEmployees: { employeeId: string; name: string }[] = [];

    // ─── التأخير ──────────────────────────────────────────────────────────
    type LateEntry = { employeeId: string; name: string; minutesLate: number };
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
        lateEmployees.push({ employeeId, name: info.name, minutesLate });
        totalLateMinutes += minutesLate;
      }
    }

    // ─── العمل الإضافي ────────────────────────────────────────────────────
    type OvertimeEntry = {
      employeeId: string;
      name: string;
      overtimeMinutes: number;
      overtimePay: number;
    };
    const overtimeEmployees: OvertimeEntry[] = [];
    let totalOvertimeMinutes = 0;

    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'OUT') continue;
      const shiftPair = rec.shiftPair as Record<string, unknown> | null;
      const hoursWorked = Number(shiftPair?.hoursWorked ?? 0);
      const standardHours = 8;
      const overtimeHours = Math.max(0, hoursWorked - standardHours);
      const overtimeMinutes = Math.round(overtimeHours * 60);

      if (overtimeMinutes > 0) {
        const baseSalary = Number(salaryAgg._sum?.baseSalary ?? 0);
        const hourlyRate = baseSalary / (26 * 8);
        const overtimePay = Number((hourlyRate * overtimeHours * 1.5).toFixed(2));

        overtimeEmployees.push({
          employeeId: rec.employeeId,
          name: rec.employee.name,
          overtimeMinutes,
          overtimePay,
        });
        totalOvertimeMinutes += overtimeMinutes;
      }
    }

    // ─── الرواتب المستحقة من التجميعات ─────────────────────────────────
    const sumBase = Number(salaryAgg._sum?.baseSalary ?? 0);
    const sumLumpSum = Number(salaryAgg._sum?.lumpSumSalary ?? 0);
    const sumLiving = Number(salaryAgg._sum?.livingAllowance ?? 0);
    const sumResponsibility = Number(salaryAgg._sum?.responsibilityAllowance ?? 0);
    const sumExtraEffort = Number(salaryAgg._sum?.extraEffortAllowance ?? 0);
    const sumProductionIncentive = Number(salaryAgg._sum?.productionIncentive ?? 0);
    const sumTransport = Number(salaryAgg._sum?.transportAllowance ?? 0);
    const totalDueSalaries = sumBase + sumLumpSum + sumLiving + sumResponsibility + sumExtraEffort + sumProductionIncentive + sumTransport;
    
    // إجمالي المقبوض من آخر تشغيل رواتب (أولًا الشهر الحالي، إن لم يكن موجودًا آخر تشغيل مكتمل على الإطلاق)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIndex = now.getMonth();
    const periodStartDate = new Date(Date.UTC(currentYear, currentMonthIndex, 1));
    const periodEndDate = new Date(Date.UTC(currentYear, currentMonthIndex + 1, 0));

    const currentMonthRuns = await this.prisma.payrollRun.findMany({
      where: {
        periodStart: { gte: periodStartDate, lte: periodEndDate },
        status: 'completed',
      },
      orderBy: { runDate: 'desc' },
      include: { items: { select: { netPayRounded: true, netPay: true } } },
    });

    let latestRun = null;
    if (currentMonthRuns.length > 0) {
      latestRun = currentMonthRuns[0];
    } else {
      latestRun = await this.prisma.payrollRun.findFirst({
        where: { status: 'completed' },
        orderBy: { runDate: 'desc' },
        include: { items: { select: { netPayRounded: true, netPay: true } } },
      });
    }

    let totalReceivedSalaries = 0;
    if (latestRun && latestRun.items) {
      totalReceivedSalaries = latestRun.items.reduce((sum, item) => {
        return sum + Number(item.netPayRounded ?? item.netPay ?? 0);
      }, 0);
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
