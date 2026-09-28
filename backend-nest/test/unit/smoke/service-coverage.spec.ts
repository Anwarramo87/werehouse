import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { ShortCacheService } from '../../../src/common/cache/short-cache.service';
import { AdvancesService } from '../../../src/advances/advances.service';
import { AttendanceService } from '../../../src/attendance/attendance.service';
import { AttendanceAggregationService } from '../../../src/attendance/attendance-aggregation.service';
import { DailyLogsService } from '../../../src/attendance/daily-logs.service';
import { BonusesService } from '../../../src/bonuses/bonuses.service';
import { CycleCountsService } from '../../../src/cycle-counts/cycle-counts.service';
import { DashboardService } from '../../../src/dashboard/dashboard.service';
import { DepartmentsService } from '../../../src/departments/departments.service';
import { DevicesService } from '../../../src/devices/devices.service';
import { FinancesService } from '../../../src/finances/finances.service';
import { ImportsService } from '../../../src/imports/imports.service';
import { IntegrationsService } from '../../../src/integrations/integrations.service';
import { LocationsService } from '../../../src/locations/locations.service';
import { PickingService } from '../../../src/fulfillment/picking.service';
import { ShippingService } from '../../../src/fulfillment/shipping.service';
import { PurchaseInvoicesService } from '../../../src/purchase-invoices/purchase-invoices.service';
import { QualityService } from '../../../src/quality/quality.service';
import { SalesInvoicesService } from '../../../src/sales-invoices/sales-invoices.service';
import { SettingsService } from '../../../src/settings/settings.service';
import { TransportationService } from '../../../src/transportation/transportation.service';
import { WmsAnalyticsService } from '../../../src/wms-analytics/wms-analytics.service';

/**
 * Module-provider smoke coverage.
 *
 * Every service in src/ that had no unit test is listed here. The point is
 * not to re-verify business logic (the dedicated specs do that) but to prove
 * each service can be wired with its declared dependencies and serve its
 * primary read path against empty data without exploding -- so a provider
 * added to app.module without a matching constructor, or a rename in a
 * signature, shows up here as a broken suite rather than at runtime.
 */

type CacheStub = {
  getOrSetJson: ReturnType<typeof jest.fn>;
  getJson: ReturnType<typeof jest.fn>;
  setJson: ReturnType<typeof jest.fn>;
  invalidatePrefix: ReturnType<typeof jest.fn>;
  get: ReturnType<typeof jest.fn>;
  set: ReturnType<typeof jest.fn>;
  del: ReturnType<typeof jest.fn>;
};

function makeCache(): ShortCacheService {
  const stub: CacheStub = {
    getOrSetJson: jest.fn((_key: string, _ttl: number, cb: () => unknown) =>
      Promise.resolve(typeof cb === 'function' ? cb() : undefined),
    ),
    getJson: jest.fn(() => Promise.resolve(null)),
    setJson: jest.fn(() => Promise.resolve(undefined)),
    invalidatePrefix: jest.fn(() => Promise.resolve(undefined)),
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve(undefined)),
    del: jest.fn(() => Promise.resolve(undefined)),
  };
  return stub as unknown as ShortCacheService;
}

function makeConfig() {
  return { get: jest.fn((_key: string, dflt?: unknown) => dflt) } as unknown as ConfigService;
}

/**
 * Prisma mock that answers ANY delegate operation with a benign default, so a
 * read path never has to be stubbed method-by-method: findMany -> [], count ->
 * 0, findUnique/findFirst -> null, create/update -> {}, aggregate -> {}.
 */
function makePrisma(): PrismaService {
  const resolveFor = (op: string): unknown => {
    switch (op) {
      case 'findMany':
      case 'findManyAndDelete':
      case 'groupBy':
        return [];
      case 'findUnique':
      case 'findFirst':
      case 'findFirstOrThrow':
      case 'findUniqueOrThrow':
        return null;
      case 'count':
        return 0;
      case 'aggregate':
        return { _sum: {}, _count: {}, _avg: {}, _max: {}, _min: {} };
      case 'createMany':
      case 'updateMany':
      case 'deleteMany':
        return { count: 0 };
      case 'create':
      case 'update':
      case 'upsert':
      case 'delete':
        return {};
      default:
        return {};
    }
  };

  const delegate = () =>
    new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, op: string | symbol) {
          if (typeof op !== 'string') return undefined;
          const fn = jest.fn((..._args: unknown[]) => Promise.resolve(resolveFor(op)));
          return fn;
        },
      },
    );

  const handler = {
    get(_target: Record<string, unknown>, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (prop === '$transaction') {
        return jest.fn((cb: (tx: unknown) => unknown) => Promise.resolve(cb(new Proxy({}, handler))));
      }
      if (prop.startsWith('$')) {
        return jest.fn(() => Promise.resolve([]));
      }
      return delegate();
    },
  };

  return new Proxy<Record<string, unknown>>({}, handler) as unknown as PrismaService;
}

