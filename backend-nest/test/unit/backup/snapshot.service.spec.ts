import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { runWithTenant } from '../../../src/common/tenant/tenant-context';
import { SnapshotService } from '../../../src/backup/snapshot.service';
import { RestoreService } from '../../../src/backup/restore.service';
import { checksumOf } from '../../../src/backup/snapshot.codec';
import { RESTORE_ORDER } from '../../../src/backup/snapshot.model-graph';
import { SNAPSHOT_FORMAT_VERSION } from '../../../src/backup/snapshot.types';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('SnapshotService', () => {
  let service: SnapshotService;
  let prismaMock: Record<string, unknown>;

  const productRows = [
    {
      id: 'p1',
      tenantId: TENANT,
      sku: 'RAW-001',
      name: 'حديد',
      unitPrice: new Prisma.Decimal('12345.67'),
      costPrice: new Prisma.Decimal('10000.00'),
      photo: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  const employeeRows = [
    { id: 'e1', tenantId: TENANT, employeeId: 'EMP00003', name: 'علي', createdAt: new Date('2026-02-01T00:00:00.000Z') },
  ];

  const buildPrismaMock = () => {
    const mock: Record<string, unknown> = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ migration_name: '20260823190000_multi_tenancy' }]),
      tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Factory One' }) },
    };

    for (const model of RESTORE_ORDER) {
      mock[model] = { findMany: jest.fn().mockResolvedValue([]) };
    }
    (mock.product as { findMany: jest.Mock }).findMany.mockResolvedValue(productRows);
    (mock.employee as { findMany: jest.Mock }).findMany.mockResolvedValue(employeeRows);

    return mock;
  };

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithTenant({ tenantId: TENANT, bypass: false, actor: 'test' }, fn);

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SnapshotService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get(SnapshotService);
  });

  it('reads every model in the graph', async () => {
    await asTenant(() => service.createSnapshot());

    for (const model of RESTORE_ORDER) {
      expect((prismaMock[model] as { findMany: jest.Mock }).findMany).toHaveBeenCalled();
    }
  });

  it('covers the models the Excel export leaves out', async () => {
    const snapshot = await asTenant(() => service.createSnapshot());

    // The .xlsx backup carries 20 sheets and none of these. This is the gap the
    // snapshot format exists to close.
    for (const model of [
      'product',
      'stockLevel',
      'warehouse',
      'stockMovement',
      'supplier',
      'purchaseOrder',
      'goodsReceipt',
      'customer',
      'salesOrder',
      'salesPayment',
      'account',
      'journalEntry',
      'journalEntryLine',
      'notification',
    ]) {
      expect(snapshot.data).toHaveProperty(model);
    }
  });

  it('records the tenant, schema version and per-model counts', async () => {
    const snapshot = await asTenant(() => service.createSnapshot({ username: 'manager' }));

    expect(snapshot.manifest).toMatchObject({
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      tenantId: TENANT,
      tenantName: 'Factory One',
      schemaVersion: '20260823190000_multi_tenancy',
      createdBy: 'manager',
    });
    expect(snapshot.manifest.counts.product).toBe(1);
    expect(snapshot.manifest.counts.employee).toBe(1);
    expect(snapshot.manifest.counts.salesOrder).toBe(0);
  });

  it('writes a checksum that matches its own payload', async () => {
    const snapshot = await asTenant(() => service.createSnapshot());
    expect(snapshot.manifest.checksum).toBe(checksumOf(snapshot.data));
  });

  it('keeps Decimal money exact rather than converting to float', async () => {
    const snapshot = await asTenant(() => service.createSnapshot());
    expect(snapshot.data.product[0].unitPrice).toBe('12345.67');
  });

  it('survives a database with no _prisma_migrations table', async () => {
    (prismaMock.$queryRawUnsafe as jest.Mock).mockRejectedValue(new Error('relation does not exist'));

    const snapshot = await asTenant(() => service.createSnapshot());
    expect(snapshot.manifest.schemaVersion).toBeNull();
  });

  it('serialises to a JSON buffer that parses back identically', async () => {
    const buffer = await asTenant(() => service.createSnapshotBuffer());
    const parsed = JSON.parse(buffer.toString('utf8'));

    expect(parsed.manifest.checksum).toBe(checksumOf(parsed.data));
    expect(parsed.data.product[0].name).toBe('حديد');
  });

  describe('round trip through RestoreService', () => {
    /**
     * The point of this whole step: a snapshot this service produces must be
     * accepted and applied by the restore path. A backup nobody has restored is
     * not a backup.
     */
    it('exports, survives serialisation, and restores every row', async () => {
      const buffer = await asTenant(() => service.createSnapshotBuffer({ username: 'manager' }));
      const onTheWire = JSON.parse(buffer.toString('utf8'));

      const tx: Record<string, Record<string, jest.Mock>> = {};
      for (const model of RESTORE_ORDER) {
        tx[model] = {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockImplementation(({ data }) => ({ count: data.length })),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        };
      }

      const restorePrisma = {
        $queryRawUnsafe: jest
          .fn()
          .mockResolvedValue([{ migration_name: '20260823190000_multi_tenancy' }]),
        $transaction: jest.fn().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(tx)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [RestoreService, { provide: PrismaService, useValue: restorePrisma }],
      }).compile();
      const restore = module.get(RestoreService);

      const report = await asTenant(() =>
        restore.restore(
          onTheWire,
          { mode: 'apply', strategy: 'merge' },
          { userId: 'u1', username: 'manager', role: 'admin', roles: ['admin'], tenantId: TENANT },
        ),
      );

      expect(report.valid).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.totals.created).toBe(2); // one product, one employee
      expect(report.totals.deleted).toBe(0);

      // The values that arrived are the values that left.
      expect(tx.product.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ id: 'p1', unitPrice: '12345.67', name: 'حديد' })],
        }),
      );
      expect(tx.employee.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ employeeId: 'EMP00003', name: 'علي' })],
        }),
      );
    });

    it('detects a byte of corruption introduced in transit', async () => {
      const buffer = await asTenant(() => service.createSnapshotBuffer());
      const tampered = JSON.parse(buffer.toString('utf8'));
      tampered.data.product[0].unitPrice = '1.00';

      const restorePrisma = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [RestoreService, { provide: PrismaService, useValue: restorePrisma }],
      }).compile();
      const restore = module.get(RestoreService);

      const report = await asTenant(() =>
        restore.restore(
          tampered,
          { mode: 'apply', strategy: 'merge' },
          { userId: 'u1', role: 'admin', roles: ['admin'], tenantId: TENANT },
        ),
      );

      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/Checksum mismatch/);
      expect(restorePrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
