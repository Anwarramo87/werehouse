import { SalaryService } from '../src/salary/salary.service';

describe('SalaryService — calculateAllowances', () => {
  it('calculates difference and allowances exactly for provided scenario', () => {
    // Arrange: instantiate with a minimal mock PrismaService
    const mockPrisma: any = {};
    const svc = new SalaryService(mockPrisma);

    const dto = {
      salary: 10_000_000,
      lumpSumSalary: 750_000,
      livingAllowance: 12_000,
    } as any;

    // Act
    const result = svc.calculateAllowances(dto as any);

    // Assert — values are strings with 4 decimal places per implementation
    expect(result.salary).toBe('10000000.0000');
    expect(result.lumpSumSalary).toBe('750000.0000');
    expect(result.livingAllowance).toBe('12000.0000');

    expect(result.difference).toBe('9238000.0000');
    expect(result.responsibilityAllowance).toBe('4619000.0000');
    expect(result.extraEffortAllowance).toBe('2771400.0000');
    expect(result.productionIncentives).toBe('1847600.0000');

    // verification
    expect(result.verification.sum).toBe('9238000.0000');
    expect(result.verification.isExact).toBe(true);
    expect(result.verification.ratiosSum).toBe('1.00');
    expect(result.verification.ratiosSumIs1).toBe(true);
  });
});
