// main.ts
import 'dotenv/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// -----------------------------------------------------------------------------
// 1. Global error handling
// -----------------------------------------------------------------------------
const logger = new Logger('Bootstrap');

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// -----------------------------------------------------------------------------
// 2. Helpers – CORS & Normalization
// -----------------------------------------------------------------------------
const normalizeOrigin = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

type OriginFunction = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void;

const buildCorsOptions = (rawOrigins: string, isProd: boolean) => {
  const splitted = rawOrigins
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  const allowed = new Set(splitted);

  const originCallback: OriginFunction = (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, allowed.has(normalizeOrigin(origin)));
  };

  if (splitted.length) {
    return { origin: originCallback, credentials: true };
  }

  return {
    origin: isProd ? false : [/^http:\/\/localhost:\d+$/i, /^http:\/\/127\.0\.0\.1:\d+$/i],
    credentials: true,
  };
};

// -----------------------------------------------------------------------------
// 3. Main Bootstrap function
// -----------------------------------------------------------------------------
async function bootstrap() {
  // تحديد نوع التطبيق كـ NestExpressApplication للوصول لميزات Express بأمان
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  const configService = app.get(ConfigService);
  const prismaService = app.get(PrismaService);
  
  const isProd = configService.get<string>('NODE_ENV') === 'production';
  const port = configService.get<number>('PORT', 5001);

  // --- Security & Proxy ---
  const trustProxy = configService.get<boolean>('TRUST_PROXY', isProd);
  if (trustProxy) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by'); // زيادة الأمان بإخفاء تقنية السيرفر

  // --- Shutdown Hooks ---
  app.enableShutdownHooks();
  await prismaService.enableShutdownHooks(app);

  // --- Global Middlewares ---
  app.setGlobalPrefix('api');
  
  app.use(helmet({
    hsts: isProd ? {
      maxAge: 15552000,
      includeSubDomains: true,
      preload: true,
    } : false,
  }));
  
  app.use(compression());
  app.use(cookieParser());

  // --- Global Filters & Pipes ---
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,               // حذف أي حقول إضافية غير موجودة في الـ DTO
      forbidNonWhitelisted: true,    // رفض الطلب إذا احتوى على حقول غير مصرح بها
      transform: true,               // تحويل البيانات لأنواعها المحددة في الـ DTO
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // --- CORS Configuration ---
  const corsOrigin = configService.get<string>('CORS_ORIGIN', '');
  app.enableCors(buildCorsOptions(corsOrigin, isProd));

  // --- Start Server ---
  await app.listen(port);
  logger.log(`🚀 Server running on port ${port} in ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error during bootstrap:', err);
  process.exit(1);
});