import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InsuranceService } from './insurance.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

const insuranceRecord = {
  id: 'ins-1',
  employeeId: 'EMP000001',
  insuranceSalary: new Prisma.Decimal(3000),
  socialSecurityNumber: 'SSN-123',
  registrationDate: new Date('2025-01-01'),
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

describe('InsuranceService', () => {
  let service: InsuranceService;

  const prismaMock = {
    employeeInsurance: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    employee: { count: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsuranceService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get(InsuranceService);
  });

  describe('status', () => {
    it('returns correct coverage rate when all employees are insured', async () => {
      prismaMock.employeeInsurance.findMany.mockResolvedValue([insuranceRecord]);
      prismaMock.employee.count.mockResolvedValue(1);

      const result = await service.status();
      expect(result.coverageRate).toBe(100);
      expect(result.insuredEmployees).toBe(1);
      expect(result.uninsuredEmployees).toBe(0);
    });

    it('returns 0 coverage rate when no employees exist', async () => {
      prismaMock.employeeInsurance.findMany.mockResolvedValue([]);
      prismaMock.employee.count.mockResolvedValue(0);

      const result = await service.status();
      expect(result.coverageRate).toBe(0);
    });

    it('calculates partial coverage correctly', async () => {
      prismaMock.employeeInsurance.findMany.mockResolvedValue([insuranceRecord]);
      prismaMock.employee.count.mockResolvedValue(4);

      const result = await service.status();
      expect(result.coverageRate).toBe(25);
      expect(result.uninsuredEmployees).toBe(3);
    });
  });

  describe('getByEmployee', () => {
    it('throws NotFoundException when no record exists', async () => {
      prismaMock.employeeInsurance.findUnique.mockResolvedValue(null);
      await expect(service.getByEmployee('UNKNOWN')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the insurance record when found', async () => {
      prismaMock.employeeInsurance.findUnique.mockResolvedValue(insuranceRecord);
      const result = await service.getByEmployee('EMP000001');
      expect(result.employeeId).toBe('EMP000001');
    });
  });

  describe('upsert', () => {
    it('calls prisma upsert with correct Decimal salary', async () => {
      prismaMock.employeeInsurance.upsert.mockResolvedValue(insuranceRecord);

      await service.upsert('EMP000001', {
        insuranceSalary: 3000,
        socialSecurityNumber: 'SSN-123',
        registrationDate: '2025-01-01',
      });

      expect(prismaMock.employeeInsurance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'EMP000001' },
          create: expect.objectContaining({ employeeId: 'EMP000001' }),
          update: expect.objectContaining({
            insuranceSalary: expect.any(Prisma.Decimal),
          }),
        }),
      );
    });

    it('handles null optional fields', async () => {
      prismaMock.employeeInsurance.upsert.mockResolvedValue(insuranceRecord);
      await expect(
        service.upsert('EMP000001', { insuranceSalary: 2000 }),
      ).resolves.toBeDefined();
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when record does not exist', async () => {
      prismaMock.employeeInsurance.findUnique.mockResolvedValue(null);
      await expect(service.remove('UNKNOWN')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes the record and returns success message', async () => {
      prismaMock.employeeInsurance.findUnique.mockResolvedValue(insuranceRecord);
      prismaMock.employeeInsurance.delete.mockResolvedValue(insuranceRecord);

      const result = await service.remove('EMP000001');
      expect(prismaMock.employeeInsurance.delete).toHaveBeenCalledWith({
        where: { employeeId: 'EMP000001' },
      });
      expect(result.message).toContain('deleted');
    });
  });
});
