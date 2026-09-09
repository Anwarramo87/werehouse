import { HrTools } from '../../../../src/assistant/tools/hr.tools';
import { PrismaService } from '../../../../src/prisma/prisma.service';

/**
 * The assistant used to report present staff as absent.
 *
 * It had no tool that read the clock-in records: every attendance question was
 * answered from DailyAttendanceLog, the payroll ledger, whose ABSENCE rows are
 * posted by hand and are empty for the current day. Asked who was absent today
 * the model had nothing describing today and filled the gap itself.
 *
 * get_daily_attendance_status closes that gap, so these tests hold it to the
 * one property that matters: a person with an IN punch is never absent, and a
 * person on approved leave is never absent either.
 */

/** Factory time is UTC+3, so 05:00Z is 08:00 local. */
const at = (utc: string) => new Date(utc);

type EmployeeRow = {
  employeeId: string;
  name: string;
  department: string | null;
  scheduledStart: string | null;
};

type PunchRow = { employeeId: string; type: string; timestamp: Date };
type LeaveRow = { employeeId: string; leaveType: string };

function makePrisma(opts: {
  employees: EmployeeRow[];
  punches?: PunchRow[];
  leaves?: LeaveRow[];
}) {
  return {
    employee: {
      findMany: jest.fn().mockResolvedValue(opts.employees),
    },
    attendanceRecord: {
      findMany: jest.fn().mockResolvedValue(
        [...(opts.punches ?? [])].sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        ),
      ),
    },
    leaveRequest: {
      findMany: jest.fn().mockResolvedValue(opts.leaves ?? []),
    },
  } as unknown as PrismaService;
}

const employee = (
  employeeId: string,
  over: Partial<EmployeeRow> = {},
): EmployeeRow => ({
  employeeId,
  name: `Employee ${employeeId}`,
  department: 'Warehouse',
  scheduledStart: '08:00',
  ...over,
});

type StatusRow = {
  employeeId: string;
  status: 'present' | 'absent' | 'on_leave';
  checkIn: string | null;
  checkOut: string | null;
  minutesLate: number | null;
  leaveType: string | null;
};

type StatusResult = {
  date: string;
  counts: {
    total: number;
    present: number;
    absent: number;
    onLeave: number;
    late: number;
  };
  totalMatching: number;
  rowCount: number;
  truncated: boolean;
  rows: StatusRow[];
};

async function status(
  tools: HrTools,
  input: Record<string, unknown> = {},
): Promise<StatusResult> {
  const tool = tools
    .tools()
    .find((t) => t.name === 'get_daily_attendance_status')!;
  return (await tool.run(input, {
    user: { userId: 'u1' },
    tenantId: 't1',
  })) as never;
}

const rowFor = (result: StatusResult, employeeId: string) =>
  result.rows.find((r) => r.employeeId === employeeId)!;

describe('HrTools.get_daily_attendance_status', () => {
  it('is registered as a tool', () => {
    const tools = new HrTools(makePrisma({ employees: [] }));
    const names = tools.tools().map((t) => t.name);
    expect(names).toContain('get_daily_attendance_status');
  });

  it('reports someone with an IN punch as present, never absent', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001')],
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T05:00:00Z') }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(result.counts.present).toBe(1);
    expect(result.counts.absent).toBe(0);
    expect(rowFor(result, 'EMP001').status).toBe('present');
    expect(rowFor(result, 'EMP001').checkIn).toBe('08:00');
  });

  it('reports someone on approved leave as on_leave, not absent', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP002')],
      leaves: [{ employeeId: 'EMP002', leaveType: 'PAID_LEAVE' }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(result.counts.onLeave).toBe(1);
    expect(result.counts.absent).toBe(0);
    expect(rowFor(result, 'EMP002').status).toBe('on_leave');
    expect(rowFor(result, 'EMP002').leaveType).toBe('PAID_LEAVE');
  });

  it('reports only the genuinely missing as absent', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001'), employee('EMP002'), employee('EMP003')],
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T05:00:00Z') }],
      leaves: [{ employeeId: 'EMP002', leaveType: 'SICK_LEAVE' }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(result.counts).toMatchObject({
      total: 3,
      present: 1,
      onLeave: 1,
      absent: 1,
    });
    expect(rowFor(result, 'EMP003').status).toBe('absent');
  });

  it('measures lateness against the scheduled start in factory time', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001', { scheduledStart: '08:00' })],
      // 06:45Z is 09:45 factory time — 105 minutes past an 08:00 start.
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T06:45:00Z') }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(rowFor(result, 'EMP001').minutesLate).toBe(105);
    expect(result.counts.late).toBe(1);
  });

  it('does not report early arrival as negative lateness', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001', { scheduledStart: '08:00' })],
      // 04:30Z is 07:30 factory time — half an hour early.
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T04:30:00Z') }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(rowFor(result, 'EMP001').minutesLate).toBe(0);
    expect(result.counts.late).toBe(0);
  });

  it('takes the first IN and the last OUT of a multi-punch day', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001')],
      punches: [
        { employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T05:00:00Z') },
        { employeeId: 'EMP001', type: 'OUT', timestamp: at('2026-09-07T09:00:00Z') },
        { employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T10:00:00Z') },
        { employeeId: 'EMP001', type: 'OUT', timestamp: at('2026-09-07T14:00:00Z') },
      ],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(rowFor(result, 'EMP001').checkIn).toBe('08:00');
    expect(rowFor(result, 'EMP001').checkOut).toBe('17:00');
  });

  it('filters to one state on request', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001'), employee('EMP002')],
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T05:00:00Z') }],
    });

    const result = await status(new HrTools(prisma), {
      date: '2026-09-07',
      status: 'absent',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].employeeId).toBe('EMP002');
    // Counts still describe the whole factory, not the filtered slice.
    expect(result.counts.total).toBe(2);
    expect(result.counts.present).toBe(1);
  });

  it('reports the true match count when rows are capped', async () => {
    const employees = Array.from({ length: 40 }, (_, i) =>
      employee(`EMP${String(i + 1).padStart(3, '0')}`),
    );
    const prisma = makePrisma({ employees });

    const result = await status(new HrTools(prisma), {
      date: '2026-09-07',
      limit: 5,
    });

    expect(result.totalMatching).toBe(40);
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.counts.absent).toBe(40);
  });

  it('handles a factory with no active employees', async () => {
    const result = await status(new HrTools(makePrisma({ employees: [] })), {
      date: '2026-09-07',
    });

    expect(result.counts.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('leaves lateness unknown when no shift start is configured', async () => {
    const prisma = makePrisma({
      employees: [employee('EMP001', { scheduledStart: null })],
      punches: [{ employeeId: 'EMP001', type: 'IN', timestamp: at('2026-09-07T09:00:00Z') }],
    });

    const result = await status(new HrTools(prisma), { date: '2026-09-07' });

    expect(rowFor(result, 'EMP001').minutesLate).toBeNull();
    expect(result.counts.late).toBe(0);
  });
});
