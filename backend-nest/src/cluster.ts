import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { Logger } from '@nestjs/common';

/**
 * Runs the API across every available core.
 *
 * Node is single-threaded, and two things in this app are CPU-bound enough to
 * block the event loop for everyone: bcrypt at 12 rounds costs ~269ms per login
 * (measured), and a payroll run executes inline unless the worker process is
 * deployed. On a 2-vCPU box the second core sat idle while the first queued.
 *
 * Opt-in via CLUSTER_WORKERS so a single-core plan is not forced to pay the
 * extra ~150MB per worker:
 *   unset or "1" — one process, exactly as before
 *   "auto"       — one worker per core
 *   a number     — that many workers
 *
 * Things that must NOT be duplicated live in the worker process, not here:
 * @Cron jobs would otherwise fire once per worker. See CRON_ENABLED below.
 */
const logger = new Logger('Cluster');

/**
 * Whether this process should register the @Cron schedules.
 *
 * Read from CRON_WORKER, which `cluster.fork()` places in the child's
 * environment BEFORE the child starts — so it is already present when
 * app.module.ts is imported.
 *
 * An earlier version set `CRON_ENABLED` from inside bootstrapClustered() and
 * had app.module read that. It could never work: `import { AppModule }` at the
 * top of main.ts evaluates the @Module decorator, and therefore the env check
 * inside it, long before any function in this file runs. Every worker
 * registered the schedules, so the hourly absence sweep fired once per core and
 * each factory received a duplicate of every notification.
 *
 *   undefined — not clustered; this single process owns the schedules
 *   'true'    — the designated cron-owning worker
 *   'false'   — a worker that must not run them
 */
export function shouldRegisterSchedules(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRON_WORKER !== 'false';
}

function desiredWorkers(): number {
  const configured = (process.env.CLUSTER_WORKERS || '').trim().toLowerCase();
  if (!configured || configured === '1') return 1;
  if (configured === 'auto') return Math.max(1, availableParallelism());

  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

export async function bootstrapClustered(start: () => Promise<void>): Promise<void> {
  const workers = desiredWorkers();

  if (workers === 1 || !cluster.isPrimary) {
    // A worker (or an unclustered run) just starts the app. Whether it owns the
    // schedules was already decided by the CRON_WORKER the fork gave it; see
    // shouldRegisterSchedules above for why it cannot be decided here.
    await start();
    return;
  }

  logger.log(`Starting ${workers} workers across ${availableParallelism()} cores`);

  for (let i = 0; i < workers; i++) {
    // Exactly one worker owns the scheduled jobs.
    cluster.fork({ CRON_WORKER: i === 0 ? 'true' : 'false' });
  }

  // Which worker owns the schedules, tracked here because a dead ChildProcess
  // no longer exposes the env it was forked with.
  let cronOwnerId = [...Object.keys(cluster.workers ?? {})][0];

  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died (${signal || code}); starting a replacement`);

    const wasCronOwner = String(worker.id) === cronOwnerId;
    const replacement = cluster.fork({ CRON_WORKER: wasCronOwner ? 'true' : 'false' });
    if (wasCronOwner) {
      cronOwnerId = String(replacement.id);
    }
  });
}
