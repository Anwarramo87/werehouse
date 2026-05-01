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

  async list(employeeId?: string): Promise<DiscountRecord[]> {
    const [advances, bonuses] = await Promise.all([
      this.advancesService.list(employeeId),
      this.bonusesService.list(employeeId),
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

    const bonusRecords: DiscountRecord[] = bonuses
      .filter((bonus) => this.toNumber(bonus.assistanceAmount) > 0)
      .map((bonus) => ({
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
    const record = await this.bonusesService.create({
      employeeId: dto.employeeId,
      bonusAmount: 0,
      bonusReason: dto.type || 'خصم متنوع',
      assistanceAmount: dto.amount,
      period,
    });

    return {
      id: record.id,
      employeeId: record.employeeId,
      type: record.bonusReason || 'خصم متنوع',
      amount: this.toNumber(record.assistanceAmount),
      date: record.createdAt.toISOString(),
      notes: record.bonusReason ?? null,
      kind: DiscountKind.ASSISTANCE,
    };
  }

  async remove(id: string, kind: DiscountKind, deletedBy?: string) {
    if (!kind) {
      throw new BadRequestException('kind is required');
    }

    if (kind === DiscountKind.ADVANCE) {
      return this.advancesService.remove(id, deletedBy);
    }

    return this.bonusesService.remove(id);
  }
}
