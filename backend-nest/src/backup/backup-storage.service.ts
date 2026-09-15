import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';

export interface StoredBackup {
  id: string;
  tenantId: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
}

/**
 * Where finished backups are kept.
 *
 * ── Why the filesystem, and not S3 yet ──────────────────────────────────────
 * BACKUP_ROOT points at the same kind of mounted volume UPLOAD_ROOT does, so a
 * backup survives a redeploy — which was the actual failure mode. True offsite
 * storage needs an account, a bucket and a bill, and that is a commercial
 * decision rather than a technical one, so the write path is kept behind this
 * one small surface: adding an S3-compatible driver (R2, S3 and Backblaze all
 * speak the same API) means implementing `put`, `list` and `remove` here and
 * nothing else changes.
 *
 * A volume is not an offsite backup. If the volume dies, the backups die with
 * the database. Treat this as "survives a deploy", not "survives a disaster",
 * and copy the files off the box on a schedule.
 */
@Injectable()
export class BackupStorageService {
  private readonly logger = new Logger(BackupStorageService.name);

  /** Kept out of the container image for the same reason uploads are. */
  private get root(): string {
    const configured = (process.env.BACKUP_ROOT || '').trim();
    if (configured) return resolve(configured);

    const uploadRoot = (process.env.UPLOAD_ROOT || '').trim();
    if (uploadRoot) return join(resolve(uploadRoot), 'backups');

    return resolve(process.cwd(), 'tmp', 'backups');
  }

  private tenantDir(tenantId: string): string {
    // tenantId is a UUID from the database, never from a request body, but the
    // containment check below costs nothing and removes the question entirely.
    const dir = resolve(this.root, tenantId);
    if (dir !== this.root && !dir.startsWith(this.root + sep)) {
      throw new Error('Refusing to write a backup outside the backup root');
    }
    return dir;
  }

  async put(tenantId: string, fileName: string, contents: Buffer): Promise<StoredBackup> {
    const dir = this.tenantDir(tenantId);
    await mkdir(dir, { recursive: true });

    const path = join(dir, fileName);
    await writeFile(path, contents);

    const checksum = createHash('sha256').update(contents).digest('hex');
    this.logger.log(
      `Backup stored for factory ${tenantId}: ${fileName} (${contents.length} bytes)`,
    );

    return {
      id: fileName,
      tenantId,
      fileName,
      sizeBytes: contents.length,
      checksum,
      createdAt: new Date().toISOString(),
    };
  }

  async list(tenantId: string): Promise<StoredBackup[]> {
    const dir = this.tenantDir(tenantId);

    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // No directory means no backups yet, which is not an error.
      return [];
    }

    const files = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const info = await stat(join(dir, name));
          return {
            id: name,
            tenantId,
            fileName: name,
            sizeBytes: info.size,
            checksum: '',
            createdAt: info.mtime.toISOString(),
          };
        }),
    );

    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(tenantId: string, fileName: string): Promise<Buffer> {
    const dir = this.tenantDir(tenantId);
    const path = resolve(dir, fileName);
    if (!path.startsWith(dir + sep)) {
      throw new Error('Refusing to read outside the factory backup directory');
    }
    return readFile(path);
  }

  /**
   * Deletes backups older than the retention window, newest-first so a run that
   * fails part way through has still removed the oldest.
   *
   * Always keeps at least one, whatever the age: an old backup beats none.
   */
  async prune(tenantId: string, retentionDays: number, keepMinimum = 1): Promise<number> {
    const existing = await this.list(tenantId);
    if (existing.length <= keepMinimum) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const candidates = existing
      .slice(keepMinimum)
      .filter((backup) => new Date(backup.createdAt).getTime() < cutoff);

    let removed = 0;
    for (const backup of candidates) {
      try {
        await unlink(join(this.tenantDir(tenantId), backup.fileName));
        removed++;
      } catch (error) {
        this.logger.warn(
          `Could not prune ${backup.fileName}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }

    if (removed > 0) {
      this.logger.log(`Pruned ${removed} backup(s) for factory ${tenantId}`);
    }
    return removed;
  }
}
