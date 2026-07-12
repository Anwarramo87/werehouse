import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PenaltiesService } from './penalties.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { Prisma } from '@prisma/client';

const penaltyRecord = {
  id: 'pen-1',
  employeeId: 'EMP000001',
  category: 'absence',
  amount: new Prisma.Decimal(500),
  reason: 'غياب بدون إذن',
  issueDate: new Date('2026-01-15'),
  createdAt: new Date('2026-01-15'),
  updatedAt: new Date('2026-01-15'),
};

describe('PenaltiesService', () => {
  let service: PenaltiesService;

  const prismaMock = {
    employee: { findUnique: jest.fn() },
    employeePenalty: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    deletedRecordHistory: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const cacheMock = { invalidatePrefix: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        employeePenalty: prismaMock.employeePenalty,
        deletedRecordHistory: prismaMock.deletedRecordHistory,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltiesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ShortCacheService, useValue: cacheMock },
      ],
    }).compile();

    service = module.get(PenaltiesService);
  });

  describe('create', () => {
    it('throws BadRequestException when employee does not exist', async () => {
      prismaMock.employee.findUnique.mockResolvedValue(null);
      await expect(
        service.create({ employeeId: 'UNKNOWN', category: 'absence', amount: 100, issueDate: '2026-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for invalid issueDate', async () => {
      prismaMock.employee.findUnique.mockResolvedValue({ employeeId: 'EMP000001' });
      await expect(
        service.create({ employeeId: 'EMP000001', category: 'absence', amount: 100, issueDate: 'not-a-date' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates penalty and invalidates cache', async () => {
      prismaMock.employee.findUnique.mockResolvedValue({ employeeId: 'EMP000001' });
      prismaMock.employeePenalty.create.mockResolvedValue(penaltyRecord);

      const result = await service.create({
        employeeId: 'EMP000001',
        category: 'absence',
        amount: 500,
        issueDate: '2026-01-15',
      });

      expect(prismaMock.employeePenalty.create).toHaveBeenCalledTimes(1);
      expect(cacheMock.invalidatePrefix).toHaveBeenCalledWith('employees:stats');
      expect(result.id).toBe('pen-1');
    });
  });

  describe('getById', () => {
    it('throws NotFoundException when penalty does not exist', async () => {
      prismaMock.employeePenalty.findUnique.mockResolvedValue(null);
      await expect(service.getById('missing-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the penalty record when found', async () => {
      prismaMock.employeePenalty.findUnique.mockResolvedValue(penaltyRecord);
      const result = await service.getById('pen-1');
      expect(result.id).toBe('pen-1');
    });
  });

  describe('update', () => {
    it('throws BadRequestException for invalid issueDate on update', async () => {
      prismaMock.employeePenalty.findUnique.mockResolvedValue(penaltyRecord);
      await expect(
        service.update('pen-1', { issueDate: 'bad-date' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates penalty and invalidates cache', async () => {
      prismaMock.employeePenalty.findUnique.mockResolvedValue(penaltyRecord);
      prismaMock.employeePenalty.update.mockResolvedValue({ ...penaltyRecord, amount: new Prisma.Decimal(750) });

      const result = await service.update('pen-1', { amount: 750 });
      expect(prismaMock.employeePenalty.update).toHaveBeenCalledTimes(1);
      expect(cacheMock.invalidatePrefix).toHaveBeenCalledWith('employees:stats');
      expect(Number(result.amount)).toBe(750);
    });
  });

  describe('remove', () => {
    it('archives to history and deletes penalty', async () => {
      prismaMock.employeePenalty.findUnique.mockResolvedValue(penaltyRecord);
      prismaMock.deletedRecordHistory.create.mockResolvedValue({ id: 'hist-1' });
      prismaMock.employeePenalty.delete.mockResolvedValue(penaltyRecord);

      const result = await service.remove('pen-1', 'admin-user');
      expect(prismaMock.deletedRecordHistory.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.employeePenalty.delete).toHaveBeenCalledTimes(1);
      expect(result.message).toContain('deleted');
    });
  });

  describe('restore', () => {
    it('throws NotFoundException when history record not found', async () => {
      prismaMock.deletedRecordHistory.findFirst.mockResolvedValue(null);
      await expect(service.restore('missing-hist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restores penalty from history', async () => {
      prismaMock.deletedRecordHistory.findFirst.mockResolvedValue({
        id: 'hist-1',
        payload: {
          id: 'pen-1',
          employeeId: 'EMP000001',
          category: 'absence',
          amount: '500',
          reason: 'test',
          issueDate: '2026-01-15T00:00:00.000Z',
        },
      });
      prismaMock.employeePenalty.create.mockResolvedValue(penaltyRecord);
      prismaMock.deletedRecordHistory.update.mockResolvedValue({});

      const result = await service.restore('hist-1', 'admin');
      expect(prismaMock.employeePenalty.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('pen-1');
    });
  });

  describe('list', () => {
    it('filters by period using issueDate range', async () => {
      prismaMock.employeePenalty.findMany.mockResolvedValue([penaltyRecord]);
      const result = await service.list({ period: '2026-01' } as never);
      expect(prismaMock.employeePenalty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ issueDate: expect.any(Object) }),
        }),
      );
      expect(result).toHaveLength(1);
    });
  });
});
