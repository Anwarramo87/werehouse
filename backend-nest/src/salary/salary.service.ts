import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertSalaryDto } from './dto/upsert-salary.dto';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';
import {
  RESPONSIBILITY_ALLOWANCE_RATIO,
  EXTRA_EFFORT_ALLOWANCE_RATIO,
} from '../common/constants/payroll.constants';

// نسب التوزيع — Prisma.Decimal لضمان دقة الفاصلة العشرية الكاملة
const RESPONSIBILITY_RATIO = new Prisma.Decimal(RESPONSIBILITY_ALLOWANCE_RATIO.toString());
const EXTRA_EFFORT_RATIO   = new Prisma.Decimal(EXTRA_EFFORT_ALLOWANCE_RATIO.toString());
const PRODUCTION_RATIO     = new Prisma.Decimal((1 - RESPONSIBILITY_ALLOWANCE_RATIO - EXTRA_EFFORT_ALLOWANCE_RATIO).toString());

@Injectable()
export class SalaryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/salary/calculate-allowances
   *
   * المنطق:
   *   Difference = Salary - LumpSumSalary - LivingAllowance
   *   ResponsibilityAllowance = Difference × 0.50
   *   ExtraEffortAllowance    = Difference × 0.30
   *   ProductionIncentives    = Difference - Responsibility - ExtraEffort
   *     (الأخير بالطرح لضمان مجموع = Difference بدون أي خطأ في الفاصلة العشرية)
   */
  calculateAllowances(dto: CalculateAllowancesDto) {
    const salary          = new Prisma.Decimal(dto.salary.toString());
    const lumpSumSalary   = new Prisma.Decimal(dto.lumpSumSalary.toString());
    const livingAllowance = new Prisma.Decimal(dto.livingAllowance.toString());

    if (lumpSumSalary.plus(livingAllowance).greaterThan(salary)) {
      throw new BadRequestException(
        'مجموع الراتب المقطوع وبدل المعيشة يتجاوز الراتب الكلي — الفرق سيكون سالباً',
      );
    }

    // الخطوة الأولى: حساب الفرق
    const difference = salary.minus(lumpSumSalary).minus(livingAllowance);

    // الخطوة الثانية: توزيع الفرق بدقة عشرية كاملة
    const responsibilityAllowance = difference.times(RESPONSIBILITY_RATIO);
    const extraEffortAllowance    = difference.times(EXTRA_EFFORT_RATIO);
    // الأخير بالطرح لضمان: مجموع البدلات = difference بالضبط
    const productionIncentives    = difference
      .minus(responsibilityAllowance)
      .minus(extraEffortAllowance);

    // تحقق داخلي
    const sum        = responsibilityAllowance.plus(extraEffortAllowance).plus(productionIncentives);
    const isExact    = sum.equals(difference);
    const ratiosSum  = RESPONSIBILITY_RATIO.plus(EXTRA_EFFORT_RATIO).plus(PRODUCTION_RATIO);

    return {
      // المدخلات
      salary:          salary.toFixed(4),
      lumpSumSalary:   lumpSumSalary.toFixed(4),
      livingAllowance: livingAllowance.toFixed(4),
      // النتائج — strings للحفاظ على الدقة الكاملة
      difference:              difference.toFixed(4),
      responsibilityAllowance: responsibilityAllowance.toFixed(4),
      extraEffortAllowance:    extraEffortAllowance.toFixed(4),
      productionIncentives:    productionIncentives.toFixed(4),
      // أضفنا حقولاً مقربة لسهولة العرض والتحقق
      differenceRounded: Number(difference.toFixed(0)),
      responsibilityRounded: Number(responsibilityAllowance.toFixed(0)),
      extraEffortRounded: Number(extraEffortAllowance.toFixed(0)),
      productionRounded: Number(productionIncentives.toFixed(0)),
      // تحقق
      verification: {
        sum:          sum.toFixed(4),
        isExact,
        ratiosSum:    ratiosSum.toFixed(2),
        ratiosSumIs1: ratiosSum.equals(new Prisma.Decimal('1')),
        message: isExact
          ? 'مجموع البدلات يساوي الفرق بالضبط ✓'
          : 'تحذير: يوجد فرق في الفاصلة العشرية',
      },
    };
  }

  /** Compute monthlySalary = baseSalary + livingAllowance + responsibilityAllowance + extraEffortAllowance + productionIncentive */
  private withMonthlySalary<T extends {
    baseSalary: Prisma.Decimal;
    livingAllowance: Prisma.Decimal;
    responsibilityAllowance: Prisma.Decimal;
    extraEffortAllowance: Prisma.Decimal;
    productionIncentive: Prisma.Decimal;
  }>(record: T): T & { monthlySalary: number } {
    const monthly = record.baseSalary
      .plus(record.livingAllowance)
      .plus(record.responsibilityAllowance)
      .plus(record.extraEffortAllowance)
      .plus(record.productionIncentive);
    return { ...record, monthlySalary: Number(monthly.toFixed(2)) };
  }

  async list() {
    const records = await this.prisma.employeeSalary.findMany({ orderBy: { employeeId: 'asc' } });
    return records.map((r) => this.withMonthlySalary(r));
  }

  async getByEmployee(employeeId: string) {
    const record = await this.prisma.employeeSalary.findUnique({ where: { employeeId } });
    if (!record) throw new NotFoundException(`No salary record for employee ${employeeId}`);
    return this.withMonthlySalary(record);
  }

  async upsert(employeeId: string, dto: UpsertSalaryDto) {
    const baseSalary      = new Prisma.Decimal(dto.baseSalary.toString());
    const lumpSumSalary   = new Prisma.Decimal((dto.lumpSumSalary ?? 0).toString());
    const livingAllowance = new Prisma.Decimal((dto.livingAllowance ?? 0).toString());

    let responsibilityAllowance: Prisma.Decimal;
    let extraEffortAllowance: Prisma.Decimal;
    let productionIncentive: Prisma.Decimal;

    const hasManualAllowances =
      dto.responsibilityAllowance !== undefined ||
      dto.extraEffortAllowance !== undefined ||
      dto.extraEffort !== undefined ||
      dto.productionIncentive !== undefined;

    if (hasManualAllowances) {
      responsibilityAllowance = new Prisma.Decimal((dto.responsibilityAllowance ?? 0).toString());
      extraEffortAllowance    = new Prisma.Decimal((dto.extraEffortAllowance ?? dto.extraEffort ?? 0).toString());
      productionIncentive     = new Prisma.Decimal((dto.productionIncentive ?? 0).toString());
    } else {
      const difference = baseSalary.minus(lumpSumSalary).minus(livingAllowance);
      const positveDiff = difference.greaterThan(0) ? difference : new Prisma.Decimal(0);
      responsibilityAllowance = positveDiff.times(RESPONSIBILITY_RATIO);
      extraEffortAllowance    = positveDiff.times(EXTRA_EFFORT_RATIO);
      productionIncentive     = positveDiff.minus(responsibilityAllowance).minus(extraEffortAllowance);
    }

    const data = {
      profession:             dto.profession ?? null,
      baseSalary,
      lumpSumSalary,
      livingAllowance,
      responsibilityAllowance,
      extraEffortAllowance,
      productionIncentive,
      insuranceAmount:        new Prisma.Decimal((dto.insuranceAmount ?? dto.insurances ?? 0).toString()),
      transportAllowance:     new Prisma.Decimal((dto.transportAllowance ?? 0).toString()),
    };

    return this.prisma.employeeSalary.upsert({
      where: { employeeId },
      update: data,
      create: { employeeId, ...data },
    });
  }

  async remove(employeeId: string) {
    await this.getByEmployee(employeeId);
    await this.prisma.employeeSalary.delete({ where: { employeeId } });
    return { message: 'Salary record deleted' };
  }
}
