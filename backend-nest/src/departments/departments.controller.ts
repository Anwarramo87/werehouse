import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateDepartmentDto } from './dto/create-department.dto';

@ApiTags('departments')
@ApiCookieAuth()
@Controller('departments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  @Permissions('view_employees')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.departmentsService.list({
      userId: user?.userId,
      tenantId: user?.tenantId ?? null,
    });
  }

  @Post()
  @Permissions('edit_employees')
  create(@Body() dto: CreateDepartmentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.departmentsService.create(dto, {
      userId: user?.userId,
      tenantId: user?.tenantId ?? null,
    });
  }

  @Put(':id')
  @Permissions('edit_employees')
  update(@Param('id') id: string, @Body() dto: CreateDepartmentDto) {
    return this.departmentsService.update(id, dto);
  }

  @Patch(':id/supervisor')
  @Permissions('edit_employees')
  clearSupervisor(@Param('id') id: string) {
    return this.departmentsService.clearSupervisor(id);
  }

  @Delete(':id')
  @Permissions('edit_employees')
  remove(@Param('id') id: string) {
    return this.departmentsService.remove(id);
  }
}
