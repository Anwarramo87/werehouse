import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';
import { AdminController } from '../admin/admin.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [LeavesController, AdminController],
  providers: [LeavesService],
  exports: [LeavesService],
})
export class LeavesModule {}
