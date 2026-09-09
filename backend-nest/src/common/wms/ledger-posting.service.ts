import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const ZERO = new Prisma.Decimal(0);
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/**
 * The accounting roles a warehouse movement can touch.
 *
 * A role is not an account code: every business numbers its chart differently,
 * so the mapping from role to account lives in `account_mappings` and is set
 * once per factory. Hard-coding `1300` here would work for exactly one client.
 */
export const LEDGER_ROLES = {
  inventory: 'المخزون',
  accountsPayable: 'الذمم الدائنة (موردون)',
  accountsReceivable: 'الذمم المدينة (عملاء)',
  salesRevenue: 'إيراد المبيعات',
  cogs: 'تكلفة البضاعة المباعة',
  taxInput: 'ضريبة مشتريات مستردّة',
  taxOutput: 'ضريبة مبيعات مستحقة',
  salesDiscount: 'خصم مبيعات',
  inventoryAdjustment: 'فروقات جرد',
} as const;

export type LedgerRole = keyof typeof LEDGER_ROLES;

export interface LedgerLine {
  role: LedgerRole;
  debit?: Prisma.Decimal | number;
  credit?: Prisma.Decimal | number;
}

export interface PostLedgerInput {
  /** Human description written onto the entry. */
  description: string;
  entryDate: Date;
  sourceType: 'purchase_invoice' | 'sales_invoice' | 'cycle_count';
  sourceId: string;
  /** Idempotency key, e.g. `sales_invoice:post:<id>`. */
  sourceRef: string;
  createdBy: string;
  lines: LedgerLine[];
}

export type PostLedgerResult =
  | { posted: true; entryNumber: string; entryId: string }
  | { posted: false; reason: 'unmapped'; missingRoles: LedgerRole[] }
  | { posted: false; reason: 'duplicate'; entryNumber: string }
  | { posted: false; reason: 'zero' };

/**
 * Turns a warehouse document into a balanced journal entry.
 *
 * Two decisions shape this service:
 *
 * **Unmapped means skipped, not failed.** A factory that has not yet told the
 * system which account is "inventory" should still be able to receive goods.
 * Posting returns `unmapped` and the caller carries on — the stock movement is
 * the system of record, the journal entry is a downstream convenience. Failing
 * the receipt instead would make the accounting module a hostage-taker.
 *
 * **Reversals are new entries.** Cancelling an invoice posts a mirrored entry
 * rather than deleting the original, because a ledger you can rewrite is not a
 * ledger.
 */
