import { HrTools } from '../../../../src/assistant/tools/hr.tools';
import { PrismaService } from '../../../../src/prisma/prisma.service';

/**
 * The absence and leave arithmetic is the part of the assistant a silent bug
 * would hurt most: a wrong day count reads like a real answer. These tests pin
 * the aggregation against a stubbed daily attendance log, so the maths is
 * checked without a database.
 */

type GroupedRow = {
  employeeId: string;
  recordType: string;
  _sum: { value: number };
};

type EmployeeRow = {
  employeeId: string;
  name: string;
  department: string;
  jobTitle: string | null;
  status: string;
  baseSalary: number | null;
  currency: string;
  employmentStartDate: Date | null;
  employeeSalary: { baseSalary: number } | null;
};

function makePrisma(grouped: GroupedRow[], employees: EmployeeRow[]) {
  const calls: { employeeWhere?: unknown } = {};
  const prisma = {
    dailyAttendanceLog: {
      groupBy: jest.fn().mockResolvedValue(grouped),
    },
    employee: {
      count: jest.fn().mockImplementation((args: { where: unknown }) => {
        const where = args.where as {
          employeeId?: { in?: string[]; notIn?: string[] };
        };
        let rows = employees;
        if (where.employeeId?.in) {
          rows = rows.filter((e) => where.employeeId!.in!.includes(e.employeeId));
        }
        if (where.employeeId?.notIn) {
          rows = rows.filter(
            (e) => !where.employeeId!.notIn!.includes(e.employeeId),
          );
        }
        return Promise.resolve(rows.length);
      }),
      findMany: jest.fn().mockImplementation((args: { where: unknown }) => {
        calls.employeeWhere = args.where;
        const where = args.where as {
          employeeId?: { in?: string[]; notIn?: string[] };
        };
        let rows = employees;
        if (where.employeeId?.in) {
          rows = rows.filter((e) => where.employeeId!.in!.includes(e.employeeId));
        }
        if (where.employeeId?.notIn) {
          rows = rows.filter(
            (e) => !where.employeeId!.notIn!.includes(e.employeeId),
          );
        }
        return Promise.resolve(rows);
      }),
    },
  } as unknown as PrismaService;

  return { prisma, calls };
}

const employee = (employeeId: string, over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  employeeId,
  name: `Employee ${employeeId}`,
  department: 'Warehouse',
  jobTitle: 'Operator',
  status: 'active',
  baseSalary: 1_000_000,
  currency: 'SYP',
  employmentStartDate: new Date('2024-01-01'),
  employeeSalary: null,
  ...over,
});

async function search(
  tools: HrTools,
  input: Record<string, unknown>,
): Promise<{
  period: { from: string; to: string; applied: boolean };
  totalMatching: number;
  truncated: boolean;
  rowCount: number;
  rows: Array<{ employeeId: string; absentDays?: number; leaveDays?: number; salary: number }>;
}> {
  const tool = tools.tools().find((t) => t.name === 'search_employees')!;
  return (await tool.run(input, {
    user: { userId: 'u1' },
    tenantId: 't1',
  })) as never;
}

