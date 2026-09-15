import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { RequestWithCorrelationId } from '../types/request-context.types';

type ExceptionResponseShape = {
  message?: string | string[];
};

/** What a client is told when the server broke and the reason is internal. */
const OPAQUE_SERVER_ERROR = 'Internal server error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestWithCorrelationId>();
    const response = ctx.getResponse<Response>();

    const correlationId = request.correlationId || request.headers['x-correlation-id'] || null;

    const isHttpException = exception instanceof HttpException;
    const isDbConnectionError = this.isDatabaseConnectionError(exception);
    const statusCode = isDbConnectionError
      ? HttpStatus.SERVICE_UNAVAILABLE
      : isHttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = isHttpException ? exception.getResponse() : null;
    const message = isDbConnectionError
      ? 'Database connection failed. Check DATABASE_URL or database availability.'
      : this.extractMessage(exceptionResponse, exception);

    // What the client is told and what the log records deliberately diverge for
    // 5xx: an unhandled exception's message is written by whatever threw it --
    // a Prisma error naming columns, a tenant-scope failure naming internals --
    // and none of that belongs in a response body. The correlation id is the
    // bridge: the user quotes it, the log has the detail.
    const clientMessage =
      this.isProduction && statusCode >= 500 && !isHttpException && !isDbConnectionError
        ? OPAQUE_SERVER_ERROR
        : message;

    if (statusCode >= 500) {
      this.logger.error(
        JSON.stringify({
          correlationId,
          method: request.method,
          path: request.originalUrl,
          statusCode,
          message,
        }),
        // Without the stack a production 500 is undiagnosable: the log line
        // named the message but never where it came from.
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (statusCode >= 400) {
      this.logger.warn(
        JSON.stringify({
          correlationId,
          method: request.method,
          path: request.originalUrl,
          statusCode,
          message,
        }),
      );
    }

    // Hint the frontend not to retry on client errors (4xx)
    if (statusCode >= 400 && statusCode < 500) {
      response.setHeader('X-Should-Retry', 'false');
    }

    response.status(statusCode).json({
      success: false,
      error: {
        statusCode,
        message: clientMessage,
        code: this.resolveErrorCode(statusCode),
      },
      metadata: {
        correlationId,
        timestamp: new Date().toISOString(),
        path: request.originalUrl,
        method: request.method,
      },
    });
  }

  private extractMessage(exceptionResponse: unknown, exception: unknown) {
    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const maybeMessage = (exceptionResponse as ExceptionResponseShape).message;
      if (Array.isArray(maybeMessage)) {
        return maybeMessage.join(', ');
      }
      if (typeof maybeMessage === 'string') {
        return maybeMessage;
      }
    }

    if (exception instanceof Error) {
      return exception.message;
    }

    return 'Internal server error';
  }

  private resolveErrorCode(statusCode: number) {
    if (statusCode === 400) return 'BAD_REQUEST';
    if (statusCode === 401) return 'UNAUTHORIZED';
    if (statusCode === 403) return 'FORBIDDEN';
    if (statusCode === 404) return 'NOT_FOUND';
    if (statusCode === 429) return 'TOO_MANY_REQUESTS';
    if (statusCode === 503) return 'SERVICE_UNAVAILABLE';
    if (statusCode >= 500) return 'INTERNAL_SERVER_ERROR';
    return 'REQUEST_FAILED';
  }

  private isDatabaseConnectionError(exception: unknown) {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return ['ECONNREFUSED', 'P1001', 'P1002'].includes(exception.code);
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return true;
    }

    if (exception instanceof Error) {
      return /ECONNREFUSED|Connection refused/i.test(exception.message);
    }

    return false;
  }
}
