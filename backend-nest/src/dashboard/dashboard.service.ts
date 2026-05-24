import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async getHomeStats() {
    const today = this.todayKey();

    const [
      totalEmployees,
      todayAttendanceRecords,
      salaryRecords,
      latestPayrollRun,
    ] = await Promise.all([
      // إجمالي الموظفين النشطين
      this.prisma.employee.count({ where: { status: 'active' } }),

      // سجلات الحضور لليوم
      this.prisma.attendanceRecord.findMany({
        where: { date: today },
        include: { employee: { select: { name: true, employeeId: true, scheduledStart: true } } },
        orderBy: { timestamp: 'asc' },
      }),

      // سجلات الرواتب
      this.prisma.employeeSalary.findMany({
        select: {
          employeeId: true,
          baseSalary: true,
          lumpSumSalary: true,
          livingAllowance: true,
          responsibilityAllowance: true,
          extraEffortAllowance: true,
          productionIncentive: true,
          insuranceAmount: true,
          transportAllowance: true,
        },
      }),
      this.prisma.payrollRun.findFirst({
        where: { status: 'completed' },
        orderBy: { runDate: 'desc' },
        include: {
          items: { select: { netPayRounded: true, netPay: true } },
        },
      }),
    ]);

    // ─── حضور اليوم ───────────────────────────────────────────────────────
    // نجمع أول IN لكل موظف اليوم
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

    // ─── الغياب (محسوب بطريقة مُخففة لتجنّب جلب كل الموظفين)
    // بدلاً من جلب جميع الموظفين النشطين، نحسب العدد الغائب بطرح الحاضرين من الإجمالي.
    // نُعيد مصفوفة فارغة للأسماء لتجنّب تحميل جدول الموظفين بالكامل — إذا احتجنا أسماء،
    // يمكن توفير endpoint منفصل يحمّل عينات أو صفحة من الأسماء.
    const absentCount = Math.max(0, totalEmployees - presentCount);
    const absentEmployees: { employeeId: string; name: string }[] = [];

    // ─── التأخير ──────────────────────────────────────────────────────────
    type LateEntry = { employeeId: string; name: string; minutesLate: number };
    const lateEmployees: LateEntry[] = [];
    let totalLateMinutes = 0;

    for (const rec of todayAttendanceRecords) {
      if (rec.type !== 'IN') continue;
      const shiftPair = rec.shiftPair as Record<string, unknown> | null;
      const minutesLate = Number(shiftPair?.minutesLate ?? 0);
      if (minutesLate > 0) {
        lateEmployees.push({
          employeeId: rec.employeeId,
          name: rec.employee.name,
          minutesLate,
        });
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
      // نعتبر أكثر من 8 ساعات عمل إضافي
      const standardHours = 8;
      const overtimeHours = Math.max(0, hoursWorked - standardHours);
      const overtimeMinutes = Math.round(overtimeHours * 60);

      if (overtimeMinutes > 0) {
        // حساب أجر الإضافي بناءً على الراتب الساعي
        const salaryRec = salaryRecords.find((s) => s.employeeId === rec.employeeId);
        const baseSalary = Number(salaryRec?.baseSalary ?? 0);
        // الراتب الساعي = الراتب الأساسي / (26 يوم * 8 ساعات)
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

    // ─── الرواتب المستحقة ─────────────────────────────────────────────────
    // نعتمد أحدث تشغيل رواتب إن وجد، وإلا نرجع لتقدير ثابت من السجل
    const payrollRunTotal = latestPayrollRun?.items?.reduce((sum, item) => {
      return sum + Number(item.netPayRounded ?? item.netPay ?? 0);
    }, 0);
    const fallbackTotalDueSalaries = salaryRecords.reduce((sum, s) => {
      const gross = Number(s.baseSalary) + Number(s.transportAllowance);
      const deductions = Number(s.insuranceAmount);
      return sum + gross - deductions;
    }, 0);
    const totalDueSalaries = payrollRunTotal ?? fallbackTotalDueSalaries;

    return {
      // ─── إجمالي الموظفين
      totalEmployees,

      // ─── حضور اليوم
      attendance: {
        count: presentCount,
        employees: presentEmployees,
      },

      // ─── الغياب
      absence: {
        count: absentCount,
        employees: absentEmployees,
      },

      // ─── الرواتب المستحقة
      totalDueSalaries: Number(totalDueSalaries.toFixed(2)),

      // ─── التأخير
      lateness: {
        totalMinutes: totalLateMinutes,
        count: lateEmployees.length,
        employees: lateEmployees,
      },

      // ─── العمل الإضافي
      overtime: {
        totalMinutes: totalOvertimeMinutes,
        count: overtimeEmployees.length,
        employees: overtimeEmployees,
      },

      // ─── تاريخ التقرير
      reportDate: today,
    };
  }
}
