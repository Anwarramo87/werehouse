import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { SUPERADMIN_ROLE } from '../common/tenant/tenant.constants';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { checksumOf, decodeRow } from './snapshot.codec';
import { DELETE_ORDER, GLOBAL_MODELS, RESTORE_ORDER } from './snapshot.model-graph';
import {
  ModelRestoreResult,
  RestoreReport,
  SNAPSHOT_FORMAT_VERSION,
  SnapshotFile,
} from './snapshot.types';

/** Rows per statement. Kept well under Postgres' 65,535 bind-parameter ceiling. */
const WRITE_CHUNK = 500;

/** Interactive-transaction budget. A full-factory restore is minutes of work, not seconds. */
const TX_TIMEOUT_MS = 10 * 60 * 1000;
const TX_MAX_WAIT_MS = 30 * 1000;

/**
 * Thrown deliberately at the end of a dry run so Prisma rolls the transaction
 * back. Carries the report, because everything we learned lives inside the
 * transaction that is about to disappear.
 */
class DryRunRollback extends Error {
  constructor(readonly report: RestoreReport) {
    super('dry-run rollback');
  }
}

export type RestoreOptions = {
  mode: 'validate' | 'dryRun' | 'apply';
  strategy: 'merge' | 'replace';
  /** Required for `apply` + `replace`. Must equal `REPLACE <tenantId>`. */
  confirm?: string;
};

type TxClient = Record<string, unknown>;

