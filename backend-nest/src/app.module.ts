import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from './common/throttler/client-ip.throttler-guard';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { ThrottlerStorageModule } from './common/throttler/throttler-storage.module';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './common/logger/winston.config';
import { shouldRegisterSchedules } from './cluster';
import { AuthModule } from './auth';
import { EmployeesModule } from './employees';
import { DevicesModule } from './devices';
import { HealthModule } from './health/health.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PayrollModule } from './payroll/payroll.module';
import { InventoryModule } from './inventory/inventory.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { SalesModule } from './sales/sales.module';
import { AssistantModule } from './assistant/assistant.module';
import { AccountingModule } from './accounting/accounting.module';
import { ImportsModule } from './imports/imports.module';
import { PrismaModule } from './prisma/prisma.module';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware';
import { CsrfOriginCheckMiddleware } from './common/middleware/csrf-origin-check.middleware';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { SalaryModule } from './salary/salary.module';
import { AdvancesModule } from './advances/advances.module';
import { InsuranceModule } from './insurance/insurance.module';
import { BonusesModule } from './bonuses/bonuses.module';
import { FilesModule } from './files/files.module';
import { FinancesModule } from './finances/finances.module';
import { ShortCacheModule } from './common/cache/short-cache.module';
import { EmployeeAccessModule } from './common/access/employee-access.module';
import { TransportationModule } from './transportation/transportation.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscountsModule } from './discounts/discounts.module';
import { PenaltiesModule } from './penalties/penalties.module';
import { LeavesModule } from './leaves/leaves.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DepartmentsModule } from './departments';
import { BiometricModule } from './biometric/biometric.module';
import { TrashModule } from './trash/trash.module';
import { BackupModule } from './backup/backup.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { EntitlementsModule } from './common/entitlements/entitlements.module';
import { FactoryScopeInterceptor } from './common/tenant/factory-scope.interceptor';
import { AuditLogModule } from './audit/audit-log.module';
// --- WMS extension ---
import { WmsCommonModule } from './common/wms/wms-common.module';
import { BatchesModule } from './batches/batches.module';
import { PricingModule } from './pricing/pricing.module';
import { PurchaseInvoicesModule } from './purchase-invoices/purchase-invoices.module';
import { SalesInvoicesModule } from './sales-invoices/sales-invoices.module';
import { LocationsModule } from './locations/locations.module';
import { QualityModule } from './quality/quality.module';
import { CycleCountsModule } from './cycle-counts/cycle-counts.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { WmsAnalyticsModule } from './wms-analytics/wms-analytics.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ManufacturingModule } from './manufacturing/manufacturing.module';
import { WmsSetupModule } from './wms-setup/wms-setup.module';
import { SettingsModule } from './settings/settings.module';
import { RepresentativesModule } from './representatives/representatives.module';

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

const explicitQueuesEnabled = parseBooleanEnv(process.env.QUEUES_ENABLED);
const queuesEnabled =
  process.env.NODE_ENV !== 'test' &&
  (explicitQueuesEnabled ?? process.env.NODE_ENV === 'production');

