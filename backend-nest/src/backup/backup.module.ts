import { Module } from '@nestjs/common';
import { AuditService } from '../common/services/audit.service';
import { BackupStorageService } from './backup-storage.service';
import { TenantBackupService } from './tenant-backup.service';
import { BackupCronService } from './backup-cron.service';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { SnapshotService } from './snapshot.service';
import { RestoreService } from './restore.service';

@Module({
  controllers: [BackupController],
  providers: [
    BackupService,
    SnapshotService,
    RestoreService,
    AuditService,
    BackupStorageService,
    TenantBackupService,
    BackupCronService,
  ],
  exports: [TenantBackupService, SnapshotService, RestoreService],
})
export class BackupModule {}
