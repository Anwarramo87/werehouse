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

type SocketUser = { userId: string; role?: string; roles?: string[] };

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

      const dbUser = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { role: true },
      });

      if (!dbUser || dbUser.status !== 'active') {
        client.disconnect(true);
        return;
      }

      const roleName = dbUser.role?.name || 'staff';
      const user: SocketUser = { userId: dbUser.id, role: roleName, roles: [roleName] };
      client.data.user = user;
      this.logger.log(`WS client connected: socket=${client.id} userId=${user.userId} role=${user.role}`);
    } catch {
      this.logger.warn(`WS connection rejected — invalid token (socket ${client.id})`);
      client.disconnect(true);
    }
  }

  emitAttendanceUpdate(payload: AttendanceUpdateEventPayload) {
    if (!this.server) {
      this.logger.warn('Realtime server is not initialized yet; attendance event skipped');
      return;
    }

    this.server.emit('attendanceUpdate', payload);
  }

  emitNotification(payload: NotificationRealtimePayload) {
    if (!this.server) {
      this.logger.warn('Realtime server is not initialized yet; notification event skipped');
      return;
    }

    this.server.emit('notification', payload);
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
