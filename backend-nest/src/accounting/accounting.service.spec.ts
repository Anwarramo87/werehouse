import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountingService } from './accounting.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AccountingService', () => {
  let service: AccountingService;

  const prismaMock: {
    account: Record<string, jest.Mock>;
    journalEntry: Record<string, jest.Mock>;
    journalEntryLine: Record<string, jest.Mock>;
  } = {
    account: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    journalEntry: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    journalEntryLine: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [AccountingService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get(AccountingService);
  });

  describe('createAccount', () => {
    it('throws ConflictException when the code already exists', async () => {
      prismaMock.account.findUnique.mockResolvedValue({ id: 'acc-1', code: '1000' });

      await expect(
        service.createAccount({ code: '1000', name: 'Cash', type: 'asset' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates an account', async () => {
      prismaMock.account.findUnique.mockResolvedValue(null);
      prismaMock.account.create.mockResolvedValue({ id: 'acc-1', code: '1000', name: 'Cash' });

      const result = await service.createAccount({ code: '1000', name: 'Cash', type: 'asset' });
      expect(result.message).toBe('Account created successfully');
      expect(prismaMock.account.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { code: '1000', name: 'Cash', type: 'asset' } }),
      );
    });
  });

  describe('createJournalEntry', () => {
    it('throws BadRequestException when debits do not equal credits', async () => {
      await expect(
        service.createJournalEntry(
          {
            description: 'Unbalanced',
            lines: [
              { accountId: 'a-1', debit: 100, credit: 0 },
              { accountId: 'a-2', debit: 0, credit: 90 },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when a line has neither debit nor credit', async () => {
      await expect(
        service.createJournalEntry(
          {
            description: 'Zero line',
            lines: [
              { accountId: 'a-1', debit: 100, credit: 0 },
              { accountId: 'a-2', debit: 0, credit: 100 },
              { accountId: 'a-3', debit: 0, credit: 0 },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when posting to an inactive account', async () => {
      prismaMock.account.findMany.mockResolvedValue([
        { id: 'a-1', isActive: true },
        { id: 'a-2', isActive: false },
      ]);

      await expect(
        service.createJournalEntry(
          {
            description: 'Inactive',
            lines: [
              { accountId: 'a-1', debit: 100, credit: 0 },
              { accountId: 'a-2', debit: 0, credit: 100 },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('posts a balanced journal entry with generated number', async () => {
      prismaMock.account.findMany.mockResolvedValue([
        { id: 'a-1', isActive: true },
        { id: 'a-2', isActive: true },
      ]);
      prismaMock.journalEntry.findFirst.mockResolvedValue(null);
      prismaMock.journalEntry.create.mockResolvedValue({ id: 'je-1', lines: [] });

      const result = await service.createJournalEntry(
        {
          description: 'Sale on credit',
          lines: [
            { accountId: 'a-1', debit: 500, credit: 0 },
            { accountId: 'a-2', debit: 0, credit: 500 },
          ],
        },
        'user-1',
      );

      const createData = prismaMock.journalEntry.create.mock.calls[0][0].data;
      expect(createData.entryNumber).toMatch(/^JE-\d{4}-\d{6}$/);
      expect(createData.description).toBe('Sale on credit');
      expect(createData.lines.create).toHaveLength(2);
      expect(result.message).toBe('Journal entry posted');
    });
  });

  describe('trialBalance', () => {
    it('aggregates debits and credits per account and reports balance', async () => {
      prismaMock.journalEntryLine.findMany.mockResolvedValue([
        { debit: 100, credit: 0, account: { code: '1000', name: 'Cash', type: 'asset' } },
        { debit: 0, credit: 100, account: { code: '4000', name: 'Revenue', type: 'revenue' } },
      ]);

      const result = await service.trialBalance({});

      expect(result.data).toHaveLength(2);
      expect(result.totals.debit).toBe(100);
      expect(result.totals.credit).toBe(100);
      expect(result.totals.balanced).toBe(true);
    });
  });
});
