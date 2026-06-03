import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { DailyLogsService } from './daily-logs.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateDailyLogDto } from './dto/create-daily-log.dto';
import { UpdateDailyLogDto } from './dto/update-daily-log.dto';
import { DailyLogQueryDto } from './dto/daily-log-query.dto';
import { MonthlySummaryQueryDto } from './dto/monthly-summary-query.dto';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

@ApiTags('attendance')
@ApiCookieAuth()
@Controller('attendance/daily-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DailyLogsController {
  constructor(private readonly dailyLogsService: DailyLogsService) {}

  /**
   * إنشاء سجل يومي جديد
   * POST /attendance/daily-logs
   */
  @Post()
  @Permissions('edit_attendance')
  create(@Body() dto: CreateDailyLogDto, @CurrentUser() user: AuthenticatedUser) {
    return this.dailyLogsService.create(dto, user?.userId);
  }

  /**
   * الحصول على قائمة السجلات اليومية مع الفلترة
   * GET /attendance/daily-logs
   */
  @Get()
  @Permissions('view_attendance')
  list(@Query() query: DailyLogQueryDto) {
    return this.dailyLogsService.list(query);
  }

  /**
   * الحصول على المجاميع الشهرية لجميع الموظفين
   * GET /attendance/daily-logs/summary/all?month=2026-05
   */
  @Get('summary/all')
  @Permissions('view_attendance')
  getAllEmployeesMonthlySummary(@Query() query: MonthlySummaryQueryDto) {
    return this.dailyLogsService.getAllEmployeesMonthlySummary(query.month);
  }

  /**
   * الحصول على المجاميع الشهرية لموظف محدد
   * GET /attendance/daily-logs/summary/:employeeId?month=2026-05
   */
  @Get('summary/:employeeId')
  @Permissions('view_attendance')
  getMonthlySummary(
    @Param('employeeId') employeeId: string,
    @Query() query: MonthlySummaryQueryDto,
  ) {
    return this.dailyLogsService.getMonthlySummary(employeeId, query.month);
  }

  /**
   * الحصول على السجلات اليومية لموظف في شهر محدد
   * GET /attendance/daily-logs/employee/:employeeId/month/:month
   */
  @Get('employee/:employeeId/month/:month')
  @Permissions('view_attendance')
  getEmployeeMonthLogs(
    @Param('employeeId') employeeId: string,
    @Param('month') month: string,
  ) {
    return this.dailyLogsService.getEmployeeMonthLogs(employeeId, month);
  }

  /**
   * الحصول على سجل يومي محدد
   * GET /attendance/daily-logs/:logId
   */
  @Get(':logId')
  @Permissions('view_attendance')
  getById(@Param('logId') logId: string) {
    return this.dailyLogsService.getById(logId);
  }

  /**
   * تحديث سجل يومي
   * PUT /attendance/daily-logs/:logId
   */
  @Put(':logId')
  @Permissions('edit_attendance')
  update(@Param('logId') logId: string, @Body() dto: UpdateDailyLogDto) {
    return this.dailyLogsService.update(logId, dto);
  }

  /**
   * حذف سجل يومي
   * DELETE /attendance/daily-logs/:logId
   */
  @Delete(':logId')
  @Permissions('edit_attendance')
  remove(@Param('logId') logId: string) {
    return this.dailyLogsService.remove(logId);
  }
}
