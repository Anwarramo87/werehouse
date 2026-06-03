import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { LeavesService } from './leaves.service';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { LeavesListQueryDto } from './dto/leaves-list-query.dto';
import { UpdateLeaveRequestDto } from './dto/update-leave-request.dto';

@ApiTags('leaves')
@ApiCookieAuth()
@Controller('leaves')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  @Get()
  @Permissions('view_employees')
  list(@Query() query: LeavesListQueryDto) {
    return this.leavesService.list(query);
  }

  @Get(':id')
  @Permissions('view_employees')
  getOne(@Param('id') id: string) {
    return this.leavesService.getById(id);
  }

  @Post()
  @Permissions('edit_employees')
  create(@Body() dto: CreateLeaveRequestDto) {
    return this.leavesService.create(dto);
  }

  @Patch(':id')
  @Permissions('edit_employees')
  update(@Param('id') id: string, @Body() dto: UpdateLeaveRequestDto) {
    return this.leavesService.update(id, dto);
  }

  @Delete(':id')
  @Permissions('edit_employees')
  remove(@Param('id') id: string) {
    return this.leavesService.remove(id);
  }
}
