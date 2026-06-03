import { Controller, Get, OnModuleDestroy } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { freemem, totalmem } from 'os';
import { statfs } from 'fs/promises';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

const HEAP_WARN_MB = 512;
const DISK_WARN_PERCENT = 20;

@ApiTags('health')
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly redisEnabled: boolean;
  private readonly redis: Redis | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.redisEnabled = this.config.get<boolean>('QUEUES_ENABLED', true);
    this.redis = this.redisEnabled
      ? new Redis(this.config.get<string>('REDIS_URL', 'redis://127.0.0.1:6379'), {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableReadyCheck: false,
        })
      : null;
  }

  /** Liveness probe — السيرفر شغّال؟ */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe', description: 'يُرجع ok إذا كان السيرفر يعمل' })
  @ApiResponse({ status: 200, description: 'السيرفر يعمل' })
  getLive() {
    return {
      status: 'ok',
      check: 'liveness',
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness probe — الخدمات جاهزة؟ */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe', description: 'يتحقق من DB + Redis' })
  async getReady() {
    const db = await this.checkDatabase();
    const redis = await this.checkRedis();
    const redisHealthy = redis.status === 'up' || redis.status === 'disabled';

    return {
      status: db.status === 'up' && redisHealthy ? 'ok' : 'degraded',
      check: 'readiness',
      timestamp: new Date().toISOString(),
      services: {
        database: db.status,
        redis: redis.status,
      },
    };
  }

  /** Health check كامل — DB + Redis + Memory + Disk */
  @Get()
  @ApiOperation({
    summary: 'Full health check',
    description: 'يتحقق من: قاعدة البيانات، Redis، ذاكرة الـ heap، مساحة القرص',
  })
  @ApiResponse({
    status: 200,
    description: 'تقرير صحة مفصّل',
    schema: {
      example: {
        status: 'ok',
        timestamp: '2025-01-01T00:00:00.000Z',
        services: {
          database: { status: 'up', latencyMs: 5 },
          redis: { status: 'up', latencyMs: 2 },
          memory: { status: 'ok', heapUsedMb: 120, heapTotalMb: 256, rssMemMb: 180 },
          disk: { status: 'ok', freePercent: 45 },
        },
      },
    },
  })
  async getHealth() {
    const [db, redis, memory, disk] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkMemory(),
      this.checkDisk(),
    ]);

    const redisOk = redis.status === 'up' || redis.status === 'disabled';
    const allOk = db.status === 'up' && redisOk && memory.status === 'ok' && disk.status === 'ok';

    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      framework: 'NestJS',
      services: { database: db, redis, memory, disk },
    };
  }

  // ─── Private checks ────────────────────────────────────────────────────────

  private async checkDatabase(): Promise<{ status: 'up' | 'down'; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1 as ok`;
      return { status: 'up', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down' };
    }
  }

  private async checkRedis(): Promise<{ status: 'up' | 'down' | 'disabled'; latencyMs?: number }> {
    if (!this.redisEnabled || !this.redis) {
      return { status: 'disabled' };
    }
    const start = Date.now();
    try {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      await this.redis.ping();
      return { status: 'up', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down' };
    }
  }

  private checkMemory(): { status: 'ok' | 'warn'; heapUsedMb: number; heapTotalMb: number; rssMemMb: number } {
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMemMb = Math.round(mem.rss / 1024 / 1024);
    return {
      status: heapUsedMb > HEAP_WARN_MB ? 'warn' : 'ok',
      heapUsedMb,
      heapTotalMb,
      rssMemMb,
    };
  }

  private async checkDisk(): Promise<{ status: 'ok' | 'warn'; freePercent: number }> {
    try {
      const stats = await statfs('/');
      const freePercent = Math.round((stats.bfree / stats.blocks) * 100);
      return {
        status: freePercent < DISK_WARN_PERCENT ? 'warn' : 'ok',
        freePercent,
      };
    } catch {
      // statfs غير مدعومة في Windows — نستخدم os.freemem كبديل
      const freePercent = Math.round((freemem() / totalmem()) * 100);
      return { status: 'ok', freePercent };
    }
  }

  async onModuleDestroy() {
    if (!this.redis) return;
    await this.redis.quit();
  }
}