type Delegate = {
  findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  createMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  count: (args?: Record<string, unknown>) => Promise<number>;
  update: (args: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Restores a factory from a `SnapshotService` snapshot.
 *
 * Three deliberate safety properties, in the order they matter:
 *
 *   1. **Nothing is written outside a transaction.** Every model is restored
 *      inside one interactive transaction, so a failure at model 40 of 42 leaves
 *      the database exactly as it was rather than half-restored.
 *   2. **Dry run is the same code path.** `dryRun` executes the real writes and
 *      then forces a rollback, so what it reports is what `apply` will do -- not
 *      a separate simulation that can drift from reality.
 *   3. **Merge is the default.** The destructive `replace` strategy has to be
 *      asked for by name *and* confirmed with the tenant id, and is refused
 *      outright for anyone who is not the Super Admin.
 */
@Injectable()
export class RestoreService {
  private readonly logger = new Logger(RestoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- validation

  /**
   * Structural checks that need no database access. Runs before every mode, so
   * a corrupt file is rejected before it can open a transaction.
   */
  private validateStructure(snapshot: SnapshotFile): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!snapshot || typeof snapshot !== 'object') {
      return { errors: ['Snapshot is not a JSON object'], warnings };
    }

    const { manifest, data } = snapshot;

    if (!manifest || typeof manifest !== 'object') {
      errors.push('Snapshot is missing its manifest');
    } else if (manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
      errors.push(
        `Unsupported snapshot format version ${manifest.formatVersion}; ` +
          `this server reads version ${SNAPSHOT_FORMAT_VERSION}`,
      );
    }

    if (!data || typeof data !== 'object') {
      errors.push('Snapshot is missing its data payload');
    }

    if (errors.length > 0) return { errors, warnings };

    // Integrity: the checksum covers the whole data payload, so a truncated or
    // hand-edited file is caught here rather than halfway through a restore.
    const actual = checksumOf(data);
    if (manifest.checksum && actual !== manifest.checksum) {
      errors.push(
        `Checksum mismatch: the file has been modified or truncated since export ` +
          `(expected ${manifest.checksum.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      );
    }

    for (const [model, rows] of Object.entries(data)) {
      if (GLOBAL_MODELS.has(model)) {
        errors.push(
          `Snapshot contains global model "${model}". Roles and tenants are shared ` +
            'across factories and are never restored.',
        );
        continue;
      }

      if (!RESTORE_ORDER.includes(model)) {
        // Skipping rows during a restore is how data disappears quietly, so an
        // unknown model with content is fatal. An empty one is just noise.
        if (Array.isArray(rows) && rows.length > 0) {
          errors.push(`Unknown model "${model}" carries ${rows.length} rows and cannot be restored`);
        } else {
          warnings.push(`Unknown model "${model}" in snapshot; ignored (no rows)`);
        }
        continue;
      }

      if (!Array.isArray(rows)) {
        errors.push(`Model "${model}" is not an array of rows`);
        continue;
      }

      const missingId = rows.findIndex((row) => !row || typeof row.id !== 'string');
      if (missingId !== -1) {
        errors.push(`Model "${model}" row ${missingId} has no string \`id\`; cannot be matched`);
      }

      const declared = manifest.counts?.[model];
      if (typeof declared === 'number' && declared !== rows.length) {
        errors.push(
          `Model "${model}" declares ${declared} rows in the manifest but carries ${rows.length}`,
        );
      }
    }

    for (const model of RESTORE_ORDER) {
      if (!(model in data)) {
        warnings.push(`Model "${model}" is absent from the snapshot; it will be left untouched`);
      }
    }

    return { errors, warnings };
  }

  /**
   * A snapshot may only be restored into the factory it came from. For a
   * tenant-scoped caller the Prisma extension would silently re-home foreign
   * rows into their own factory, which is safe but is never what anyone meant.
   */
  private validateTenant(snapshot: SnapshotFile, user?: AuthenticatedUser): string[] {
    const errors: string[] = [];
    const scope = currentTenant();
    const isSuperadmin = user?.roles?.includes(SUPERADMIN_ROLE) || user?.role === SUPERADMIN_ROLE;

    if (isSuperadmin || scope?.bypass) return errors;

    const callerTenant = scope?.tenantId ?? user?.tenantId ?? null;
    const snapshotTenant = snapshot.manifest?.tenantId ?? null;

    if (snapshotTenant === null) {
      errors.push(
        'This is a global (multi-factory) snapshot. Only the Super Admin can restore it.',
      );
    } else if (callerTenant && snapshotTenant !== callerTenant) {
      errors.push(
        `Snapshot belongs to factory ${snapshotTenant} but you are signed in to ${callerTenant}.`,
      );
    }

    return errors;
  }

  private async schemaWarnings(snapshot: SnapshotFile): Promise<string[]> {
    const warnings: string[] = [];
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
      );
      const current = rows[0]?.migration_name ?? null;
      const snapshotVersion = snapshot.manifest?.schemaVersion ?? null;

      if (snapshotVersion && current && snapshotVersion !== current) {
        warnings.push(
          `Snapshot was taken at migration "${snapshotVersion}" but the database is at ` +
            `"${current}". Columns added since then will take their default values.`,
        );
      }
    } catch {
      warnings.push('Could not read the applied migration list; schema drift was not checked.');
    }
    return warnings;
  }

  // ------------------------------------------------------------------- helpers

  private delegate(tx: TxClient, model: string): Delegate | null {
    const candidate = tx[model];
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as Delegate).createMany === 'function'
    ) {
      return candidate as Delegate;
    }
    return null;
  }

  private static chunk<T>(rows: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  }

  /**
   * Which of these ids already exist. Chunked so the `IN` list stays sane.
   *
   * `tenantId` is applied explicitly for the same reason the delete is: a Super
   * Admin runs with `bypass: true`, so the extension adds no predicate and this
   * lookup would otherwise range across every factory.
   */
  private async existingIds(
    delegate: Delegate,
    ids: string[],
    tenantId: string | null,
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (const batch of RestoreService.chunk(ids, WRITE_CHUNK)) {
      const rows = await delegate.findMany({
        where: { id: { in: batch }, ...(tenantId ? { tenantId } : {}) },
        select: { id: true },
      });
      for (const row of rows) {
        if (typeof row.id === 'string') found.add(row.id);
      }
    }
    return found;
  }

  // ------------------------------------------------------------------ the work

  /**
   * The single write path shared by `dryRun` and `apply`. Runs entirely inside
   * `tx`; the caller decides whether that transaction commits.
   */
  private async applyInTransaction(
    tx: TxClient,
    snapshot: SnapshotFile,
    strategy: 'merge' | 'replace',
    warnings: string[],
  ): Promise<ModelRestoreResult[]> {
    const perModel: ModelRestoreResult[] = [];
    const present = RESTORE_ORDER.filter((model) => Array.isArray(snapshot.data[model]));

    // `replace` clears children before parents, so no row is ever orphaned even
    // momentarily. Only models the snapshot actually covers are cleared -- a
    // partial snapshot must not wipe data it says nothing about.
    //
    // The tenant filter is applied HERE, explicitly, rather than being left to
    // the Prisma extension. `replace` is Super Admin only, and a Super Admin
    // carries `bypass: true` -- for whom the extension adds no tenant predicate
    // at all. A bare `deleteMany({})` would therefore empty the table for EVERY
    // factory while restoring one. Scoping the delete to the snapshot's own
    // tenant is what keeps a single-factory restore single-factory.
    const deleted: Record<string, number> = {};
    if (strategy === 'replace') {
      const scopeTenantId = snapshot.manifest.tenantId;
      if (!scopeTenantId) {
        throw new BadRequestException(
          'A replace restore requires a single-factory snapshot. This snapshot is global ' +
            '(tenantId: null) and replacing from it would clear every factory at once. ' +
            'Restore each factory individually, or use strategy "merge".',
        );
      }

      for (const model of DELETE_ORDER) {
        if (!present.includes(model)) continue;
        const delegate = this.delegate(tx, model);
        if (!delegate) continue;
        const result = await delegate.deleteMany({ where: { tenantId: scopeTenantId } });
        deleted[model] = result.count;
      }
    }

    for (const model of present) {
      const delegate = this.delegate(tx, model);
      if (!delegate) {
        warnings.push(`Model "${model}" is not available on the Prisma client; skipped`);
        continue;
      }

      const rows = snapshot.data[model].map((row) => decodeRow(row));
      const result: ModelRestoreResult = {
        model,
        inSnapshot: rows.length,
        existing: 0,
        created: 0,
        updated: 0,
        deleted: deleted[model] ?? 0,
      };

      if (rows.length === 0) {
        perModel.push(result);
        continue;
      }

      if (strategy === 'replace') {
        // The table was just emptied for this tenant, so every row is an insert.
        for (const batch of RestoreService.chunk(rows, WRITE_CHUNK)) {
          const inserted = await delegate.createMany({ data: batch, skipDuplicates: false });
          result.created += inserted.count;
        }
      } else {
        const ids = rows.map((row) => row.id as string);
        const existing = await this.existingIds(delegate, ids, snapshot.manifest.tenantId);
        result.existing = existing.size;

        const toCreate = rows.filter((row) => !existing.has(row.id as string));
        const toUpdate = rows.filter((row) => existing.has(row.id as string));

        for (const batch of RestoreService.chunk(toCreate, WRITE_CHUNK)) {
          const inserted = await delegate.createMany({ data: batch, skipDuplicates: true });
          result.created += inserted.count;
        }

        // Updates go one row at a time: `updateMany` cannot give each row its own
        // values, and an upsert loop would repeat the existence check we just did.
        for (const row of toUpdate) {
          const { id, ...rest } = row;
          await delegate.update({ where: { id }, data: rest });
          result.updated += 1;
        }
      }

      perModel.push(result);
    }

    return perModel;
  }

  // -------------------------------------------------------------------- public

  async restore(
    snapshot: SnapshotFile,
    options: RestoreOptions,
    user?: AuthenticatedUser,
  ): Promise<RestoreReport> {
    const startedAt = Date.now();
    const { mode, strategy } = options;

    const structure = this.validateStructure(snapshot);
    const errors = [...structure.errors, ...this.validateTenant(snapshot, user)];
    const warnings = [...structure.warnings];

    const report: RestoreReport = {
      mode,
      strategy,
      tenantId: snapshot?.manifest?.tenantId ?? null,
      valid: errors.length === 0,
      errors,
      warnings,
      perModel: [],
      totals: { created: 0, updated: 0, deleted: 0 },
    };

    if (errors.length > 0) {
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    warnings.push(...(await this.schemaWarnings(snapshot)));

    if (mode === 'validate') {
      report.perModel = RESTORE_ORDER.filter((m) => Array.isArray(snapshot.data[m])).map((m) => ({
        model: m,
        inSnapshot: snapshot.data[m].length,
        existing: 0,
        created: 0,
        updated: 0,
        deleted: 0,
      }));
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    // Destructive restores need the caller to name the factory they are about to
    // overwrite, and are closed to anyone below the Super Admin.
    if (strategy === 'replace') {
      const isSuperadmin =
        user?.roles?.includes(SUPERADMIN_ROLE) || user?.role === SUPERADMIN_ROLE;
      if (!isSuperadmin) {
        throw new ForbiddenException(
          'A replace restore deletes existing rows and is restricted to the super admin. ' +
            'Use strategy "merge" instead.',
        );
      }
      if (mode === 'apply') {
        const expected = `REPLACE ${snapshot.manifest.tenantId ?? 'ALL'}`;
        if (options.confirm !== expected) {
          throw new BadRequestException(
            `A replace restore is irreversible. Send confirm: "${expected}" to proceed.`,
          );
        }
      }
    }

    const run = async (tx: TxClient): Promise<ModelRestoreResult[]> =>
      this.applyInTransaction(tx, snapshot, strategy, warnings);

    try {
      const perModel = await this.prisma.$transaction(
        async (tx: TxClient) => {
          const results = await run(tx);

          if (mode === 'dryRun') {
            // Same writes as `apply`, then undone. Throwing is the only way to
            // roll back an interactive transaction, so the results ride out on
            // the error rather than being lost with it.
            const draft: RestoreReport = {
              ...report,
              perModel: results,
              totals: RestoreService.sum(results),
              rolledBack: true,
            };
            throw new DryRunRollback(draft);
          }

          return results;
        },
        { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
      );

      report.perModel = perModel;
      report.totals = RestoreService.sum(perModel);
      report.durationMs = Date.now() - startedAt;

      this.logger.log(
        `Restore applied (${strategy}) for tenant=${report.tenantId ?? 'ALL'}: ` +
          `+${report.totals.created} created, ~${report.totals.updated} updated, ` +
          `-${report.totals.deleted} deleted in ${report.durationMs}ms`,
      );

      return report;
    } catch (err) {
      if (err instanceof DryRunRollback) {
        const result = err.report;
        result.durationMs = Date.now() - startedAt;
        this.logger.log(
          `Dry run rolled back for tenant=${result.tenantId ?? 'ALL'}: would create ` +
            `${result.totals.created}, update ${result.totals.updated}, delete ${result.totals.deleted}`,
        );
        return result;
      }
      throw err;
    }
  }

  private static sum(results: ModelRestoreResult[]) {
    return results.reduce(
      (acc, r) => ({
        created: acc.created + r.created,
        updated: acc.updated + r.updated,
        deleted: acc.deleted + r.deleted,
      }),
      { created: 0, updated: 0, deleted: 0 },
    );
  }
}
