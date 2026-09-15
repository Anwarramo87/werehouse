import { Logger, OnModuleInit, UseGuards } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WsJwtGuard } from './ws-jwt.guard';
import { currentTenant, runUnscoped } from '../common/tenant/tenant-context';

export type AttendanceUpdateEventPayload = {
  employeeId: string;
  employeeName: string;
  type: 'IN' | 'OUT';
  timestamp: string;
  date: string;
  time: string;
  source: 'biometric';
  status: 'success';
  action: 'created' | 'updated';
  message: string;
};

type SocketUser = { userId: string; role?: string; roles?: string[]; tenantId: string | null };

const normalizeOrigin = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

const resolveSocketCorsOrigin = () => {
  const configuredOrigins = String(process.env.CORS_ORIGIN || '')
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins;
  }

  return process.env.NODE_ENV === 'production' ? false : true;
};

/** Room name carrying one factory's realtime traffic. */
const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;

@UseGuards(WsJwtGuard)
@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: resolveSocketCorsOrigin(),
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly cookieName: string;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'warehouse_access_token');
  }

  onModuleInit() {
    this.logger.log('RealtimeGateway initialized');
  }

  private extractToken(client: Socket): string | null {
    const cookieHeader = client.handshake.headers?.cookie;
    if (cookieHeader) {
      const match = new RegExp(`(?:^|;\\s*)${this.cookieName}=([^;]+)`).exec(cookieHeader);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
    return null;
  }

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`WS connection rejected — no token (socket ${client.id})`);
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify<{ userId?: string; sub?: string }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });

      const userId = payload.userId || payload.sub;
      if (!userId) {
        client.disconnect(true);
        return;
      }

      // A socket.io handshake never passes through Express, so TenantMiddleware
      // never ran and there is no ambient scope -- `user` is tenant-scoped, so
      // an unwrapped lookup here throws inside the extension, lands in the
      // catch below, and every single connection is dropped as "invalid token".
      // Looking a principal up by the id inside an already signature-verified
      // token is cross-tenant by nature, exactly as in JwtStrategy.
      const dbUser = await runUnscoped('ws-handshake', async () =>
        this.prisma.user.findUnique({
          where: { id: userId },
          include: { role: true },
        }),
      );

      if (!dbUser || dbUser.status !== 'active') {
        client.disconnect(true);
        return;
      }

      const roleName = dbUser.role?.name || 'staff';
      const user: SocketUser = {
        userId: dbUser.id,
        role: roleName,
        roles: [roleName],
        tenantId: dbUser.tenantId ?? null,
      };
      client.data.user = user;

      // Every socket joins its own factory's room. Without this the gateway
      // broadcast each notification and attendance punch to every connected
      // client on the server, so one factory saw another factory's staff names
      // and absences in its notification bell.
      if (user.tenantId) {
        await client.join(tenantRoom(user.tenantId));
      }

      this.logger.log(
        `WS client connected: socket=${client.id} userId=${user.userId} ` +
          `role=${user.role} tenant=${user.tenantId ?? 'none'}`,
      );
    } catch (error) {
      // The reason matters: an expired token and a server-side fault both
      // ended here as "invalid token", which is how a gateway that rejected
      // every connection went unnoticed.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`WS connection rejected (socket ${client.id}): ${reason}`);
      client.disconnect(true);
    }
  }

  /** The socket.io room carrying one factory's realtime traffic. */
  private target(): { emit: (event: string, payload: unknown) => void } | null {
    if (!this.server) return null;

    // The emitting call always runs inside a tenant scope: request handlers get
    // one from TenantMiddleware, the absence cron from runWithTenant. A missing
    // tenant means unscoped background work, and broadcasting that to everyone
    // is exactly the leak the rooms exist to prevent -- so drop it instead.
    const tenantId = currentTenant()?.tenantId;
    if (!tenantId) return null;

    return this.server.to(tenantRoom(tenantId));
  }

  emitAttendanceUpdate(payload: AttendanceUpdateEventPayload) {
    const target = this.target();
    if (!target) {
      this.logger.warn('No tenant-scoped realtime target; attendance event skipped');
      return;
    }

    target.emit('attendanceUpdate', payload);
  }

  emitNotification(payload: NotificationRealtimePayload) {
    const target = this.target();
    if (!target) {
      this.logger.warn('No tenant-scoped realtime target; notification event skipped');
      return;
    }

    target.emit('notification', payload);
  }
}

export type NotificationRealtimePayload = {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  employeeId?: string | null;
  employeeName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  createdAt: string;
};
