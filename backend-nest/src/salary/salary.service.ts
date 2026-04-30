import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertSalaryDto } from './dto/upsert-salary.dto';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';

// نسب التوزيع — Prisma.Decimal لضمان دقة الفاصلة العشرية الكاملة
const RESPONSIBILITY_RATIO = new Prisma.Decimal('0.50');
const EXTRA_EFFORT_RATIO   = new Prisma.Decimal('0.30');
const PRODUCTION_RATIO     = new Prisma.Decimal('0.20');

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

  async list() {
    return this.prisma.employeeSalary.findMany({ orderBy: { employeeId: 'asc' } });
  }

  async getByEmployee(employeeId: string) {
    const record = await this.prisma.employeeSalary.findUnique({ where: { employeeId } });
    if (!record) throw new NotFoundException(`No salary record for employee ${employeeId}`);
    return record;
  }

  async upsert(employeeId: string, dto: UpsertSalaryDto) {
    const data = {
      profession: dto.profession ?? null,
      baseSalary: new Prisma.Decimal(dto.baseSalary),
      responsibilityAllowance: new Prisma.Decimal(dto.responsibilityAllowance ?? 0),
      productionIncentive: new Prisma.Decimal(dto.productionIncentive ?? 0),
      transportAllowance: new Prisma.Decimal(dto.transportAllowance ?? 0),
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
