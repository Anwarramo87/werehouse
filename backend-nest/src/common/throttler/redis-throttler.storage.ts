import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * Rate-limit counters in Redis rather than in each process's memory.
 *
 * The default storage is an in-process Map, which means counters reset on every
 * restart and are not shared between instances. Both matter here: a deploy
 * silently forgives every attacker mid-brute-force, and the moment a second
 * instance exists the effective limit doubles.
 *
 * Built on the ioredis client the project already depends on rather than adding
 * a storage package — the whole contract is one method.
 *
 * Falls back to the in-memory implementation when Redis is absent, because a
 * rate limiter that throws is worse than one that is merely per-instance: it
 * would take the whole API down with it.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly prefix = 'throttle:';
  private readonly redisUrl: string;

  private redis: Redis | null = null;
  private readonly memoryFallback = new ThrottlerStorageService();

  constructor(config: ConfigService) {
    this.redisUrl = config.get<string>('REDIS_URL', '').trim();
  }

  async onModuleInit() {
    if (!this.redisUrl) {
      this.logger.warn(
        'REDIS_URL is not set — rate-limit counters are per-instance and reset on restart.',
      );
      return;
    }

    try {
      const client = new Redis(this.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
      });
      client.on('error', () => {
        // ioredis emits on every reconnect attempt; the operations below handle
        // failure individually, so this only exists to stop unhandled events.
      });
      await client.connect();
      this.redis = client;
      this.logger.log('Rate-limit counters are shared via Redis.');
    } catch (error) {
      this.redis = null;
      this.logger.warn(
        `Redis unavailable for rate limiting, falling back to per-instance counters: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  async onModuleDestroy() {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.redis) {
      return this.memoryFallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    const hitKey = `${this.prefix}${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      // INCR then EXPIRE-if-new, in one round trip. The TTL is set only when the
      // counter is created, so a burst cannot keep extending its own window.
      const [blockTtl, hits] = (await this.redis
        .multi()
        .pttl(blockKey)
        .incr(hitKey)
        .exec()) as Array<[Error | null, number]>;

      const timeToBlockExpire = Math.max(0, Math.ceil((blockTtl?.[1] ?? -2) / 1000));
      if (timeToBlockExpire > 0) {
        return {
          totalHits: hits?.[1] ?? 0,
          timeToExpire: timeToBlockExpire,
          isBlocked: true,
          timeToBlockExpire,
        };
      }

      const totalHits = hits?.[1] ?? 1;
      if (totalHits === 1) {
        await this.redis.pexpire(hitKey, ttl);
      }

      const remainingTtl = await this.redis.pttl(hitKey);
      const timeToExpire = Math.max(0, Math.ceil(remainingTtl / 1000));

      if (totalHits > limit && blockDuration > 0) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        const seconds = Math.ceil(blockDuration / 1000);
        return { totalHits, timeToExpire: seconds, isBlocked: true, timeToBlockExpire: seconds };
      }

      return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
    } catch (error) {
      // A Redis blip must not take the API with it. Degrade to per-instance
      // counting and say so once, rather than refusing the request.
      this.logger.warn(
        `Rate-limit counter failed in Redis, using memory for this request: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return this.memoryFallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
