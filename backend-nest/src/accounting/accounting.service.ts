import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { JournalEntryQueryDto } from './dto/journal-entry-query.dto';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------- accounts

  async listAccounts(query: { search?: string; type?: string; isActive?: string }) {
    const where: Prisma.AccountWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search } },
      ];
    }
    if (query.type) {
      if (!ACCOUNT_TYPES.includes(query.type)) {
        throw new BadRequestException(
          `Invalid account type. Allowed: ${ACCOUNT_TYPES.join(', ')}`,
        );
      }
      where.type = query.type;
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive === 'true';
    }

    const accounts = await this.prisma.account.findMany({
      where,
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    });
    return { data: accounts };
  }

  async getAccount(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: { children: true, parent: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async createAccount(dto: CreateAccountDto) {
    if (dto.parentId) {
      const parent = await this.prisma.account.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent account not found');
    }

    const existing = await this.prisma.account.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('Account code already exists');

    const account = await this.prisma.account.create({
      data: {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        parentId: dto.parentId,
      },
    });
    return { message: 'Account created successfully', account };
  }

  async updateAccount(accountId: string, dto: UpdateAccountDto) {
    const existing = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!existing) throw new NotFoundException('Account not found');

    if (dto.code && dto.code !== existing.code) {
      const collision = await this.prisma.account.findUnique({ where: { code: dto.code } });
      if (collision) throw new ConflictException('Account code already exists');
    }
    if (dto.parentId === accountId) {
      throw new BadRequestException('An account cannot be its own parent');
    }

    const account = await this.prisma.account.update({
      where: { id: accountId },
      data: {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        parentId: dto.parentId,
        isActive: dto.isActive,
      },
    });
    return { message: 'Account updated', account };
  }

  async removeAccount(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: {
        _count: { select: { children: true, journalLines: true } },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    if (account._count.children > 0) {
      throw new BadRequestException('Cannot delete an account that has child accounts');
    }
    if (account._count.journalLines > 0) {
      throw new BadRequestException('Cannot delete an account with journal entries');
    }

    await this.prisma.account.delete({ where: { id: accountId } });
    return { message: 'Account deleted' };
  }

  // ------------------------------------------------------------- journal entries

  private async generateEntryNumber(): Promise<string> {
    const now = new Date();
    const y = now.getFullYear();
    const prefix = `JE-${y}-`;
    const last = await this.prisma.journalEntry.findFirst({
      where: { entryNumber: { startsWith: prefix } },
      orderBy: { entryNumber: 'desc' },
      select: { entryNumber: true },
    });

    const seq = last ? parseInt(last.entryNumber.slice(prefix.length), 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  async createJournalEntry(dto: CreateJournalEntryDto, userId: string) {
    const totalDebit = dto.lines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredit = dto.lines.reduce((sum, line) => sum + line.credit, 0);

    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      throw new BadRequestException(
        `Journal entry is not balanced (debits ${totalDebit.toFixed(2)}, credits ${totalCredit.toFixed(2)})`,
      );
    }
    if (totalDebit <= 0) {
      throw new BadRequestException('Journal entry must have a non-zero amount');
    }
    const zeroLines = dto.lines.filter((line) => line.debit === 0 && line.credit === 0);
    if (zeroLines.length > 0) {
      throw new BadRequestException('Each line must have either a debit or a credit');
    }

    const accountIds = dto.lines.map((line) => line.accountId);
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, isActive: true },
    });
    if (accounts.length !== new Set(accountIds).size) {
      throw new BadRequestException('One or more accounts do not exist');
    }
    const inactive = accounts.filter((account) => !account.isActive);
    if (inactive.length > 0) {
      throw new BadRequestException('Cannot post to an inactive account');
    }

    const entryNumber = await this.generateEntryNumber();

    const entry = await this.prisma.journalEntry.create({
      data: {
        entryNumber,
        entryDate: dto.entryDate ? new Date(dto.entryDate) : new Date(),
        description: dto.description,
        createdBy: userId,
        lines: {
          create: dto.lines.map((line) => ({
            accountId: line.accountId,
            debit: new Prisma.Decimal(line.debit),
            credit: new Prisma.Decimal(line.credit),
          })),
        },
      },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });

    return { message: 'Journal entry posted', entry };
  }

  async listJournalEntries(query: JournalEntryQueryDto) {
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.JournalEntryWhereInput = {};
    if (query.from || query.to) {
      where.entryDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.search) {
      where.description = { contains: query.search, mode: 'insensitive' };
    }
    if (query.accountId) {
      where.lines = { some: { accountId: query.accountId } };
    }

    const [entries, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return paginatedResponse(entries, page, limit, total);
  }

  async getJournalEntry(entryId: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    return entry;
  }

  // --------------------------------------------------------------------- reports

  async trialBalance(query: { from?: string; to?: string }) {
    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        journalEntry: {
          entryDate: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        },
      },
      include: { account: { select: { code: true, name: true, type: true } } },
    });

    const totals = new Map<string, { code: string; name: string; type: string; debit: number; credit: number }>();
    for (const line of lines) {
      const key = line.account.code;
      const current = totals.get(key) ?? {
        code: line.account.code,
        name: line.account.name,
        type: line.account.type,
        debit: 0,
        credit: 0,
      };
      current.debit += Number(line.debit);
      current.credit += Number(line.credit);
      totals.set(key, current);
    }

    const rows = Array.from(totals.values()).map((row) => ({
      ...row,
      debit: Number(row.debit.toFixed(2)),
      credit: Number(row.credit.toFixed(2)),
    }));

    const totalDebit = rows.reduce((sum, row) => sum + row.debit, 0);
    const totalCredit = rows.reduce((sum, row) => sum + row.credit, 0);

    return {
      data: rows,
      totals: {
        debit: Number(totalDebit.toFixed(2)),
        credit: Number(totalCredit.toFixed(2)),
        balanced: Math.abs(totalDebit - totalCredit) < 0.01,
      },
    };
  }

  async incomeStatement(query: { from?: string; to?: string }) {
    const rows = await this.balanceByType(['revenue', 'expense'], query);

    const revenue = rows
      .filter((row) => row.type === 'revenue')
      .reduce((sum, row) => sum + (row.credit - row.debit), 0);
    const expenses = rows
      .filter((row) => row.type === 'expense')
      .reduce((sum, row) => sum + (row.debit - row.credit), 0);

    return {
      revenue: Number(revenue.toFixed(2)),
      expenses: Number(expenses.toFixed(2)),
      netIncome: Number((revenue - expenses).toFixed(2)),
      accounts: rows,
    };
  }

  async balanceSheet(query: { asOf?: string }) {
    const rows = await this.balanceByType(['asset', 'liability', 'equity'], query);

    const assets = rows
      .filter((row) => row.type === 'asset')
      .reduce((sum, row) => sum + (row.debit - row.credit), 0);
    const liabilities = rows
      .filter((row) => row.type === 'liability')
      .reduce((sum, row) => sum + (row.credit - row.debit), 0);
    const equity = rows
      .filter((row) => row.type === 'equity')
      .reduce((sum, row) => sum + (row.credit - row.debit), 0);

    return {
      assets: Number(assets.toFixed(2)),
      liabilities: Number(liabilities.toFixed(2)),
      equity: Number(equity.toFixed(2)),
      balanced: Math.abs(assets - (liabilities + equity)) < 0.01,
      accounts: rows,
    };
  }

  private async balanceByType(
    types: string[],
    query: { from?: string; to?: string; asOf?: string },
  ) {
    const accounts = await this.prisma.account.findMany({
      where: { type: { in: types }, isActive: true },
      select: { id: true, code: true, name: true, type: true },
    });

    const lines = await this.prisma.journalEntryLine.findMany({
      where: {
        account: { type: { in: types } },
        journalEntry: {
          entryDate: {
            ...(query.asOf ? { lte: new Date(query.asOf) } : {}),
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        },
      },
      select: { accountId: true, debit: true, credit: true },
    });

    const debitByAccount = new Map<string, number>();
    const creditByAccount = new Map<string, number>();
    for (const line of lines) {
      debitByAccount.set(line.accountId, (debitByAccount.get(line.accountId) ?? 0) + Number(line.debit));
      creditByAccount.set(line.accountId, (creditByAccount.get(line.accountId) ?? 0) + Number(line.credit));
    }

    return accounts.map((account) => {
      const debit = debitByAccount.get(account.id) ?? 0;
      const credit = creditByAccount.get(account.id) ?? 0;
      return {
        code: account.code,
        name: account.name,
        type: account.type,
        debit: Number(debit.toFixed(2)),
        credit: Number(credit.toFixed(2)),
      };
    });
  }
}
