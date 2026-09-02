/**
 * The JSON snapshot format used by export and restore.
 *
 * WHY NOT THE EXCEL EXPORT: `backup.service.ts` writes .xlsx for humans to read,
 * and it is good at that. It cannot be restored from, for three reasons that no
 * amount of parsing fixes:
 *
 *   1. It covers 20 of the 42 tenant-scoped models. Every product, warehouse,
 *      stock level, supplier, purchase order, customer, sales order and journal
 *      entry is absent -- so the "full" backup contains no inventory, purchasing,
 *      sales or accounting data at all.
 *   2. Excel cells are lossy. Decimals become floats, `null` and `''` collapse
 *      into each other, and a cell caps at 32,767 characters -- which silently
 *      truncates the base64 data URLs currently stored in `Product.photo`.
 *   3. Binary columns (`BiometricCredential.publicKeyDer`) cannot round-trip.
 *
 * This format is therefore additive: the Excel export is untouched and keeps
 * doing its job, and restore reads only snapshots produced by `SnapshotService`.
 */

export const SNAPSHOT_FORMAT_VERSION = 1;

/** Marker wrapper for `Bytes` columns, which JSON has no native form for. */
export type EncodedBytes = { $bytes: string };

export type SnapshotManifest = {
  /** Bumped only for breaking changes to this file's shape. */
  formatVersion: number;
  createdAt: string;
  /** Factory this snapshot belongs to. `null` only for a super-admin global snapshot. */
  tenantId: string | null;
  /** Human label carried for provenance; never used to locate anything. */
  tenantName?: string | null;
  /** Latest applied Prisma migration at export time. Restore warns on mismatch. */
  schemaVersion: string | null;
  /** Who exported it. */
  createdBy?: string | null;
  /** Model insert order used at export time, so restore can replay it exactly. */
  modelOrder: string[];
  /** Row count per model, for a fast integrity check that needs no re-hashing. */
  counts: Record<string, number>;
  /** SHA-256 of the canonicalised `data` payload. */
  checksum: string;
};

export type SnapshotFile = {
  manifest: SnapshotManifest;
  /** `modelName -> rows`, each row a plain JSON object of scalar columns. */
  data: Record<string, Record<string, unknown>[]>;
};

/** What a restore would do, or did, to one model. */
export type ModelRestoreResult = {
  model: string;
  /** Rows present in the snapshot. */
  inSnapshot: number;
  /** Rows already in the database with a matching id. */
  existing: number;
  created: number;
  updated: number;
  deleted: number;
};

export type RestoreReport = {
  mode: 'validate' | 'dryRun' | 'apply';
  strategy: 'merge' | 'replace';
  tenantId: string | null;
  /** True only when the snapshot parsed, checksummed and shape-checked cleanly. */
  valid: boolean;
  /** Blocking problems. Non-empty means nothing was written. */
  errors: string[];
  /** Non-blocking observations -- schema drift, unknown models, empty models. */
  warnings: string[];
  perModel: ModelRestoreResult[];
  totals: { created: number; updated: number; deleted: number };
  /** Present for dryRun and apply. */
  durationMs?: number;
  /** dryRun only: confirms the simulating transaction was rolled back. */
  rolledBack?: boolean;
};
