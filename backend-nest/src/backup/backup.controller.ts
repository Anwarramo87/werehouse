import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { BackupService } from './backup.service';

@ApiTags('backup')
@ApiCookieAuth()
@Controller('backup')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BackupController {
  private readonly logger = new Logger(BackupController.name);

  constructor(private readonly backupService: BackupService) {}

  @Get('export/full')
  @Permissions('manage_backups')
  @ApiOperation({ summary: 'تصدير نسخة احتياطية كاملة (Excel)' })
  async exportFull(@Res({ passthrough: true }) res: Response) {
    try {
      const buffer = await this.backupService.exportFull();
      const filename = `backup-full-${new Date().toISOString().slice(0, 10)}.xlsx`;

      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });

      return buffer;
    } catch (err) {
      this.logger.error('Full backup export failed', err);
      throw err;
    }
  }

  @Get('export/month')
  @Permissions('manage_backups')
  @ApiOperation({ summary: 'تصدير نسخة احتياطية شهرية (Excel)' })
  async exportMonth(
    @Query('period') period: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      res.status(400);
      return { message: 'period is required and must be in YYYY-MM format' };
    }

    try {
      const buffer = await this.backupService.exportMonth(period);
      const filename = `backup-${period}.xlsx`;

      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });

      return buffer;
    } catch (err) {
      this.logger.error(`Month backup export failed for ${period}`, err);
      throw err;
    }
  }
}
