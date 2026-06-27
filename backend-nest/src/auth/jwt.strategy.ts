import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { RequestWithCookies } from '../common/types/request-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { TokenRevocationService } from './token-revocation.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { JWT_USER_CACHE_TTL_SECONDS } from '../common/constants/auth.constants';

type CachedAuthUser = {
  userId: string;
  username: string;
  email?: string;
  role: string;
  roles: string[];
  permissions: string[];
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly cookieName: string;
  private readonly allowBearer: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly shortCache: ShortCacheService,
  ) {
    const cookieName = config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
    const nodeEnv = config.get<string>('NODE_ENV', 'development');
    const allowBearer = config.get<boolean>('JWT_ALLOW_BEARER', nodeEnv !== 'production');

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => (req as RequestWithCookies)?.cookies?.[cookieName] || null,
        ...(allowBearer ? [ExtractJwt.fromAuthHeaderAsBearerToken()] : []),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });

    this.cookieName = cookieName;
    this.allowBearer = allowBearer;
  }

  async validate(req: Request, payload: AuthenticatedUser): Promise<AuthenticatedUser> {
    if (!payload?.userId) {
      throw new UnauthorizedException('Invalid token');
    }

    const rawToken = this.extractRawToken(req);
    if (!rawToken || (await this.tokenRevocation.isRevoked(rawToken))) {
      throw new UnauthorizedException('Session expired, please sign in again');
    }

    const cacheKey = `jwt-user:${payload.userId}`;
    const cached = await this.shortCache.getJson<CachedAuthUser>(cacheKey);

    const resolved =
      cached ??
      (await this.shortCache.getOrSetJson(cacheKey, JWT_USER_CACHE_TTL_SECONDS, async () => {
        const user = await this.prisma.user.findUnique({
          where: { id: payload.userId },
          include: { role: true },
        });

        if (!user || user.status !== 'active') {
          throw new UnauthorizedException('Account is no longer active');
        }

        const roleName = user.role?.name || 'staff';
        return {
          userId: user.id,
          username: user.username,
          email: user.email ?? undefined,
          role: roleName,
          roles: [roleName],
          permissions: user.role?.permissions || [],
        };
      }));

    return {
      ...resolved,
      iat: payload.iat,
      exp: payload.exp,
    };
  }

  private extractRawToken(req: Request): string | null {
    const cookieToken = (req as RequestWithCookies)?.cookies?.[this.cookieName];
    if (cookieToken) return cookieToken;

    if (this.allowBearer) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
      }
    }

    return null;
  }
}
