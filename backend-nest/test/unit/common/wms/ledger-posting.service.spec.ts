import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LedgerPostingService, LedgerLine } from '../../../../src/common/wms/ledger-posting.service';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/**
 * The ledger poster turns warehouse events into double-entry. Three properties
 * matter enough to pin: entries balance, a retry does not double the books,
 * and an unconfigured chart degrades to "skipped" rather than blocking a
 * receipt.
 */
describe('LedgerPostingService', () => {
  const service = new LedgerPostingService({} as never);

  /** Fake tx with a configurable set of mapped roles and existing entries. */
  const makeTx = (opts: { mappedRoles?: string[]; existingRef?: string } = {}) => {
    const created: Array<Record<string, unknown>> = [];
    const mapped = opts.mappedRoles ?? [
      'inventory',
      'accountsPayable',
      'accountsReceivable',
      'salesRevenue',
      'salesDiscount',
      'cogs',
      'taxInput',
      'taxOutput',
      'inventoryAdjustment',
    ];

    return {
      created,
      tx: {
        journalEntry: {
          findFirst: jest.fn(async ({ where }: { where: { sourceRef: string } }) =>
            opts.existingRef && where.sourceRef === opts.existingRef
              ? { entryNumber: 'JE-2026-000042' }
              : null,
          ),
          create: jest.fn(async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return { id: 'entry-1', entryNumber: 'JE-2026-000100' };
          }),
        },
        accountMapping: {
          findMany: jest.fn(async ({ where }: { where: { role: { in: string[] } } }) =>
            where.role.in
              .filter((role) => mapped.includes(role))
              .map((role) => ({ role, accountId: `acct-${role}` })),
          ),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue([{ last: 'JE-2026-000099' }]),
      } as never,
    };
  };

  const base = {
    description: 'test',
    entryDate: new Date('2026-03-01'),
    sourceType: 'sales_invoice' as const,
    sourceId: 'inv-1',
    sourceRef: 'sales_invoice:post:inv-1',
    createdBy: 'user-1',
  };

  const linesOf = (data: Record<string, unknown>) =>
    (data.lines as { create: Array<{ accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal }> })
      .create;

  describe('postWithin', () => {
    it('writes a balanced entry and numbers it in sequence', async () => {
      const { tx, created } = makeTx();

      const result = await service.postWithin(tx, 'tenant-1', {
        ...base,
        lines: [
          { role: 'inventory', debit: 1000 },
          { role: 'accountsPayable', credit: 1000 },
        ],
      });

      expect(result).toEqual({ posted: true, entryNumber: 'JE-2026-000100', entryId: 'entry-1' });
      expect(created[0].entryNumber).toBe('JE-2026-000100');
      expect(created[0].isAutomatic).toBe(true);

      const lines = linesOf(created[0]);
      const debits = lines.reduce((s, l) => s.plus(l.debit), D(0));
      const credits = lines.reduce((s, l) => s.plus(l.credit), D(0));
      expect(debits.toString()).toBe(credits.toString());
    });

    it('refuses to write an unbalanced entry', async () => {
      const { tx } = makeTx();

      await expect(
        service.postWithin(tx, 'tenant-1', {
          ...base,
          lines: [
            { role: 'inventory', debit: 1000 },
            { role: 'accountsPayable', credit: 900 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips instead of failing when a role has no account mapped', async () => {
      // A factory mid-setup must still be able to receive goods.
      const { tx, created } = makeTx({ mappedRoles: ['inventory'] });

      const result = await service.postWithin(tx, 'tenant-1', {
        ...base,
        lines: [
          { role: 'inventory', debit: 1000 },
          { role: 'accountsPayable', credit: 1000 },
        ],
      });

      expect(result).toEqual({
        posted: false,
        reason: 'unmapped',
        missingRoles: ['accountsPayable'],
      });
      expect(created).toHaveLength(0);
    });

    it('does not post the same event twice', async () => {
      const { tx, created } = makeTx({ existingRef: 'sales_invoice:post:inv-1' });

      const result = await service.postWithin(tx, 'tenant-1', {
        ...base,
        lines: [
          { role: 'inventory', debit: 1000 },
          { role: 'accountsPayable', credit: 1000 },
        ],
      });

      expect(result).toEqual({ posted: false, reason: 'duplicate', entryNumber: 'JE-2026-000042' });
      expect(created).toHaveLength(0);
    });

    it('nets two sides that hit the same account into one line', async () => {
      // A sales entry debits COGS and credits inventory; if both mapped to the
      // same account the entry should show the net, not a wash pair.
      const { tx, created } = makeTx();

      await service.postWithin(tx, 'tenant-1', {
        ...base,
        lines: [
          { role: 'inventory', debit: 1000 },
          { role: 'inventory', credit: 400 },
          { role: 'accountsPayable', credit: 600 },
        ],
      });

      const lines = linesOf(created[0]);
      const inventoryLine = lines.find((l) => l.accountId === 'acct-inventory');
      expect(inventoryLine?.debit.toString()).toBe('600');
      expect(inventoryLine?.credit.toString()).toBe('0');
      expect(lines).toHaveLength(2);
    });

    it('reports zero rather than writing an empty entry', async () => {
      const { tx } = makeTx();

      const result = await service.postWithin(tx, 'tenant-1', {
        ...base,
        lines: [
          { role: 'inventory', debit: 0 },
          { role: 'accountsPayable', credit: 0 },
        ],
      });

      expect(result).toEqual({ posted: false, reason: 'zero' });
    });
  });

  describe('entry shapes', () => {
    const totals = (lines: LedgerLine[]) => ({
      debit: lines.reduce((s, l) => s.plus(D(l.debit ?? 0)), D(0)),
      credit: lines.reduce((s, l) => s.plus(D(l.credit ?? 0)), D(0)),
    });

    it('purchase: inventory + input tax = payable', () => {
      const lines = service.purchaseInvoiceLines({
        goodsValue: D(1000),
        taxAmount: D(110),
        payableTotal: D(1110),
      });
      const t = totals(lines);
      expect(t.debit.toString()).toBe(t.credit.toString());
      expect(t.debit.toString()).toBe('1110');
    });

    it('sales: receivable + discount + COGS balance revenue, tax and inventory', () => {
      // 1000 gross, 100 discount, 99 tax on 900 => receivable 999; cost 600.
      const lines = service.salesInvoiceLines({
        receivable: D(999),
        revenue: D(1000),
        discount: D(100),
        taxAmount: D(99),
        cogs: D(600),
      });
      const t = totals(lines);
      expect(t.debit.toString()).toBe(t.credit.toString());
    });

    it('count shortage credits inventory, overage debits it', () => {
      const shortage = service.cycleCountLines(D(-250));
      expect(shortage.find((l) => l.role === 'inventory')?.credit?.toString()).toBe('250');
      expect(shortage.find((l) => l.role === 'inventoryAdjustment')?.debit?.toString()).toBe('250');

      const overage = service.cycleCountLines(D(75));
      expect(overage.find((l) => l.role === 'inventory')?.debit?.toString()).toBe('75');
    });

    it('reverse mirrors every side', () => {
      const original = service.purchaseInvoiceLines({
        goodsValue: D(1000),
        taxAmount: D(110),
        payableTotal: D(1110),
      });
      const reversed = service.reverse(original);

      const before = totals(original);
      const after = totals(reversed);
      expect(after.debit.toString()).toBe(before.credit.toString());
      expect(after.credit.toString()).toBe(before.debit.toString());
    });
  });
});
