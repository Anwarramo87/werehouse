// main.ts
import 'dotenv/config';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
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

  if (allowed.has('*')) {
    return { origin: true, credentials: true };
  }

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
    origin: isProd ? false : true,
    credentials: true,
  };
};

// -----------------------------------------------------------------------------
// 3. Main Bootstrap function
// -----------------------------------------------------------------------------
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);
  const prismaService = app.get(PrismaService);

  const isProd = configService.get<string>('NODE_ENV') === 'production';
  const port = configService.get<number>('PORT', 3000);
  const host = configService.get<string>('HOST', '0.0.0.0');

  // --- Security & Proxy ---
  const trustProxy = configService.get<boolean>('TRUST_PROXY', isProd);
  if (trustProxy) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  // --- Shutdown Hooks ---
  app.enableShutdownHooks();
  await prismaService.enableShutdownHooks(app);

  // --- Global Prefix + Versioning ---
  // الـ health endpoint يبقى على /api/health بدون versioning
  // كل الـ endpoints الأخرى تصبح /api/v1/...
  // لإضافة v2 مستقبلاً: أضف @Version('2') على الـ controller الجديد
  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready'],
  });

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  // --- Global Middlewares ---
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
    new ZodValidationPipe(),           // Zod validation for DTOs using Zod schemas
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // --- CORS Configuration ---
  const corsOrigin = configService.get<string>('CORS_ORIGIN', '');
  app.enableCors(buildCorsOptions(corsOrigin, isProd));

  // --- Swagger (متاح فقط في dev أو إذا تم تفعيله صراحة) ---
  const swaggerEnabled = configService.get<boolean>('SWAGGER_ENABLED', !isProd);
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('HRM Warehouse API')
      .setDescription(
        'نظام إدارة الموارد البشرية والمستودعات — توثيق كامل لجميع الـ endpoints',
      )
      .setVersion('1.0')
      .addTag('auth', 'المصادقة وإدارة الجلسات')
      .addTag('employees', 'إدارة الموظفين')
      .addTag('attendance', 'سجلات الحضور والغياب')
      .addTag('payroll', 'حساب الرواتب')
      .addTag('salary', 'إعدادات الراتب والبدلات')
      .addTag('advances', 'السلف والقروض')
      .addTag('bonuses', 'العلاوات والمساعدات')
      .addTag('penalties', 'الغرامات والخصومات')
      .addTag('leaves', 'طلبات الإجازات')
      .addTag('insurance', 'التأمين الاجتماعي')
      .addTag('devices', 'أجهزة البصمة')
      .addTag('transportation', 'إدارة الباصات والنقل')
      .addTag('inventory', 'المنتجات والمستودع')
      .addTag('dashboard', 'إحصائيات لوحة التحكم')
      .addTag('departments', 'الأقسام')
      .addTag('finances', 'الملخص المالي')
      .addTag('imports', 'استيراد البيانات بالجملة')
      .addTag('files', 'إدارة الملفات')
      .addTag('health', 'فحص صحة السيرفر')
      .addCookieAuth('warehouse_access_token', {
        type: 'apiKey',
        in: 'cookie',
        name: 'warehouse_access_token',
        description: 'JWT token stored in HttpOnly cookie after login',
      })
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        displayRequestDuration: true,
      },
    });

    logger.log(`📚 Swagger UI available at: http://localhost:${port}/api/docs`);
  }

  // --- Start Server ---
  await app.listen(port, host);
  logger.log(`🚀 Server running on port ${port} in ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
  logger.log(`🔗 API base URL: http://${host}:${port}/api/v1`);
}

bootstrap().catch((err) => {
  logger.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
