import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from '../../../src/employees/employees.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { ShortCacheService } from '../../../src/common/cache/short-cache.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { AuthenticatedUser } from '../../../src/common/types/authenticated-user.types';

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

  const notificationsMock = {
    create: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ShortCacheService, useValue: shortCacheMock },
        { provide: NotificationsService, useValue: notificationsMock },
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

  describe('salary leak policy (manage_salary gating)', () => {
    const row = {
      id: 'e1',
      employeeId: 'EMP001',
      name: 'n',
      baseSalary: 5000,
      hourlyRate: 25,
      livingAllowance: 200,
      transportAllowanceOverride: null,
      insuranceAmount: 100,
    };
    const regular: AuthenticatedUser = { userId: 'u1', username: 'a', tenantId: 't', permissions: ['view_employees'], roles: [] };
    const admin: AuthenticatedUser = { userId: 'u2', username: 'b', tenantId: 't', permissions: ['view_employees', 'manage_salary'], roles: [] };

    it('byDepartment(): strips pay and excludes photo without manage_salary', async () => {
      prismaMock.employee.findMany.mockResolvedValueOnce([{ ...row }]).mockResolvedValueOnce([]);
      prismaMock.employee.count.mockResolvedValue(1);

      const res = await service.byDepartment('Warehouse', { page: 1, limit: 10 } as any, regular);

      expect(res.data).toHaveLength(1);
      expect(res.data[0]).not.toHaveProperty('baseSalary');
      expect(res.data[0]).not.toHaveProperty('hourlyRate');
      expect(res.data[0]).not.toHaveProperty('livingAllowance');
      expect(res.data[0]).not.toHaveProperty('transportAllowanceOverride');
      expect(res.data[0]).not.toHaveProperty('insuranceAmount');
      expect(res.data[0]).not.toHaveProperty('photo');
      expect(res.data[0]).toHaveProperty('photoUrl');
    });

    it('byDepartment(): keeps pay for a manage_salary holder', async () => {
      prismaMock.employee.findMany.mockResolvedValueOnce([{ ...row }]).mockResolvedValueOnce([]);
      prismaMock.employee.count.mockResolvedValue(1);

      const res = await service.byDepartment('Warehouse', { page: 1, limit: 10 } as any, admin);

      expect(res.data[0].baseSalary).toBe(5000);
      expect(res.data[0]).not.toHaveProperty('photo'); // payload stays lean for everyone
    });

    it('getResignedEmployees(): strips pay and excludes photo without manage_salary', async () => {
      prismaMock.employee.findMany.mockResolvedValueOnce([{ ...row }]).mockResolvedValueOnce([]);
      prismaMock.employee.count.mockResolvedValue(1);
      prismaMock.employee.groupBy.mockResolvedValue([{ _count: { _all: 1 } }]);

      const res = await service.getResignedEmployees({ page: 1, limit: 10 } as any, regular);

      expect(res.data[0]).not.toHaveProperty('baseSalary');
      expect(res.data[0]).not.toHaveProperty('insuranceAmount');
      expect(res.data[0]).not.toHaveProperty('photo');
      expect(res.data[0]).toHaveProperty('photoUrl');
    });

    it('getByEmployeeId(): strips pay without manage_salary but keeps the single photo', async () => {
      (prismaMock.employee as any).findFirst = jest.fn().mockResolvedValue({ ...row, photo: 'data:image/png;base64,xxx' });

      const res = await service.getByEmployeeId('EMP001', regular);

      expect(res).not.toHaveProperty('baseSalary');
      expect(res).not.toHaveProperty('hourlyRate');
      expect(res.photo).toBe('data:image/png;base64,xxx'); // one avatar is fine for the detail page
    });

    it('getByEmployeeId(): allows the owner through the asSelf carve-out with no permissions', async () => {
      (prismaMock.employee as any).findFirst = jest.fn().mockResolvedValue({ ...row, photo: null });

      const res = await service.getByEmployeeId('EMP001', regular, { asSelf: true });

      expect(res.baseSalary).toBe(5000);
      expect(res.hourlyRate).toBe(25);
    });

    it('getByEmployeeId(): keeps pay for a manage_salary holder', async () => {
      (prismaMock.employee as any).findFirst = jest.fn().mockResolvedValue({ ...row, photo: null });

      const res = await service.getByEmployeeId('EMP001', admin);

      expect(res.baseSalary).toBe(5000);
    });

    it('getByEmployeeId(): strips pay when no caller context is available', async () => {
      (prismaMock.employee as any).findFirst = jest.fn().mockResolvedValue({ ...row, photo: null });

      const res = await service.getByEmployeeId('EMP001');

      expect(res).not.toHaveProperty('baseSalary');
    });
  });
});

