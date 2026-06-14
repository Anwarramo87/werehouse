import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertSalaryDto } from './dto/upsert-salary.dto';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';


@Injectable()
export class SalaryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/salary/calculate-allowances
   *
   * Allowances are no longer auto-computed.
   * responsibilityAllowance, extraEffortAllowance, and productionIncentive
   * are always 0 unless explicitly provided in the salary record.
   */
  calculateAllowances(dto: CalculateAllowancesDto) {
    const salary          = new Prisma.Decimal(dto.salary.toString());
    const lumpSumSalary   = new Prisma.Decimal(dto.lumpSumSalary.toString());
    const livingAllowance = new Prisma.Decimal(dto.livingAllowance.toString());

    return {
      salary:          salary.toFixed(4),
      lumpSumSalary:   lumpSumSalary.toFixed(4),
      livingAllowance: livingAllowance.toFixed(4),
      difference:              '0.0000',
      responsibilityAllowance: '0.0000',
      extraEffortAllowance:    '0.0000',
      productionIncentives:    '0.0000',
      differenceRounded: 0,
      responsibilityRounded: 0,
      extraEffortRounded: 0,
      productionRounded: 0,
      verification: {
        sum:          '0.0000',
        isExact: true,
        ratiosSum:    '0.00',
        ratiosSumIs1: false,
        message: 'البدلات لم تعد تُحسب تلقائياً — أدخل القيم يدوياً إذا لزم الأمر',
      },
    };
  }

  /** Compute monthlySalary = baseSalary + livingAllowance (allowances no longer auto-computed) */
  private withMonthlySalary<T extends {
    baseSalary: Prisma.Decimal;
    livingAllowance: Prisma.Decimal;
  }>(record: T): T & { monthlySalary: number } {
    const monthly = record.baseSalary
      .plus(record.livingAllowance);
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

    // Allowances are no longer auto-computed — always default to 0.
    // Only use manually-provided values if explicitly passed in the DTO.
    const responsibilityAllowance = new Prisma.Decimal((dto.responsibilityAllowance ?? 0).toString());
    const extraEffortAllowance    = new Prisma.Decimal((dto.extraEffortAllowance ?? dto.extraEffort ?? 0).toString());
    const productionIncentive     = new Prisma.Decimal((dto.productionIncentive ?? 0).toString());

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
