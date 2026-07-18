import { Module } from '@nestjs/common';
import { PenaltiesController } from './penalties.controller';
import { PenaltiesService } from './penalties.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PenaltiesController],
  providers: [PenaltiesService],
  exports: [PenaltiesService],
})
export class PenaltiesModule {}
