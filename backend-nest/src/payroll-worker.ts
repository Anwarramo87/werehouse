// payroll-worker.ts
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PayrollWorkerModule } from './payroll/payroll-worker.module';

async function bootstrap() {
  const logger = new Logger('PayrollWorker');
  
  // إنشاء تطبيق "رأسي" (Headless) خفيف جداً للأداء
  const app = await NestFactory.createApplicationContext(PayrollWorkerModule, {
    logger: ['error', 'warn', 'log', 'debug'], // تحكم أفضل في السجلات
  });

  // تفعيل خطافات الإغلاق لضمان سلامة البيانات
  app.enableShutdownHooks();

  logger.log('✅ Payroll worker started and listening for queued jobs');

  // دالة الإغلاق الآمن مع Timeout
  const shutdown = async (signal: string) => {
    logger.warn(`⚠️ Received ${signal}, starting graceful shutdown...`);
    
    // تحديد وقت أقصى للإغلاق (مثلاً 10 ثوانٍ) لضمان عدم تعليق العملية
    const forceExitTimeout = setTimeout(() => {
      logger.error('🚨 Graceful shutdown timed out, forcing exit.');
      process.exit(1);
    }, 10000);

    try {
      await app.close();
      clearTimeout(forceExitTimeout);
      logger.log('🛑 Payroll worker shut down cleanly.');
      process.exit(0);
    } catch (err) {
      logger.error('❌ Error during shutdown:', err);
      process.exit(1);
    }
  };

  // التعامل مع إشارات نظام التشغيل
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  
  // التعامل مع الأخطاء غير المتوقعة داخل الـ Worker
  process.on('unhandledRejection', (reason) => {
    logger.error(`🔥 Unhandled Rejection in Worker: ${reason}`);
  });
}

bootstrap().catch((error) => {
  const logger = new Logger('PayrollWorker-Fatal');
  logger.error(
    '💥 Payroll worker failed to start', 
    error instanceof Error ? error.stack : JSON.stringify(error)
  );
  process.exit(1);
});