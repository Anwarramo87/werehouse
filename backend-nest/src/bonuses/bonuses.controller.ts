import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { BonusesService } from './bonuses.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateBonusDto } from './dto/create-bonus.dto';
import { UpdateBonusDto } from './dto/update-bonus.dto';
import { BonusesListQueryDto } from './dto/bonuses-list-query.dto';

/**
 * BonusesController — متاح على مسارين:
 *   /api/bonuses  (الاسم الأصلي)
 *   /api/rewards  (alias يتوقعه الفرونت)
 *
 * كلاهما يشيران لنفس الـ service تماماً.
 */
@Controller(['bonuses', 'rewards'])
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BonusesController {
  constructor(private readonly bonusesService: BonusesService) {}

  /**
   * GET /api/bonuses   أو   GET /api/rewards
   * params: search, employeeId, type, from, to, page, limit, period
   */
  @Get()
  @Permissions('manage_bonuses')
  list(@Query() query: BonusesListQueryDto) {
    return this.bonusesService.list(query);
  }

  /** GET /api/bonuses/summary/:period */
  @Get('summary/:period')
  @Permissions('manage_bonuses')
  periodSummary(@Param('period') period: string) {
    return this.bonusesService.periodSummary(period);
  }

  /** GET /api/bonuses/:id */
  @Get(':id')
  @Permissions('manage_bonuses')
  getOne(@Param('id') id: string) {
    return this.bonusesService.getById(id);
  }

  /**
   * POST /api/bonuses   أو   POST /api/rewards
   * body: { employeeId, bonusAmount?, bonusReason?, assistanceAmount?, period? }
   */
  @Post()
  @Permissions('manage_bonuses')
  create(@Body() dto: CreateBonusDto) {
    return this.bonusesService.create(dto);
  }

  /** PUT /api/bonuses/:id */
  @Put(':id')
  @Permissions('manage_bonuses')
  update(@Param('id') id: string, @Body() dto: UpdateBonusDto) {
    return this.bonusesService.update(id, dto);
  }

  /**
   * DELETE /api/bonuses/:id   أو   DELETE /api/rewards/:id
   */
  @Delete(':id')
  @Permissions('manage_bonuses')
  remove(@Param('id') id: string) {
    return this.bonusesService.remove(id);
  }
}
