import { Injectable } from '@nestjs/common';
import { ShortCacheService } from '../common/cache/short-cache.service';

@Injectable()
export class AuthCacheService {
  private readonly jwtUserPrefix = 'jwt-user:';

  constructor(private readonly cache: ShortCacheService) {}

  async invalidateUser(userId: string): Promise<void> {
    if (!userId) return;
    await this.cache.del(`${this.jwtUserPrefix}${userId}`);
  }
}
