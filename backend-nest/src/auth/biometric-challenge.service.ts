import { Injectable } from '@nestjs/common';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { BIOMETRIC_CHALLENGE_TTL_SECONDS } from '../common/constants/auth.constants';

export type BiometricChallengePurpose = 'REGISTER' | 'LOGIN';

export interface BiometricChallengeRecord {
  id: string;
  userId: string;
  purpose: BiometricChallengePurpose;
  challengeHash: string;
  challengeBase64: string;
  expiresAt: number;
  usedAt?: string;
  keyId?: string;
  pendingPublicKeyBase64?: string;
  pendingDeviceName?: string;
}

@Injectable()
export class BiometricChallengeService {
  private readonly prefix = 'auth:biometric-challenge:';

  constructor(private readonly cache: ShortCacheService) {}

  async save(record: BiometricChallengeRecord): Promise<void> {
    await this.cache.setJson(this.key(record.id), record, BIOMETRIC_CHALLENGE_TTL_SECONDS);
  }

  async consume(
    challengeId: string,
    purpose: BiometricChallengePurpose,
    userId?: string,
  ): Promise<BiometricChallengeRecord | null> {
    const record = await this.cache.getJson<BiometricChallengeRecord>(this.key(challengeId));
    if (!record) {
      return null;
    }

    await this.cache.del(this.key(challengeId));

    if (record.usedAt || record.expiresAt < Date.now() || record.purpose !== purpose) {
      return null;
    }

    if (userId && record.userId !== userId) {
      return null;
    }

    return record;
  }

  private key(id: string) {
    return `${this.prefix}${id}`;
  }
}
