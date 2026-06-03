import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestWithCorrelationId } from '../types/request-context.types';

export type AuditEvent = {
  action: string;
  actorId?: string;
  actorUsername?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AUDIT');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * يُسجّل الحدث في الـ logger ويحفظه في جدول AuditLog بقاعدة البيانات.
   * لا يُوقف تنفيذ الطلب إذا فشل الحفظ في DB.
   */
  log(event: AuditEvent, req?: Request): void {
    const request = req as RequestWithCorrelationId | undefined;
    const correlationId = request
      ? request.correlationId || request.headers?.['x-correlation-id']
      : null;

    const ipAddress = request?.ip || request?.socket?.remoteAddress || null;
    const userAgent = request?.headers?.['user-agent'] || null;

    const logEntry = {
      timestamp: new Date().toISOString(),
      correlationId,
      action: event.action,
      actorId: event.actorId || null,
      actorUsername: event.actorUsername || null,
      targetType: event.targetType || null,
      targetId: event.targetId || null,
      metadata: event.metadata || {},
      path: request?.originalUrl || null,
      method: request?.method || null,
      ipAddress,
    };

    // 1. كتابة في الـ logger (sync — لا تُوقف التنفيذ)
    this.logger.log(JSON.stringify(logEntry));

    // 2. حفظ في قاعدة البيانات (async — fire and forget)
    this.prisma.auditLog
      .create({
        data: {
          actorId: event.actorId || null,
          actorUsername: event.actorUsername || null,
          action: event.action,
          targetType: event.targetType || null,
          targetId: event.targetId || null,
          ipAddress,
          userAgent,
          metadata: event.metadata
            ? { ...(event.metadata as Record<string, unknown>), correlationId }
            : { correlationId },
        },
      })
      .catch((err: unknown) => {
        // لا نُوقف الطلب إذا فشل حفظ الـ audit
        this.logger.error('Failed to persist audit log to DB', err);
      });
  }
}
