import { createHash } from 'crypto';
import { EncodedBytes } from './snapshot.types';

/**
 * Lossless JSON encoding for Prisma scalar values.
 *
 * Three types need care on the way out:
 *
 *   - `DateTime` -> ISO string. Prisma accepts ISO strings on the way back in,
 *     so no marker is needed.
 *   - `Decimal`  -> its exact string form, never a JS number. `Decimal(12,2)`
 *     values such as salaries exceed float precision, and Prisma accepts a
 *     string on input. Going through `Number` here is how backups quietly lose
 *     the last piastre of every amount.
 *   - `Bytes`    -> base64 inside a `{ $bytes }` wrapper, because a bare base64
 *     string is indistinguishable from a genuine string column.
 *
 * `Json` columns pass through untouched -- they are already JSON.
 */

function isDecimal(value: unknown): value is { toFixed: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  );
}

export function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (isDecimal(value)) return value.toFixed();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = encodeValue(value);
  }
  return out;
}

function isEncodedBytes(value: unknown): value is EncodedBytes {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as EncodedBytes).$bytes === 'string' &&
    Object.keys(value as object).length === 1
  );
}

/**
 * Reverses `encodeValue` far enough for Prisma to take over. Dates and Decimals
 * are deliberately left as strings: Prisma coerces both from their string form
 * using the schema's own type information, which is more reliable than guessing
 * from the value's shape.
 */
export function decodeValue(value: unknown): unknown {
  if (isEncodedBytes(value)) return Buffer.from(value.$bytes, 'base64');
  return value;
}

export function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = decodeValue(value);
  }
  return out;
}

/**
 * Deterministic JSON: object keys sorted at every depth, so two snapshots of the
 * same rows hash identically regardless of column order coming back from
 * Postgres. Without this the checksum would flag false corruption whenever
 * Prisma reordered a select.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);

  return `{${entries.join(',')}}`;
}

export function checksumOf(data: unknown): string {
  return createHash('sha256').update(canonicalise(data), 'utf8').digest('hex');
}
