import { Module } from '@nestjs/common';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditService } from '../common/services/audit.service';

@Module({
  imports: [NotificationsModule],
  controllers: [QualityController],
  providers: [QualityService, AuditService],
  exports: [QualityService],
})
export class QualityModule {}
