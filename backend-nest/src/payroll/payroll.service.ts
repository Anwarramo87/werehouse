import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { CalculatePayrollDto } from './dto/calculate-payroll.dto';
import { PayrollListQueryDto } from './dto/payroll-list-query.dto';
import { PayrollInputsQueryDto, UpsertPayrollInputDto } from './dto/payroll-input.dto';
import { Queue } from 'bullmq';
import { QUEUE_JOBS, QUEUE_NAMES } from '../queues/queue.constants';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { TransportationService } from '../transportation/transportation.service';
import {
  PAYROLL_BATCH_SIZE,
  WORK_DAYS_PER_MONTH,
  WORK_HOURS_PER_DAY,
  MINUTES_PER_HOUR as MINUTES_PER_HOUR_NUM,
  OVERTIME_MULTIPLIER,
  SICK_LEAVE_DEDUCTION_RATIO,
  WEEKEND_MULTIPLIER,
  PAYROLL_ROUNDING_UNIT,
} from '../common/constants/payroll.constants';

const STANDARD_WORK_DAYS = new Prisma.Decimal(WORK_DAYS_PER_MONTH);
const STANDARD_HOURS_PER_DAY = new Prisma.Decimal(WORK_HOURS_PER_DAY);
const MINUTES_PER_HOUR = new Prisma.Decimal(MINUTES_PER_HOUR_NUM);
const MULTIPLIER_OVERTIME = new Prisma.Decimal(OVERTIME_MULTIPLIER);
const MULTIPLIER_SICK_LEAVE = new Prisma.Decimal(SICK_LEAVE_DEDUCTION_RATIO);
const MULTIPLIER_WEEKEND = new Prisma.Decimal(WEEKEND_MULTIPLIER);

