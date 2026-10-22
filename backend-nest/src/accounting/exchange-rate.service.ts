import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { TransactionAuditService } from '../common/audit/transaction-audit.service';

/** The currencies the product knows how to hold. */
export const SUPPORTED_CURRENCIES = ['SYP', 'USD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** The currency every ledger is denominated in. */
export const BASE_CURRENCY: SupportedCurrency = 'SYP';

/**
 * The canonical pair name for a (from → to) direction.
 *
 * Stored as a single string rather than two columns so the unique index is a
 * plain (tenantId, pair, rateDate) triple and "one rate per pair per day" is
 * enforced by the database rather than by application code that could race.
 */
export function pairName(from: string, to: string): string {
  return `${from.toUpperCase()}_TO_${to.toUpperCase()}`;
}

/** The inverse pair of a given pair, e.g. USD_TO_SYP → SYP_TO_USD. */
export function inversePair(pair: string): string {
  const [from, to] = pair.toUpperCase().split('_TO_');
  return `${to}_TO_${from}`;
}

export interface CurrencyAmount {
  /** The currency the amount was entered in. */
  currency: string;
  /** The amount as entered, in `currency`. */
  originalAmount: number;
  /** The exchange rate used to convert to the base currency. */
  exchangeRate: number;
  /** The date the exchange rate applies to. */
  exchangeRateDate: string | null;
  /** The amount converted into the base currency (SYP). */
  baseAmount: number;
}

/**
 * Exchange rates, archived daily.
 *
 * ── The rule this service exists to enforce ─────────────────────────────────
 * A transaction records the rate that was used, and that record is never
 * rewritten by a later price change. So the price table is append-only per
 * (pair, date): changing a rate for a date that already has transactions is
 * refused, and the caller is told to correct the transactions explicitly
 * (which is audited) rather than silently moving money.
 *
 * ── Why rates are archived per date, not per timestamp ──────────────────────
 * A factory prices in SYP against a USD cost. The USD→SYP rate moves daily.
 * The invoice must show the rate of the day it was issued, not the rate of the
 * day it is looked at. One row per (pair, date) makes "the rate on date D" a
 * lookup rather than a "most recent before D" search that could pick the
 * wrong row after a correction.
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: TransactionAuditService,
  ) {}

  /** The pair used to convert `currency` into the base currency. */
  private pairFor(currency: string): string {
    const code = currency.toUpperCase();
    if (code === BASE_CURRENCY) return '';
    return pairName(code, BASE_CURRENCY);
  }

  /**
   * Validates a currency code, throwing a 400 with the allowed set rather than
   * silently storing an unknown code that no report can interpret.
   */
  private assertSupported(currency: string): SupportedCurrency {
    const code = (currency ?? '').trim().toUpperCase();
    if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(code)) {
      throw new BadRequestException(
        `عملة غير مدعومة: ${currency}. العملات المدعومة: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }
    return code as SupportedCurrency;
  }

  /** Lists rates, newest first, optionally filtered by pair. */
  async listRates(query: { pair?: string; from?: string; to?: string } = {}) {
    const where: Prisma.ExchangeRateWhereInput = {};
    if (query.pair) where.pair = query.pair.toUpperCase();
    if (query.from || query.to) {
      where.rateDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const rows = await this.prisma.exchangeRate.findMany({
      where,
      orderBy: [{ rateDate: 'desc' }, { pair: 'asc' }],
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        pair: r.pair,
        rate: Number(r.rate),
        rateDate: r.rateDate.toISOString().slice(0, 10),
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /**
   * Adds a rate for a (pair, date).
   *
   * The same pair and date may not be added twice — the unique index enforces
   * it — but the error here is the friendly one, and it names the existing row
   * so the operator knows to EDIT rather than ADD.
   */
  async addRate(
    input: { pair: string; rate: number; rateDate: string; createdBy?: string },
  ) {
    const pair = (input.pair ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}_TO_[A-Z]{3}$/.test(pair)) {
      throw new BadRequestException(
        'زوج العملات غير صالح. الصيغة المطلوبة: USD_TO_SYP',
      );
    }
    if (!Number.isFinite(input.rate) || input.rate <= 0) {
      throw new BadRequestException('سعر الصرف يجب أن يكون رقماً أكبر من صفر');
    }
    const rateDate = this.parseDate(input.rateDate);

    const existing = await this.prisma.exchangeRate.findFirst({
      where: { pair, rateDate },
    });
    if (existing) {
      throw new ConflictException(
        `يوجد سعر صرف مسجل لهذه العملة في نفس التاريخ (${rateDate.toISOString().slice(0, 10)}). عدّل السعر المسجل بدلاً من إضافة سعر جديد.`,
      );
    }

    const created = await this.prisma.exchangeRate.create({
      data: {
        pair,
        rate: new Prisma.Decimal(input.rate),
        rateDate,
        createdBy: input.createdBy ?? null,
      },
    });

    await this.audit.record({
      entityType: 'exchange_rate',
      entityId: created.id,
      action: 'create',
      newValues: {
        pair,
        rate: Number(created.rate),
        rateDate: created.rateDate.toISOString().slice(0, 10),
      },
      actorId: input.createdBy,
    });

    return this.toView(created);
  }

  /**
   * Edits a rate.
   *
   * REFUSED when a transaction already used this rate: silently re-pricing
   * history would change the meaning of an issued invoice without any trace.
   * The operator must correct the affected transactions first, and each such
   * correction is itself audited.
   */
  async updateRate(
    id: string,
    input: { rate: number; actorId?: string; reason?: string },
  ) {
    const existing = await this.prisma.exchangeRate.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('سعر الصرف غير موجود');

    if (!Number.isFinite(input.rate) || input.rate <= 0) {
      throw new BadRequestException('سعر الصرف يجب أن يكون رقماً أكبر من صفر');
    }

    const usages = await this.countUsages(existing.pair, existing.rateDate);
    if (usages > 0) {
      throw new ConflictException(
        `لا يمكن تعديل سعر الصرف: هناك ${usages} معاملة مسجلة بسعر الصرف هذا. ` +
          'صحّح المعاملات المرتبطة أولاً — كل تصحيح سيُسجّل في سجل التدقيق.',
      );
    }

    const updated = await this.prisma.exchangeRate.update({
      where: { id },
      data: { rate: new Prisma.Decimal(input.rate) },
    });

    await this.audit.record({
      entityType: 'exchange_rate',
      entityId: id,
      action: 'update',
      oldValues: { rate: Number(existing.rate) },
      newValues: { rate: Number(updated.rate) },
      actorId: input.actorId,
      note: input.reason,
    });

    return this.toView(updated);
  }

  /** Deletes a rate — only when nothing used it. */
  async removeRate(id: string, actorId?: string) {
    const existing = await this.prisma.exchangeRate.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('سعر الصرف غير موجود');

    const usages = await this.countUsages(existing.pair, existing.rateDate);
    if (usages > 0) {
      throw new ConflictException(
        `لا يمكن حذف سعر الصرف: هناك ${usages} معاملة مسجلة به.`,
      );
    }

    await this.prisma.exchangeRate.delete({ where: { id } });

    await this.audit.record({
      entityType: 'exchange_rate',
      entityId: id,
      action: 'delete',
      oldValues: {
        pair: existing.pair,
        rate: Number(existing.rate),
        rateDate: existing.rateDate.toISOString().slice(0, 10),
      },
      actorId,
    });

    return { message: 'تم حذف سعر الصرف' };
  }

  /**
   * How many transactions recorded this (pair, rateDate) — the guard that
   * stops a rate from being re-priced under live documents.
   */
  private async countUsages(pair: string, rateDate: Date): Promise<number> {
    const [invoices, sales, journal, movements] = await Promise.all([
      this.prisma.purchaseInvoice.count({
        where: { exchangeRateDate: rateDate, currency: pair.split('_TO_')[0] },
      }),
      this.prisma.salesInvoice.count({
        where: { exchangeRateDate: rateDate, currency: pair.split('_TO_')[0] },
      }),
      this.prisma.journalEntryLine.count({
        where: { exchangeRateDate: rateDate, currency: pair.split('_TO_')[0] },
      }),
      this.prisma.stockMovement.count({
        where: { exchangeRateDate: rateDate, currency: pair.split('_TO_')[0] },
      }),
    ]);
    return invoices + sales + journal + movements;
  }

  /**
   * The rate to use for a currency on a given date.
   *
   * Resolution order:
   *   1. the exact rate recorded for that (pair, date);
   *   2. the most recent rate on or before that date (a rate is valid until
   *      the next one is published — this is what "the rate in force on date
   *      D" means in practice);
   *   3. nothing — the caller must supply a rate.
   *
   * The base currency needs no rate at all.
   */
  async resolveRate(
    currency: string,
    rateDate: Date,
  ): Promise<{ rate: number; date: string; exact: boolean } | null> {
    const code = (currency ?? '').trim().toUpperCase();
    if (code === BASE_CURRENCY) {
      return { rate: 1, date: rateDate.toISOString().slice(0, 10), exact: true };
    }

    const pair = this.pairFor(code);
    if (!pair) return null;

    const exact = await this.prisma.exchangeRate.findFirst({
      where: { pair, rateDate },
      orderBy: { createdAt: 'desc' },
    });
    if (exact) {
      return {
        rate: Number(exact.rate),
        date: exact.rateDate.toISOString().slice(0, 10),
        exact: true,
      };
    }

    const previous = await this.prisma.exchangeRate.findFirst({
      where: { pair, rateDate: { lte: rateDate } },
      orderBy: [{ rateDate: 'desc' }, { createdAt: 'desc' }],
    });
    if (previous) {
      return {
        rate: Number(previous.rate),
        date: previous.rateDate.toISOString().slice(0, 10),
        exact: false,
      };
    }

    return null;
  }

  /**
   * Converts an amount into the base currency, using the rate recorded for the
   * transaction's own date.
   *
   * The caller must pass the rate and its date when it has them (a transaction
   * being edited already knows them). When it does not, the rate for that date
   * is resolved — and if no rate exists for that currency at that date, the
   * conversion is REFUSED rather than silently using today's rate, because
   * today's rate applied to a historical transaction is exactly the silent
   * rewrite the brief forbids.
   */
  async convert(input: {
    amount: number;
    currency: string;
    rateDate?: string | Date;
    exchangeRate?: number;
    exchangeRateDate?: string | Date;
  }): Promise<CurrencyAmount> {
    const code = this.assertSupported(input.currency);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount)) {
      throw new BadRequestException('المبلغ غير صالح');
    }

    if (code === BASE_CURRENCY) {
      const date = input.exchangeRateDate
        ? this.toIsoDate(input.exchangeRateDate)
        : (input.rateDate ? this.toIsoDate(input.rateDate) : null);
      return {
        currency: code,
        originalAmount: amount,
        exchangeRate: 1,
        exchangeRateDate: date,
        baseAmount: this.round2(amount),
      };
    }

    const rateDate = input.exchangeRateDate
      ? this.toDate(input.exchangeRateDate)
      : input.rateDate
        ? this.toDate(input.rateDate)
        : new Date();

    let rate: number;
    let appliedDate: string;

    if (input.exchangeRate !== undefined && input.exchangeRate !== null) {
      if (!Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0) {
        throw new BadRequestException('سعر الصرف يجب أن يكون رقماً أكبر من صفر');
      }
      rate = input.exchangeRate;
      appliedDate = this.toIsoDate(rateDate);
    } else {
      const resolved = await this.resolveRate(code, rateDate);
      if (!resolved) {
        throw new BadRequestException(
          `لا يوجد سعر صرف مسجل للزوج ${code}_TO_${BASE_CURRENCY} بتاريخ ` +
            `${rateDate.toISOString().slice(0, 10)}. ` +
            'أضف السعر إلى سجل أسعار الصرف ثم أعد المحاولة.',
        );
      }
      rate = resolved.rate;
      appliedDate = resolved.date;
    }

    return {
      currency: code,
      originalAmount: amount,
      exchangeRate: rate,
      exchangeRateDate: appliedDate,
      baseAmount: this.round2(amount * rate),
    };
  }

  /**
   * Asserts that a USD transaction carries its own rate and date.
   *
   * The brief requires the user to enter the exchange-rate date and the rate
   * adopted for that date whenever a transaction is recorded in dollars — not
   * a rate looked up silently. This is the guard for that rule.
   */
  async assertRateProvided(input: {
    currency: string;
    exchangeRate?: number | null;
    exchangeRateDate?: string | Date | null;
  }): Promise<void> {
    const code = this.assertSupported(input.currency);
    if (code === BASE_CURRENCY) return;

    if (input.exchangeRateDate === undefined || input.exchangeRateDate === null) {
      throw new BadRequestException(
        `تاريخ سعر الصرف مطلوب للمعاملات بعملة ${code}`,
      );
    }
    if (input.exchangeRate === undefined || input.exchangeRate === null) {
      throw new BadRequestException(
        `سعر الصرف مطلوب للمعاملات بعملة ${code}`,
      );
    }
    if (!Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0) {
      throw new BadRequestException('سعر الصرف يجب أن يكون رقماً أكبر من صفر');
    }
  }

  /** Rounds to 2 decimals, the precision the ledgers use. */
  private round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private parseDate(value: string): Date {
    const date = this.toDate(value);
    if (!date) {
      throw new BadRequestException('التاريخ غير صالح');
    }
    return date;
  }

  private toDate(value: string | Date): Date {
    if (value instanceof Date) {
      return new Date(
        Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
      );
    }
    const text = (value ?? '').trim();
    if (!text) return new Date(NaN);
    const iso = text.length <= 10 ? `${text}T00:00:00.000Z` : text;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? new Date(NaN) : date;
  }

  private toIsoDate(value: string | Date): string {
    const date = this.toDate(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  private toView(row: {
    id: string;
    pair: string;
    rate: Prisma.Decimal;
    rateDate: Date;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      pair: row.pair,
      rate: Number(row.rate),
      rateDate: row.rateDate.toISOString().slice(0, 10),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The tenant this service is operating for — used by the audit trail. */
  private tenantId(): string | null {
    return currentTenant()?.tenantId ?? null;
  }
}
