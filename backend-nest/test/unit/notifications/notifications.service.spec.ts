import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { RealtimeGateway } from '../../../src/realtime/realtime.gateway';
import { runWithTenant } from '../../../src/common/tenant/tenant-context';

/**
 * The absence sweep is the whole notification system as far as the office is
 * concerned: nothing else creates the alert the bell exists to show. It had
 * three faults that each silenced it or made it lie, so each one is pinned
 * here.
 *
 * 1. It ran as a @Cron with no tenant scope, so every Prisma call threw and
 *    the catch swallowed it. No notification was ever created.
 * 2. It mixed server-local hours with factory-local date keys, so on a UTC
 *    host the working window and the lateness figure were both hours out.
 * 3. It knew nothing about approved leave, so staff on booked leave were
 *    reported as failing to turn up.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

/** 09:30 factory time (UTC+3) on Monday 2026-09-07. */
const MONDAY_0930 = new Date('2026-09-07T06:30:00.000Z');

type EmployeeRow = {
  employeeId: string;
  name: string;
  scheduledStart: string | null;
};

function makePrisma(opts: {
  employees: EmployeeRow[];
  checkedIn?: string[];
  onLeave?: string[];
  existing?: Record<string, { id: string; isDismissed: boolean }>;
}) {
  const upserts: Array<Record<string, unknown>> = [];

  const prisma = {
    tenant: {
      findMany: jest.fn().mockResolvedValue([{ id: TENANT, name: 'Factory One' }]),
    },
    employee: {
      findMany: jest.fn().mockResolvedValue(opts.employees),
    },
    attendanceRecord: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.checkedIn ?? []).map((employeeId) => ({ employeeId }))),
    },
    leaveRequest: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.onLeave ?? []).map((employeeId) => ({ employeeId }))),
    },
    notification: {
      findFirst: jest.fn().mockImplementation((args: { where: { dedupeKey: string } }) =>
        Promise.resolve(opts.existing?.[args.where.dedupeKey] ?? null),
      ),
      upsert: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        upserts.push(args);
        const create = args.create as Record<string, unknown>;
        return Promise.resolve({
          id: `notif-${upserts.length}`,
          ...create,
          entityId: null,
          updatedAt: new Date('2026-09-07T06:30:00.000Z'),
        });
      }),
    },
  } as unknown as PrismaService;

  return { prisma, upserts };
}

function makeGateway() {
  const emitted: Array<Record<string, unknown>> = [];
  const gateway = {
    emitNotification: jest.fn((payload: Record<string, unknown>) => {
      emitted.push(payload);
    }),
  } as unknown as RealtimeGateway;
  return { gateway, emitted };
}

/** The sweep as the cron calls it: inside a tenant scope. */
function scanIn(service: NotificationsService, now = MONDAY_0930) {
  return runWithTenant({ tenantId: TENANT, bypass: false }, () =>
    service.scanTenantAbsences(now),
  );
}

describe('NotificationsService — absence sweep', () => {
  it('flags an active employee who has not clocked in', async () => {
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway, emitted } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const result = await scanIn(service);

    expect(result.skipped).toBeNull();
    expect(result.flagged).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(upserts[0].where).toEqual({ dedupeKey: 'ABSENT:EMP001:2026-09-07' });
  });

  it('does not flag someone who has already clocked in', async () => {
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
      checkedIn: ['EMP001'],
    });
    const { gateway, emitted } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const result = await scanIn(service);

    expect(result.flagged).toBe(0);
    expect(result.present).toBe(1);
    expect(upserts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('does not flag someone on approved leave', async () => {
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP002', name: 'سارة', scheduledStart: '08:00' }],
      onLeave: ['EMP002'],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const result = await scanIn(service);

    expect(result.flagged).toBe(0);
    expect(result.onLeave).toBe(1);
    expect(upserts).toHaveLength(0);
  });

  it('respects the grace period rather than flagging the newly late', async () => {
    // Shift starts 09:15, it is 09:30 — fifteen minutes, inside the 30 default.
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP003', name: 'خالد', scheduledStart: '09:15' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const result = await scanIn(service);

    expect(result.flagged).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it('counts lateness from the factory clock, not the server clock', async () => {
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    await scanIn(service);

    // 09:30 factory time against an 08:00 start is 90 minutes, whatever
    // timezone the host running this test happens to be in.
    const create = upserts[0].create as { metadata: { lateMinutes: number } };
    expect(create.metadata.lateMinutes).toBe(90);
  });

  it('leaves a dismissed alert dismissed', async () => {
    const { prisma, upserts } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
      existing: {
        'ABSENT:EMP001:2026-09-07': { id: 'notif-old', isDismissed: true },
      },
    });
    const { gateway, emitted } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const result = await scanIn(service);

    expect(result.flagged).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('skips the weekly rest day', async () => {
    const { prisma } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    // Friday 2026-09-11, 09:30 factory time.
    const result = await scanIn(service, new Date('2026-09-11T06:30:00.000Z'));

    expect(result.skipped).toBe('weekend');
  });

  it('does not run before the scan window opens', async () => {
    const { prisma } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    // 04:00 factory time.
    const result = await scanIn(service, new Date('2026-09-07T01:00:00.000Z'));

    expect(result.skipped).toBe('outside scan window');
  });

  it('does not run after the working day ends', async () => {
    const { prisma } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    // 19:00 factory time.
    const result = await scanIn(service, new Date('2026-09-07T16:00:00.000Z'));

    expect(result.skipped).toBe('outside scan window');
  });

  it('establishes a tenant scope for each factory before touching Prisma', async () => {
    // The regression that silenced the whole system: the cron reached Prisma
    // with no scope, requireScope() threw, and the catch hid it.
    const { prisma } = makePrisma({
      employees: [{ employeeId: 'EMP001', name: 'أحمد', scheduledStart: '08:00' }],
    });
    const { gateway } = makeGateway();
    const service = new NotificationsService(prisma, gateway);

    const scanSpy = jest
      .spyOn(service, 'scanTenantAbsences')
      .mockImplementation(async () => {
        // Throws unless a scope is active — which is the whole point.
        const { currentTenant } = await import('../../../src/common/tenant/tenant-context');
        expect(currentTenant()?.tenantId).toBe(TENANT);
        return { scanned: 0, flagged: 0, onLeave: 0, present: 0, skipped: null };
      });

    await service.scanAbsentEmployees();

    expect(scanSpy).toHaveBeenCalledTimes(1);
  });
});
