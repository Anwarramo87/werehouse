import { Logger, UseGuards } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
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
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    const user = client.data?.user as { userId?: string; role?: string } | undefined;
    if (!user?.userId) {
      // Guard already disconnected the socket; this is a safety net
      client.disconnect(true);
      return;
    }
    this.logger.log(`WS client connected: socket=${client.id} userId=${user.userId} role=${user.role}`);
  }

  emitAttendanceUpdate(payload: AttendanceUpdateEventPayload) {
    if (!this.server) {
      this.logger.warn('Realtime server is not initialized yet; attendance event skipped');
      return;
    }

    this.server.emit('attendanceUpdate', payload);
  }
}
