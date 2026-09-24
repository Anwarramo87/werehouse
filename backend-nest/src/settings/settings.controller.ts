import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { SettingsService, UpdateSettingsDto } from './settings.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

@Controller('settings/system')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  private requireTenant(user: AuthenticatedUser): string {
    if (!user.tenantId) throw new ForbiddenException('لا يوجد tenant للمستخدم');
    return user.tenantId;
  }

  @Get()
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getSettings(this.requireTenant(user));
  }

  @Patch()
  updateSettings(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      throw new ForbiddenException('تعديل الإعدادات للمسؤول فقط');
    }
    return this.settings.updateSettings(this.requireTenant(user), dto);
  }
}
