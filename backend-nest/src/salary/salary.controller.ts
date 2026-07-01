import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { SalaryService } from './salary.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { UpsertSalaryDto } from './dto/upsert-salary.dto';
import { CalculateAllowancesDto } from './dto/calculate-allowances.dto';
import { BulkRaiseDto } from './dto/bulk-raise.dto';

@ApiTags('salary')
@ApiCookieAuth()
@Controller('salary')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalaryController {
  constructor(private readonly salaryService: SalaryService) {}

  /**
   * POST /api/salary/calculate-allowances
   */
  @Post('calculate-allowances')
  @Permissions('manage_salary')
  calculateAllowances(@Body() dto: CalculateAllowancesDto) {
    return this.salaryService.calculateAllowances(dto);
  }

  /**
   * POST /api/salary/bulk-raise
   * يضيف مبلغ الزيادة على baseSalary بشكل دائم لكل الموظفين (أو موظف واحد)
   */
  @Post('bulk-raise')
  @Permissions('manage_salary')
  bulkRaise(@Body() dto: BulkRaiseDto) {
    return this.salaryService.bulkRaise(dto);
  }

  @Get()
  @Permissions('manage_salary')
  list() {
    return this.salaryService.list();
  }

  @Get(':employeeId')
  @Permissions('manage_salary')
  getOne(@Param('employeeId') employeeId: string) {
    return this.salaryService.getByEmployee(employeeId);
  }

  @Put(':employeeId')
  @Permissions('manage_salary')
  upsert(@Param('employeeId') employeeId: string, @Body() dto: UpsertSalaryDto) {
    return this.salaryService.upsert(employeeId, dto);
  }

  @Delete(':employeeId')
  @Permissions('manage_salary')
  remove(@Param('employeeId') employeeId: string) {
    return this.salaryService.remove(employeeId);
  }
}