type PayrollQueuePayload = {
  payrollRunId: string;
  dto: CalculatePayrollDto;
  userId?: string;
};

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @InjectQueue(QUEUE_NAMES.PAYROLL) private readonly payrollQueue?: Queue,
    @Optional() private readonly transportationService?: TransportationService,
  ) {}

  private toDecimal(value: Prisma.Decimal | number | string | null | undefined) {
    if (value instanceof Prisma.Decimal) {
      return value;
    }
    return new Prisma.Decimal(value ?? 0);
  }

  /** Normalize any date string to YYYY-MM-DD (strip timezone offsets) */
  private toDateOnly(value: string): Date {
    return new Date(value.slice(0, 10) + 'T00:00:00.000Z');
  }

  private roundUpToNearestThousand(value: Prisma.Decimal) {
    const numeric = value.toNumber();
    if (!Number.isFinite(numeric) || numeric === 0) {
      return new Prisma.Decimal(0);
    }
    return new Prisma.Decimal(Math.ceil(numeric / PAYROLL_ROUNDING_UNIT) * PAYROLL_ROUNDING_UNIT);
  }

  private resolveAttendanceValue(value: number | null | undefined, fallback: number, enabled: boolean) {
    if (value !== null && value !== undefined) {
      return Number(value);
    }

    return enabled ? fallback : 0;
  }

  private extractMinutesLate(shiftPair: Prisma.JsonValue | null): number {
    if (!shiftPair || typeof shiftPair !== 'object' || Array.isArray(shiftPair)) {
      return 0;
    }

    const raw = (shiftPair as Record<string, unknown>).minutesLate;
    const parsed = Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }
  
  private extractHoursWorked(shiftPair: Prisma.JsonValue | null): number {
    if (!shiftPair || typeof shiftPair !== 'object') return 0;
    
    const raw = (shiftPair as Record<string, unknown>).hoursWorked;
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private resolvePeriod(periodStart?: string, periodEnd?: string) {
    if (periodStart && periodEnd) {
      return { periodStart, periodEnd };
    }

    if (periodStart || periodEnd) {
      throw new BadRequestException('Period start and end dates must be provided together');
    }

    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);

    return {
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
    };
  }

  private resolveMonthPeriod(month: string) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }

    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const periodStartDate = new Date(Date.UTC(year, monthIndex, 1));
    const periodEndDate = new Date(Date.UTC(year, monthIndex + 1, 0));

    return {
      periodStartDate,
      periodEndDate,
      periodStart: `${match[1]}-${match[2]}-01`,
      periodEnd: `${match[1]}-${match[2]}-${String(periodEndDate.getUTCDate()).padStart(2, '0')}`,
    };
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private async resolvePayrollRun(runIdentifier: string) {
    const where: Prisma.PayrollRunWhereInput = this.isUuid(runIdentifier)
      ? {
          OR: [{ id: runIdentifier }, { runId: runIdentifier }],
        }
      : { runId: runIdentifier };

    const run = await this.prisma.payrollRun.findFirst({ where });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  async list(query: PayrollListQueryDto) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.PayrollRunWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;

    const [payrollRuns, total] = await Promise.all([
      this.prisma.payrollRun.findMany({
        where,
        orderBy: { runDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payrollRun.count({ where }),
    ]);

    return {
      data: payrollRuns,
      ...paginationMeta(page, limit, total),
    };
  }

  async listInputs(query: PayrollInputsQueryDto) {
    const page = Math.max(1, (query as any).page ?? 1);
    const limit = Math.min(200, Math.max(1, (query as any).limit ?? 50));
    const skip = (page - 1) * limit;
    const where: Prisma.PayrollInputWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.periodStart && query.periodEnd) {
      where.periodStart = this.toDateOnly(query.periodStart);
      where.periodEnd = this.toDateOnly(query.periodEnd);
    }

    const [records, total] = await Promise.all([
      this.prisma.payrollInput.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payrollInput.count({ where }),
    ]);

    return {
      data: records,
      ...paginationMeta(page, limit, total),
    };
  }

  async upsertInput(dto: UpsertPayrollInputDto) {
    const periodStart = dto.periodStart.slice(0, 10);
    const periodEnd = dto.periodEnd.slice(0, 10);

    const data = {
      employeeId: dto.employeeId,
      periodStart: this.toDateOnly(periodStart),
      periodEnd: this.toDateOnly(periodEnd),
      lateMinutes: Number(dto.lateMinutes ?? 0),
      earlyLeaveMinutes: Number(dto.earlyLeaveMinutes ?? 0),
      absenceDays: Number(dto.absenceDays ?? 0),
      sickLeaveDays: Number(dto.sickLeaveDays ?? 0),
      adminLeaveDays: Number(dto.adminLeaveDays ?? 0),
      unpaidLeaveDays: Number(dto.unpaidLeaveDays ?? 0),
      deathLeaveDays: Number(dto.deathLeaveDays ?? 0),
      unpaidHours: new Prisma.Decimal((dto.unpaidHours ?? 0).toString()),
      overtimeRegularMinutes: Number(dto.overtimeRegularMinutes ?? 0),
      overtimeWeekendDays: new Prisma.Decimal((dto.overtimeWeekendDays ?? 0).toString()),
      penaltyAmount: new Prisma.Decimal((dto.penaltyAmount ?? 0).toString()),
      clothingDeduction: new Prisma.Decimal((dto.clothingDeduction ?? 0).toString()),
      bonusAdjustment: new Prisma.Decimal((dto.bonusAdjustment ?? 0).toString()),
      advanceAmount: new Prisma.Decimal((dto.advanceAmount ?? 0).toString()),
      insuranceAmount:
        dto.insuranceAmount === undefined || dto.insuranceAmount === null
          ? null
          : new Prisma.Decimal(dto.insuranceAmount.toString()),
      transportAllowanceOverride:
        dto.transportAllowanceOverride === undefined || dto.transportAllowanceOverride === null
          ? null
          : new Prisma.Decimal(dto.transportAllowanceOverride.toString()),
      notes: dto.notes ?? null,
    } as Prisma.PayrollInputUncheckedCreateInput;

    return this.prisma.payrollInput.upsert({
      where: {
        employeeId_periodStart_periodEnd: {
          employeeId: dto.employeeId,
          periodStart: this.toDateOnly(periodStart),
          periodEnd: this.toDateOnly(periodEnd),
        },
      },
      update: data,
      create: data,
    });
  }

  async calculateProvisionalSettlement(employeeId: string, terminationDateStr: string) {
    const terminationDate = new Date(terminationDateStr);
    const month = terminationDateStr.substring(0, 7); // YYYY-MM

    const [employee, employeeSalary] = await Promise.all([
      this.prisma.employee.findUnique({ where: { employeeId } }),
      this.prisma.employeeSalary.findUnique({ where: { employeeId } }),
    ]);

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found.`);
    }

    // 2. Fetch bonuses up to termination date
    const bonuses = await this.prisma.employeeBonus.findMany({
      where: {
        employeeId,
        period: month,
      },
    });
    const totalBonuses = bonuses.reduce((sum, b) => {
      return sum.plus(this.toDecimal(b.bonusAmount)).plus(this.toDecimal(b.assistanceAmount));
    }, new Prisma.Decimal(0));

    // 3. Fetch deductions (advances and penalties) up to termination date
    const advances = await this.prisma.employeeAdvance.findMany({
      where: {
        employeeId,
        issueDate: { lte: terminationDate },
        remainingAmount: { gt: 0 },
      },
    });

    const penalties = await this.prisma.employeePenalty.findMany({
      where: {
        employeeId,
        issueDate: { lte: terminationDate },
      },
    });
    
    const totalAdvances = advances.reduce((sum, a) => {
      // Deduct only the installment amount, or remaining amount if less
      const installment = this.toDecimal(a.installmentAmount).toNumber();
      const remaining = this.toDecimal(a.remainingAmount).toNumber();
      const deductible = Math.min(installment, remaining);
      return sum.plus(new Prisma.Decimal(deductible));
    }, new Prisma.Decimal(0));

    const totalPenalties = penalties.reduce((sum, p) => {
      return sum.plus(this.toDecimal(p.amount));
    }, new Prisma.Decimal(0));

    const otherDeductions = this.toDecimal(employeeSalary?.insuranceAmount);

    const totalDeductions = totalAdvances.plus(totalPenalties).plus(otherDeductions);

    // 4. Calculate earned salary using the same g3 formula as processPayrollRun
    let earnedSalary = new Prisma.Decimal(0);
    if (employee.baseSalary || employeeSalary) {
      const baseSalary = this.toDecimal(employeeSalary?.baseSalary ?? employee.baseSalary ?? 0);
      const livingAllowance = this.toDecimal(employeeSalary?.livingAllowance ?? 0);
      const lumpSumSalary = this.toDecimal(employeeSalary?.lumpSumSalary ?? 0);
      const g3 = baseSalary.plus(livingAllowance).plus(lumpSumSalary);
      const dailyWage = g3.div(STANDARD_WORK_DAYS);
      const daysWorkedInTerminationMonth = new Prisma.Decimal(terminationDate.getDate());
      earnedSalary = dailyWage.mul(daysWorkedInTerminationMonth);
    } else if (employee.hourlyRate) {
      const hourlyRate = this.toDecimal(employee.hourlyRate);
      const hoursPerDay = this.toDecimal(employee.hoursPerDay ?? WORK_HOURS_PER_DAY);
      const daysWorkedInTerminationMonth = new Prisma.Decimal(terminationDate.getDate());
      earnedSalary = hourlyRate.mul(hoursPerDay).mul(daysWorkedInTerminationMonth);
    }

    // Final calculation for provisional settlement
    const provisionalFinalSalary = earnedSalary.plus(totalBonuses).minus(totalDeductions);

    return {
      employeeId: employee.employeeId,
      employeeName: employee.name,
      terminationDate: terminationDateStr,
      earnedSalary: earnedSalary.toFixed(2),
      bonuses: totalBonuses.toFixed(2),
      deductions: totalDeductions.toFixed(2),
      provisionalTotal: provisionalFinalSalary.toFixed(2),
      currency: employee.currency ?? 'SYP',
    };
  }

  async calculate(dto: CalculatePayrollDto, userId?: string) {
    const runDateKey = dto.periodStart.slice(0, 10).replace(/-/g, '');
    const runId = `PAY${runDateKey}-${Date.now().toString().slice(-4)}`;

    const run = await this.prisma.payrollRun.create({
      data: {
        runId,
        periodStart: this.toDateOnly(dto.periodStart),
        periodEnd: this.toDateOnly(dto.periodEnd),
        runBy: userId,
        status: 'processing',
        approvalStatus: 'pending',
        totalEmployees: 0,
      },
    });

    const updatedRun = await this.processPayrollRun(run.id, dto, userId);

    return { message: 'Payroll calculated successfully', payrollRun: updatedRun };
  }

  async calculateAsync(dto: CalculatePayrollDto, userId?: string) {
    const runDateKey = dto.periodStart.slice(0, 10).replace(/-/g, '');
    const runId = `PAY${runDateKey}-${Date.now().toString().slice(-4)}`;

    const run = await this.prisma.payrollRun.create({
      data: {
        runId,
        periodStart: this.toDateOnly(dto.periodStart),
        periodEnd: this.toDateOnly(dto.periodEnd),
        runBy: userId,
        status: 'queued',
        approvalStatus: 'pending',
        totalEmployees: 0,
      },
    });

    await this.enqueuePayrollJob({ payrollRunId: run.id, dto, userId });

    return { message: 'Payroll calculation queued', payrollRun: run };
  }

  async getRun(runId: string) {
    const payrollRun = await this.resolvePayrollRun(runId);
    const items = await this.prisma.payrollItem.findMany({ where: { payrollRunId: payrollRun.id } });
    return { payrollRun, items, itemCount: items.length };
  }

  async getEmployeeHistory(employeeId: string) {
    const payrollItems = await this.prisma.payrollItem.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
    });
    return { employeeId, payrollItems };
  }

  async approve(runId: string, userId?: string) {
    const run = await this.resolvePayrollRun(runId);

    const updated = await this.prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: 'approved',
        approvalStatus: 'approved',
        approvedBy: userId,
        approvalDate: new Date(),
      },
    });

    return { message: 'Payroll approved successfully', payrollRun: updated };
  }

  async reject(runId: string, reason: string, userId?: string) {
    if (!reason) throw new BadRequestException('Rejection reason is required');
    const run = await this.resolvePayrollRun(runId);

    const updated = await this.prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: 'draft',
        approvalStatus: 'rejected',
        approvedBy: userId,
        notes: reason,
      },
    });

    return { message: 'Payroll rejected successfully', payrollRun: updated };
  }

  async deletePayrollRun(runId: string, userId?: string) {
    const run = await this.resolvePayrollRun(runId);

    if (run.approvalStatus === 'approved') {
      throw new BadRequestException('Cannot delete an approved payroll run');
    }

    const items = await this.prisma.payrollItem.findMany({ where: { payrollRunId: run.id } });

    await this.prisma.deletedRecordHistory.create({
      data: {
        entityType: 'PayrollRun',
        recordId: run.id,
        payload: {
          run,
          items,
          deletedBy: userId,
          deletedAt: new Date().toISOString(),
        },
      },
    });

    await this.prisma.payrollItem.deleteMany({ where: { payrollRunId: run.id } });
    await this.prisma.payrollRun.delete({ where: { id: run.id } });

    return { message: 'Payroll run deleted successfully', runId: run.runId };
  }

  async summary(periodStart?: string, periodEnd?: string) {
    const period = this.resolvePeriod(periodStart, periodEnd);

    const runs = await this.prisma.payrollRun.findMany({
      where: {
        periodStart: { gte: this.toDateOnly(period.periodStart), lte: this.toDateOnly(period.periodEnd) },
      },
    });

    return {
      period,
      summary: {
        totalRuns: runs.length,
        totalNetPay: Number(
          runs
            .reduce((sum, run) => sum.plus(this.toDecimal(run.totalNetPay || 0)), new Prisma.Decimal(0))
            .toFixed(2),
        ),
        totalGrossPay: Number(
          runs
            .reduce((sum, run) => sum.plus(this.toDecimal(run.totalGrossPay || 0)), new Prisma.Decimal(0))
            .toFixed(2),
        ),
      },
    };
  }

  async report(month: string) {
    const period = this.resolveMonthPeriod(month);

    const runs = await this.prisma.payrollRun.findMany({
      where: {
        periodStart: {
          gte: period.periodStartDate,
          lte: period.periodEndDate,
        },
      },
      orderBy: { runDate: 'desc' },
    });

    if (runs.length === 0) {
      return {
        month,
        period: {
          startDate: period.periodStart,
          endDate: period.periodEnd,
        },
        runsCount: 0,
        latestRun: null,
        totals: {
          totalGrossPay: 0,
          totalDeductions: 0,
          totalNetPay: 0,
        },
        items: [],
      };
    }

    const latestRun = runs[0];
    const items = await this.prisma.payrollItem.findMany({
      where: { payrollRunId: latestRun.id },
      orderBy: { employeeId: 'asc' },
    });

    return {
      month,
      period: {
        startDate: period.periodStart,
        endDate: period.periodEnd,
      },
      runsCount: runs.length,
      latestRun,
      totals: {
        totalGrossPay: Number(
          runs
            .reduce((sum, run) => sum.plus(this.toDecimal(run.totalGrossPay || 0)), new Prisma.Decimal(0))
            .toFixed(2),
        ),
        totalDeductions: Number(
          runs
            .reduce((sum, run) => sum.plus(this.toDecimal(run.totalDeductions || 0)), new Prisma.Decimal(0))
            .toFixed(2),
        ),
        totalNetPay: Number(
          runs
            .reduce((sum, run) => sum.plus(this.toDecimal(run.totalNetPay || 0)), new Prisma.Decimal(0))
            .toFixed(2),
        ),
      },
      items,
    };
  }

  async anomalies(runId: string) {
    const run = await this.resolvePayrollRun(runId);
    const anomalies = await this.prisma.payrollItem.findMany({
      where: {
        payrollRunId: run.id,
        NOT: { anomalies: { isEmpty: true } },
      },
    });

    return {
      runId: run.runId,
      anomalyCount: anomalies.length,
      anomalies: anomalies.map((a: (typeof anomalies)[number]) => ({
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        anomalies: a.anomalies,
      })),
    };
  }

  async export(runId: string) {
    const run = await this.resolvePayrollRun(runId);

    const items = await this.prisma.payrollItem.findMany({
      where: { payrollRunId: run.id },
      orderBy: { employeeId: 'asc' },
    });

    const fileName = `payroll-${run.runId}.csv`;
    return {
      mimeType: 'text/csv; charset=utf-8',
      fileName,
      content: this.buildCsv(run, items),
    };
  }

  async exportPdf(runId: string) {
    const run = await this.resolvePayrollRun(runId);

    const items = await this.prisma.payrollItem.findMany({
      where: { payrollRunId: run.id },
      orderBy: { employeeId: 'asc' },
    });

    const pdf = await PDFDocument.create();
    const page = pdf.addPage([842, 595]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const margin = 24;
    let y = 565;

    page.drawText(`Payroll Report: ${run.runId}`, {
      x: margin,
      y,
      size: 14,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= 20;
    page.drawText(`Period: ${run.periodStart.toISOString().slice(0, 10)} to ${run.periodEnd.toISOString().slice(0, 10)}`, {
      x: margin,
      y,
      size: 10,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= 24;

    const header = 'EmpID        Name                    Dept            Gross     Deductions   Net';
    page.drawText(header, { x: margin, y, size: 10, font: bold });
    y -= 14;

    for (const item of items) {
      if (y < 36) {
        break;
      }

      const netDisplay = Number(item.netPayRounded ?? item.netPay);
      const line = [
        (item.employeeId || '').padEnd(12).slice(0, 12),
        (item.employeeName || '').padEnd(24).slice(0, 24),
        (item.department || '').padEnd(14).slice(0, 14),
        Number(item.grossPay).toFixed(2).padStart(10),
        Number(item.totalDeductions).toFixed(2).padStart(12),
        netDisplay.toFixed(2).padStart(8),
      ].join(' ');

      page.drawText(line, { x: margin, y, size: 9, font });
      y -= 12;
    }

    const bytes = await pdf.save();
    return {
      mimeType: 'application/pdf',
      fileName: `payroll-${run.runId}.pdf`,
      content: Buffer.from(bytes),
    };
  }

  private buildCsv(run: NonNullable<Awaited<ReturnType<PrismaService['payrollRun']['findUnique']>>>, items: Awaited<ReturnType<PrismaService['payrollItem']['findMany']>>) {
    const rows: string[] = [];
    rows.push([
      'payrollRunId',
      'periodStart',
      'periodEnd',
      'employeeId',
      'employeeName',
      'department',
      'hoursWorked',
      'hourlyRate',
      'grossPay',
      'totalDeductions',
      'netPay',
      'netPayRounded',
      'roundingDifference',
      'netPayWithAdvance',
      'anomalies',
    ].join(','));

    for (const item of items) {
      rows.push([
        this.escapeCsv(run.runId),
        this.escapeCsv(run.periodStart.toISOString().slice(0, 10)),
        this.escapeCsv(run.periodEnd.toISOString().slice(0, 10)),
        this.escapeCsv(item.employeeId),
        this.escapeCsv(item.employeeName),
        this.escapeCsv(item.department),
        this.escapeCsv(Number(item.hoursWorked)),
        this.escapeCsv(Number(item.hourlyRate)),
        this.escapeCsv(Number(item.grossPay)),
        this.escapeCsv(Number(item.totalDeductions)),
        this.escapeCsv(Number(item.netPay)),
        this.escapeCsv(Number(item.netPayRounded)),
        this.escapeCsv(Number(item.roundingDifference)),
        this.escapeCsv(Number(item.netPayWithAdvance)),
        this.escapeCsv((item.anomalies || []).join('; ')),
      ].join(','));
    }

    return rows.join('\n');
  }

  private escapeCsv(value: unknown): string {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  async processPayrollRunJob(payload: PayrollQueuePayload) {
    return this.processPayrollRun(payload.payrollRunId, payload.dto, payload.userId);
  }

  async markPayrollRunFailed(payrollRunId: string, message: string) {
    await this.prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        status: 'failed',
        notes: message || 'Payroll calculation failed',
      },
    });
  }

  private async enqueuePayrollJob(payload: PayrollQueuePayload) {
    try {
      if (!this.payrollQueue) {
        throw new Error('Payroll queue is not available');
      }

      const workers = await this.payrollQueue.getWorkers();
      if (workers.length === 0) {
        throw new Error('No payroll worker is currently connected');
      }

      await this.payrollQueue.add(QUEUE_JOBS.PAYROLL_CALCULATE, payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      });
      return;
    } catch (error) {
      this.logger.warn(
        `Payroll queue unavailable; falling back to inline execution. Reason: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      await this.processPayrollRunJob(payload);
    }
  }

  private async processPayrollRun(runId: string, dto: CalculatePayrollDto, userId?: string) {
    const targetEmployees = await this.prisma.employee.findMany({
      where: {
        OR: [
          { status: 'active' },
          { status: 'terminated', isSettled: false },
        ],
      },
      orderBy: { employeeId: 'asc' },
      select: {
        employeeId: true,
        name: true,
        department: true,
        hourlyRate: true,
        baseSalary: true,
        workDaysInPeriod: true,
        hoursPerDay: true,
        gracePeriodMinutes: true,
      },
    });

    if (targetEmployees.length === 0) {
      throw new BadRequestException('No eligible employees found');
    }

    const employeeIds = targetEmployees.map((employee) => employee.employeeId);
    const periodStart = dto.periodStart.slice(0, 10);
    const periodEnd = dto.periodEnd.slice(0, 10);
    const periodTag = periodStart.slice(0, 7);
    const defaultGracePeriodMinutes = Math.max(0, Number(dto.gracePeriodMinutes ?? 5));
    const defaultWorkDaysInPeriod = Math.max(1, Number(dto.workDaysInPeriod ?? 26));
    const defaultHoursPerDay = Math.max(1, Number(dto.hoursPerDay ?? 8));

    // تحديد الـ flags للخصومات (افتراضياً مفعل)
    const includeAttendanceDeductions = dto.includeAttendanceDeductions !== false;
    const includeTransportationDeductions = dto.includeTransportationDeductions !== false;

    const [
      salaryRecords,
      bonuses,
      advances,
      penalties,
      attendanceInRecords,
      payrollInputs,
      dailyOvertimeLogs,
    ] = await Promise.all([


      this.prisma.employeeSalary.findMany({
        where: { employeeId: { in: employeeIds } },
      }),
      this.prisma.employeeBonus.findMany({
        where: {
          employeeId: { in: employeeIds },
          OR: [
            // جلب bonuses بفترة محددة
            { period: periodTag },
            // جلب bonuses بدون فترة (خصومات عامة)
            { period: null },
            // جلب bonuses المنشأة خلال الفترة (في حالة عدم تحديد period)
            { createdAt: { gte: new Date(`${periodStart}T00:00:00.000Z`), lte: new Date(`${periodEnd}T23:59:59.999Z`) } },
          ],
        },
      }),
      this.prisma.employeeAdvance.findMany({
        where: {
          employeeId: { in: employeeIds },
          remainingAmount: { gt: new Prisma.Decimal(0) },
        },
      }),
      this.prisma.employeePenalty.findMany({
        where: {
          employeeId: { in: employeeIds },
          issueDate: {
            gte: new Date(`${periodStart}T00:00:00.000Z`),
            lte: new Date(`${periodEnd}T23:59:59.999Z`),
          },
        },
      }),
      includeAttendanceDeductions
        ? this.prisma.attendanceRecord.findMany({
            where: {
              employeeId: { in: employeeIds },
              type: 'IN',
              date: {
                gte: periodStart,
                lte: periodEnd,
              },
            },
            select: {
              employeeId: true,
              date: true,
              shiftPair: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.payrollInput.findMany({
        where: {
          employeeId: { in: employeeIds },
          periodStart: this.toDateOnly(periodStart),
          periodEnd: this.toDateOnly(periodEnd),
        },
      }),
      // DailyAttendanceLog: base automated overtime data
      this.prisma.dailyAttendanceLog.findMany({
        where: {
          employeeId: { in: employeeIds },
          recordType: 'OVERTIME_MINUTES',
          date: {
            gte: new Date(`${periodStart}T00:00:00.000Z`),
            lte: new Date(`${periodEnd}T23:59:59.999Z`),
          },
        },
        select: {
          employeeId: true,
          date: true,
          value: true,
        },
      }),
    ]);


    const salaryByEmployee = new Map(salaryRecords.map((record) => [record.employeeId, record]));
    const employeeById = new Map(targetEmployees.map((employee) => [employee.employeeId, employee]));
    const payrollInputByEmployee = new Map(payrollInputs.map((input) => [input.employeeId, input]));

    const attendanceDatesByEmployee = new Map<string, Set<string>>();
    const lateMinutesByEmployee = new Map<string, number>();
    const overtimeMinutesByEmployee = new Map<string, number>();

    const overtimeWeekendMinutesByEmployee = new Map<string, number>();
    const overtimeWeekendDaysByEmployee = new Map<string, number>();

    // Classify weekend overtime (Friday) from DailyAttendanceLog
    for (const log of dailyOvertimeLogs) {
      // NOTE timezone: relies on JS Date created by Prisma for `date` field.
      const d = new Date(log.date);
      const isFriday = d.getDay() === 5;
      if (!isFriday) continue;

      const minutes = Number(log.value ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;

      overtimeWeekendMinutesByEmployee.set(
        log.employeeId,
        (overtimeWeekendMinutesByEmployee.get(log.employeeId) || 0) + minutes,
      );

      // For days representation: convert minutes to working day-hours model later if needed.
      // Here we approximate weekend overtime days as 1 per any weekend log day.
      overtimeWeekendDaysByEmployee.set(
        log.employeeId,
        (overtimeWeekendDaysByEmployee.get(log.employeeId) || 0) + 1,
      );
    }


    // معالجة خصومات الدوام فقط إذا كان enabled
    if (includeAttendanceDeductions) {
      for (const record of attendanceInRecords) {
        const dates = attendanceDatesByEmployee.get(record.employeeId) || new Set<string>();
        dates.add(record.date);
        attendanceDatesByEmployee.set(record.employeeId, dates);

        const employee = employeeById.get(record.employeeId);
        const graceForEmployee = employee?.gracePeriodMinutes ?? defaultGracePeriodMinutes;
        const hoursPerDayForEmployee = employee?.hoursPerDay ?? defaultHoursPerDay;

        const minutesLate = this.extractMinutesLate(record.shiftPair);
        const lateAfterGrace = Math.max(0, minutesLate - graceForEmployee);
        if (lateAfterGrace <= 0) {
          continue;
        }

        lateMinutesByEmployee.set(
          record.employeeId,
          (lateMinutesByEmployee.get(record.employeeId) || 0) + lateAfterGrace,
        );

        const hoursWorked = this.extractHoursWorked(record.shiftPair);
        if (hoursWorked > hoursPerDayForEmployee) {
          const overtimeMinutes = (hoursWorked - hoursPerDayForEmployee) * 60;
          overtimeMinutesByEmployee.set(
            record.employeeId,
            (overtimeMinutesByEmployee.get(record.employeeId) || 0) + overtimeMinutes,
          );
        }
      }
    }

    const attendanceDaysByEmployee = new Map<string, number>();
    for (const [employeeId, daysSet] of attendanceDatesByEmployee.entries()) {
      attendanceDaysByEmployee.set(employeeId, daysSet.size);
    }

    const bonusesByEmployee = new Map<string, { bonus: number; deductions: number }>();
    for (const bonus of bonuses) {
      const current = bonusesByEmployee.get(bonus.employeeId) || { bonus: 0, deductions: 0 };
      // المكافآت (bonusAmount + assistanceAmount) تُضاف للراتب
      current.bonus += Number(bonus.bonusAmount || 0);
      current.bonus += Number(bonus.assistanceAmount || 0);
      bonusesByEmployee.set(bonus.employeeId, current);
    }

    const advancesByEmployee = new Map<string, number>();
    for (const advance of advances) {
      const installment = Number(advance.installmentAmount || 0);
      const remaining = Number(advance.remainingAmount || 0);

      if (installment <= 0 || remaining <= 0) {
        continue;
      }

      const deductible = Math.min(installment, remaining);
      advancesByEmployee.set(
        advance.employeeId,
        (advancesByEmployee.get(advance.employeeId) || 0) + deductible,
      );
    }

    const penaltiesByEmployee = new Map<string, number>();
    for (const penalty of penalties) {
      penaltiesByEmployee.set(
        penalty.employeeId,
        (penaltiesByEmployee.get(penalty.employeeId) || 0) + Number(penalty.amount || 0),
      );
    }

    await this.prisma.payrollRun.update({
      where: { id: runId },
      data: {
        status: 'processing',
        totalEmployees: targetEmployees.length,
      },
    });

    // Ensures idempotent retry for the same run id.
    await this.prisma.payrollItem.deleteMany({ where: { payrollRunId: runId } });

    // ── Batch-calculate bus subscription deductions for all target employees ──
    const busDeductionsByEmployee = new Map<string, number>();
    if (includeTransportationDeductions && this.transportationService) {
      try {
        const targetMonth = new Date(periodEnd);
        const allEmpIds = targetEmployees.map((e) => e.employeeId);
        const batchResult = await this.transportationService.calculateBatchBusDeductions(allEmpIds, targetMonth);
        for (const [empId, amount] of batchResult) {
          busDeductionsByEmployee.set(empId, amount);
        }
        if (batchResult.size > 0) {
          this.logger.log(`Bus subscription deductions calculated for ${batchResult.size} employees`);
        }
      } catch (err) {
        this.logger.warn(`Failed to calculate bus subscription deductions: ${(err as Error)?.message || String(err)}`);
      }
    }

    let totalGross = new Prisma.Decimal(0);
    let totalDeductions = new Prisma.Decimal(0);
    let totalNet = new Prisma.Decimal(0);
    let processedEmployees = 0;

    for (let offset = 0; offset < targetEmployees.length; offset += PAYROLL_BATCH_SIZE) {
      const employeesBatch = targetEmployees.slice(offset, offset + PAYROLL_BATCH_SIZE);
      const items: Prisma.PayrollItemCreateManyInput[] = [];

      for (const employee of employeesBatch) {
        const salaryRecord = salaryByEmployee.get(employee.employeeId);
        const input = payrollInputByEmployee.get(employee.employeeId);
        
        const workDays = employee.workDaysInPeriod ?? defaultWorkDaysInPeriod;
        const hoursPerDayEmp = employee.hoursPerDay ?? defaultHoursPerDay;
        
        const fallbackBaseSalary = Number(employee.hourlyRate || 0) * hoursPerDayEmp * workDays;
        const baseSalary = this.toDecimal(
          salaryRecord?.baseSalary ?? employee.baseSalary ?? fallbackBaseSalary,
        );
        const livingAllowance = this.toDecimal(salaryRecord?.livingAllowance ?? 0);
        const lumpSumSalary = this.toDecimal(salaryRecord?.lumpSumSalary ?? 0);
        // responsibilityAllowance, extraEffortAllowance, productionIncentive
        // are no longer auto-computed and are excluded from g3.
        const transportAllowanceBase = this.toDecimal(
          input?.transportAllowanceOverride ?? salaryRecord?.transportAllowance ?? 0,
        );

        const attendanceDays = attendanceDaysByEmployee.get(employee.employeeId) || 0;
        const hoursWorked = attendanceDays * hoursPerDayEmp;

        // absenceDaysFallback: compute as (workDays - attendanceDays) BUT exclude APPROVED paid leaves
        const absenceDaysFallbackRaw = Math.max(0, workDays - attendanceDays);

        // Count paid approved leave days inside period to avoid double-penalizing them as absence
        // NOTE: For now we treat PAID leave type or isPaid=true as "paid".
        // This logic is intentionally inclusive for overlap partials.
        const paidApprovedLeaves = await this.prisma.leaveRequest.findMany({
          where: {
            employeeId: employee.employeeId,
            status: 'APPROVED',
            leaveType: { in: ['PAID', 'SICK', 'ADMIN', 'DEATH'] },
            startDate: { lte: new Date(periodEnd) },
            endDate: { gte: new Date(periodStart) },
          },
          select: { startDate: true, endDate: true, isPaid: true, leaveType: true },
        });

        const paidApprovedLeaveDaysInPeriod = paidApprovedLeaves.reduce((sum, l) => {
          // inclusive overlap day count
          const overlapStart = l.startDate > new Date(periodStart) ? l.startDate : new Date(periodStart);
          const overlapEnd = l.endDate < new Date(periodEnd) ? l.endDate : new Date(periodEnd);
          const ms = overlapEnd.getTime() - overlapStart.getTime();
          const days = Math.floor(ms / 86_400_000) + 1;
          return sum + (Number.isFinite(days) && days > 0 ? days : 0);
        }, 0);

        const absenceDaysFallback = Math.max(
          0,
          absenceDaysFallbackRaw - paidApprovedLeaveDaysInPeriod,
        );


        const employeeBonuses = bonusesByEmployee.get(employee.employeeId);
        const bonusAmount = this.toDecimal(employeeBonuses?.bonus || 0);
        const advancesInstallments = this.toDecimal(advancesByEmployee.get(employee.employeeId) || 0);
        const penaltiesTotal = this.toDecimal(penaltiesByEmployee.get(employee.employeeId) || 0);

        // العقوبات فقط (بدون assistanceAmount لأنها مكافآت)
        const penaltyAmount = this.toDecimal(
          input?.penaltyAmount ?? penaltiesTotal,
        );
        const clothingDeduction = this.toDecimal(
          (input as unknown as { clothingDeduction?: Prisma.Decimal })?.clothingDeduction ?? 0,
        );
        const bonusAdjustment = this.toDecimal(
          input?.bonusAdjustment ?? bonusAmount,
        );
        const advanceAmount = this.toDecimal(
          input?.advanceAmount ?? advancesInstallments,
        );
        const insuranceAmount = this.toDecimal(
          input?.insuranceAmount ?? salaryRecord?.insuranceAmount ?? 0,
        );

        const lateMinutes = this.resolveAttendanceValue(
          input?.lateMinutes,
          lateMinutesByEmployee.get(employee.employeeId) || 0,
          includeAttendanceDeductions,
        );
        const earlyLeaveMinutes = Number(input?.earlyLeaveMinutes ?? 0);
        const absenceDays = this.resolveAttendanceValue(
          input?.absenceDays,
          absenceDaysFallback,
          includeAttendanceDeductions,
        );
        const sickLeaveDays = Number(input?.sickLeaveDays ?? 0);
        const adminLeaveDays = Number(input?.adminLeaveDays ?? 0);
        const unpaidLeaveDays = Number(input?.unpaidLeaveDays ?? 0);
        const deathLeaveDays = Number(input?.deathLeaveDays ?? 0);
        const unpaidHours = Number(input?.unpaidHours ?? 0);
        // overtimeRegularMinutes (computed from AttendanceRecord as hoursWorked - hoursPerDay)
        const overtimeRegularMinutesComputed = overtimeMinutesByEmployee.get(employee.employeeId) || 0;
        const overtimeRegularMinutes = includeAttendanceDeductions
          ? Number(input?.overtimeRegularMinutes ?? overtimeRegularMinutesComputed)
          : Number(input?.overtimeRegularMinutes ?? 0);

        // overtimeWeekendMinutes/days:
        // - Start by using PayrollInput override if present.
        // - For automated classification (weekend overtime), we will use DailyAttendanceLog in a later step.
        const overtimeWeekendMinutesComputed =
          overtimeWeekendMinutesByEmployee.get(employee.employeeId) || 0;

        // PayrollInput currently stores overtimeWeekendDays (Decimal) - keep existing field.
        // We approximate computed weekend days by the classified weekend log days.
        const overtimeWeekendDaysComputed =
          overtimeWeekendDaysByEmployee.get(employee.employeeId) || 0;

        const overtimeWeekendDays = Number(
          input?.overtimeWeekendDays ?? overtimeWeekendDaysComputed,
        );

        // If in future PayrollInput adds overtimeWeekendMinutes, we can switch to minutes-based pay.



        const g3 = baseSalary
          .plus(livingAllowance)
          .plus(lumpSumSalary);
        const dailyWage = g3.div(STANDARD_WORK_DAYS);
        const hourlyWage = dailyWage.div(STANDARD_HOURS_PER_DAY);
        const minuteWage = hourlyWage.div(MINUTES_PER_HOUR);

        // Late penalty policy: minuteWage * lateMinutes * 1.5 (overtime multiplier)
        const latePenalty = minuteWage.times(this.toDecimal(lateMinutes)).times(1.5);

        const earlyLeavePenalty = minuteWage.times(this.toDecimal(earlyLeaveMinutes));
        const absencePenalty = dailyWage.times(this.toDecimal(absenceDays));
        const sickLeavePenalty = dailyWage
          .times(this.toDecimal(sickLeaveDays))
          .times(MULTIPLIER_SICK_LEAVE);
        const unpaidLeavePenalty = dailyWage.times(this.toDecimal(unpaidLeaveDays));
        const unpaidHoursPenalty = hourlyWage.times(this.toDecimal(unpaidHours));
        const overtimeWeekendPay = dailyWage
          .times(this.toDecimal(overtimeWeekendDays))
          .times(MULTIPLIER_WEEKEND);
        const overtimeRegularPay = minuteWage
          .times(MULTIPLIER_OVERTIME)
          .times(this.toDecimal(overtimeRegularMinutes));

        const leaveTotal = absenceDays + sickLeaveDays + adminLeaveDays + unpaidLeaveDays + deathLeaveDays;
        const transportAllowance = includeTransportationDeductions
          ? transportAllowanceBase
              .div(STANDARD_WORK_DAYS)
              .times(this.toDecimal(Math.max(0, WORK_DAYS_PER_MONTH - leaveTotal)))
          : transportAllowanceBase;

        const grossPay = g3
          .plus(overtimeWeekendPay)
          .plus(overtimeRegularPay)
          .plus(bonusAdjustment)
          .plus(transportAllowance);
        const penaltyTotal = penaltyAmount.plus(clothingDeduction);

        // ── Bus subscription deduction ──
        const busDeductionAmount = this.toDecimal(busDeductionsByEmployee.get(employee.employeeId) ?? 0);

        const employeeDeductions = latePenalty
          .plus(earlyLeavePenalty)
          .plus(absencePenalty)
          .plus(sickLeavePenalty)
          .plus(unpaidLeavePenalty)
          .plus(unpaidHoursPenalty)
          .plus(penaltyTotal)
          .plus(advanceAmount)
          .plus(insuranceAmount)
          .plus(busDeductionAmount);
        const netPay = grossPay.minus(employeeDeductions);
        const netPayRounded = this.roundUpToNearestThousand(netPay);
        const roundingDifference = netPayRounded.minus(netPay);
        const netPayWithAdvance = netPayRounded;

        const anomalies: string[] = [];
        if (!salaryRecord) {
          anomalies.push('Salary configuration not found; fallback hourly-rate baseline used');
        }
        if (!input) {
          anomalies.push('Payroll inputs not found; defaults used where possible');
        }
        if (attendanceDays === 0) {
          anomalies.push('No attendance records in selected period');
        }
        if (absenceDays > 0) {
          anomalies.push(`Absence days deducted: ${absenceDays}`);
        }
        if (latePenalty.greaterThan(0)) {
          anomalies.push(`Late penalty applied: ${latePenalty.toFixed(2)}`);
        }
        if (penaltyTotal.greaterThan(0)) {
          anomalies.push(`Penalties applied: ${penaltyTotal.toFixed(2)}`);
        }
        if (insuranceAmount.greaterThan(0)) {
          anomalies.push(`Insurance deducted: ${insuranceAmount.toFixed(2)}`);
        }
        if (transportAllowance.greaterThan(0)) {
          anomalies.push(`Transport allowance added: ${transportAllowance.toFixed(2)}`);
        }
        if (busDeductionAmount.greaterThan(0)) {
          anomalies.push(`Bus subscription deducted: ${busDeductionAmount.toFixed(2)}`);
        }
        if (netPay.lessThan(0)) {
          anomalies.push('Net pay is negative after deductions');
        }

        totalGross = totalGross.plus(grossPay);
        totalDeductions = totalDeductions.plus(employeeDeductions);
        totalNet = totalNet.plus(netPayRounded);
        processedEmployees += 1;

        items.push({
          payrollRunId: runId,
          employeeId: employee.employeeId,
          employeeName: employee.name,
          department: employee.department,
          hoursWorked: new Prisma.Decimal(hoursWorked),
          hourlyRate: hourlyWage,
          grossPay,
          totalDeductions: employeeDeductions,
          netPay,
          netPayRounded,
          roundingDifference,
          netPayWithAdvance,
          anomalies,
        });
      }

      if (items.length > 0) {
        await this.prisma.payrollItem.createMany({ data: items });
      }
    }

    const updatedRun = await this.prisma.payrollRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        totalEmployees: processedEmployees,
        totalGrossPay: totalGross,
        totalDeductions: totalDeductions,
        totalNetPay: totalNet,
      },
    });

    return updatedRun;
  }
}