describe('HrTools.search_employees', () => {
  it('sums ABSENCE rows and filters on the minimum', async () => {
    const { prisma } = makePrisma(
      [
        { employeeId: 'EMP001', recordType: 'ABSENCE', _sum: { value: 12 } },
        { employeeId: 'EMP002', recordType: 'ABSENCE', _sum: { value: 3 } },
      ],
      [employee('EMP001'), employee('EMP002')],
    );

    const result = await search(new HrTools(prisma), { absentDaysMin: 10 });

    expect(result.rows.map((r) => r.employeeId)).toEqual(['EMP001']);
    expect(result.rows[0].absentDays).toBe(12);
  });

  it('counts every kind of leave together, and keeps it separate from absence', async () => {
    const { prisma } = makePrisma(
      [
        { employeeId: 'EMP001', recordType: 'PAID_LEAVE', _sum: { value: 8 } },
        { employeeId: 'EMP001', recordType: 'SICK_LEAVE', _sum: { value: 9 } },
        { employeeId: 'EMP001', recordType: 'UNPAID_LEAVE', _sum: { value: 4 } },
        { employeeId: 'EMP001', recordType: 'ABSENCE', _sum: { value: 2 } },
      ],
      [employee('EMP001')],
    );

    const result = await search(new HrTools(prisma), { leaveDaysMin: 20 });

    expect(result.rows[0].leaveDays).toBe(21);
    expect(result.rows[0].absentDays).toBe(2);
  });

  it('applies a maximum-only filter without dropping employees who have no log rows', async () => {
    // EMP001 has 9 absences and must be excluded by "at most 5".
    // EMP002 has no rows at all, so it has zero absences and must be kept --
    // narrowing to the ids groupBy returned would wrongly drop it.
    const { prisma } = makePrisma(
      [{ employeeId: 'EMP001', recordType: 'ABSENCE', _sum: { value: 9 } }],
      [employee('EMP001'), employee('EMP002')],
    );

    const result = await search(new HrTools(prisma), { absentDaysMax: 5 });

    const ids = result.rows.map((r) => r.employeeId);
    expect(ids).toContain('EMP002');
    expect(ids).not.toContain('EMP001');
    expect(result.rows.find((r) => r.employeeId === 'EMP002')?.absentDays).toBe(0);
  });

  it('reports the true match count, not the size of the capped page', async () => {
    // The bug this pins: a page capped at `limit` was reported as the total,
    // so "how many active employees" answered 50 when the real answer was 74.
    const many = Array.from({ length: 74 }, (_, i) =>
      employee(`EMP${String(i).padStart(3, '0')}`),
    );
    const { prisma } = makePrisma([], many);

    const result = await search(new HrTools(prisma), { status: 'active', limit: 5 });

    expect(result.totalMatching).toBe(74);
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('marks a result as not truncated when everything fits', async () => {
    const { prisma } = makePrisma([], [employee('EMP001'), employee('EMP002')]);

    const result = await search(new HrTools(prisma), { limit: 50 });

    expect(result.totalMatching).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('defaults the period to the last 30 days and reports which it used', async () => {
    const { prisma } = makePrisma([], [employee('EMP001')]);

    const result = await search(new HrTools(prisma), { absentDaysMin: 1 });

    const from = new Date(result.period.from);
    const to = new Date(result.period.to);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    expect(days).toBe(30);
    expect(result.period.applied).toBe(true);
  });

  it('does not compute day counts when no filter needs them', async () => {
    const { prisma } = makePrisma([], [employee('EMP001')]);
    const hr = new HrTools(prisma);

    const result = await search(hr, { department: 'Warehouse' });

    expect(prisma.dailyAttendanceLog.groupBy).not.toHaveBeenCalled();
    expect(result.period.applied).toBe(false);
    expect(result.rows[0].absentDays).toBeUndefined();
  });

  it('prefers the EmployeeSalary record over the fallback on Employee', async () => {
    const { prisma } = makePrisma(
      [],
      [employee('EMP001', { employeeSalary: { baseSalary: 2_500_000 } })],
    );

    const result = await search(new HrTools(prisma), {});

    expect(result.rows[0].salary).toBe(2_500_000);
  });

  it('sorts by absence descending when asked', async () => {
    const { prisma } = makePrisma(
      [
        { employeeId: 'EMP001', recordType: 'ABSENCE', _sum: { value: 4 } },
        { employeeId: 'EMP002', recordType: 'ABSENCE', _sum: { value: 11 } },
      ],
      [employee('EMP001'), employee('EMP002')],
    );

    const result = await search(new HrTools(prisma), { sortBy: 'absentDays' });

    expect(result.rows.map((r) => r.employeeId)).toEqual(['EMP002', 'EMP001']);
  });
});
