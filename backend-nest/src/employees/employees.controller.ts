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
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { EmployeesService } from './employees.service';
import { AuditService } from '../common/services/audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequiresPage } from '../common/entitlements/requires-page.decorator';
import { PageAccessGuard } from '../common/entitlements/page-access.guard';
import { SubscriptionGuard } from '../common/entitlements/subscription.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesListQueryDto } from './dto/employees-list-query.dto';
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { TerminateEmployeeBodyDto } from './dto/terminate-employee-body.dto';
import { BulkTerminateDepartmentDto } from './dto/bulk-terminate-department.dto';
import { RehireEmployeeDto } from './dto/rehire-employee.dto';
import { FinancialSettlementDto } from './dto/financial-settlement.dto';
import { ResignedEmployeesQueryDto } from './dto/resigned-employees-query.dto';

@ApiTags('employees')
@ApiCookieAuth()
@Controller('employees')
@UseGuards(JwtAuthGuard, SubscriptionGuard, PermissionsGuard, PageAccessGuard)
@RequiresPage('hr.employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Permissions('view_employees')
  @ApiOperation({
    summary: 'قائمة الموظفين',
    description: 'يُرجع قائمة مُصفّاة ومُرقَّمة بالصفحات',
  })
  list(@Query() query: EmployeesListQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.list(query, user);
  }

  // Served separately from the list so a ~41 KB base64 photo is fetched only
  // when it is going to be shown, and cached per employee by the browser.
  @Get(':employeeId/photo')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'صورة الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  async getPhoto(@Param('employeeId') employeeId: string, @Res() res: Response) {
    const photo = await this.employeesService.getPhoto(employeeId);
    if (!photo) {
      res.status(404).json({ message: 'No photo on file' });
      return;
    }

    // Photos are stored as data URLs. Decode to bytes so the browser can cache
    // an image rather than re-parse base64 out of JSON on every render.
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(photo);
    if (!match) {
      // A plain URL was stored instead of a data URL; hand it back as-is.
      res.status(200).json({ url: photo });
      return;
    }

    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length),
      // Private: an avatar is personal data, so it may sit in the user's own
      // cache but never in a shared proxy.
      'Cache-Control': 'private, max-age=3600',
    });
    res.send(buffer);
  }

  @Get('stats')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'إحصائيات الموظفين' })
  stats() {
    return this.employeesService.stats();
  }

  @Get('resigned')
  @RequiresPage('hr.resigned') // sold separately from hr.employees
  @Permissions('view_employees')
  getResignedEmployees(
    @Query() query: ResignedEmployeesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.getResignedEmployees(query, user);
  }

  @Get('department/:department')
  @Permissions('view_employees')
  @ApiOperation({ summary: 'موظفو قسم محدد' })
  @ApiParam({ name: 'department', description: 'اسم القسم' })
  byDepartment(
    @Param('department') department: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.byDepartment(department, {}, user);
  }

  @Post()
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'إضافة موظف جديد' })
  @ApiResponse({ status: 201, description: 'تم إنشاء الموظف بنجاح' })
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.create(dto, user);
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
  getOne(
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.getByEmployeeId(employeeId, user);
  }

  @Put(':employeeId')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'تعديل بيانات الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  update(
    @Param('employeeId') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employeesService.update(employeeId, dto, user);
  }

  // Ending, restoring and settling someone's employment are the operations an
  // HR dispute is argued over, and none of them were recorded anywhere. The
  // frontend had an audit module aimed at exactly these, but it posted to a
  // mock Next.js route that answered 403 and kept its rows in a per-instance
  // array — so nothing was ever written. Recording it here means the trail
  // cannot be forged or skipped by a client.
  @Post('terminate')
  @Permissions('edit_employees')
  async terminateEmployee(
    @Body() dto: TerminateEmployeeBodyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.terminateEmployee(dto, user);
    this.audit.log(
      {
        action: 'employee.terminate',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: dto.employeeId,
        metadata: { reason: dto.reason, terminationDate: dto.terminationDate },
      },
      req,
    );
    return result;
  }

  @Patch(':employeeId/terminate')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'إنهاء خدمة الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  async terminate(
    @Param('employeeId') employeeId: string,
    @Body() dto: TerminateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.terminate(employeeId, dto);
    this.audit.log(
      {
        action: 'employee.terminate',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: employeeId,
        metadata: { ...dto },
      },
      req,
    );
    return result;
  }

  @Patch(':employeeId/resign')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'استقالة الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  async resign(
    @Param('employeeId') employeeId: string,
    @Body() dto: TerminateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.resign(employeeId, dto);
    this.audit.log(
      {
        action: 'employee.resign',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: employeeId,
        metadata: { ...dto },
      },
      req,
    );
    return result;
  }

  @Patch(':employeeId/settle')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'تسوية حساب الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  async settle(
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.settle(employeeId);
    this.audit.log(
      {
        action: 'employee.settle',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: employeeId,
      },
      req,
    );
    return result;
  }

  @Post('rehire')
  @RequiresPage('hr.resigned')
  @Permissions('edit_employees')
  async rehireEmployee(
    @Body() dto: RehireEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.rehireEmployee(dto, user);
    this.audit.log(
      {
        action: 'employee.rehire',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: dto.employeeId,
        metadata: { ...dto },
      },
      req,
    );
    return result;
  }

  @Post('financial-settlement')
  @RequiresPage('hr.resigned')
  @Permissions('edit_employees')
  async processFinancialSettlement(
    @Body() dto: FinancialSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.processFinancialSettlement(dto, user);
    this.audit.log(
      {
        action: 'employee.financial-settlement',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: dto.employeeId,
        metadata: { ...dto },
      },
      req,
    );
    return result;
  }

  @Post('bulk-terminate-department')
  @Permissions('edit_employees')
  @ApiOperation({ summary: 'إنهاء خدمة جميع موظفي قسم محدد' })
  async bulkTerminateDepartment(
    @Body() dto: BulkTerminateDepartmentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.bulkTerminateDepartment(dto, user);
    this.audit.log(
      {
        action: 'employee.bulk-terminate-department',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'department',
        targetId: dto.department,
        metadata: { ...dto },
      },
      req,
    );
    return result;
  }

  @Get('deleted/history')
  @Permissions('delete_employees')
  listDeletedHistory() {
    return this.employeesService.listDeletedEmployees();
  }

  @Post('restore/:historyId')
  @Permissions('delete_employees')
  async restore(
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.employeesService.restoreEmployee(historyId, user?.userId, user);
    this.audit.log(
      {
        action: 'employee.restore',
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'employee',
        targetId: historyId,
      },
      req,
    );
    return result;
  }

  @Delete(':employeeId')
  @Permissions('delete_employees')
  @ApiOperation({ summary: 'حذف الموظف' })
  @ApiParam({ name: 'employeeId', description: 'رقم الموظف' })
  remove(@Param('employeeId') employeeId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.remove(employeeId, user?.userId);
  }
}
