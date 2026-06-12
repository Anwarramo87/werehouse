import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShortCacheService } from '../common/cache/short-cache.service';

describe('EmployeesService', () => {
  let service: EmployeesService;
  const prismaMock: Record<string, any> = {

    employee: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    department: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(prismaMock)),
  };


  const shortCacheMock = {
    getOrSetJson: jest.fn(),
    invalidatePrefix: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
      ],
    }).compile();

    service = module.get(EmployeesService);
  });

  describe('status filtering policy', () => {
    it('list(): when query.status is not provided, should exclude terminated/resigned by default', async () => {
      prismaMock.employee.findMany.mockResolvedValue([]);
      prismaMock.employee.count.mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, skip: 0 } as any);

      const wherePassed = prismaMock.employee.findMany.mock.calls[0][0].where;
      expect(wherePassed).toMatchObject({
        status: { notIn: ['terminated', 'resigned'] },
      });
    });

    it('list(): when query.status is provided, should use it directly', async () => {
      prismaMock.employee.findMany.mockResolvedValue([]);
      prismaMock.employee.count.mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, skip: 0, status: 'inactive' } as any);

      const wherePassed = prismaMock.employee.findMany.mock.calls[0][0].where;
      expect(wherePassed.status).toBe('inactive');
    });

    it('byDepartment(): should NOT hardcode status=active (should follow unified policy)', async () => {
      prismaMock.employee.findMany.mockResolvedValue([]);
      prismaMock.employee.count.mockResolvedValue(0);

      await service.byDepartment('MyDept', { page: 1, limit: 10 } as any);

      const wherePassed = prismaMock.employee.findMany.mock.calls[0][0].where;
      expect(wherePassed.status).toMatchObject({ notIn: ['terminated', 'resigned'] });
    });
  });

  describe('input validation', () => {
    it('should throw if employment start date later than termination date (smoke test)', async () => {
      await expect(
        service.create({
          employeeId: 'E1',
          username: 'e1',
          name: 'n',
          hourlyRate: 100,
          employmentStartDate: '2026-02-10',
          terminationDate: '2026-01-01',
          department: 'Warehouse',
          workDaysInPeriod: 26,
          hoursPerDay: 8,
          profession: 'p',
          roleId: null,
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