@Injectable()
export class LedgerPostingService {
  private readonly logger = new Logger(LedgerPostingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds and writes the entry inside the caller's transaction, so the books
   * and the stock ledger commit together or not at all.
   */
  async postWithin(
    tx: Prisma.TransactionClient,
    tenantId: string | null,
    input: PostLedgerInput,
  ): Promise<PostLedgerResult> {
    const lines = input.lines.filter(
      (l) => !D(l.debit ?? 0).isZero() || !D(l.credit ?? 0).isZero(),
    );
    if (lines.length === 0) return { posted: false, reason: 'zero' };

    // Idempotency first: a retried post must not double the books.
    const existing = await tx.journalEntry.findFirst({
      where: { sourceRef: input.sourceRef },
      select: { entryNumber: true },
    });
    if (existing) {
      return { posted: false, reason: 'duplicate', entryNumber: existing.entryNumber };
    }

    const neededRoles = [...new Set(lines.map((l) => l.role))];
    const mappings = await tx.accountMapping.findMany({
      where: { role: { in: neededRoles } },
      select: { role: true, accountId: true },
    });
    const accountByRole = new Map(mappings.map((m) => [m.role, m.accountId]));

    const missingRoles = neededRoles.filter((role) => !accountByRole.has(role));
    if (missingRoles.length > 0) {
      this.logger.warn(
        `Skipping ledger entry for ${input.sourceRef} — unmapped roles: ${missingRoles.join(', ')}`,
      );
      return { posted: false, reason: 'unmapped', missingRoles };
    }

    // Merge lines that hit the same account, then net them: a document that
    // debits and credits one account is expressing a single smaller movement,
    // and posting both sides makes the trial balance harder to read.
    const byAccount = new Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>();
    for (const line of lines) {
      const accountId = accountByRole.get(line.role) as string;
      const current = byAccount.get(accountId) ?? { debit: ZERO, credit: ZERO };
      byAccount.set(accountId, {
        debit: current.debit.plus(D(line.debit ?? 0)),
        credit: current.credit.plus(D(line.credit ?? 0)),
      });
    }

    const netted = [...byAccount.entries()].map(([accountId, sides]) => {
      const net = sides.debit.minus(sides.credit);
      return {
        accountId,
        debit: net.greaterThan(ZERO) ? net : ZERO,
        credit: net.lessThan(ZERO) ? net.abs() : ZERO,
      };
    });

    const totalDebit = netted.reduce((s, l) => s.plus(l.debit), ZERO);
    const totalCredit = netted.reduce((s, l) => s.plus(l.credit), ZERO);

    if (!totalDebit.equals(totalCredit)) {
      // A caller built an unbalanced entry — a bug, not a data condition, so
      // it fails loudly rather than writing crooked books.
      throw new BadRequestException(
        `Ledger entry for ${input.sourceRef} is unbalanced: debits ${totalDebit} vs credits ${totalCredit}`,
      );
    }
    if (totalDebit.isZero()) return { posted: false, reason: 'zero' };

    const entryNumber = await this.nextEntryNumber(tx, tenantId, input.entryDate.getFullYear());

    const entry = await tx.journalEntry.create({
      data: {
        entryNumber,
        entryDate: input.entryDate,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceRef: input.sourceRef,
        isAutomatic: true,
        createdBy: input.createdBy,
        lines: {
          create: netted
            .filter((l) => !l.debit.isZero() || !l.credit.isZero())
            .map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
        },
      },
      select: { id: true, entryNumber: true },
    });

    return { posted: true, entryNumber: entry.entryNumber, entryId: entry.id };
  }

  /**
   * Sequential entry number, serialised on an advisory lock so two concurrent
   * posts cannot both read the same last number.
   */
  private async nextEntryNumber(
    tx: Prisma.TransactionClient,
    tenantId: string | null,
    year: number,
  ): Promise<string> {
    const lockKey = `${tenantId ?? 'global'}:journal:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const prefix = `JE-${year}-`;
    const rows = await tx.$queryRaw<Array<{ last: string | null }>>`
      SELECT MAX("entryNumber") AS last FROM journal_entries
      WHERE "entryNumber" LIKE ${prefix + '%'}
        AND ("tenantId" = ${tenantId}::uuid OR (${tenantId}::uuid IS NULL AND "tenantId" IS NULL))
    `;

    const last = rows[0]?.last ?? null;
    const seq = last ? Number(last.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(Number.isFinite(seq) ? seq : 1).padStart(6, '0')}`;
  }

  // ------------------------------------------------------------ entry shapes

  /**
   * Receiving goods on credit.
   *
   *   Dr  Inventory              (goods at landed cost)
   *   Dr  Recoverable VAT        (input tax)
   *     Cr  Accounts payable     (what the supplier is owed)
   */
  purchaseInvoiceLines(input: {
    goodsValue: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    payableTotal: Prisma.Decimal;
  }): LedgerLine[] {
    return [
      { role: 'inventory', debit: input.goodsValue },
      { role: 'taxInput', debit: input.taxAmount },
      { role: 'accountsPayable', credit: input.payableTotal },
    ];
  }

  /**
   * Selling goods on credit — two movements in one entry.
   *
   *   Dr  Accounts receivable    (what the customer owes, tax included)
   *     Cr  Sales revenue        (net of discount)
   *     Cr  VAT payable          (output tax)
   *   Dr  COGS                   (cost of the lots that actually shipped)
   *     Cr  Inventory            (same amount leaves the asset)
   *
   * Discount is shown gross-and-contra rather than netted into revenue, so the
   * discount given stays visible in the income statement.
   */
  salesInvoiceLines(input: {
    receivable: Prisma.Decimal;
    revenue: Prisma.Decimal;
    discount: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    cogs: Prisma.Decimal;
  }): LedgerLine[] {
    return [
      { role: 'accountsReceivable', debit: input.receivable },
      { role: 'salesRevenue', credit: input.revenue },
      { role: 'salesDiscount', debit: input.discount },
      { role: 'taxOutput', credit: input.taxAmount },
      { role: 'cogs', debit: input.cogs },
      { role: 'inventory', credit: input.cogs },
    ];
  }

  /**
   * A stock count variance, valued at cost.
   *
   * A shortage credits inventory and debits the variance expense; an overage
   * does the reverse. `netValue` carries the sign.
   */
  cycleCountLines(netValue: Prisma.Decimal): LedgerLine[] {
    return netValue.greaterThanOrEqualTo(ZERO)
      ? [
          { role: 'inventory', debit: netValue },
          { role: 'inventoryAdjustment', credit: netValue },
        ]
      : [
          { role: 'inventoryAdjustment', debit: netValue.abs() },
          { role: 'inventory', credit: netValue.abs() },
        ];
  }

  /** Mirrors an entry's lines — used when a posted document is cancelled. */
  reverse(lines: LedgerLine[]): LedgerLine[] {
    return lines.map((line) => ({
      role: line.role,
      debit: line.credit ?? 0,
      credit: line.debit ?? 0,
    }));
  }
}
