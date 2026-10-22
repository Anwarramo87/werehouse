import { Prisma } from '@prisma/client';

/**
 * Models that must never produce tombstones: the sync bookkeeping tables
 * themselves (writing a tombstone about a tombstone would recurse) and the
 * migration table.
 */
const IGNORED_MODELS = new Set(['SyncState', 'SyncDeletion', 'SyncConflict']);

export type TombstoneWriter = (
  model: string,
  rowIds: string[],
  node: string,
) => Promise<void>;

/**
 * Captures hard deletes so the offline/cloud replication can replay them.
 *
 * The local and cloud databases are merged by row id, so a row disappearing on
 * one side is invisible to an upsert-based sync: it simply would not be listed.
 * This extension records every `delete`/`deleteMany` into `sync_deletions`
 * before the rows vanish, and the sync worker drains that table.
 *
 * The writes go through the caller-supplied `writeTombstones` callback, which
 * must use an *unextended* Prisma client. That is what keeps this hook from
 * observing its own inserts and recursing.
 */
export function deletionTombstoneExtension(writeTombstones: TombstoneWriter) {
  const node = process.env.SYNC_NODE_NAME || 'local';

  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'deletion-tombstones',
      query: {
        $allModels: {
          async delete({ model, args, query }) {
            if (IGNORED_MODELS.has(model)) {
              return query(args);
            }

            const ids = await fetchIds(client, model, args.where);
            const result = await query(args);
            await writeIds(writeTombstones, model, ids, node);
            return result;
          },

          async deleteMany({ model, args, query }) {
            if (IGNORED_MODELS.has(model)) {
              return query(args);
            }

            const ids = await fetchIds(client, model, args?.where, 5000);
            const result = await query(args);
            await writeIds(writeTombstones, model, ids, node);
            return result;
          },
        },
      },
    }),
  );
}

function delegateFor(client: unknown, model: string) {
  const key = model[0].toLowerCase() + model.slice(1);
  return (client as Record<string, unknown>)[key] as
    | {
        findMany: (args: {
          where?: unknown;
          select: { id: true };
          take?: number;
        }) => Promise<Array<{ id: string }>>;
      }
    | undefined;
}

async function fetchIds(client: unknown, model: string, where: unknown, take?: number) {
  const delegate = delegateFor(client, model);
  if (!delegate?.findMany) {
    return [];
  }

  try {
    const rows = await delegate.findMany({ where, select: { id: true }, take });
    return rows.map((row) => row.id).filter((id): id is string => typeof id === 'string');
  } catch {
    // If the pre-read fails (unusual where clause, transient error) we still
    // must not block the delete. The row stays un-tombstoned and the next full
    // reconciliation on the other side will simply keep its copy.
    return [];
  }
}

async function writeIds(
  writeTombstones: TombstoneWriter,
  model: string,
  ids: string[],
  node: string,
) {
  if (ids.length === 0) {
    return;
  }

  try {
    await writeTombstones(model, [...new Set(ids)], node);
  } catch {
    // Tombstone bookkeeping must never turn a successful delete into an error.
  }
}
