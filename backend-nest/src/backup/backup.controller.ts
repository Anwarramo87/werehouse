import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { ApiTags, ApiCookieAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { AuditService } from '../common/services/audit.service';
import { BackupService } from './backup.service';
import { SnapshotService } from './snapshot.service';
import { RestoreService } from './restore.service';
import { RestoreDto } from './dto/restore.dto';
import { SnapshotFile } from './snapshot.types';

@ApiTags('backup')
@ApiCookieAuth()
@Controller('backup')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BackupController {
  private readonly logger = new Logger(BackupController.name);

  constructor(
    private readonly backupService: BackupService,
    private readonly snapshotService: SnapshotService,
    private readonly restoreService: RestoreService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------- Excel (unchanged)

  @Get('export/full')
  @Permissions('manage_backups')
  @ApiOperation({ summary: 'تصدير نسخة احتياطية كاملة (Excel — للقراءة فقط، غير قابلة للاستعادة)' })
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Export failed';
      this.logger.error('Full backup export failed', err instanceof Error ? err.stack : String(err));
      throw new InternalServerErrorException(`فشل التصدير: ${message}`);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Export failed';
      this.logger.error(`Month backup export failed for ${period}`, err instanceof Error ? err.stack : String(err));
      throw new InternalServerErrorException(`فشل التصدير: ${message}`);
    }
  }

  // --------------------------------------------------- Snapshot (restorable)

  @Get('snapshot')
  @Permissions('manage_backups')
  @ApiOperation({
    summary: 'تنزيل نسخة احتياطية كاملة قابلة للاستعادة (JSON)',
    description:
      'Covers all 42 tenant-scoped models without loss. This is the only format ' +
      'the restore endpoint accepts; the Excel export is for reading, not restoring.',
  })
  async snapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    try {
      const buffer = await this.snapshotService.createSnapshotBuffer(user);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `snapshot-${user?.tenantId ?? 'all'}-${stamp}.json`;

      this.audit.log(
        {
          action: 'backup.snapshot.export',
          actorId: user?.userId,
          actorUsername: user?.username,
          targetType: 'tenant',
          targetId: user?.tenantId ?? undefined,
          metadata: { bytes: buffer.length },
        },
        req,
      );

      res.set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });

      return buffer;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Snapshot failed';
      this.logger.error('Snapshot export failed', err instanceof Error ? err.stack : String(err));
      throw new InternalServerErrorException(`فشل إنشاء النسخة الاحتياطية: ${message}`);
    }
  }

  private static readonly restoreUpload = {
    fileFilter: (
      _req: Request,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      const name = String(file?.originalname || '').toLowerCase();
      if (!name.endsWith('.json')) {
        cb(
          new BadRequestException('A snapshot must be the .json file produced by /backup/snapshot') as unknown as Error,
          false,
        );
        return;
      }
      cb(null, true);
    },
    // Snapshots carry base64 product images inline, so they get large. 256 MB is
    // generous enough for a mature factory and still bounded.
    limits: { fileSize: 256 * 1024 * 1024, files: 1 },
  };

  @Post('restore')
  @Permissions('manage_backups')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', BackupController.restoreUpload))
  @ApiOperation({
    summary: 'استعادة نسخة احتياطية',
    description:
      'Defaults to mode=validate, which touches nothing. mode=dryRun performs the ' +
      'real writes and rolls them back. mode=apply commits. strategy=replace is ' +
      'destructive, Super Admin only, and needs an explicit confirm string.',
  })
  async restore(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: RestoreDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No snapshot file was uploaded (form field "file")');
    }

    let snapshot: SnapshotFile;
    try {
      snapshot = JSON.parse(file.buffer.toString('utf8')) as SnapshotFile;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Snapshot is not valid JSON: ${message}`);
    }

    const report = await this.restoreService.restore(
      snapshot,
      { mode: dto.mode, strategy: dto.strategy, confirm: dto.confirm },
      user,
    );

    // Audit every attempt, including refusals -- a rejected restore is exactly
    // the kind of event someone will want to find later.
    this.audit.log(
      {
        action: `backup.restore.${dto.mode}`,
        actorId: user?.userId,
        actorUsername: user?.username,
        targetType: 'tenant',
        targetId: report.tenantId ?? undefined,
        metadata: {
          strategy: report.strategy,
          valid: report.valid,
          errors: report.errors.slice(0, 10),
          totals: report.totals,
          snapshotCreatedAt: snapshot?.manifest?.createdAt ?? null,
          durationMs: report.durationMs,
        },
      },
      req,
    );

    return report;
  }
}
