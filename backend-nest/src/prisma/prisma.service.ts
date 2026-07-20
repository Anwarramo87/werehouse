import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { MetricsService } from '../common/metrics/metrics.service';

type PrismaQueryEventClient = {
  $on(eventType: 'query', callback: (event: Prisma.QueryEvent) => void): void;
};

// How often to ping Neon to prevent it from sleeping (ms)
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes (أسرع)

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;
  private readonly poolMax: number;
  private readonly slowQueryThresholdMs: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Optional() private readonly metricsService?: MetricsService) {
    // Allow horizontal scaling: total connections = replicas × max. Lower the
    // per-instance max when scaling out to avoid exhausting Neon's limit.
    // Pool size. The dashboard fires a large concurrent burst of independent
    // API calls on load (~15-25 at once), so a tiny pool serializes them behind
    // a queue and produces multi-second latency. Size the pool to absorb that
    // burst. Neon's pooler caps the *server* connections anyway, so a larger
    // local pool just means we hold waiting clients ready instead of queueing
    // them at the Node level.
    const maxConnections = Number(process.env.DATABASE_MAX_CONNECTIONS || 20);
    const poolMax = Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 20;
    // Bounded statement timeout (ms) so a slow/runaway query cannot hold one of
    // the few pooled connections indefinitely and cause cascading exhaustion.
    const statementTimeoutMs = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 30_000);

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Keep connections alive — critical for Neon serverless.
      // maxLifetimeSeconds recycles connections periodically to prevent stale
      // sockets. 1800s (30 min) is conservative — short enough to reclaim dead
      // sockets but long enough to avoid frequent reconnect storms. (The old
      // 120s value caused measurable latency spikes; measured with pool stats.)
      max: poolMax,
      maxLifetimeSeconds: 1800,
      idleTimeoutMillis: 0, // never close on idle; keepalive holds the socket
      connectionTimeoutMillis: 30_000, // Increased from 10s to 30s for Neon cold starts
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      allowExitOnIdle: false,
      application_name: 'backend-nest',
    });

    // Bounded statement timeout so a slow/runaway query cannot hold one of the
    // few pooled connections indefinitely. We set it per-session via `SET`
    // rather than the startup `options` parameter: Neon's connection *pooler*
    // rejects `statement_timeout` in the startup package (error 08P01), so it
    // must be applied after the connection is established.
    if (statementTimeoutMs > 0) {
      pool.on('connect', (client: import('pg').PoolClient) => {
        void client.query(
          `SET statement_timeout = ${Math.round(statementTimeoutMs)}`,
        );
      });
    }

    // Swallow pool-level errors so a single dead socket doesn't crash the process
    // or surface as an unhandledRejection. The pool auto-discards failed sockets.
    pool.on('error', (err: Error) => {
      this.logger.warn(`[PrismaService] Pool connection error: ${err.message}`);
    });

    super({
      adapter: new PrismaPg(pool),
      log: [{ emit: 'event', level: 'query' }],
    });

    this.pool = pool;
    this.poolMax = poolMax;
    this.slowQueryThresholdMs = this.resolveSlowQueryThreshold();
    this.registerSlowQueryObserver();
  }

  private resolveSlowQueryThreshold() {
    const defaultThreshold = process.env.NODE_ENV === 'production' ? 200 : 800;
    const configured = Number(process.env.PRISMA_SLOW_QUERY_MS || defaultThreshold);
    if (!Number.isFinite(configured) || configured <= 0) {
      return defaultThreshold;
    }

    return Math.round(configured);
  }

  private registerSlowQueryObserver() {
    const eventClient = this as unknown as PrismaQueryEventClient;

    eventClient.$on('query', (event: Prisma.QueryEvent) => {
      if (event.duration < this.slowQueryThresholdMs) {
        return;
      }

      const compactQuery = event.query.replace(/\s+/g, ' ').trim();
      const maxQueryPreview = 280;
      const queryPreview =
        compactQuery.length > maxQueryPreview
          ? `${compactQuery.slice(0, maxQueryPreview)}...`
          : compactQuery;

      this.logger.warn(
        `[Slow Query] ${event.duration}ms (threshold: ${this.slowQueryThresholdMs}ms) ${queryPreview}`,
      );
      this.metricsService?.dbSlowQueriesTotal.inc();

      // Log pool state alongside slow queries so we can see if pool exhaustion
      // is contributing to the slowness.
      this.logger.warn(`[Pool Stats] ${this.getPoolStatsSummary()}`);
    });
  }

  /**
   * Returns a snapshot of the pg Pool's connection state.
   * Use this to diagnose whether pool exhaustion is contributing to latency:
   *   waitingCount > 0  → requests are queued, pool is saturated
   *   waitingCount = 0  → pool is innocent, bottleneck is elsewhere
   */
  getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  private getPoolStatsSummary() {
    const s = this.getPoolStats();
    return `total=${s.totalCount} idle=${s.idleCount} waiting=${s.waitingCount}`;
  }

  /**
   * Connect with retry logic — handles Neon cold-start delays.
   */
  async onModuleInit() {
    const maxRetries = 3; // قللنا من 5 إلى 3
    const retryDelayMs = 2_000; // قللنا من 3000 إلى 2000

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Database connection established.');
        await this.warmupPool();
        this.startKeepalive();
        return;
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const message = error instanceof Error ? error.message : String(error);

        if (isLastAttempt) {
          this.logger.error(
            `Database connection failed after ${maxRetries} attempts: ${message}`,
          );
          throw error;
        }

        this.logger.warn(
          `Database connection attempt ${attempt}/${maxRetries} failed: ${message}. Retrying in ${retryDelayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  /**
   * Sends a lightweight ping to Neon every 2 minutes so it never
   * enters sleep mode while the backend is running.
   */
  private startKeepalive() {
    this.keepaliveTimer = setInterval(async () => {
      try {
        await this.pool.query('SELECT 1');
        this.logger.debug('[Keepalive] Neon ping OK');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[Keepalive] Neon ping failed: ${message}`);
        // Don't try to manually reconnect - Prisma/Pool will handle reconnection
        // on the next actual database query automatically
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Don't block process exit
    if (this.keepaliveTimer.unref) {
      this.keepaliveTimer.unref();
    }

    this.logger.log(
      `[Keepalive] Started — pinging Neon every ${KEEPALIVE_INTERVAL_MS / 1000}s to prevent sleep.`,
    );
  }

  /**
   * Eagerly opens a few connections so the first real request burst doesn't
   * pay the full cost of establishing the entire pool at once against the
   * Neon pooler (TLS + auth + SET overhead). Without this, the first dashboard
   * load after a cold start can take several seconds while 20 connections are
   * opened simultaneously.
   */
  private async warmupPool() {
    const warmCount = Math.min(this.poolMax, 10);
    const clients: import('pg').PoolClient[] = [];
    try {
      for (let i = 0; i < warmCount; i++) {
        clients.push(await this.pool.connect());
      }
      this.logger.log(`[PrismaService] Warmed up ${clients.length} pooled connections.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[PrismaService] Pool warmup partial/failed: ${message}`);
    } finally {
      // Release back to the pool (the `connect` event already ran SET on each).
      clients.forEach((c) => c.release());
    }
  }

  async enableShutdownHooks(app: INestApplication) {
    process.once('beforeExit', async () => {
      await app.close();
    });
  }

  async onModuleDestroy() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    await this.$disconnect();
    await this.pool.end();
  }
}
