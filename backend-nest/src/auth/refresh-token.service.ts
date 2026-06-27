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
  private readonly ttlSeconds: number;

  constructor(
    private readonly cache: ShortCacheService,
    config: ConfigService,
  ) {
    const days = config.get<number>('JWT_REFRESH_DAYS', 7);
    this.ttlSeconds = Math.max(1, days) * 24 * 60 * 60;
  }

  async issue(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const record: StoredRefreshToken = {
      userId,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    };
    await this.cache.setJson(this.key(token), record, this.ttlSeconds);
    return token;
  }

  async consume(token: string): Promise<string | null> {
    if (!token?.trim()) return null;

    const record = await this.cache.getJson<StoredRefreshToken>(this.key(token));
    await this.cache.del(this.key(token));

    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }

    return record.userId;
  }

  async revoke(token: string): Promise<void> {
    if (!token?.trim()) return;
    await this.cache.del(this.key(token));
  }

  private key(token: string) {
    const hash = createHash('sha256').update(token).digest('hex');
    return `${this.prefix}${hash}`;
  }
}
