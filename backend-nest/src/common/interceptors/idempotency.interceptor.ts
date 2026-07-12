import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { ShortCacheService } from '../cache/short-cache.service';
import { AuthenticatedUser } from '../types/authenticated-user.types';

const IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes
const IDEMPOTENCY_HEADER = 'idempotency-key';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly cache: ShortCacheService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();

    const idempotencyKey = req.headers[IDEMPOTENCY_HEADER];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return next.handle();
    }

    const user = req.user as AuthenticatedUser | undefined;
    const userId = user?.userId ?? 'anonymous';
    const cacheKey = `idempotency:${userId}:${req.method}:${req.path}:${idempotencyKey.trim()}`;

    const cached = await this.cache.getJson<unknown>(cacheKey);
    if (cached !== null) {
      return of(cached);
    }

    return next.handle().pipe(
      tap(async (responseBody) => {
        await this.cache.setJson(cacheKey, responseBody, IDEMPOTENCY_TTL_SECONDS);
      }),
    );
  }
}
