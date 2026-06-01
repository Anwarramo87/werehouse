import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesListQueryDto } from './dto/employees-list-query.dto';
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { TerminateEmployeeZodDto } from './dto/terminate-employee-zod.dto';
import { RehireEmployeeDto } from './dto/rehire-employee.dto';
import { FinancialSettlementDto } from './dto/financial-settlement.dto';
import { ResignedEmployeesQueryDto } from './dto/resigned-employees-query.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

@Controller('employees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @Permissions('view_employees')
  list(@Query() query: EmployeesListQueryDto) {
    return this.employeesService.list(query);
  }

  @Get('stats')
  @Permissions('view_employees')
  stats() {
    return this.employeesService.stats();
  }

  @Get('resigned')
  @Permissions('view_employees')
  getResignedEmployees(@Query() query: ResignedEmployeesQueryDto) {
    return this.employeesService.getResignedEmployees(query);
  }

  @Get('department/:department')
  @Permissions('view_employees')
  byDepartment(@Param('department') department: string) {
    return this.employeesService.byDepartment(department);
  }

  @Post()
  @Permissions('edit_employees')
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get(':employeeId/profile')
  @Permissions('view_employees')
  getProfile(
    @Param('employeeId') employeeId: string,
    @Query() query: EmployeeProfileQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.getProfile(employeeId, query, user);
  }

  @Get(':employeeId')
  @Permissions('view_employees')
  getOne(@Param('employeeId') employeeId: string) {
    return this.employeesService.getByEmployeeId(employeeId);
  }

  @Put(':employeeId')
  @Permissions('edit_employees')
  update(@Param('employeeId') employeeId: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(employeeId, dto);
  }

  @Post('terminate')
  @Permissions('edit_employees')
  terminateEmployee(
    @Body() dto: TerminateEmployeeZodDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.terminateEmployee(dto, user);
  }

  @Patch(':employeeId/terminate')
  @Permissions('edit_employees')
  terminate(@Param('employeeId') employeeId: string, @Body() dto: TerminateEmployeeDto) {
    return this.employeesService.terminate(employeeId, dto);
  }

  @Patch(':employeeId/resign')
  @Permissions('edit_employees')
  resign(@Param('employeeId') employeeId: string, @Body() dto: TerminateEmployeeDto) {
    return this.employeesService.resign(employeeId, dto);
  }

  @Patch(':employeeId/settle')
  @Permissions('edit_employees')
  settle(@Param('employeeId') employeeId: string) {
    return this.employeesService.settle(employeeId);
  }

  @Post('rehire')
  @Permissions('edit_employees')
  rehireEmployee(
    @Body() dto: RehireEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.rehireEmployee(dto, user);
  }

  @Post('financial-settlement')
  @Permissions('edit_employees')
  processFinancialSettlement(
    @Body() dto: FinancialSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.processFinancialSettlement(dto, user);
  }

  @Delete(':employeeId')
  @Permissions('delete_employees')
  remove(@Param('employeeId') employeeId: string) {
    return this.employeesService.remove(employeeId);
  }
}
