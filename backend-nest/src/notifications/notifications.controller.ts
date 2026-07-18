import { Controller, Get, Post, Query, Body, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto, MarkReadDto, DismissNotificationDto } from './dto/notifications.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @Permissions('notifications.view')
  list(@Query() query: ListNotificationsQueryDto) {
    return this.notificationsService.list({
      unreadOnly: query.unreadOnly === 'true' || query.unreadOnly === '1',
      type: query.type,
      limit: query.limit ? Number(query.limit) : 30,
      cursor: query.cursor,
    });
  }

  @Get('unread-count')
  @Permissions('notifications.view')
  unreadCount() {
    return this.notificationsService.getUnreadCount();
  }

  @Post('mark-all-read')
  @Permissions('notifications.view')
  markAllRead() {
    return this.notificationsService.markAllRead();
  }

  @Post('mark-read')
  @Permissions('notifications.view')
  markRead(@Body() dto: MarkReadDto) {
    if (!dto.id) {
      return { message: 'Notification id is required' };
    }
    return this.notificationsService.markRead(dto.id);
  }

  @Post('dismiss')
  @Permissions('notifications.view')
  dismiss(@Body() dto: DismissNotificationDto, @CurrentUser() user: { userId?: string }) {
    return this.notificationsService.dismiss(dto.id, dto.dedupeKey, user?.userId);
  }
}
