import { Module } from '@nestjs/common';
import { AuditService } from '../common/services/audit.service';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { SnapshotService } from './snapshot.service';
import { RestoreService } from './restore.service';

@Module({
  controllers: [BackupController],
  providers: [BackupService, SnapshotService, RestoreService, AuditService],
  exports: [SnapshotService, RestoreService],
})
export class BackupModule {}
