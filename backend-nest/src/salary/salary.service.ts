import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertSalaryDto } from './dto/upsert-salary.dto';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';
import { BulkRaiseDto } from './dto/bulk-raise.dto';
import { buildEmployeeSalaryMirror, resolveSalary } from '../common/utils/salary-resolution.util';

const SALARY_DELETION_ENTITY = 'salary';

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
    const salary = new Prisma.Decimal(dto.salary.toString());
    const lumpSumSalary = new Prisma.Decimal(dto.lumpSumSalary.toString());
    const livingAllowance = new Prisma.Decimal(dto.livingAllowance.toString());

    return {
      salary: salary.toFixed(4),
      lumpSumSalary: lumpSumSalary.toFixed(4),
      livingAllowance: livingAllowance.toFixed(4),
      difference: '0.0000',
      responsibilityAllowance: '0.0000',
      extraEffortAllowance: '0.0000',
      productionIncentives: '0.0000',
      differenceRounded: 0,
      responsibilityRounded: 0,
      extraEffortRounded: 0,
      productionRounded: 0,
      verification: {
        sum: '0.0000',
        isExact: true,
        ratiosSum: '0.00',
        ratiosSumIs1: false,
        message: 'البدلات لم تعد تُحسب تلقائياً — أدخل القيم يدوياً إذا لزم الأمر',
      },
    };
  }

  /** Compute monthlySalary = baseSalary + livingAllowance */
  private withMonthlySalary<
    T extends {
      baseSalary: Prisma.Decimal;
      livingAllowance: Prisma.Decimal;
    },
  >(record: T): T & { monthlySalary: number } {
    const monthly = record.baseSalary.plus(record.livingAllowance);
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
    const baseSalary = new Prisma.Decimal(dto.baseSalary.toString());
    const lumpSumSalary = new Prisma.Decimal((dto.lumpSumSalary ?? 0).toString());
    const livingAllowance = new Prisma.Decimal((dto.livingAllowance ?? 0).toString());

    // Allowances are no longer auto-computed — always default to 0.
    // Only use manually-provided values if explicitly passed in the DTO.
    const responsibilityAllowance = new Prisma.Decimal(
      (dto.responsibilityAllowance ?? 0).toString(),
    );
    const extraEffortAllowance = new Prisma.Decimal(
      (dto.extraEffortAllowance ?? dto.extraEffort ?? 0).toString(),
    );
    const productionIncentive = new Prisma.Decimal((dto.productionIncentive ?? 0).toString());

    const data = {
      profession: dto.profession ?? null,
      baseSalary,
      lumpSumSalary,
      livingAllowance,
      responsibilityAllowance,
      extraEffortAllowance,
      productionIncentive,
      insuranceAmount: new Prisma.Decimal((dto.insuranceAmount ?? dto.insurances ?? 0).toString()),
      transportAllowance: new Prisma.Decimal((dto.transportAllowance ?? 0).toString()),
    };

    const record = await this.prisma.employeeSalary.upsert({
      where: { employeeId },
      update: data,
      create: { employeeId, ...data },
    });

    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (employee) {
      const resolved = resolveSalary(employee, record);
      await this.prisma.employee.update({
        where: { employeeId },
        data: {
          ...buildEmployeeSalaryMirror(resolved),
          ...(dto.profession ? { profession: dto.profession, jobTitle: dto.profession } : {}),
        },
      });
    }

    return record;
  }

  async remove(employeeId: string, deletedBy?: string) {
    const record = await this.prisma.employeeSalary.findUnique({ where: { employeeId } });
    if (!record) throw new NotFoundException(`No salary record for employee ${employeeId}`);

    // نقل السجل إلى سلة المهملات (حذف ناعم) بدلاً من الحذف النهائي
    await this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: SALARY_DELETION_ENTITY,
          recordId: record.employeeId,
          payload: {
            id: record.id,
            employeeId: record.employeeId,
            profession: record.profession,
            baseSalary: record.baseSalary.toString(),
            lumpSumSalary: record.lumpSumSalary.toString(),
            livingAllowance: record.livingAllowance.toString(),
            responsibilityAllowance: record.responsibilityAllowance.toString(),
            extraEffortAllowance: record.extraEffortAllowance.toString(),
            productionIncentive: record.productionIncentive.toString(),
            insuranceAmount: record.insuranceAmount.toString(),
            transportAllowance: record.transportAllowance.toString(),
          },
          deletedBy: deletedBy || null,
        },
      });

      await tx.employeeSalary.delete({ where: { employeeId } });
    });

    return { message: 'تم نقل بيانات الراتب إلى سلة المهملات' };
  }

  /**
   * استعادة سجل راتب من سلة المهملات (يُستدعى من TrashService)
   */
  async restoreSalary(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: SALARY_DELETION_ENTITY, restoredAt: null },
    });
    if (!history) throw new NotFoundException('History record not found or already restored');

    const p = history.payload as Record<string, string | null | undefined>;

    const employee = await this.prisma.employee.findUnique({ where: { employeeId: String(p.employeeId) } });
    if (!employee) {
      throw new NotFoundException(`لا يمكن الاستعادة — الموظف ${p.employeeId} غير موجود`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.employeeSalary.upsert({
        where: { employeeId: String(p.employeeId) },
        create: {
          id: p.id ?? undefined,
          employeeId: String(p.employeeId),
          profession: (p.profession as string) ?? null,
          baseSalary: new Prisma.Decimal(p.baseSalary ?? '0'),
          lumpSumSalary: new Prisma.Decimal(p.lumpSumSalary ?? '0'),
          livingAllowance: new Prisma.Decimal(p.livingAllowance ?? '0'),
          responsibilityAllowance: new Prisma.Decimal(p.responsibilityAllowance ?? '0'),
          extraEffortAllowance: new Prisma.Decimal(p.extraEffortAllowance ?? '0'),
          productionIncentive: new Prisma.Decimal(p.productionIncentive ?? '0'),
          insuranceAmount: new Prisma.Decimal(p.insuranceAmount ?? '0'),
          transportAllowance: new Prisma.Decimal(p.transportAllowance ?? '0'),
        },
        update: {
          profession: (p.profession as string) ?? null,
          baseSalary: new Prisma.Decimal(p.baseSalary ?? '0'),
          lumpSumSalary: new Prisma.Decimal(p.lumpSumSalary ?? '0'),
          livingAllowance: new Prisma.Decimal(p.livingAllowance ?? '0'),
          responsibilityAllowance: new Prisma.Decimal(p.responsibilityAllowance ?? '0'),
          extraEffortAllowance: new Prisma.Decimal(p.extraEffortAllowance ?? '0'),
          productionIncentive: new Prisma.Decimal(p.productionIncentive ?? '0'),
          insuranceAmount: new Prisma.Decimal(p.insuranceAmount ?? '0'),
          transportAllowance: new Prisma.Decimal(p.transportAllowance ?? '0'),
        },
      });

      await tx.deletedRecordHistory.update({
        where: { id: historyId },
        data: { restoredAt: new Date(), restoredBy: restoredBy || null },
      });

      return { message: 'تمت استعادة بيانات الراتب بنجاح' };
    });
  }

  /**
   * POST /api/salary/bulk-raise
   * يضيف مبلغ الزيادة على baseSalary بشكل دائم.
   * - إذا employeeId = ALL أو غير مُرسل → كل الموظفين النشطين
   * - إذا employeeId محدد → موظف واحد فقط
   */
  async bulkRaise(dto: BulkRaiseDto) {
    const raise = new Prisma.Decimal(dto.amount.toString());
    const applyToAll = !dto.employeeId || dto.employeeId === 'ALL';

    // جلب سجلات الرواتب المستهدفة
    const salaryRecords = await this.prisma.employeeSalary.findMany({
      where: applyToAll
        ? {
            employee: { status: 'active' },
          }
        : { employeeId: dto.employeeId },
      include: {
        employee: true,
      },
    });

    if (salaryRecords.length === 0) {
      return { updated: 0, message: 'لا يوجد سجلات رواتب للتعديل' };
    }

    // تحديث baseSalary ومزامنة mirror fields في transaction واحدة
    const transactionOperations = [];
    for (const record of salaryRecords) {
      const newBaseSalary = record.baseSalary.plus(raise);
      transactionOperations.push(
        this.prisma.employeeSalary.update({
          where: { employeeId: record.employeeId },
          data: { baseSalary: newBaseSalary },
        }),
      );
      if (record.employee) {
        const resolved = resolveSalary(record.employee, { ...record, baseSalary: newBaseSalary });
        transactionOperations.push(
          this.prisma.employee.update({
            where: { employeeId: record.employeeId },
            data: buildEmployeeSalaryMirror(resolved),
          }),
        );
      }
    }

    await this.prisma.$transaction(transactionOperations);
    const updates = salaryRecords;

    return {
      updated: updates.length,
      raiseAmount: dto.amount,
      appliedTo: applyToAll ? 'all_active' : dto.employeeId,
      message: `تمت إضافة ${dto.amount.toLocaleString()} ل.س على الراتب الأساسي لـ ${updates.length} موظف بشكل دائم`,
    };
  }
}
