import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { runUnscoped, runWithTenant } from '../common/tenant/tenant-context';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotService } from './snapshot.service';
import { BackupStorageService, StoredBackup } from './backup-storage.service';

export type BackupJobState = 'queued' | 'running' | 'done' | 'failed';

export interface BackupJob {
  id: string;
  tenantId: string;
  tenantName: string;
  state: BackupJobState;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  file: StoredBackup | null;
}

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);

/**
 * Runs one factory's backup, off the request.
 *
 * A snapshot walks 74 models and holds the whole result in memory before it is
 * written — the audit measured the restore buffer at up to 256 MB. Doing that
 * inside a request would block the event loop for every other user, which is
 * the exact failure inline payroll already demonstrated. So the HTTP call only
 * registers a job and returns; the work happens after the response.
 *
 * Job state is kept in memory on purpose. It is progress reporting, not a
 * record: a backup that was interrupted by a restart did not finish, and the
 * honest thing is for it to disappear rather than to sit at "running" forever.
 * The FILES are what persist, and they are listed from storage.
 */
@Injectable()
export class TenantBackupService {
  private readonly logger = new Logger(TenantBackupService.name);
  private readonly jobs = new Map<string, BackupJob>();

  /** One at a time per factory, so a double-click cannot run two at once. */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: SnapshotService,
    private readonly storage: BackupStorageService,
  ) {}

  listJobs(): BackupJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  jobFor(tenantId: string): BackupJob | null {
    return this.listJobs().find((job) => job.tenantId === tenantId) ?? null;
  }

  listFiles(tenantId: string) {
    return this.storage.list(tenantId);
  }

  /** Reads a stored backup back out of storage for download. */
  readFile(tenantId: string, fileName: string) {
    return this.storage.read(tenantId, fileName);
  }

  /**
   * Queues a backup and returns immediately.
   *
   * Returns the existing job when one is already in flight for this factory,
   * rather than starting a second — two concurrent snapshots of the same data
   * would double the memory cost for no benefit.
   */
  async enqueue(tenantId: string, actor?: string): Promise<BackupJob> {
    const inFlight = this.listJobs().find(
      (job) => job.tenantId === tenantId && (job.state === 'queued' || job.state === 'running'),
    );
    if (inFlight) return inFlight;

    const tenant = await runUnscoped('backup-tenant-name', () =>
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    );

    const job: BackupJob = {
      id: randomUUID(),
      tenantId,
      tenantName: tenant?.name ?? tenantId,
      state: 'queued',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      file: null,
    };
    this.jobs.set(job.id, job);

    // Deliberately not awaited: the caller gets its response now.
    void this.run(job, actor);

    return job;
  }

  private async run(job: BackupJob, actor?: string): Promise<void> {
    if (this.running.has(job.tenantId)) return;
    this.running.add(job.tenantId);
    job.state = 'running';

    try {
      // Scoped to the one factory, so the snapshot contains that factory's rows
      // and nothing else — even though the caller is the super admin.
      const buffer = await runWithTenant(
        { tenantId: job.tenantId, bypass: false, actor: `backup:${actor ?? 'superadmin'}` },
        async () => await this.snapshots.createSnapshotBuffer({ username: actor }),
      );

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      job.file = await this.storage.put(job.tenantId, `snapshot-${stamp}.json`, buffer);
      job.state = 'done';

      await this.storage.prune(job.tenantId, RETENTION_DAYS);
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : 'Backup failed';
      this.logger.error(`Backup failed for factory ${job.tenantId}: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running.delete(job.tenantId);
      this.forgetOldJobs();
    }
  }

  /** Keeps the in-memory job list from growing without bound. */
  private forgetOldJobs(): void {
    const jobs = this.listJobs();
    for (const job of jobs.slice(50)) {
      this.jobs.delete(job.id);
    }
  }
}
