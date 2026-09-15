import { Global, Module } from '@nestjs/common';
import { ShortCacheModule } from '../cache/short-cache.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { BackupModule } from '../../backup/backup.module';
import { AuditService } from '../services/audit.service';
import {
  EntitlementsController,
  TenantEntitlementsController,
} from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { PageAccessGuard } from './page-access.guard';

/**
 * Global because PageAccessGuard is applied by feature controllers all over the
 * tree, and a guard cannot be injected without its provider being reachable.
 */
@Global()
@Module({
  imports: [ShortCacheModule, PrismaModule, BackupModule],
  controllers: [EntitlementsController, TenantEntitlementsController],
  providers: [EntitlementsService, PageAccessGuard, AuditService],
  exports: [EntitlementsService, PageAccessGuard],
})
export class EntitlementsModule {}
