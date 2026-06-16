import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiCookieAuth } from '@nestjs/swagger';
import { BonusesService } from './bonuses.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateBonusDto } from './dto/create-bonus.dto';
import { UpdateBonusDto } from './dto/update-bonus.dto';
import { BonusesListQueryDto } from './dto/bonuses-list-query.dto';

@ApiTags('bonuses')
@ApiCookieAuth()
@Controller('bonuses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BonusesController {
  constructor(private readonly bonusesService: BonusesService) {}

  @Get()
  @Permissions('manage_bonuses')
  list(@Query() query: BonusesListQueryDto) {
    return this.bonusesService.list(query);
  }

  @Get('summary/:period')
  @Permissions('manage_bonuses')
  periodSummary(@Param('period') period: string) {
    return this.bonusesService.periodSummary(period);
  }

  @Get('deleted/history')
  @Permissions('manage_bonuses')
  listDeletedHistory() {
    return this.bonusesService.listDeletedHistory();
  }

  @Get(':id')
  @Permissions('manage_bonuses')
  getOne(@Param('id') id: string) {
    return this.bonusesService.getById(id);
  }

  @Post()
  @Permissions('manage_bonuses')
  create(@Body() dto: CreateBonusDto) {
    return this.bonusesService.create(dto);
  }

  @Post('restore/:historyId')
  @Permissions('manage_bonuses')
  restore(
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bonusesService.restore(historyId, user?.userId);
  }

  @Put(':id')
  @Permissions('manage_bonuses')
  update(@Param('id') id: string, @Body() dto: UpdateBonusDto) {
    return this.bonusesService.update(id, dto);
  }

  @Delete(':id')
  @Permissions('manage_bonuses')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bonusesService.remove(id, user?.userId);
  }
}