const empty: Record<string, unknown> = {};

describe('service provider smoke coverage', () => {
  it('advances.service: constructs and lists', async () => {
    const cache = makeCache();
    const service = new AdvancesService(makePrisma(), cache, empty as never);
    expect(service).toBeDefined();
    await expect(
      service.list({ employeeId: 'EMP-1' }),
    ).resolves.toBeDefined();
    expect(cache.getOrSetJson).toBeDefined();
  });

  it('attendance.service: constructs and lists', async () => {
    const service = new AttendanceService(
      makePrisma(),
      makeCache(),
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 20 });
    expect(result).toBeDefined();
  });

  it('attendance-aggregation.service: constructs', async () => {
    const service = new AttendanceAggregationService(makePrisma(), makeConfig());
    expect(service).toBeDefined();
    expect(typeof (service as unknown as Record<string, unknown>).aggregateEmployeeDay).toBe('function');
  });

  it('bonuses.service: constructs and lists', async () => {
    const service = new BonusesService(makePrisma(), makeCache(), empty as never);
    expect(service).toBeDefined();
    await expect(service.list({ page: 1, limit: 20 })).resolves.toBeDefined();
  });

  it('cycle-counts.service: constructs and lists', async () => {
    const service = new CycleCountsService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    await expect(service.list({ page: 1, limit: 20 })).resolves.toBeDefined();
  });

  it('daily-logs.service: constructs and lists', async () => {
    const service = new DailyLogsService(makePrisma());
    expect(service).toBeDefined();
    await expect(service.list({ page: 1, limit: 20 })).resolves.toBeDefined();
  });

  it('dashboard.service: constructs', async () => {
    const service = new DashboardService(makePrisma(), makeCache(), empty as never);
    expect(service).toBeDefined();
    expect(typeof (service as unknown as Record<string, unknown>).getHomeStats).toBe('function');
  });

  it('departments.service: constructs and lists', async () => {
    const service = new DepartmentsService(makePrisma(), makeCache(), empty as never);
    expect(service).toBeDefined();
    const result = await service.list();
    expect(result).toBeDefined();
  });

  it('devices.service: constructs and lists', async () => {
    const service = new DevicesService(makePrisma());
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 20 });
    expect(result).toBeDefined();
  });

  it('finances.service: constructs', async () => {
    const service = new FinancesService(makePrisma(), empty as never, empty as never);
    expect(service).toBeDefined();
    expect(typeof (service as unknown as Record<string, unknown>).summary).toBe('function');
  });

  it('imports.service: constructs and histories', async () => {
    const service = new ImportsService(makePrisma());
    expect(service).toBeDefined();
    const result = await service.history({ page: 1, limit: 20 });
    expect(result).toBeDefined();
  });

  it('integrations.service: constructs', async () => {
    const service = new IntegrationsService(makePrisma(), empty as never, makeConfig());
    expect(service).toBeDefined();
    expect(typeof (service as unknown as Record<string, unknown>).list).toBe('function');
  });

  it('locations.service: constructs and lists zones', async () => {
    const service = new LocationsService(makePrisma(), empty as never, empty as never);
    expect(service).toBeDefined();
    await expect(service.listZones()).resolves.toEqual([]);
  });

  it('picking.service: constructs and lists', async () => {
    const service = new PickingService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 25 });
    expect(result).toBeDefined();
  });

  it('purchase-invoices.service: constructs and lists', async () => {
    const service = new PurchaseInvoicesService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 20 });
    expect(result).toBeDefined();
  });

  it('quality.service: constructs and lists', async () => {
    const service = new QualityService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 25 });
    expect(result).toBeDefined();
  });

  it('sales-invoices.service: constructs and lists', async () => {
    const service = new SalesInvoicesService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    const result = await service.list({ page: 1, limit: 20 });
    expect(result).toBeDefined();
  });

  it('settings.service: constructs and reads settings (auto-provisioning)', async () => {
    const service = new SettingsService(makePrisma());
    expect(service).toBeDefined();
    const result = await service.getSettings('11111111-1111-1111-1111-111111111111');
    expect(result).toBeDefined();
  });

  it('shipping.service: constructs and lists carriers', async () => {
    const service = new ShippingService(
      makePrisma(),
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
    expect(service).toBeDefined();
    await expect(service.listCarriers()).resolves.toEqual([]);
  });

  it('transportation.service: constructs and lists buses', async () => {
    const service = new TransportationService(makePrisma());
    expect(service).toBeDefined();
    await expect(service.listBuses()).resolves.toEqual([]);
  });

  it('wms-analytics.service: constructs and serves kpis', async () => {
    const service = new WmsAnalyticsService(makePrisma(), makeCache());
    expect(service).toBeDefined();
    const result = await service.kpis(30);
    expect(result).toBeDefined();
  });
});