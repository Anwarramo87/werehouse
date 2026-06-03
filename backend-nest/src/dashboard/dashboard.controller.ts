import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

@ApiTags('dashboard')
@ApiCookieAuth()
@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /api/dashboard/home
   * بيانات لوحة التحكم الرئيسية:
   * - إجمالي الموظفين
   * - حضور اليوم (عدد + أسماء)
   * - الغياب (عدد + أسماء)
   * - الرواتب المستحقة (مجموع)
   * - التأخير (إجمالي دقائق + تفاصيل كل موظف)
   * - العمل الإضافي (إجمالي دقائق + تفاصيل كل موظف)
   */
  @Get('home')
  @Permissions('view_employees')
  getHomeStats() {
    return this.dashboardService.getHomeStats();
  }
}
