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

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

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

    if (statusCode >= 400) {
      this.logger.warn(
        JSON.stringify({
          correlationId,
          method: request.method,
          path: request.originalUrl,
          statusCode,
          message,
          body: statusCode === 400 ? request.body : undefined,
        }),
      );
    }

    if (statusCode >= 500) {
      this.logger.error(
        JSON.stringify({
          correlationId,
          method: request.method,
          path: request.originalUrl,
          statusCode,
          message,
        }),
      );
    }

    response.status(statusCode).json({
      success: false,
      error: {
        statusCode,
        message,
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
