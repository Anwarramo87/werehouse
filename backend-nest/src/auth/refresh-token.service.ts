import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { ShortCacheService } from '../common/cache/short-cache.service';

export type StoredRefreshToken = {
  userId: string;
  expiresAt: number;
};

@Injectable()
export class RefreshTokenService {
  private readonly prefix = 'auth:refresh:';
  private readonly userPointerPrefix = 'auth:refresh:user:';
  private readonly ttlSeconds: number;
  private readonly singleSession: boolean;

  constructor(
    private readonly cache: ShortCacheService,
    config: ConfigService,
  ) {
    const days = config.get<number>('JWT_REFRESH_DAYS', 7);
    this.ttlSeconds = Math.max(1, days) * 24 * 60 * 60;
    this.singleSession = config.get<boolean>('SINGLE_SESSION_ENFORCED', false) === true;
  }

  async issue(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const tokenKey = this.key(token);

    if (this.singleSession) {
      const pointer = await this.cache.getJson<{ key: string }>(this.userPointerKey(userId));
      if (pointer && pointer.key && pointer.key !== tokenKey) {
        await this.cache.del(pointer.key);
      }
      await this.cache.setJson(this.userPointerKey(userId), { key: tokenKey }, this.ttlSeconds);
    }

    const record: StoredRefreshToken = {
      userId,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    };
    await this.cache.setJson(tokenKey, record, this.ttlSeconds);
    return token;
  }

  async consume(token: string): Promise<string | null> {
    if (!token?.trim()) return null;

    const tokenKey = this.key(token);
    const record = await this.cache.getJson<StoredRefreshToken>(tokenKey);
    await this.cache.del(tokenKey);

    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }

    return record.userId;
  }

  async revoke(token: string): Promise<void> {
    if (!token?.trim()) return;

    const tokenKey = this.key(token);
    const record = await this.cache.getJson<StoredRefreshToken>(tokenKey);
    await this.cache.del(tokenKey);

    if (record && this.singleSession) {
      const pointer = await this.cache.getJson<{ key: string }>(this.userPointerKey(record.userId));
      if (pointer && pointer.key === tokenKey) {
        await this.cache.del(this.userPointerKey(record.userId));
      }
    }
  }

  private key(token: string) {
    const hash = createHash('sha256').update(token).digest('hex');
    return `${this.prefix}${hash}`;
  }

  private userPointerKey(userId: string) {
    return `${this.userPointerPrefix}${userId}`;
  }
}
