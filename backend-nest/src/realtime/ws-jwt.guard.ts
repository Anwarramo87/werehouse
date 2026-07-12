import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
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
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);
  private readonly cookieName: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly shortCache: ShortCacheService,
    private readonly prisma: PrismaService,
  ) {
    this.cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient<Socket>();

    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`WS connection rejected — no token (socket ${client.id})`);
      client.disconnect(true);
      throw new WsException('Unauthorized: missing token');
    }

    let payload: AuthenticatedUser;
    try {
      payload = this.jwtService.verify<AuthenticatedUser>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      this.logger.warn(`WS connection rejected — invalid/expired token (socket ${client.id})`);
      client.disconnect(true);
      throw new WsException('Unauthorized: invalid or expired token');
    }

    if (!payload?.userId) {
      client.disconnect(true);
      throw new WsException('Unauthorized: malformed token payload');
    }

    if (await this.tokenRevocation.isRevoked(token)) {
      this.logger.warn(`WS connection rejected — revoked token (socket ${client.id})`);
      client.disconnect(true);
      throw new WsException('Unauthorized: session revoked');
    }

    const cacheKey = `jwt-user:${payload.userId}`;
    const user =
      (await this.shortCache.getJson<CachedAuthUser>(cacheKey)) ??
      (await this.shortCache.getOrSetJson(cacheKey, JWT_USER_CACHE_TTL_SECONDS, async () => {
        const dbUser = await this.prisma.user.findUnique({
          where: { id: payload.userId },
          include: { role: true },
        });

        if (!dbUser || dbUser.status !== 'active') {
          throw new WsException('Unauthorized: account inactive');
        }

        const roleName = dbUser.role?.name || 'staff';
        return {
          userId: dbUser.id,
          username: dbUser.username,
          email: dbUser.email ?? undefined,
          role: roleName,
          roles: [roleName],
          permissions: dbUser.role?.permissions || [],
        };
      }));

    // Attach resolved user to socket data for downstream use
    client.data.user = user;

    return true;
  }

  private extractToken(client: Socket): string | null {
    // 1. HttpOnly cookie (preferred — set by the auth login endpoint)
    const cookieHeader = client.handshake.headers?.cookie;
    if (cookieHeader) {
      const match = new RegExp(`(?:^|;\\s*)${this.cookieName}=([^;]+)`).exec(cookieHeader);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }

    // 2. Handshake auth payload (for clients that can't send cookies)
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim();
    }

    return null;
  }
}
