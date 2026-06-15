import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdvancesService } from '../advances/advances.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { CreateDiscountDto, DiscountKind } from './dto/create-discount.dto';
import { AdvanceType } from '../advances/dto/create-advance.dto';

export type DiscountRecord = {
  id: string;
  employeeId: string;
  type: string;
  amount: number;
  date: string;
  notes?: string | null;
  kind: DiscountKind;
};

@Injectable()
export class DiscountsService {
  constructor(
    private readonly advancesService: AdvancesService,
    private readonly bonusesService: BonusesService,
  ) {}

  private toNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value === null || value === undefined) return 0;
    if (value instanceof Prisma.Decimal) return Number(value);
    return Number(value || 0);
  }

  private resolveKind(dto: CreateDiscountDto): DiscountKind {
    if (dto.kind) return dto.kind;
    if (dto.type?.trim() === 'سلفة') return DiscountKind.ADVANCE;
    return DiscountKind.ASSISTANCE;
  }

  async list(employeeId?: string, period?: string): Promise<DiscountRecord[]> {
    const [advances, bonuses] = await Promise.all([
      this.advancesService.list({ employeeId, period }),
      this.bonusesService.list({ employeeId, period } as any),
    ]);

    const advanceRecords: DiscountRecord[] = advances.map((advance) => ({
      id: advance.id,
      employeeId: advance.employeeId,
      type: 'سلفة',
      amount: this.toNumber(advance.remainingAmount ?? advance.totalAmount),
      date: advance.issueDate.toISOString(),
      notes: advance.notes ?? null,
      kind: DiscountKind.ADVANCE,
    }));

    const bonusRecords: DiscountRecord[] = (bonuses.data ?? [])
      .filter((bonus: { assistanceAmount: Prisma.Decimal | number | string }) => this.toNumber(bonus.assistanceAmount) > 0)
      .map((bonus: { id: string; employeeId: string; bonusReason: string | null; assistanceAmount: Prisma.Decimal | number | string; createdAt: Date }) => ({
        id: bonus.id,
        employeeId: bonus.employeeId,
        type: bonus.bonusReason || 'خصم متنوع',
        amount: this.toNumber(bonus.assistanceAmount),
        date: bonus.createdAt.toISOString(),
        notes: bonus.bonusReason ?? null,
        kind: DiscountKind.ASSISTANCE,
      }));

    return [...advanceRecords, ...bonusRecords].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }

  async create(dto: CreateDiscountDto, kind?: DiscountKind): Promise<DiscountRecord> {
    const resolvedKind = kind ?? this.resolveKind(dto);

    if (resolvedKind === DiscountKind.ADVANCE) {
      const record = await this.advancesService.create({
        employeeId: dto.employeeId,
        advanceType: dto.advanceType ?? AdvanceType.SALARY,
        totalAmount: dto.amount,
        installmentAmount: 0,
        notes: dto.notes,
        issueDate: dto.date,
      });

      return {
        id: record.id,
        employeeId: record.employeeId,
        type: 'سلفة',
        amount: this.toNumber(record.remainingAmount ?? record.totalAmount),
        date: record.issueDate.toISOString(),
        notes: record.notes ?? null,
        kind: DiscountKind.ADVANCE,
      };
    }

    const period = dto.date ? dto.date.slice(0, 7) : undefined;
    
    // لم نعد نستخدم assistanceAmount في discounts
    // assistanceAmount الآن تُستخدم فقط في bonuses (مكافآت)
    throw new BadRequestException('Use bonuses endpoint to create assistance records');
  }

  async remove(id: string, kind?: DiscountKind, deletedBy?: string) {
    if (!kind) {
      const advance = await this.advancesService.getById(id).catch(() => null);
      if (advance) {
        return this.advancesService.remove(id, deletedBy);
      }
      throw new BadRequestException('Record not found');
    }

    if (kind === DiscountKind.ADVANCE) {
      return this.advancesService.remove(id, deletedBy);
    }

    throw new BadRequestException('Invalid kind for discounts endpoint');
  }
}
