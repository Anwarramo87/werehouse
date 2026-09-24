import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RepresentativesService } from '../../src/representatives/representatives.service';
import { runUnscoped, runWithTenant } from '../../src/common/tenant/tenant-context';

const T = '77777777-0000-4000-8000-000000000077';
const TIMEOUT = 120_000;

function extractCookies(rawCookieHeader: string[] | string | undefined) {
  return Array.isArray(rawCookieHeader)
    ? rawCookieHeader
    : rawCookieHeader
      ? [rawCookieHeader]
      : [];
}

/**
 * Representative isolation (e2e, real PostgreSQL).
 *
 * 1. transferStockToRep must deduct from the REAL warehouse location (the old
 *    code hardcoded 'WH-A', so transfers silently no-op'd against stock that
 *    actually lives in 'MAIN').
 * 2. transferStockFromRep returns stock to the warehouse as a real IN
 *    movement and keeps the rep-side audit trail balanced.
 * 3. The guard layer must reject one representative touching another rep's
 *    stock, movements, sales, summaries or settlements, while an admin sees
 *    every rep's data.
 */
describe('Representative isolation (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let reps: RepresentativesService;
  let app: INestApplication;

  const asT = <R>(fn: () => Promise<R>): Promise<R> =>
    runWithTenant({ tenantId: T, bypass: false, actor: 'e2e' }, async () => await fn());

  let adminU: { id: string; username: string };
  let repAU: { id: string; username: string };
  let repBU: { id: string; username: string };
  let repA: { id: string };
  let repB: { id: string };

  const cleanTenant = async () => {
    await runUnscoped('rep-iso-teardown', async () => {
      // representatives.userId → users is RESTRICT, so reps must go first.
      // Match by userId, not tenantId: an orphaned rep may carry a NULL tenant.
      const userIds = await prisma.user.findMany({
        where: { tenantId: T },
        select: { id: true },
      });
      await prisma.representative.deleteMany({
        where: { userId: { in: userIds.map((u) => u.id) } },
      });
      await prisma.user.deleteMany({ where: { tenantId: T } });
      await prisma.tenant.deleteMany({ where: { id: T } });
    });
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    reps = moduleRef.get(RepresentativesService);

    const stamp = Date.now();

    await runUnscoped('rep-iso-roles', async () => {
      for (const name of ['admin', 'representative']) {
        const existing = await prisma.role.findUnique({ where: { name } });
        if (!existing) {
          await prisma.role.create({ data: { name, permissions: [] } });
        }
      }
    });

const cleanTenant = async () => {
      await runUnscoped('rep-iso-teardown', async () => {
        // representatives.userId → users is RESTRICT, so reps must go first.
        // Match by userId, not tenantId: an orphaned rep may carry a NULL tenant.
        const userIds = await prisma.user.findMany({
          where: { tenantId: T },
          select: { id: true },
        });
        await prisma.representative.deleteMany({
          where: { userId: { in: userIds.map((u) => u.id) } },
        });
        await prisma.user.deleteMany({ where: { tenantId: T } });
        await prisma.tenant.deleteMany({ where: { id: T } });
      });
    };

    await cleanTenant();

    await runUnscoped('rep-iso-users', async () => {
      const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
      const repRole = await prisma.role.findUniqueOrThrow({ where: { name: 'representative' } });

      await prisma.tenant.create({
        data: { id: T, name: 'RepIsolation', code: `REPISO-${stamp}`, status: 'active' },
      });

      adminU = await prisma.user.create({
        data: {
          tenantId: T,
          username: `repiso-admin-${stamp}`,
          email: `repiso-admin-${stamp}@t.local`,
          passwordHash: bcrypt.hashSync('AdminPass!23', 10),
          roleId: adminRole.id,
          status: 'active',
        },
        select: { id: true, username: true },
      });
      repAU = await prisma.user.create({
        data: {
          tenantId: T,
          username: `repiso-a-${stamp}`,
          email: `repiso-a-${stamp}@t.local`,
          passwordHash: bcrypt.hashSync('RepPass!23', 10),
          roleId: repRole.id,
          status: 'active',
        },
        select: { id: true, username: true },
      });
      repBU = await prisma.user.create({
        data: {
          tenantId: T,
          username: `repiso-b-${stamp}`,
          email: `repiso-b-${stamp}@t.local`,
          passwordHash: bcrypt.hashSync('RepPass!23', 10),
          roleId: repRole.id,
          status: 'active',
        },
        select: { id: true, username: true },
      });
    });

    await asT(async () => {
      repA = await prisma.representative.create({
        data: { userId: repAU.id, name: 'Rep A', code: `RPA-${stamp}` },
        select: { id: true },
      });
      repB = await prisma.representative.create({
        data: { userId: repBU.id, name: 'Rep B', code: `RPB-${stamp}` },
        select: { id: true },
      });

      await prisma.product.createMany({
        data: [
          { sku: 'T-PMAIN', name: 'Main-Sku', category: 'iso', unitPrice: new Prisma.Decimal(100), costPrice: new Prisma.Decimal(40) },
          { sku: 'T-PWHB', name: 'Whb-Sku', category: 'iso', unitPrice: new Prisma.Decimal(80), costPrice: new Prisma.Decimal(25) },
        ],
      });
      await prisma.stockLevel.createMany({
        data: [
          { sku: 'T-PMAIN', location: 'MAIN', quantity: 100, available: 100 },
          { sku: 'T-PWHB', location: 'WH-B', quantity: 40, available: 40 },
        ],
      });
    });

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanTenant();
    // app.close() already closes the TestingModule and its Prisma pool
    await app?.close();
  }, TIMEOUT);

  // ---------------------------------------------------------------------------
  // Service level — transfer accounting at the REAL warehouse location
  // ---------------------------------------------------------------------------

  it('transferStockToRep deducts from the real location and credits rep stock', async () => {
    await asT(() =>
      reps.transferStockToRep(repA.id, { items: [{ sku: 'T-PMAIN', quantity: 10 }] }, adminU.id),
    );

    await asT(async () => {
      const main = await prisma.stockLevel.findUnique({
        where: { tenantId_sku_location: { tenantId: T, sku: 'T-PMAIN', location: 'MAIN' } },
      });
      expect(main?.available).toBe(90);

      const repStock = await prisma.repStock.findFirst({ where: { representativeId: repA.id, sku: 'T-PMAIN' } });
      expect(Number(repStock?.quantity)).toBe(10);
      expect(Number(repStock?.unitCost)).toBe(40);

      const out = await prisma.stockMovement.findFirst({
        where: { sku: 'T-PMAIN', type: 'OUT', referenceType: 'rep_transfer' },
      });
      expect(out?.location).toBe('MAIN');
      expect(Number(out?.quantity)).toBe(-10);

      const mov = await prisma.repStockMovement.findFirst({
        where: { representativeId: repA.id, sku: 'T-PMAIN', type: 'RECEIVED' },
      });
      expect(mov?.referenceType).toBe('warehouse_transfer');
      expect(mov?.referenceId).toBe('MAIN');
      expect(Number(mov?.quantity)).toBe(10);

      const repBStock = await prisma.repStock.count({ where: { representativeId: repB.id } });
      expect(repBStock).toBe(0);
    });
  }, TIMEOUT);

  it('resolves each SKU to its OWN location (regression: WH-A phantom)', async () => {
    await asT(() =>
      reps.transferStockToRep(repA.id, { items: [{ sku: 'T-PWHB', quantity: 5 }] }, adminU.id),
    );

    await asT(async () => {
      const whb = await prisma.stockLevel.findUnique({
        where: { tenantId_sku_location: { tenantId: T, sku: 'T-PWHB', location: 'WH-B' } },
      });
      expect(whb?.available).toBe(35);

      const out = await prisma.stockMovement.findFirst({
        where: { sku: 'T-PWHB', type: 'OUT', referenceType: 'rep_transfer' },
      });
      expect(out?.location).toBe('WH-B');

      const repStock = await prisma.repStock.findFirst({ where: { representativeId: repA.id, sku: 'T-PWHB' } });
      expect(Number(repStock?.quantity)).toBe(5);
    });
  }, TIMEOUT);

  it('falls back from a phantom preferred location to the real one', async () => {
    // warehouseLocation 'WH-A' does not exist for this SKU. The old code went
    // straight there and failed/never moved stock; now it resolves anyway.
    await asT(() =>
      reps.transferStockToRep(
        repA.id,
        { items: [{ sku: 'T-PMAIN', quantity: 2 }], warehouseLocation: 'WH-A' },
        adminU.id,
      ),
    );

    await asT(async () => {
      const main = await prisma.stockLevel.findUnique({
        where: { tenantId_sku_location: { tenantId: T, sku: 'T-PMAIN', location: 'MAIN' } },
      });
      expect(main?.available).toBe(88);
      const repStock = await prisma.repStock.findFirst({ where: { representativeId: repA.id, sku: 'T-PMAIN' } });
      expect(Number(repStock?.quantity)).toBe(12);
    });
  }, TIMEOUT);

  it('rejects a transfer that exceeds available warehouse stock', async () => {
    await expect(
      asT(() =>
        reps.transferStockToRep(
          repA.id,
          { items: [{ sku: 'T-PMAIN', quantity: 9999 }] },
          adminU.id,
        ),
      ),
    ).rejects.toThrow('مخزون غير كافٍ');
  }, TIMEOUT);

  it('transferStockFromRep returns stock to the warehouse as a real IN movement', async () => {
    await asT(() =>
      reps.transferStockFromRep(repA.id, { items: [{ sku: 'T-PMAIN', quantity: 3 }] }, adminU.id),
    );

    await asT(async () => {
      const main = await prisma.stockLevel.findUnique({
        where: { tenantId_sku_location: { tenantId: T, sku: 'T-PMAIN', location: 'MAIN' } },
      });
      expect(main?.available).toBe(91);

      const repStock = await prisma.repStock.findFirst({ where: { representativeId: repA.id, sku: 'T-PMAIN' } });
      expect(Number(repStock?.quantity)).toBe(9);

      const inc = await prisma.stockMovement.findFirst({
        where: { sku: 'T-PMAIN', type: 'IN', referenceType: 'rep_transfer_back' },
      });
      expect(inc?.location).toBe('MAIN');
      expect(Number(inc?.quantity)).toBe(3);

      const mov = await prisma.repStockMovement.findFirst({
        where: { representativeId: repA.id, sku: 'T-PMAIN', type: 'ADJUSTED' },
      });
      expect(mov?.referenceType).toBe('warehouse_transfer_back');
      expect(Number(mov?.quantity)).toBe(-3);
    });
  }, TIMEOUT);

  it('rejects a transfer-back that exceeds what the rep holds', async () => {
    await expect(
      asT(() =>
        reps.transferStockFromRep(repA.id, { items: [{ sku: 'T-PWHB', quantity: 999 }] }, adminU.id),
      ),
    ).rejects.toThrow('لا يملك المندوب');
  }, TIMEOUT);

  // ---------------------------------------------------------------------------
  // HTTP level — guard isolation (supertest + cookie auth)
  // ---------------------------------------------------------------------------

  it('lets a rep see only their own stock and blocks cross-rep access', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: repAU.username, password: 'RepPass!23' })
      .expect(201);
    const cookies = extractCookies(login.headers['set-cookie']);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repA.id}/stock`)
      .set('Cookie', cookies)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/stock`)
      .set('Cookie', cookies)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/movements`)
      .set('Cookie', cookies)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/sales`)
      .set('Cookie', cookies)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/summary`)
      .set('Cookie', cookies)
      .expect(403);

    // settlements is admin-only: a rep must not reach it even for themselves
    await request(app.getHttpServer())
      .get(`/api/representatives/${repA.id}/settlements`)
      .set('Cookie', cookies)
      .expect(403);
  }, TIMEOUT);

  it('blocks a rep from admin-only warehouse transfer endpoints', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: repAU.username, password: 'RepPass!23' })
      .expect(201);
    const cookies = extractCookies(login.headers['set-cookie']);

    await request(app.getHttpServer())
      .post(`/api/representatives/${repA.id}/transfer`)
      .set('Cookie', cookies)
      .send({ items: [{ sku: 'T-PMAIN', quantity: 1 }] })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/representatives/${repA.id}/transfer-back`)
      .set('Cookie', cookies)
      .send({ items: [{ sku: 'T-PMAIN', quantity: 1 }] })
      .expect(403);
  }, TIMEOUT);

  it('lets an admin see any rep stock and their settlements', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: adminU.username, password: 'AdminPass!23' })
      .expect(201);
    const cookies = extractCookies(login.headers['set-cookie']);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repA.id}/stock`)
      .set('Cookie', cookies)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/stock`)
      .set('Cookie', cookies)
      .expect(200);

    const settlements = await request(app.getHttpServer())
      .get(`/api/representatives/${repB.id}/settlements`)
      .set('Cookie', cookies)
      .expect(200);
    expect(Array.isArray(settlements.body)).toBe(true);
  }, TIMEOUT);
});