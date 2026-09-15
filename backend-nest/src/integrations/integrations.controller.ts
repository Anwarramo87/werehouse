import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@ApiTags('integrations')
@ApiCookieAuth()
@Controller('integrations')
@UseGuards(JwtAuthGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('admin.integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  // -------------------------------------------------------------- connections

  @Get('connections')
  @Permissions('manage_users')
  list() {
    return this.integrations.list();
  }

  @Get('connections/:connectionId')
  @Permissions('manage_users')
  get(@Param('connectionId') connectionId: string) {
    return this.integrations.get(connectionId);
  }

  @Post('connections')
  @Permissions('manage_users')
  create(@Body() dto: CreateConnectionDto) {
    return this.integrations.create(dto);
  }

  @Put('connections/:connectionId')
  @Permissions('manage_users')
  update(@Param('connectionId') connectionId: string, @Body() dto: UpdateConnectionDto) {
    return this.integrations.update(connectionId, dto);
  }

  @Delete('connections/:connectionId')
  @Permissions('manage_users')
  remove(@Param('connectionId') connectionId: string) {
    return this.integrations.remove(connectionId);
  }

  @Post('connections/:connectionId/test')
  @Permissions('manage_users')
  test(@Param('connectionId') connectionId: string) {
    return this.integrations.testConnection(connectionId);
  }

  /** Pushes current availability to the storefront now. */
  @Post('connections/:connectionId/push-stock')
  @Permissions('edit_inventory')
  pushStock(@Param('connectionId') connectionId: string, @Body() body: { skus?: string[] }) {
    return this.integrations.pushStock(connectionId, body?.skus);
  }

  @Get('connections/:connectionId/logs')
  @Permissions('manage_users')
  logs(@Param('connectionId') connectionId: string, @Query('limit') limit?: string) {
    return this.integrations.syncLogs(connectionId, limit ? Number(limit) : 50);
  }

  // ----------------------------------------------------------------- webhooks

  @Get('webhooks')
  @Permissions('manage_users')
  listWebhooks() {
    return this.integrations.listWebhooks();
  }

  @Post('webhooks')
  @Permissions('manage_users')
  createWebhook(@Body() dto: CreateWebhookDto) {
    return this.integrations.createWebhook(dto);
  }

  @Delete('webhooks/:webhookId')
  @Permissions('manage_users')
  deleteWebhook(@Param('webhookId') webhookId: string) {
    return this.integrations.deleteWebhook(webhookId);
  }
}
