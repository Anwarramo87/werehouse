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
import { ApiTags, ApiOperation, ApiCookieAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesListQueryDto } from './dto/employees-list-query.dto';
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';

@ApiTags('employees')
@ApiCookieAuth()
@Controller('employees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @Permissions('view_employees')
  @ApiOperation({ summary: 'قائمة الموظفين', description: 'يُرجع قائمة مُصفّاة ومُرقَّمة بالصفحات' })
  list(@Query() query: EmployeesListQueryDto) {
    return this.employeesService.list(query);
  }

  @Get('stats')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'إحصائيات الموظفين' })
  stats() {
    return this.employeesService.stats();
  }

  @Get('department/:department')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'موظفو قسم محدد' })
  @ApiParam({ name: 'department', description: 'اسم القسم' })
  byDepartment(@Param('department') department: string) {
    return this.employeesService.byDepartment(department);
  }

  @Post()
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'إضافة موظف جديد' })
  @ApiResponse({ status: 201, description: 'تم إنشاء الموظف بنجاح' })
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get(':employeeId/profile')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'الملف الكامل للموظف (رواتب، حضور، سلف...)' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  getProfile(
    @Param('employeeId') employeeId: string,
    @Query() query: EmployeeProfileQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.getProfile(employeeId, query, user);
  }

  @Get(':employeeId')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'بيانات موظف بالـ ID' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  getOne(@Param('employeeId') employeeId: string) {
    return this.employeesService.getByEmployeeId(employeeId);
  }

  @Put(':employeeId')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'تعديل بيانات الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  update(@Param('employeeId') employeeId: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(employeeId, dto);
  }

  @Patch(':employeeId/terminate')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'إنهاء خدمة الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  terminate(@Param('employeeId') employeeId: string, @Body() dto: TerminateEmployeeDto) {
    return this.employeesService.terminate(employeeId, dto);
  }

  @Patch(':employeeId/resign')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'استقالة الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  resign(@Param('employeeId') employeeId: string, @Body() dto: TerminateEmployeeDto) {
    return this.employeesService.resign(employeeId, dto);
  }

  @Patch(':employeeId/settle')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'تسوية حساب الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  settle(@Param('employeeId') employeeId: string) {
    return this.employeesService.settle(employeeId);
  }

  @Delete(':employeeId')
  @Permissions('delete_employees')
  @ApiOperation({ summary: 'حذف الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  remove(@Param('employeeId') employeeId: string) {
    return this.employeesService.remove(employeeId);
  }
}
