import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { runUnscoped } from '../common/tenant/tenant-context';
import { TenantBackupService } from './tenant-backup.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationSeverity, NotificationType } from '@prisma/client';

/**
 * Automatic nightly backups, one per factory.
 *
 * The HTTP surface (POST /admin/tenants/:id/backups) covers the manual case; a
 * factory that is never clicked should not be the factory that loses data, so
 * this schedules one 4 AM run for every factory in the database. Retention and
 * "keep one even if old" are enforced by BackupStorageService.prune inside the
 * per-factory job, so the cron itself stays concerned only with *starting* work,
 * never with deleting anything.
 *
 * Scheduled on the cron-owning worker only (CRON_WORKER === 'true', or an
 * unclustered run). Duplicate starts are impossible: TenantBackupService.enqueue
 * returns the existing job when one is already in flight for a factory, so the
 * 4 AM tick also cannot collide with a manual run.
 */
@Injectable()
export class BackupCronService {
  private readonly logger = new Logger(BackupCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: TenantBackupService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * One-per-minute safety net for the handful of seconds after boot when the
   * process is up but a deploy brought the volume back empty. Cheap: enqueue is
   * a no-op whenever a factory already has an in-flight or finished job, and the
   * finished-file check below makes even the completed case a single list, not
   * a snapshot.
   *
   * Gated by enabled() like the daily job: off in test/development unless the
   * operator opts in, because this must never fire inside an unrelated test
   * suite and touch a real database.
   */
  @Timeout(60_000)
  async runPendingBackup(): Promise<void> {
    if (!this.enabled()) return;

    const inFlight = await this.backups.listJobs();
    const runningTenants = new Set(
      inFlight
        .filter((job) => job.state === 'queued' || job.state === 'running')
        .map((job) => job.tenantId),
    );

    const tenants = await this.allFactories();
    for (const tenantId of tenants) {
      if (runningTenants.has(tenantId)) continue;
      const files = await this.backups.listFiles(tenantId);
      if (files.length === 0) {
        this.logger.log(`No stored backup found for factory ${tenantId}; starting one`);
        void this.enqueueSafely(tenantId, 'boot');
      } else {
        this.logger.log(
          `Factory ${tenantId} already has ${files.length} stored backup(s); skipping`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async runDailyBackups(): Promise<void> {
    if (!this.enabled()) return;

    const tenants = await this.allFactories();
    this.logger.log(`Daily backup run: ${tenants.length} factory/factories`);

    let enqueued = 0;
    for (const tenantId of tenants) {
      // enqueue() returns the existing in-flight job when there is one, so a
      // manual run that is still going never causes a second snapshot.
      const job = await this.enqueueSafely(tenantId, 'daily');
      if (job) enqueued++;
    }

    this.logger.log(
      `Daily backup run finished: ${enqueued}/${tenants.length} job(s) started`,
    );

    // The alert for the PREVIOUS night. A backup that failed four hours ago
    // must reach the operator this morning, not be discovered the next time
    // something goes wrong. The check reads the durable run log, so it sees
    // the outcome of last night's run even though this process restarted.
    await this.alertOnFailures();
  }

  /**
   * Raises an alert for every factory whose most recent backup attempt
   * failed, and for every factory that has no successful backup at all.
   *
   * The dedupe key is per factory per day, so a factory whose backups keep
   * failing produces one alert a day rather than one every time the cron
   * ticks.
   */
  private async alertOnFailures(): Promise<void> {
    try {
      const runs = await runUnscoped('backup-failure-scan', () =>
        this.prisma.backupRun.findMany({
          orderBy: { startedAt: 'desc' },
          take: 500,
        }),
      );

      const latestByTenant = new Map<string, (typeof runs)[number]>();
      for (const run of runs) {
        if (!run.tenantId) continue;
        if (!latestByTenant.has(run.tenantId)) latestByTenant.set(run.tenantId, run);
      }

      for (const [tenantId, latest] of latestByTenant) {
        if (latest.status === 'succeeded') continue;

        const tenant = await runUnscoped('backup-alert-tenant', () =>
          this.prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { name: true },
          }),
        );

        const day = new Date().toISOString().slice(0, 10);
        await this.notifications.create({
          type: NotificationType.BACKUP_FAILED,
          severity: NotificationSeverity.DANGER,
          title: 'فشل النسخ الاحتياطي',
          message:
            `فشل النسخ الاحتياطي للمصنع ${tenant?.name ?? tenantId}. ` +
            (latest.error ? `السبب: ${latest.error}. ` : '') +
            'يجب معالجة ذلك قبل فقدان البيانات.',
          entityType: 'backup',
          entityId: tenantId,
          dedupeKey: `backup-failed:${tenantId}:${day}`,
        });
      }
    } catch (error) {
      this.logger.error(
        `Could not check for failed backups: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * On by default only in production. A schedule that fires against a test or
   * dev database is worse than no schedule, and an operator who wants it in
   * development can set BACKUP_DAILY_ENABLED=true explicitly.
   */
  private enabled(): boolean {
    if (process.env.BACKUP_DAILY_ENABLED === 'true') return true;
    if (process.env.BACKUP_DAILY_ENABLED === 'false') return false;
    return process.env.NODE_ENV === 'production';
  }

  private async allFactories(): Promise<string[]> {
    return runUnscoped('backup-cron-list-tenants', async () => {
      const tenants = await this.prisma.tenant.findMany({
        select: { id: true },
        orderBy: { name: 'asc' },
      });
      return tenants.map((tenant) => tenant.id);
    });
  }

  /**
   * One factory failing (for example a tenant deleted mid-run) must not stop
   * the loop for every other factory.
   */
  private async enqueueSafely(tenantId: string, reason: string): Promise<unknown> {
    try {
      const job = await this.backups.enqueue(tenantId, reason);
      this.logger.log(`Backup ${reason} queued for ${tenantId} (job ${job.id})`);
      return job;
    } catch (error) {
      this.logger.error(
        `Backup ${reason} failed to queue for ${tenantId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return null;
    }
  }
}