/**
 * إعدادات Winston Logger
 * - Development: ألوان readable في الكونسول
 * - Production: JSON structured logging لتوافق مع Datadog / CloudWatch / ELK
 */
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * فورمات development: ألوان + timestamp + اسم الـ context
 */
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.ms(),
  nestWinstonModuleUtilities.format.nestLike('HRM', {
    colors: true,
    prettyPrint: true,
  }),
);

/**
 * فورمات production: JSON مضغوط مع correlation ID
 */
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const winstonConfig: winston.LoggerOptions = {
  level: isDev ? 'debug' : 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
    }),
    // في production يمكن إضافة File transport أو HTTP transport لـ Datadog:
    // new winston.transports.Http({ host: 'http-intake.logs.datadoghq.com', ... })
  ],
  exitOnError: false,
};