const queueInfraModules = queuesEnabled
  ? [
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: {
            url: config.get<string>('REDIS_URL', 'redis://127.0.0.1:6379'),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: true,
            retryStrategy: (times: number) => Math.min(times * 1000, 30000),
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2_000,
            },
            removeOnComplete: 500,
            removeOnFail: 500,
          },
        }),
      }),
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        PORT: Joi.number().default(5001),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().min(32).required(),
          otherwise: Joi.string().min(16).required(),
        }),
        JWT_EXPIRE: Joi.string().default('15m'),
        JWT_COOKIE_NAME: Joi.string().default('warehouse_access_token'),
        JWT_COOKIE_SECURE: Joi.boolean().default(false),
        JWT_COOKIE_SAME_SITE: Joi.string()
          .valid('strict', 'lax', 'none', 'Strict', 'Lax', 'None')
          .default('lax'),
        JWT_COOKIE_DOMAIN: Joi.string().allow('').default(''),
        JWT_COOKIE_MAX_AGE_MS: Joi.number().min(60_000).default(900_000),
        JWT_REFRESH_DAYS: Joi.number().min(1).max(30).default(7),
        JWT_REFRESH_COOKIE_NAME: Joi.string().default('warehouse_refresh_token'),
        JWT_ROTATE_THRESHOLD_SEC: Joi.number().min(30).max(3_600).default(300),
        AUTH_MAX_LOGIN_ATTEMPTS: Joi.number().min(3).max(20).default(5),
        // Comma-separated usernames (or "all") whose password the bootstrap may
        // reset from the environment on the next boot. Empty by default: a
        // bootstrap account's password is otherwise set once, at creation, and
        // changing the env var alone never rotates it.
        AUTH_FORCE_PASSWORD_RESET: Joi.string().allow('').default(''),
        AUTH_LOCKOUT_MINUTES: Joi.number().min(1).max(1_440).default(15),
        CSRF_PROTECTION_ENABLED: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(true),
          otherwise: Joi.boolean().default(false),
        }),
        ADMIN_USERNAME: Joi.string().default('admin'),
        ADMIN_EMAIL: Joi.string().email({ tlds: { allow: false } }).default('admin@warehouse.local'),
        ADMIN_BOOTSTRAP_PASSWORD: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().min(8).required(),
          otherwise: Joi.string().min(8).optional(),
        }),
        DEV_ADMIN_USERNAME: Joi.string().default('developer'),
        DEV_ADMIN_EMAIL: Joi.string()
          .email({ tlds: { allow: false } })
          .default('developer@warehouse.local'),
        DEV_ADMIN_PASSWORD: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().min(12).required(),
          otherwise: Joi.string().min(8).optional(),
        }),
        SUPERADMIN_USERNAME: Joi.string().default('superadmin'),
        SUPERADMIN_EMAIL: Joi.string().email({ tlds: { allow: false } }).default('superadmin@warehouse.local'),
        SUPERADMIN_PASSWORD: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().min(12).required(),
          otherwise: Joi.string().min(8).optional(),
        }),
        CORS_ORIGIN: Joi.string().allow('').default(''),
        JWT_ALLOW_BEARER: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(false),
          otherwise: Joi.boolean().default(true),
        }),
        AUTH_RETURN_TOKEN_IN_BODY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(false),
          otherwise: Joi.boolean().default(true),
        }),
        REGISTRATION_ENABLED: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(false),
          otherwise: Joi.boolean().default(true),
        }),
        DEVICE_API_KEY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.string().min(16).required(),
          otherwise: Joi.string().allow('').default(''),
        }),
        DEVICE_AUTH_ENFORCED: Joi.boolean().default(true),
        // The biometric simulator fabricates attendance. It exists for demos and
        // test fixtures only, so production must say "false" explicitly: a
        // production box running the simulator would record attendance nobody
        // actually clocked. BiometricService also refuses to start in that case.
        USE_BIOMETRIC_SIMULATOR: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().valid(false).default(false),
          otherwise: Joi.boolean().default(false),
        }),
        APP_TIMEZONE_OFFSET_MINUTES: Joi.number().min(-720).max(840).default(180),
        // Storage root for uploaded files. Required in production and validated
        // properly by resolveUploadRoot() in files.service.ts, which rejects any
        // path inside the container image.
        UPLOAD_ROOT: Joi.string().allow('').default(''),
        // Where finished backups are written. Defaults under UPLOAD_ROOT so a
        // single mounted volume covers both.
        BACKUP_ROOT: Joi.string().allow('').default(''),
        BACKUP_RETENTION_DAYS: Joi.number().min(1).max(3650).default(30),
        // "auto", a worker count, or unset for a single process. See src/cluster.ts.
        CLUSTER_WORKERS: Joi.string().allow('').default(''),
        // Set by cluster.fork() in the child's environment, never by an
        // operator. Declared so the schema documents it rather than hiding it.
        CRON_WORKER: Joi.string().valid('true', 'false').optional(),
        TRUST_PROXY: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(true),
          otherwise: Joi.boolean().default(false),
        }),
        BCRYPT_ROUNDS: Joi.number().min(8).max(14).default(12),
        THROTTLE_TTL_MS: Joi.number().min(1_000).default(60_000),
        THROTTLE_LIMIT: Joi.number().min(10).default(120),
        AUTH_THROTTLE_LIMIT: Joi.number().min(3).max(100).default(10),
        QUEUES_ENABLED: Joi.when('NODE_ENV', {
          is: 'production',
          then: Joi.boolean().default(true),
          otherwise: Joi.boolean().default(false),
        }),
        CACHE_ENABLED: Joi.when('NODE_ENV', {
          is: 'test',
          then: Joi.boolean().default(false),
          otherwise: Joi.boolean().default(true),
        }),
        REDIS_URL: Joi.string().uri().default('redis://127.0.0.1:6379'),
        TOKEN_REVOCATION_STRICT: Joi.boolean().default(false),
      }),
    }),
    ThrottlerModule.forRootAsync({
      // Required: the factory below resolves inside ThrottlerModule's own
      // injector, which cannot see AppModule's providers.
      imports: [ThrottlerStorageModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL_MS', 60_000),
            limit: config.get<number>('THROTTLE_LIMIT', 120),
          },
        ],
        // Shared across instances and surviving restarts; see the class comment.
        storage,
      }),
    }),
    // Only the cron-owning worker registers schedules. Without this every
    // clustered worker would run the hourly absence sweep and each factory
    // would receive N copies of every notification.
    ...(shouldRegisterSchedules() ? [ScheduleModule.forRoot()] : []),
    ...queueInfraModules,
    WinstonModule.forRoot(winstonConfig),
    ThrottlerStorageModule,
    MetricsModule,
    EntitlementsModule,
    ShortCacheModule,
    EmployeeAccessModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    EmployeesModule,
    DevicesModule,
    AttendanceModule,
    BiometricModule,
    PayrollModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    // --- WMS extension: batches, invoicing, slotting, QC, counting, fulfilment ---
    WmsCommonModule,
    BatchesModule,
    PricingModule,
    PurchaseInvoicesModule,
    SalesInvoicesModule,
    LocationsModule,
    QualityModule,
    CycleCountsModule,
    FulfillmentModule,
    WmsAnalyticsModule,
    IntegrationsModule,
    ManufacturingModule,
    WmsSetupModule,
    SettingsModule,
    RepresentativesModule,
    AssistantModule,
    AccountingModule,
    ImportsModule,
    SalaryModule,
    AdvancesModule,
    InsuranceModule,
    BonusesModule,
    DiscountsModule,
    PenaltiesModule,
    FilesModule,
    FinancesModule,
    TransportationModule,
    DashboardModule,
    DepartmentsModule,
    LeavesModule,
    TrashModule,
    BackupModule,
    NotificationsModule,
    AuditLogModule,
  ],
  providers: [
    {
      // Keys on the real client rather than the Vercel proxy's single address.
      provide: APP_GUARD,
      useClass: ClientIpThrottlerGuard,
    },
    {
      // Global, so it runs after every controller-scoped guard has established
      // who the caller is. See the class comment for why a guard cannot do this.
      provide: APP_INTERCEPTOR,
      useClass: FactoryScopeInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      // TenantMiddleware must come first: it opens the AsyncLocalStorage scope
      // that every downstream Prisma call reads. JwtStrategy then fills it in
      // from the verified token. Without it the Prisma extension fails closed.
      .apply(TenantMiddleware, RequestLoggingMiddleware, CsrfOriginCheckMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
