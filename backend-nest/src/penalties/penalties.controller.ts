import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PenaltiesService } from './penalties.service';
import { CreatePenaltyDto } from './dto/create-penalty.dto';
import { UpdatePenaltyDto } from './dto/update-penalty.dto';
import { PenaltiesListQueryDto } from './dto/penalties-list-query.dto';

@ApiTags('penalties')
@ApiCookieAuth()
@Controller('penalties')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PenaltiesController {
  constructor(private readonly penaltiesService: PenaltiesService) {}

  @Get()
  @Permissions('manage_penalties')
  list(@Query() query: PenaltiesListQueryDto) {
    return this.penaltiesService.list(query);
  }

  @Get(':id')
  @Permissions('manage_penalties')
  getOne(@Param('id') id: string) {
    return this.penaltiesService.getById(id);
  }

  @Post()
  @Permissions('manage_penalties')
  create(@Body() dto: CreatePenaltyDto) {
    return this.penaltiesService.create(dto);
  }

  @Put(':id')
  @Permissions('manage_penalties')
  update(@Param('id') id: string, @Body() dto: UpdatePenaltyDto) {
    return this.penaltiesService.update(id, dto);
  }

  @Delete(':id')
  @Permissions('manage_penalties')
  remove(@Param('id') id: string) {
    return this.penaltiesService.remove(id);
  }
}
