import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { WmsSetupService } from './wms-setup.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

@Controller('wms-setup')
@UseGuards(JwtAuthGuard)
export class WmsSetupController {
  constructor(private readonly wmsSetup: WmsSetupService) {}

  private requireTenant(user: AuthenticatedUser): string {
    if (!user.tenantId) throw new ForbiddenException('لا يوجد tenant للمستخدم');
    return user.tenantId;
  }

  /** جلب حالة الـSetup */
  @Get('state')
  getState(@CurrentUser() user: AuthenticatedUser) {
    return this.wmsSetup.getState(this.requireTenant(user));
  }

  /** فحص هل الـSetup مكتمل */
  @Get('completed')
  async isCompleted(@CurrentUser() user: AuthenticatedUser) {
    const completed = await this.wmsSetup.isCompleted(this.requireTenant(user));
    return { isCompleted: completed };
  }

  /** حفظ بيانات خطوة والانتقال للتالية */
  @Post('step/:step')
  saveStep(
    @Param('step', ParseIntPipe) step: number,
    @Body() data: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.wmsSetup.saveStep(this.requireTenant(user), step, data);
  }

  /** الانتقال لخطوة سابقة */
  @Patch('goto/:step')
  goToStep(
    @Param('step', ParseIntPipe) step: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.wmsSetup.goToStep(this.requireTenant(user), step);
  }

  /** إكمال الـSetup */
  @Post('complete')
  completeSetup(@CurrentUser() user: AuthenticatedUser) {
    return this.wmsSetup.completeSetup(this.requireTenant(user));
  }

  /** إعادة تعيين الـSetup (Admin فقط) */
  @Post('reset')
  resetSetup(@CurrentUser() user: AuthenticatedUser) {
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      throw new ForbiddenException('هذه العملية للمسؤول فقط');
    }
    return this.wmsSetup.resetSetup(this.requireTenant(user));
  }
}
