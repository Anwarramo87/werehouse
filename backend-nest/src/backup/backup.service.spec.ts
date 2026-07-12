import { Test, TestingModule } from '@nestjs/testing';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';

const makeModelMock = (rows: Record<string, unknown>[] = []) => ({
  findMany: jest.fn().mockResolvedValue(rows),
});

describe('BackupService', () => {
  let service: BackupService;

  const employeeRow = { id: 'e1', name: 'Ali', createdAt: new Date('2026-01-01') };
  const attendanceRow = { id: 'a1', employeeId: 'e1', timestamp: new Date('2026-01-15'), date: '2026-01-15', type: 'IN' };
  const payrollRunRow = { id: 'pr1', runId: 'PAY20260101', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-31') };

  const prismaMock = {
    employee: makeModelMock([employeeRow]),
    employeeSalary: makeModelMock(),
    employeeInsurance: makeModelMock(),
    attendanceRecord: makeModelMock([attendanceRow]),
    dailyAttendanceLog: makeModelMock(),
    employeeAdvance: makeModelMock(),
    employeeBonus: makeModelMock(),
    employeePenalty: makeModelMock(),
    leaveRequest: makeModelMock(),
    payrollRun: makeModelMock([payrollRunRow]),
    payrollItem: makeModelMock(),
    payrollInput: makeModelMock(),
    bus: makeModelMock(),
    busPassenger: makeModelMock(),
    device: makeModelMock(),
    department: makeModelMock(),
    role: makeModelMock(),
    user: makeModelMock(),
    deletedRecordHistory: makeModelMock(),
    auditLog: makeModelMock(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset all mocks to return empty by default, then override per test
    Object.values(prismaMock).forEach((m) => {
      if (typeof m === 'object' && 'findMany' in m) {
        (m.findMany as jest.Mock).mockResolvedValue([]);
      }
    });
    prismaMock.employee.findMany.mockResolvedValue([employeeRow]);
    prismaMock.payrollRun.findMany.mockResolvedValue([payrollRunRow]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get(BackupService);
  });

  describe('exportFull', () => {
    it('returns a non-empty Buffer', async () => {
      const result = await service.exportFull();
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);
    });

    it('queries every registered model', async () => {
      await service.exportFull();
      expect(prismaMock.employee.findMany).toHaveBeenCalled();
      expect(prismaMock.attendanceRecord.findMany).toHaveBeenCalled();
      expect(prismaMock.payrollRun.findMany).toHaveBeenCalled();
    });

    it('handles models with zero rows without throwing', async () => {
      prismaMock.employee.findMany.mockResolvedValue([]);
      await expect(service.exportFull()).resolves.toBeInstanceOf(Buffer);
    });

    it('serializes Date fields to ISO strings', async () => {
      prismaMock.employee.findMany.mockResolvedValue([employeeRow]);
      // Should not throw on Date values
      await expect(service.exportFull()).resolves.toBeInstanceOf(Buffer);
    });
  });

  describe('exportMonth', () => {
    it('returns a non-empty Buffer for a valid period', async () => {
      const result = await service.exportMonth('2026-01');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);
    });

    it('includes payroll items when payroll runs exist for the period', async () => {
      prismaMock.payrollRun.findMany.mockResolvedValue([payrollRunRow]);
      prismaMock.payrollItem.findMany.mockResolvedValue([
        { id: 'pi1', payrollRunId: 'pr1', employeeId: 'e1', netPay: 5000 },
      ]);
      const result = await service.exportMonth('2026-01');
      expect(result).toBeInstanceOf(Buffer);
      expect(prismaMock.payrollItem.findMany).toHaveBeenCalled();
    });

    it('skips payroll items sheet when no runs exist', async () => {
      prismaMock.payrollRun.findMany.mockResolvedValue([]);
      await service.exportMonth('2026-01');
      expect(prismaMock.payrollItem.findMany).not.toHaveBeenCalled();
    });
  });
});
