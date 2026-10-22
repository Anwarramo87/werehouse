import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

type AnyDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  findFirst?: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  createMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  update: (args: Record<string, unknown>) => Promise<unknown>;
  deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
};

export interface SyncRunResult {
  startedAt: string;
  finishedAt: string;
  online: boolean;
  pushedRows: number;
  pulledRows: number;
  pushedDeletes: number;
  pulledDeletes: number;
  conflicts: number;
  errors: string[];
}

export interface SyncStatus {
  enabled: boolean;
  node: string;
  online: boolean;
  running: boolean;
  lastRun: SyncRunResult | null;
  lastError: string | null;
}

const SYNC_TABLES = new Set(['SyncState', 'SyncDeletion', 'SyncConflict']);
const PAGE_SIZE = 400;
/** Re-scan window so rows written while a previous tick was running are not missed. */
const OVERLAP_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Two-way replication between the factory (local PostgreSQL) and the cloud
 * (Neon), driven from the local backend only.
 *
 * Model: last-writer-wins per row (`updatedAt`, falling back to `createdAt` for
 * append-only tables), plus tombstones for hard deletes. Rows are matched by
 * primary key, so ids created offline are preserved when they reach the cloud.
 *
 * The worker is inert unless `SYNC_ENABLED=true` and `CLOUD_DATABASE_URL` is
 * set; the cloud backend itself never runs it.
 */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private readonly enabled: boolean;
  private readonly node: string;
  private readonly intervalMs: number;
  private local: PrismaClient | null = null;
  private cloud: PrismaClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private online = false;
  private lastRun: SyncRunResult | null = null;
  private lastError: string | null = null;
  private readonly models: Array<{
    name: string;
    delegate: string;
    timeField: 'updatedAt' | 'createdAt' | null;
    dependsOn: string[];
  }> = [];

  constructor(private readonly config: ConfigService) {
    this.enabled =
      String(this.config.get('SYNC_ENABLED', 'false')).toLowerCase() === 'true' &&
      Boolean(this.config.get<string>('CLOUD_DATABASE_URL', '').trim());
    this.node = this.config.get<string>('SYNC_NODE_NAME', 'local');
    const interval = Number(this.config.get('SYNC_INTERVAL_MS', 60_000));
    this.intervalMs = Number.isFinite(interval) && interval >= 15_000 ? interval : 60_000;

    if (this.enabled) {
      this.collectModels();
    }
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Sync disabled (SYNC_ENABLED/CLOUD_DATABASE_URL not set).');
      return;
    }

    this.local = this.createClient(this.config.get<string>('DATABASE_URL', ''));
    this.cloud = this.createClient(this.config.get<string>('CLOUD_DATABASE_URL', ''));
    this.logger.log(
      `Sync enabled: node=${this.node}, interval=${this.intervalMs}ms, models=${this.models.length}`,
    );

    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([this.local?.$disconnect(), this.cloud?.$disconnect()]);
  }

  getStatus(): SyncStatus {
    return {
      enabled: this.enabled,
      node: this.node,
      online: this.online,
      running: this.running,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }

  /** Manual trigger used by the status endpoint. */
  async runNow(): Promise<SyncRunResult | null> {
    if (!this.enabled) {
      return null;
    }
    await this.tick();
    return this.lastRun;
  }

  private createClient(url: string) {
    if (!url) {
      throw new Error('Sync client created without a connection string');
    }
    const pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      application_name: `sync-${this.node}`,
    });
    pool.on('error', (err) => this.logger.warn(`Sync pool error: ${err.message}`));
    return new PrismaClient({ adapter: new PrismaPg(pool) });
  }

  private collectModels() {
    const datamodel = (Prisma as unknown as {
      dmmf?: { datamodel?: { models?: Array<{ name: string; fields: Array<{ name: string; kind: string; type: string; relationFromFields?: string[] }> }> } };
    }).dmmf?.datamodel?.models;

    if (!datamodel) {
      this.logger.warn('Prisma DMMF unavailable; sync cannot enumerate models.');
      return;
    }

    for (const model of datamodel) {
      if (SYNC_TABLES.has(model.name) || model.name.startsWith('_')) {
        continue;
      }
      const fieldNames = new Set(model.fields.map((f) => f.name));
      const timeField = fieldNames.has('updatedAt')
        ? 'updatedAt'
        : fieldNames.has('createdAt')
          ? 'createdAt'
          : null;
      const dependsOn = model.fields
        .filter((f) => f.kind === 'object' && Array.isArray(f.relationFromFields) && f.relationFromFields.length > 0)
        .map((f) => f.type)
        .filter((name) => !SYNC_TABLES.has(name));
      this.models.push({
        name: model.name,
        delegate: model.name[0].toLowerCase() + model.name.slice(1),
        timeField,
        dependsOn: [...new Set(dependsOn)],
      });
    }
  }

  /** Parents before children (Kahn); leftovers of a cycle keep declaration order. */
  private orderedModels(): typeof this.models {
    const byName = new Map(this.models.map((m) => [m.name, m]));
    const remaining = new Set(this.models.map((m) => m.name));
    const done: typeof this.models = [];

    while (remaining.size > 0) {
      let progressed = false;
      for (const name of [...remaining]) {
        const model = byName.get(name);
        if (!model) {
          remaining.delete(name);
          continue;
        }
        const blocked = model.dependsOn.some((dep) => remaining.has(dep) && dep !== name);
        if (!blocked) {
          done.push(model);
          remaining.delete(name);
          progressed = true;
        }
      }
      if (!progressed) {
        for (const name of remaining) {
          const model = byName.get(name);
          if (model) done.push(model);
        }
        break;
      }
    }
    return done;
  }

  private async tick() {
    if (!this.enabled || this.running || !this.local || !this.cloud) {
      return;
    }
    this.running = true;
    const result: SyncRunResult = {
      startedAt: new Date().toISOString(),
      finishedAt: '',
      online: false,
      pushedRows: 0,
      pulledRows: 0,
      pushedDeletes: 0,
      pulledDeletes: 0,
      conflicts: 0,
      errors: [],
    };
    try {
      this.online = await this.pingCloud();
      result.online = this.online;
      if (!this.online) {
        return;
      }

      const order = this.orderedModels();
      for (const model of order) {
        await this.pushModel(model, result);
      }
      for (const model of order) {
        await this.pullModel(model, result);
      }
      for (const model of [...order].reverse()) {
        await this.pushDeletions(model, result);
      }
      for (const model of [...order].reverse()) {
        await this.pullDeletions(model, result);
      }

      this.lastError = result.errors.length > 0 ? result.errors.join(' | ') : null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      result.errors.push(this.lastError);
      this.logger.warn(`Sync tick failed: ${this.lastError}`);
    } finally {
      result.finishedAt = new Date().toISOString();
      this.lastRun = result;
      this.running = false;
      if (this.online) {
        this.logger.log(
          `Sync done: push=${result.pushedRows} pull=${result.pulledRows} delPush=${result.pushedDeletes} delPull=${result.pulledDeletes} conflicts=${result.conflicts} errors=${result.errors.length}`,
        );
      }
    }
  }

  private async pingCloud() {
    if (!this.cloud) return false;
    try {
      await Promise.race([
        this.cloud.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private delegate(client: PrismaClient, delegate: string): AnyDelegate {
    return (client as unknown as Record<string, AnyDelegate>)[delegate];
  }

  private async getCheckpoint(key: string, fallback: Date | null): Promise<Date | null> {
    if (!this.local) return fallback;
    const row = await this.local.syncState.findUnique({ where: { key } });
    return row ? new Date(row.value) : fallback;
  }

  private async setCheckpoint(key: string, value: Date) {
    if (!this.local) return;
    await this.local.syncState.upsert({
      where: { key },
      create: { key, value: value.toISOString() },
      update: { value: value.toISOString() },
    });
  }

  private async pushModel(
    model: (typeof this.models)[number],
    result: SyncRunResult,
  ) {
    if (!this.local || !this.cloud) return;
    const checkpointKey = `push:${model.name}`;
    const stored = await this.getCheckpoint(checkpointKey, null);

    if (!model.timeField) {
      if (stored) return; // append-only table already copied once
      const rows = await this.delegate(this.local, model.delegate).findMany({
        take: PAGE_SIZE,
        orderBy: { id: 'asc' },
      });
      for (const row of rows) {
        await this.upsertRow(this.cloud, model, row, result, true);
      }
      if (rows.length > 0) await this.setCheckpoint(checkpointKey, new Date());
      return;
    }

    const since = stored ? new Date(stored.getTime() - OVERLAP_MS) : new Date(0);
    let cursor = since;
    for (;;) {
      const rows = await this.delegate(this.local, model.delegate).findMany({
        where: { [model.timeField]: { gt: cursor } },
        orderBy: [{ [model.timeField]: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        await this.upsertRow(this.cloud, model, row, result, model.timeField === 'createdAt');
        const stamp = row[model.timeField];
        if (stamp instanceof Date) cursor = stamp;
      }
      const lastStamp = rows[rows.length - 1][model.timeField];
      if (lastStamp instanceof Date) {
        cursor = lastStamp;
        await this.setCheckpoint(checkpointKey, cursor);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }

  private async pullModel(
    model: (typeof this.models)[number],
    result: SyncRunResult,
  ) {
    if (!this.local || !this.cloud) return;
    const checkpointKey = `pull:${model.name}`;
    const stored = await this.getCheckpoint(checkpointKey, null);

    if (!model.timeField) {
      if (stored) return;
      const rows = await this.delegate(this.cloud, model.delegate).findMany({
        take: PAGE_SIZE,
        orderBy: { id: 'asc' },
      });
      for (const row of rows) {
        await this.upsertRow(this.local, model, row, result, true);
      }
      if (rows.length > 0) await this.setCheckpoint(checkpointKey, new Date());
      return;
    }

    const since = stored ? new Date(stored.getTime() - OVERLAP_MS) : new Date(0);
    let cursor = since;
    for (;;) {
      const rows = await this.delegate(this.cloud, model.delegate).findMany({
        where: { [model.timeField]: { gt: cursor } },
        orderBy: [{ [model.timeField]: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        await this.upsertRow(this.local, model, row, result, model.timeField === 'createdAt');
        const stamp = row[model.timeField];
        if (stamp instanceof Date) cursor = stamp;
      }
      const lastStamp = rows[rows.length - 1][model.timeField];
      if (lastStamp instanceof Date) {
        cursor = lastStamp;
        await this.setCheckpoint(checkpointKey, cursor);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }

  /**
   * Copies one row to `target`, keeping the newest version on either side.
   * `appendOnly` is passed for tables whose rows are never updated after
   * creation (no `updatedAt`): an existing row is left alone in that case.
   */
  private async upsertRow(
    target: PrismaClient,
    model: (typeof this.models)[number],
    row: Record<string, unknown>,
    result: SyncRunResult,
    appendOnly: boolean,
  ) {
    const delegate = this.delegate(target, model.delegate);
    const id = row.id;
    if (typeof id !== 'string') return;

    try {
      const existingRows = await delegate.findMany({
        where: { id },
        take: 1,
      });
      const existing = existingRows[0];

      if (!existing) {
        await delegate.createMany({ data: [row], skipDuplicates: true });
        if (target === this.cloud) result.pushedRows++;
        else result.pulledRows++;
        return;
      }

      if (appendOnly || !model.timeField) {
        return;
      }

      const sourceStamp = row[model.timeField];
      const targetStamp = existing[model.timeField];
      if (sourceStamp instanceof Date && targetStamp instanceof Date) {
        if (targetStamp.getTime() >= sourceStamp.getTime()) {
          // Target already has this version (or a newer one); whichever side
          // is newer will propagate its own row on its own cycle.
          return;
        }
      }

      const data = { ...row };
      delete data.id;
      await delegate.update({ where: { id }, data });
      if (target === this.cloud) result.pushedRows++;
      else result.pulledRows++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isUnique = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      result.conflicts++;
      if (!this.local) return;
      await this.local.syncConflict
        .create({
          data: {
            model: model.name,
            rowId: id,
            reason: isUnique ? 'unique-key-conflict' : 'write-failed',
            details: { message, row: this.summarizeRow(row) },
          },
        })
        .catch(() => undefined);
      if (result.errors.length < 10) {
        result.errors.push(`${model.name}/${id}: ${message.split('\n')[0]}`);
      }
    }
  }

  private summarizeRow(row: Record<string, unknown>) {
    const summary: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || typeof value === 'string' || typeof value === 'number') {
        summary[key] = value;
      } else if (value instanceof Date) {
        summary[key] = value.toISOString();
      } else {
        summary[key] = String(value);
      }
    }
    return summary;
  }

  private async pushDeletions(
    model: (typeof this.models)[number],
    result: SyncRunResult,
  ) {
    if (!this.local || !this.cloud) return;
    const key = `delpush:${model.name}`;
    const stored = await this.getCheckpoint(key, new Date(0));
    const since = stored ? new Date(stored.getTime() - OVERLAP_MS) : new Date(0);

    const tombstones = await this.local.syncDeletion.findMany({
      where: { model: model.name, deletedAt: { gt: since } },
      orderBy: { deletedAt: 'asc' },
      take: PAGE_SIZE * 2,
    });
    if (tombstones.length === 0) return;

    const ids = [...new Set(tombstones.map((t) => t.rowId))];
    try {
      await this.delegate(this.cloud, model.delegate).deleteMany({ where: { id: { in: ids } } });
      result.pushedDeletes += ids.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (result.errors.length < 10) result.errors.push(`delete ${model.name}: ${message.split('\n')[0]}`);
      return; // keep the checkpoint so the next tick retries
    }

    const last = tombstones[tombstones.length - 1].deletedAt;
    await this.setCheckpoint(key, last);
  }

  private async pullDeletions(
    model: (typeof this.models)[number],
    result: SyncRunResult,
  ) {
    if (!this.local || !this.cloud) return;
    const key = `delpull:${model.name}`;
    const stored = await this.getCheckpoint(key, new Date(0));
    const since = stored ? new Date(stored.getTime() - OVERLAP_MS) : new Date(0);

    const tombstones = await this.cloud.syncDeletion.findMany({
      where: { model: model.name, deletedAt: { gt: since } },
      orderBy: { deletedAt: 'asc' },
      take: PAGE_SIZE * 2,
    });
    if (tombstones.length === 0) return;

    const ids = [...new Set(tombstones.map((t) => t.rowId))];
    try {
      // Raw local client: no tombstone extension, so replaying a remote delete
      // does not echo back to the cloud.
      await this.delegate(this.local, model.delegate).deleteMany({ where: { id: { in: ids } } });
      result.pulledDeletes += ids.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (result.errors.length < 10) result.errors.push(`delete-in ${model.name}: ${message.split('\n')[0]}`);
      return;
    }

    const last = tombstones[tombstones.length - 1].deletedAt;
    await this.setCheckpoint(key, last);
  }
}
