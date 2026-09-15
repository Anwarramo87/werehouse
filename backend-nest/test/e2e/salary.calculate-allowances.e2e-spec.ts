import { SalaryService } from '../../src/salary/salary.service';

describe('SalaryService — calculateAllowances', () => {
  it('calculates difference and allowances exactly for provided scenario', () => {
    // Arrange: instantiate with a minimal mock PrismaService
    const mockPrisma: any = {};
    // SalaryService gained a ShortCacheService dependency; calculateAllowances is
    // pure and never reaches it, so a stub is enough to construct the service.
    const mockCache: any = { getOrSetJson: async (_k: string, _t: number, fn: () => unknown) => fn() };
    const svc = new SalaryService(mockPrisma, mockCache);

    const dto = {
      salary: 10_000_000,
      lumpSumSalary: 750_000,
      livingAllowance: 12_000,
    } as any;

    // Act
    const result = svc.calculateAllowances(dto as any);

    // Assert — values are strings with 4 decimal places per implementation.
    // Allowances are deliberately no longer auto-computed (see the comment in
    // SalaryService.calculateAllowances): all derived figures are 0 unless the
    // caller records them manually.
    expect(result.salary).toBe('10000000.0000');
    expect(result.lumpSumSalary).toBe('750000.0000');
    expect(result.livingAllowance).toBe('12000.0000');

    expect(result.difference).toBe('0.0000');
    expect(result.responsibilityAllowance).toBe('0.0000');
    expect(result.extraEffortAllowance).toBe('0.0000');
    expect(result.productionIncentives).toBe('0.0000');

    // verification
    expect(result.verification.sum).toBe('0.0000');
    expect(result.verification.isExact).toBe(true);
    expect(result.verification.ratiosSum).toBe('0.00');
    expect(result.verification.ratiosSumIs1).toBe(false);
  });
});
