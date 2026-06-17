import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

// ─── DTOs (inline, small enough to not warrant separate files) ────────────────

class AggregateDateDto {
  /** Target date in YYYY-MM-DD format */
  date!: string;
}

class AggregateRangeDto {
  /** Start date in YYYY-MM-DD format */
  startDate!: string;
  /** End date in YYYY-MM-DD format */
  endDate!: string;
}

class AggregateEmployeeDto {
  employeeId!: string;
  /** Target date in YYYY-MM-DD format */
  date!: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('attendance-aggregation')
@ApiCookieAuth()
@Controller('attendance/aggregation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AttendanceAggregationController {
  constructor(
    private readonly aggregationService: AttendanceAggregationService,
  ) {}

  /**
   * POST /attendance/aggregation/date
   * Run missing-minutes aggregation for ALL active employees on a single date.
   * Typically triggered by End-of-Day cron or manually by admin.
   */
  @Post('date')
  @Permissions('edit_attendance', 'run_payroll')
  async aggregateForDate(@Body() dto: AggregateDateDto) {
    if (!dto.date) {
      throw new BadRequestException('date is required (YYYY-MM-DD)');
    }
    return this.aggregationService.aggregateAllForDate(dto.date);
  }

  /**
   * POST /attendance/aggregation/range
   * Run aggregation for all active employees across a date range.
   * Useful for backfilling or re-calculating an entire payroll period.
   */
  @Post('range')
  @Permissions('edit_attendance', 'run_payroll')
  async aggregateForRange(@Body() dto: AggregateRangeDto) {
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException('startDate and endDate are required (YYYY-MM-DD)');
    }
    return this.aggregationService.aggregateRange(dto.startDate, dto.endDate);
  }

  /**
   * POST /attendance/aggregation/employee
   * Run aggregation for a single employee on a single date.
   * Useful for targeted recalculation after manual attendance corrections.
   */
  @Post('employee')
  @Permissions('edit_attendance')
  async aggregateForEmployee(@Body() dto: AggregateEmployeeDto) {
    if (!dto.employeeId || !dto.date) {
      throw new BadRequestException('employeeId and date are required');
    }
    return this.aggregationService.aggregateEmployeeDay(dto.employeeId, dto.date);
  }
}
