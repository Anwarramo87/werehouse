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
  /** Whether the written file was read back and checksum-verified. */
  verified: boolean;
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
 *
 * ── The durable record ─────────────────────────────────────────────────────
 * The in-memory job is not enough for the question "when was the last
 * successful backup, and did it actually work?" — that has to survive a
 * restart. Every attempt therefore also writes a `BackupRun` row: the start
 * time, the finish time, the duration, the file's name and size, its SHA-256
 * checksum, and whether the file was read back and verified. The row is the
 * answer to "is this factory protected?".
 *
 * ── A backup is not successful until it is verified ────────────────────────
 * Writing a file and calling it done is how a factory ends up with a backup
 * directory full of truncated files. The file is read back and its checksum
 * recomputed; only a matching checksum makes the run "succeeded".
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
   * The durable record of this factory's backups: the last attempt, the last
   * success, the retention window and how many copies are kept.
   */
  async status(tenantId: string) {
    const [runs, files] = await Promise.all([
      runUnscoped('backup-status-runs', () =>
        this.prisma.backupRun.findMany({
          where: { tenantId },
          orderBy: { startedAt: 'desc' },
          take: 20,
        }),
      ),
      this.storage.list(tenantId),
    ]);

    const lastRun = runs[0] ?? null;
    const lastSuccess = runs.find((r) => r.status === 'succeeded') ?? null;

    return {
      retentionDays: RETENTION_DAYS,
      storedBackups: files.length,
      totalStoredBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            trigger: lastRun.trigger,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            durationMs: lastRun.durationMs,
            fileName: lastRun.fileName,
            sizeBytes: lastRun.sizeBytes,
            checksum: lastRun.checksum,
            error: lastRun.error,
            verified: lastRun.verified,
          }
        : null,
      lastSuccess: lastSuccess
        ? {
            id: lastSuccess.id,
            startedAt: lastSuccess.startedAt,
            finishedAt: lastSuccess.finishedAt,
            durationMs: lastSuccess.durationMs,
            fileName: lastSuccess.fileName,
            sizeBytes: lastSuccess.sizeBytes,
            verified: lastSuccess.verified,
          }
        : null,
      recentRuns: runs.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        fileName: r.fileName,
        error: r.error,
        verified: r.verified,
      })),
    };
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
      verified: false,
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

    const startedAt = Date.now();
    const runId = await this.openRun(job);

    try {
      // Scoped to the one factory, so the snapshot contains that factory's rows
      // and nothing else — even though the caller is the super admin.
      const buffer = await runWithTenant(
        { tenantId: job.tenantId, bypass: false, actor: `backup:${actor ?? 'superadmin'}` },
        async () => await this.snapshots.createSnapshotBuffer({ username: actor }),
      );

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `snapshot-${stamp}.json`;
      job.file = await this.storage.put(job.tenantId, fileName, buffer);

      // The verification step: read the file back and recompute its checksum.
      // A write that "succeeded" but produced a truncated file is worse than
      // no backup, because it looks like protection.
      const verified = await this.verifyFile(job.tenantId, fileName, job.file.checksum);
      job.verified = verified;
      job.state = 'done';

      if (!verified) {
        job.state = 'failed';
        job.error = 'Backup file could not be verified after writing';
      }

      await this.closeRun(runId, {
        status: job.state === 'done' ? 'succeeded' : 'failed',
        durationMs: Date.now() - startedAt,
        fileName,
        sizeBytes: job.file.sizeBytes,
        checksum: job.file.checksum,
        error: job.error,
        verified,
      });

      if (job.state === 'done') {
        await this.storage.prune(job.tenantId, RETENTION_DAYS);
      }
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : 'Backup failed';
      this.logger.error(`Backup failed for factory ${job.tenantId}: ${job.error}`);

      await this.closeRun(runId, {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: job.error,
        verified: false,
      });
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running.delete(job.tenantId);
      this.forgetOldJobs();
    }
  }

  /** Opens the durable run record. A failure to write it must not abort. */
  private async openRun(job: BackupJob): Promise<string | null> {
    try {
      const row = await runUnscoped('backup-run-open', () =>
        this.prisma.backupRun.create({
          data: {
            tenantId: job.tenantId,
            status: 'running',
            trigger: 'daily',
          },
        }),
      );
      return row.id;
    } catch (error) {
      this.logger.warn(
        `Could not open the backup run record: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return null;
    }
  }

  /** Closes the durable run record. A failure to write it must not abort. */
  private async closeRun(
    runId: string | null,
    data: {
      status: string;
      durationMs: number;
      fileName?: string;
      sizeBytes?: number;
      checksum?: string;
      error?: string | null;
      verified: boolean;
    },
  ): Promise<void> {
    if (!runId) return;
    try {
      await runUnscoped('backup-run-close', () =>
        this.prisma.backupRun.update({
          where: { id: runId },
          data: {
            status: data.status,
            finishedAt: new Date(),
            durationMs: data.durationMs,
            fileName: data.fileName ?? null,
            sizeBytes: data.sizeBytes ?? null,
            checksum: data.checksum ?? null,
            error: data.error ?? null,
            verified: data.verified,
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Could not close the backup run record: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * Reads the stored file back and compares its checksum with the one taken
   * when it was written.
   */
  private async verifyFile(
    tenantId: string,
    fileName: string,
    expectedChecksum: string,
  ): Promise<boolean> {
    try {
      const readBack = await this.storage.read(tenantId, fileName);
      if (readBack.length === 0) {
        this.logger.error(`Backup file ${fileName} is empty`);
        return false;
      }
      const actual = await this.storage.checksumOf(readBack);
      if (actual !== expectedChecksum) {
        this.logger.error(`Backup file ${fileName} failed checksum verification`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Could not read back backup file ${fileName}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return false;
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
