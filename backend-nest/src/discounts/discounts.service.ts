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
    if (dto.type?.trim() === 'سلفة') return DiscountKind.ADVANCE;
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
      type: 'سلفة',
      amount: this.toNumber(this.toNumber(advance.installmentAmount) > 0 ? advance.installmentAmount : advance.remainingAmount ?? advance.totalAmount),
      date: advance.issueDate.toISOString(),
      notes: advance.notes ?? null,
      kind: DiscountKind.ADVANCE,
      advanceType: advance.advanceType ?? undefined,
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
        type: 'سلفة',
        amount: this.toNumber(this.toNumber(result.installmentAmount) > 0 ? result.installmentAmount : result.remainingAmount ?? result.totalAmount),
        date: result.issueDate.toISOString(),
        notes: result.notes ?? null,
        kind: DiscountKind.ADVANCE,
        advanceType: result.advanceType ?? undefined,
      };
    }

    // Create assistance/discount record through bonuses endpoint
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
      // Try advance first
      const advance = await this.advancesService.getById(id).catch(() => null);
      if (advance) {
        return this.advancesService.remove(id, deletedBy);
      }
      
      // Try bonus (assistance) next
      const bonus = await this.bonusesService.getById(id).catch(() => null);
      if (bonus) {
        return this.bonusesService.remove(id, deletedBy);
      }

      // Try penalty last
      const penalty = await this.penaltiesService.getById(id).catch(() => null);
      if (penalty) {
        const result = await this.penaltiesService.remove(id, deletedBy);
        await this.shortCache.invalidatePrefix('employees:stats');
        return result;
      }
      
      throw new BadRequestException('Record not found');
    }

    if (kind === DiscountKind.ADVANCE) {
      return this.advancesService.remove(id, deletedBy);
    }
    
    if (kind === DiscountKind.ASSISTANCE) {
      const result = await this.bonusesService.remove(id, deletedBy);
      await this.shortCache.invalidatePrefix('employees:stats');
      return result;
    }

    if (kind === 'penalty') {
      const result = await this.penaltiesService.remove(id, deletedBy);
      await this.shortCache.invalidatePrefix('employees:stats');
      return result;
    }

    throw new BadRequestException('Invalid kind for discounts endpoint');
  }
}
