import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { RequestWithCorrelationId } from '../types/request-context.types';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const incomingCorrelationId = req.headers['x-correlation-id'];
    const correlationId =
      typeof incomingCorrelationId === 'string' && incomingCorrelationId
        ? incomingCorrelationId
        : randomUUID();

    req.headers['x-correlation-id'] = correlationId;
    (req as RequestWithCorrelationId).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const elapsedNs = process.hrtime.bigint() - startedAt;
      const latencyMs = Number(elapsedNs) / 1_000_000;
      const route = req.route?.path ?? req.path ?? 'unknown';
      const statusCode = String(res.statusCode);

      this.metrics.httpRequestDuration.observe(
        { method: req.method, route, status_code: statusCode },
        latencyMs,
      );

      if (res.statusCode >= 400) {
        this.metrics.httpErrorsTotal.inc({ method: req.method, route, status_code: statusCode });
      }

      const userId = (req as RequestWithCorrelationId & { user?: { id?: unknown } }).user?.id;

      this.logger.log(
        JSON.stringify({
          correlationId,
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          latencyMs: Number(latencyMs.toFixed(2)),
          ip: req.ip,
          userAgent: req.get('user-agent') || '',
          ...(userId !== undefined && { userId }),
        }),
      );
    });

    next();
  }
}
