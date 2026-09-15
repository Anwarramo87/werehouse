import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Proves the dependency graph resolves — that the app can actually start.
 *
 * Nothing else in the suite did. Typecheck, lint, unit tests and `nest build`
 * all passed while the app could not boot at all: `ThrottlerModule.forRootAsync`
 * injected a provider that only existed in AppModule, and the factory resolves
 * inside ThrottlerModule's own injector, so it failed with
 * "Nest can't resolve dependencies of the THROTTLER:MODULE_OPTIONS". DI wiring
 * is invisible to the type system, so only instantiation catches it.
 *
 * PrismaService is replaced with a stub so this needs no database. That keeps
 * the test about WIRING; connectivity is a deployment concern, not a unit one.
 */
describe('AppModule dependency graph', () => {
  const prismaStub = {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $on: () => undefined,
    $queryRaw: async () => [{ ok: 1 }],
    enableShutdownHooks: async () => undefined,
    onModuleInit: async () => undefined,
    onModuleDestroy: async () => undefined,
    getPoolStats: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
  };

  const originalEnv = { ...process.env };

  beforeAll(() => {
    // A complete, valid configuration — the schema is strict, and this doubles
    // as a check that the documented production values actually satisfy it.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_SECRET: 'test-jwt-secret-not-real-012345678',
      CORS_ORIGIN: 'http://localhost:3000',
      DEVICE_API_KEY: 'test-device-key-not-real-abcdefgh',
      QUEUES_ENABLED: 'false',
      CACHE_ENABLED: 'false',
      USE_BIOMETRIC_SIMULATOR: 'false',
      UPLOAD_ROOT: '',
    });
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  it('compiles every module, guard, interceptor and controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60_000);
});
