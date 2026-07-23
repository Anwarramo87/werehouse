import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdvancesService } from '../advances/advances.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { PenaltiesService } from '../penalties/penalties.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { CreateDiscountDto, DiscountKind } from './dto/create-discount.dto';
import { AdvanceType } from '../advances/dto/create-advance.dto';

export type DiscountRecord = {
  id: string;
  employeeId: string;
  type: string;
  amount: number;
  date: string;
  notes?: string | null;
  kind: DiscountKind | 'penalty';
  advanceType?: string;
};

@Injectable()
export class DiscountsService {
  constructor(
    private readonly advancesService: AdvancesService,
    private readonly bonusesService: BonusesService,
    private readonly penaltiesService: PenaltiesService,
    private readonly shortCache: ShortCacheService,
  ) {}

  private toNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value === null || value === undefined) return 0;
    if (value instanceof Prisma.Decimal) return Number(value);
    return Number(value || 0);
  }

  private resolveKind(dto: CreateDiscountDto): DiscountKind {
    if (dto.kind) return dto.kind;
    if (dto.type?.trim() === 'سلفة مالية' || dto.type?.trim() === 'شراء ملابس') return DiscountKind.ADVANCE;
    if (dto.type?.trim() === 'مكافأة') return DiscountKind.REWARD;
    if (dto.type?.trim() === 'عقوبة') return DiscountKind.PENALTY;
    return DiscountKind.ASSISTANCE;
  }

  async list(employeeId?: string, period?: string): Promise<DiscountRecord[]> {
    const [advances, bonuses, penalties] = await Promise.all([
      this.advancesService.list({ employeeId, period }),
      this.bonusesService.list({ employeeId, period } as any),
      this.penaltiesService.list({ employeeId, period } as any),
    ]);

    const advanceRecords: DiscountRecord[] = advances.map((advance) => ({
      id: advance.id,
      employeeId: advance.employeeId,
      type: advance.advanceType === 'clothing' ? 'شراء ملابس' : 'سلفة مالية',
      amount: this.toNumber(this.toNumber(advance.installmentAmount) > 0 ? advance.installmentAmount : advance.remainingAmount ?? advance.totalAmount),
      date: advance.issueDate.toISOString(),
      notes: advance.notes ?? null,
      kind: DiscountKind.ADVANCE,
      advanceType: advance.advanceType ?? undefined,
    }));

    const bonusRecords: DiscountRecord[] = (bonuses.data ?? [])
      .map((bonus: { id: string; employeeId: string; bonusReason: string | null; bonusAmount: Prisma.Decimal | number | string; assistanceAmount: Prisma.Decimal | number | string; createdAt: Date }) => {
        const bonusAmt = this.toNumber(bonus.bonusAmount);
        const assistAmt = this.toNumber(bonus.assistanceAmount);

        const records: DiscountRecord[] = [];

        if (bonusAmt > 0) {
          records.push({
            id: bonus.id,
            employeeId: bonus.employeeId,
            type: bonus.bonusReason || 'مكافأة',
            amount: bonusAmt,
            date: bonus.createdAt.toISOString(),
            notes: bonus.bonusReason ?? null,
            kind: DiscountKind.REWARD,
          });
        }

        if (assistAmt > 0) {
          records.push({
            id: bonus.id,
            employeeId: bonus.employeeId,
            type: bonus.bonusReason || 'خصم متنوع',
            amount: assistAmt,
            date: bonus.createdAt.toISOString(),
            notes: bonus.bonusReason ?? null,
            kind: DiscountKind.ASSISTANCE,
          });
        }

        return records;
      })
      .flat();

    const penaltyRecords: DiscountRecord[] = penalties.map((penalty: any) => ({
      id: penalty.id,
      employeeId: penalty.employeeId,
      type: penalty.category || 'عقوبة',
      amount: this.toNumber(penalty.amount),
      date: (penalty.issueDate ?? penalty.createdAt).toISOString(),
      notes: penalty.reason ?? null,
      kind: 'penalty' as const,
    }));

    return [...advanceRecords, ...bonusRecords, ...penaltyRecords].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }

  async create(dto: CreateDiscountDto, kind?: DiscountKind): Promise<DiscountRecord> {
    const resolvedKind = kind ?? this.resolveKind(dto);

    if (resolvedKind === DiscountKind.ADVANCE) {
      const result = await this.advancesService.create({
        employeeId: dto.employeeId,
        advanceType: dto.advanceType ?? AdvanceType.SALARY,
        totalAmount: dto.amount,
        installmentAmount: 0,
        notes: dto.notes,
        issueDate: dto.date,
      });

      await this.shortCache.invalidatePrefix('employees:stats');

      return {
        id: result.id,
        employeeId: result.employeeId,
        type: result.advanceType === 'clothing' ? 'شراء ملابس' : 'سلفة مالية',
        amount: this.toNumber(this.toNumber(result.installmentAmount) > 0 ? result.installmentAmount : result.remainingAmount ?? result.totalAmount),
        date: result.issueDate.toISOString(),
        notes: result.notes ?? null,
        kind: DiscountKind.ADVANCE,
        advanceType: result.advanceType ?? undefined,
      };
    }

    if (resolvedKind === DiscountKind.PENALTY) {
      const now = new Date();
      const period = dto.date ? dto.date.slice(0, 7) : now.toISOString().slice(0, 7);

      const result = await this.penaltiesService.create({
        employeeId: dto.employeeId,
        category: dto.type || 'عقوبة إدارية',
        amount: dto.amount,
        reason: dto.notes,
        issueDate: dto.date,
        period,
      });

      await this.shortCache.invalidatePrefix('employees:stats');

      return {
        id: result.id,
        employeeId: result.employeeId,
        type: result.category || 'عقوبة',
        amount: this.toNumber(result.amount),
        date: (result.issueDate instanceof Date ? result.issueDate : new Date(result.issueDate)).toISOString(),
        notes: result.reason ?? null,
        kind: DiscountKind.PENALTY,
      };
    }

    if (resolvedKind === DiscountKind.REWARD) {
      const period = dto.date ? dto.date.slice(0, 7) : new Date().toISOString().slice(0, 7);

      const result: any = await this.bonusesService.create({
        employeeId: dto.employeeId,
        bonusReason: dto.type || 'مكافأة',
        bonusAmount: dto.amount,
        assistanceAmount: 0,
        period,
      });

      if (result?.skipBonusRecord) {
        throw new BadRequestException(result.message || 'No reward record was created');
      }

      await this.shortCache.invalidatePrefix('employees:stats');

      return {
        id: result.id,
        employeeId: result.employeeId,
        type: result.bonusReason || 'مكافأة',
        amount: this.toNumber(result.bonusAmount),
        date: result.createdAt.toISOString(),
        notes: result.bonusReason ?? null,
        kind: DiscountKind.REWARD,
      };
    }

    // ASSISTANCE (old behavior)
    const period = dto.date ? dto.date.slice(0, 7) : new Date().toISOString().slice(0, 7);
    
    const result: any = await this.bonusesService.create({
      employeeId: dto.employeeId,
      bonusReason: dto.notes || 'خصم',
      assistanceAmount: dto.amount,
      period,
    });

    if (result?.skipBonusRecord) {
      throw new BadRequestException(result.message || 'No discount record was created');
    }

    await this.shortCache.invalidatePrefix('employees:stats');

    return {
      id: result.id,
      employeeId: result.employeeId,
      type: result.bonusReason || 'خصم متنوع',
      amount: this.toNumber(result.assistanceAmount),
      date: result.createdAt.toISOString(),
      notes: result.bonusReason ?? null,
      kind: DiscountKind.ASSISTANCE,
    };
  }

  async remove(id: string, kind?: DiscountKind | 'penalty', deletedBy?: string) {
    if (!kind) {
      const advance = await this.advancesService.getById(id).catch(() => null);
      if (advance) {
        return this.advancesService.remove(id, deletedBy);
      }
      
      const bonus = await this.bonusesService.getById(id).catch(() => null);
      if (bonus) {
        return this.bonusesService.remove(id, deletedBy);
      }

      const penalty = await this.penaltiesService.getById(id).catch(() => null);
      if (penalty) {
        const result = await this.penaltiesService.remove(id, deletedBy);
        await this.shortCache.invalidatePrefix('employees:stats');
        return result;
      }
      
      throw new BadRequestException('Record not found');
    }

    if (kind === 'penalty') {
      const result = await this.penaltiesService.remove(id, deletedBy);
      await this.shortCache.invalidatePrefix('employees:stats');
      return result;
    }

    if (kind === DiscountKind.ADVANCE) {
      return this.advancesService.remove(id, deletedBy);
    }
    
    if (kind === DiscountKind.ASSISTANCE || kind === DiscountKind.REWARD) {
      const result = await this.bonusesService.remove(id, deletedBy);
      await this.shortCache.invalidatePrefix('employees:stats');
      return result;
    }

    throw new BadRequestException('Invalid kind for discounts endpoint');
  }
}
