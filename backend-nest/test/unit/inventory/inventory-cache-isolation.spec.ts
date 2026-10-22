import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ShortCacheService } from '../../../src/common/cache/short-cache.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditService } from '../../../src/common/services/audit.service';
import { InventoryService } from '../../../src/inventory/inventory.service';

/**
 * Cache-key tenant isolation in InventoryService.
 *
 * Every query the service runs is tenant-narrowed by the Prisma extension, but
 * a short-cache sits *in front* of those queries. When the cache key carried no
 * factory, factory B's request hit factory A's cached page and the narrowing
 * never ran at all -- the inventory of one factory was served to another for
 * the TTL of the entry.
 *
 * The cache is the real one here (no mock): it is what makes the test mean
 * anything. Prisma is mocked so nothing touches a database.
 */

const FACTORY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FACTORY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

// A module-level switch the tests flip per factory, read by the mocked
// currentTenant below. Kept outside the mock so a test can set it inline.
let activeTenant = FACTORY_A;

jest.mock('../../../src/common/tenant/tenant-context', () => ({
  ...jest.requireActual('../../../src/common/tenant/tenant-context'),
  currentTenant: () => ({ tenantId: activeTenant, bypass: false }),
}));

// The producer argument is what proves the point: record every key the cache
// asks for so the test can assert the factory appears in each one.
const requestedKeys: string[] = [];

const makeProductRows = (tenantId: string) => [
  {
    id: 'p1',
    sku: 'A-1',
    name: 'Widget',
    tenantId,
    costPrice: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(2),
    profitPercent: null,
  },
];

describe('InventoryService cache-key tenant isolation', () => {
  let service: InventoryService;

  beforeEach(async () => {
    requestedKeys.length = 0;
    activeTenant = FACTORY_A;

    const prismaMock = {
      product: {
        findMany: jest.fn(async () => makeProductRows(activeTenant)),
        count: jest.fn(async () => 1),
        findFirst: jest.fn(async () => ({ id: 'p1', sku: 'A-1' })),
        findUnique: jest.fn(async () => ({ id: 'p1', sku: 'A-1' })),
      },
      stockLevel: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: 's1' })),
      },
      warehouse: { count: jest.fn(async () => 1), findMany: jest.fn(async () => []) },
      stockMovement: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: new ConfigService({ NODE_ENV: 'test', CACHE_ENABLED: false }) },
        ShortCacheService,
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = module.get(InventoryService);

    // Record every key the service asks for, delegating to the real in-memory
    // implementation so cross-key behaviour is genuine.
    const cache = module.get(ShortCacheService);
    const real = cache.getOrSetJson.bind(cache);
    cache.getOrSetJson = jest.fn(
      async <T>(key: string, ttl: number, producer: () => Promise<T>) => {
        requestedKeys.push(key);
        return real(key, ttl, producer);
      },
    ) as never;
  });

  it('scopes the product list cache key to the caller factory', async () => {
    await service.listProducts({ page: 1, limit: 50 });
    // The factory is the third segment of the key. Asserting the SEGMENT
    // rather than the whole string is deliberate: the key is positional and
    // every filter adds a slot, so counting separators would break whenever
    // a filter is added — while the property this test exists to protect,
    // that the factory is IN the key, stays true.
    const key = requestedKeys.find((k) => k.startsWith('inventory:products:'));
    expect(key).toBeDefined();
    expect(key!.split(':')[2]).toBe(FACTORY_A);
  });

  it('does not serve one factory its cached page under another factory key', async () => {
    // Factory A fills the cache.
    activeTenant = FACTORY_A;
    await service.listProducts({ page: 1, limit: 50 });
    const aKeys = [...requestedKeys];

    // Factory B asks the same page. If the key were global this call would be a
    // cache hit and the producer would never run; with the factory in the key
    // the cache misses and B's own query executes.
    activeTenant = FACTORY_B;
    requestedKeys.length = 0;
    await service.listProducts({ page: 1, limit: 50 });

    const bKey = requestedKeys.find((k) => k.startsWith('inventory:products:'));
    expect(bKey).toContain(FACTORY_B);
    expect(aKeys.find((k) => k.startsWith('inventory:products:'))).toContain(FACTORY_A);
    expect(aKeys.find((k) => k.startsWith('inventory:products:'))).not.toBe(bKey);
  });

  it('scopes stats, categories, warehouses and low-stock alerts to the factory', async () => {
    await service.stats();
    await service.listCategories();
    await service.listWarehouses();
    await service.lowStockAlerts({ page: 1, limit: 50 });

    // Every one of these used to be a single global key shared by every factory.
    expect(requestedKeys).toContain(`inventory:stats:${FACTORY_A}`);
    expect(requestedKeys).toContain(`inventory:categories:${FACTORY_A}`);
    expect(requestedKeys).toContain(`inventory:warehouses:${FACTORY_A}`);
    expect(requestedKeys).toContain(`inventory:alerts:low-stock:${FACTORY_A}`);
  });

  it('scopes the movements cache key to the factory', async () => {
    await service.listMovements({ page: 1, limit: 25 });
    expect(requestedKeys).toContain(`inventory:movements:${FACTORY_A}:1:25:::`);
  });
});
