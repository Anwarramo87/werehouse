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
import { TransportationService } from './transportation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateBusDto } from './dto/create-bus.dto';
import { UpdateBusDto } from './dto/update-bus.dto';
import { AddPassengerDto } from './dto/add-passenger.dto';
import {
  BusDetailQueryDto,
  RecordBusAttendanceBatchDto,
  RecordBusAttendanceDto,
  UpdateBusSettingsDto,
} from './dto/bus-attendance.dto';
import { CalculateDeductionsDto } from '../attendance/dto/calculate-deductions.dto';
import {
  PERM_DELETE_TRANSPORTATION,
  PERM_EDIT_TRANSPORTATION,
  PERM_MANAGE_TRANSPORTATION,
  PERM_PRINT_TRANSPORTATION,
  PERM_VIEW_TRANSPORTATION,
} from '../common/permissions/permission.constants';

@ApiTags('transportation')
@ApiCookieAuth()
@Controller('transportation')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('hr.transportation')
export class TransportationController {
  constructor(private readonly transportationService: TransportationService) {}

  // ── settings ─────────────────────────────────────────────────────────────

  /** GET /api/transportation/settings — التكلفة اليومية الافتراضية وأيام العمل */
  @Get('settings')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  getSettings() {
    return this.transportationService.getSettings();
  }

  /** PUT /api/transportation/settings — تعديل التكلفة اليومية من الإعدادات */
  @Put('settings')
  @Permissions(PERM_MANAGE_TRANSPORTATION)
  updateSettings(
    @Body() dto: UpdateBusSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transportationService.updateSettings(dto, user.userId);
  }

  // ── summary card ─────────────────────────────────────────────────────────

  /**
   * GET /api/transportation/summary
   *
   * The card: fleet totals plus one line per bus, so nothing is merged away.
   */
  @Get('summary')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  summary() {
    return this.transportationService.summary();
  }

  /** GET /api/transportation/buses */
  @Get('buses')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  listBuses() {
    return this.transportationService.listBuses();
  }

  /** POST /api/transportation/buses */
  @Post('buses')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  createBus(@Body() dto: CreateBusDto) {
    return this.transportationService.createBus(dto);
  }

  /** GET /api/transportation/active-subscribers — map of employeeId → { route, plateNumber } */
  @Get('active-subscribers')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  getActiveSubscribers() {
    return this.transportationService.getActiveSubscribers();
  }

  /**
   * GET /api/transportation/buses/:busId
   *
   * The detail window behind the card: cost, beneficiaries, individual share,
   * company contribution, deductions and the daily attendance record.
   */
  @Get('buses/:busId')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  getBus(@Param('busId') busId: string, @Query() query: BusDetailQueryDto) {
    return this.transportationService.getBusDetail(busId, query);
  }

  /** PUT /api/transportation/buses/:busId */
  @Put('buses/:busId')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  updateBus(
    @Param('busId') busId: string,
    @Body() dto: UpdateBusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transportationService.updateBus(busId, dto, user.userId);
  }

  /** DELETE /api/transportation/buses/:busId */
  @Delete('buses/:busId')
  @Permissions(PERM_DELETE_TRANSPORTATION)
  deleteBus(@Param('busId') busId: string) {
    return this.transportationService.deleteBus(busId);
  }

  // ── daily attendance ─────────────────────────────────────────────────────

  /**
   * POST /api/transportation/buses/:busId/attendance
   *
   * Records one day: حضر / لم يحضر, with the date and notes. Recording the
   * same day again updates the row — it never creates a second one.
   */
  @Post('buses/:busId/attendance')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  recordAttendance(
    @Param('busId') busId: string,
    @Body() dto: RecordBusAttendanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transportationService.recordAttendance(busId, dto, user.userId);
  }

  /** POST /api/transportation/buses/:busId/attendance/batch — تسوية شهر كامل */
  @Post('buses/:busId/attendance/batch')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  recordAttendanceBatch(
    @Param('busId') busId: string,
    @Body() dto: RecordBusAttendanceBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transportationService.recordAttendanceBatch(
      busId,
      dto.entries,
      user.userId,
    );
  }

  /** GET /api/transportation/buses/:busId/attendance */
  @Get('buses/:busId/attendance')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  listAttendance(
    @Param('busId') busId: string,
    @Query() query: BusDetailQueryDto,
  ) {
    return this.transportationService.listAttendance(busId, query);
  }

  // ── passengers ───────────────────────────────────────────────────────────

  /** GET /api/transportation/buses/:busId/passengers */
  @Get('buses/:busId/passengers')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  listPassengers(@Param('busId') busId: string) {
    return this.transportationService.listPassengers(busId);
  }

  /** POST /api/transportation/buses/:busId/passengers */
  @Post('buses/:busId/passengers')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  addPassenger(@Param('busId') busId: string, @Body() dto: AddPassengerDto) {
    return this.transportationService.addPassenger(busId, dto);
  }

  /** DELETE /api/transportation/buses/:busId/passengers/:employeeId */
  @Delete('buses/:busId/passengers/:employeeId')
  @Permissions(PERM_EDIT_TRANSPORTATION)
  removePassenger(
    @Param('busId') busId: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.transportationService.removePassenger(busId, employeeId);
  }

  // ── printing / export ────────────────────────────────────────────────────

  /** GET /api/transportation/report — تقرير الطباعة والتصدير */
  @Get('report')
  @Permissions(PERM_PRINT_TRANSPORTATION)
  printReport(@Query() query: BusDetailQueryDto) {
    return this.transportationService.printReport(query);
  }

  // ── payroll integration ──────────────────────────────────────────────────

  /** POST /api/transportation/calculate-deductions */
  @Post('calculate-deductions')
  @Permissions(PERM_VIEW_TRANSPORTATION)
  calculateDeductions(@Body() dto: CalculateDeductionsDto) {
    return this.transportationService.calculateDeductions(dto);
  }
}
