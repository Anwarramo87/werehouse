import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdvancesService } from '../advances/advances.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFinanceAdvanceDto } from './dto/create-finance-advance.dto';
import { CreateFinanceBonusDto } from './dto/create-finance-bonus.dto';
// تأكد من استيراد النوع لإصلاح الخطأ
import { AdvanceType } from '../advances/dto/create-advance.dto';

@Injectable()
export class FinancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly advancesService: AdvancesService,
    private readonly bonusesService: BonusesService,
  ) {}

  /**
   * تقريب الأرقام لمرتبتين عشريتين
   */
  private toMoney(value: number): number {
    return Number(value.toFixed(2));
  }

  /**
   * التأكد من صيغة الشهر YYYY-MM
   */
  private resolveMonth(month?: string): string {
    if (!month) {
      return new Date().toISOString().slice(0, 7); // الشهر الحالي
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }
    return month;
  }

  // ---------------------------------------------------------------------------
  // 1. إنشاء سلفة (مع إصلاح خطأ AdvanceType)
  // ---------------------------------------------------------------------------
  async createAdvance(dto: CreateFinanceAdvanceDto) {
    // قمنا بإضافة "as AdvanceType" لإخبار TypeScript أن القيمة صحيحة
    const advance = await this.advancesService.create({
      employeeId: dto.employeeId,
      advanceType: dto.advanceType as AdvanceType, 
      totalAmount: dto.amount,
      installmentAmount: dto.installmentAmount,
      notes: dto.notes,
      issueDate: dto.date,
    });

    return {
      message: 'تم إنشاء السلفة بنجاح',
      advance,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. إنشاء مكافأة
  // ---------------------------------------------------------------------------
  async createBonus(dto: CreateFinanceBonusDto) {
    const bonus = await this.bonusesService.create({
      employeeId: dto.employeeId,
      bonusAmount: dto.bonusAmount,
      bonusReason: dto.bonusReason,
      assistanceAmount: dto.assistanceAmount,
      period: dto.period,
    });

    return {
      message: 'تم إنشاء المكافأة/المساعدة بنجاح',
      bonus,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. ملخص المستحقات والخصومات (Financial Summary)
  // ---------------------------------------------------------------------------
  async summary(employeeId: string, month?: string) {
    const period = this.resolveMonth(month);

    // جلب كل البيانات المتعلقة بالموظف في استعلام واحد متوازي (Performance)
    const [employee, salary, insurance, bonuses, advances] = await Promise.all([
      this.prisma.employee.findUnique({ where: { employeeId } }),
      this.prisma.employeeSalary.findUnique({ where: { employeeId } }),
      this.prisma.employeeInsurance.findUnique({ where: { employeeId } }),
      this.prisma.employeeBonus.findMany({ where: { employeeId, period } }),
      this.prisma.employeeAdvance.findMany({
        where: {
          employeeId,
          remainingAmount: { gt: new Prisma.Decimal(0) },
        },
      }),
    ]);

    if (!employee) {
      throw new NotFoundException(`Employee not found: ${employeeId}`);
    }

    // --- الحسابات المالية ---
    const baseSalary = Number(salary?.baseSalary || 0);
    const transportAllowance = Number(salary?.transportAllowance || 0);

    // جمع المكافآت والمساعدات
    const bonusSum = bonuses.reduce((sum, r) => sum + Number(r.bonusAmount || 0), 0);
    const assistanceSum = bonuses.reduce((sum, r) => sum + Number(r.assistanceAmount || 0), 0);

    // حساب قسط السلفة لهذا الشهر (الأقل بين القسط والمبلغ المتبقي)
    const advancesInstallments = advances.reduce((sum, r) => {
      const inst = Number(r.installmentAmount || 0);
      const rem = Number(r.remainingAmount || 0);
      return sum + Math.min(inst, rem);
    }, 0);

    const insuranceDeduction = Number(insurance?.insuranceSalary || 0);

    // المعادلة المالية الكلية:
    // $$Gross = BaseSalary + Transport + Bonuses$$
    // $$Deductions = Insurance + Advances + Assistance$$
    // $$Net = Gross - Deductions$$

    const gross = this.toMoney(baseSalary + transportAllowance + bonusSum);
    const deductions = this.toMoney(insuranceDeduction + advancesInstallments + assistanceSum);
    const net = this.toMoney(gross - deductions);

    return {
      employeeId,
      employeeName: employee.name,
      period,
      components: {
        baseSalary: this.toMoney(baseSalary),
        transportAllowance: this.toMoney(transportAllowance),
        bonuses: this.toMoney(bonusSum),
        insurance: this.toMoney(insuranceDeduction),
        advances: this.toMoney(advancesInstallments),
        assistance: this.toMoney(assistanceSum),
      },
      totals: { gross, deductions, net },
      records: { advances, bonuses, insurance, salary },
    };
  }
}