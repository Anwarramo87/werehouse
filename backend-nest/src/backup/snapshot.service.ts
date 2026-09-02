import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { checksumOf, encodeRow } from './snapshot.codec';
import { RESTORE_ORDER } from './snapshot.model-graph';
import { SNAPSHOT_FORMAT_VERSION, SnapshotFile, SnapshotManifest } from './snapshot.types';

const PAGE_SIZE = 1000;

type PrismaDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
};

/**
 * Produces a restorable snapshot of one factory.
 *
 * Every read goes through the tenant-extended Prisma client, so an Admin
 * snapshots their own factory and only the Super Admin can produce a global one.
 * That is the same rule the rest of the system enforces -- this service adds no
 * escape hatch of its own.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Latest applied migration, used to warn on restore when a snapshot predates a
   * schema change. Best-effort: a missing `_prisma_migrations` table (a database
   * built with `db push`) is not a reason to refuse a backup.
   */
  private async schemaVersion(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
      );
      return rows[0]?.migration_name ?? null;
    } catch {
      this.logger.warn('Could not read _prisma_migrations; snapshot will carry no schema version');
      return null;
    }
  }

  private delegate(model: string): PrismaDelegate | null {
    const candidate = (this.prisma as unknown as Record<string, unknown>)[model];
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as PrismaDelegate).findMany === 'function'
    ) {
      return candidate as PrismaDelegate;
    }
    return null;
  }

  /**
   * Reads one model in pages, ordered by `id` so the output is stable between
   * two snapshots of unchanged data -- which is what makes the checksum a useful
   * comparison rather than noise.
   */
  private async readModel(model: string): Promise<Record<string, unknown>[]> {
    const delegate = this.delegate(model);
    if (!delegate) {
      this.logger.warn(`Model ${model} is in the graph but not on the Prisma client; skipped`);
      return [];
    }

    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await delegate.findMany({
        take: PAGE_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (page.length === 0) break;

      for (const row of page) rows.push(encodeRow(row));

      const last = page[page.length - 1];
      const lastId = last?.id;
      if (page.length < PAGE_SIZE || typeof lastId !== 'string') break;
      cursor = lastId;
    }

    return rows;
  }

  async createSnapshot(actor?: { username?: string }): Promise<SnapshotFile> {
    const scope = currentTenant();
    const startedAt = Date.now();

    const data: Record<string, Record<string, unknown>[]> = {};
    const counts: Record<string, number> = {};

    for (const model of RESTORE_ORDER) {
      const rows = await this.readModel(model);
      data[model] = rows;
      counts[model] = rows.length;
    }

    const tenantId = scope?.bypass ? null : (scope?.tenantId ?? null);
    let tenantName: string | null = null;
    if (tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      tenantName = tenant?.name ?? null;
    }

    const manifest: SnapshotManifest = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      tenantId,
      tenantName,
      schemaVersion: await this.schemaVersion(),
      createdBy: actor?.username ?? scope?.actor ?? null,
      modelOrder: [...RESTORE_ORDER],
      counts,
      checksum: checksumOf(data),
    };

    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
    this.logger.log(
      `Snapshot built for tenant=${tenantId ?? 'ALL'}: ${totalRows} rows across ` +
        `${RESTORE_ORDER.length} models in ${Date.now() - startedAt}ms`,
    );

    return { manifest, data };
  }

  /** Serialised form handed to the HTTP layer. */
  async createSnapshotBuffer(actor?: { username?: string }): Promise<Buffer> {
    const snapshot = await this.createSnapshot(actor);
    return Buffer.from(JSON.stringify(snapshot), 'utf8');
  }
}
