import { shouldRegisterSchedules } from '../../src/cluster';

/*
 * Cron ownership under clustering.
 *
 * The bug this pins: app.module.ts decides whether to register ScheduleModule
 * while its @Module decorator is evaluated — which happens when main.ts imports
 * it, before any function in cluster.ts has run. A flag set later from inside
 * bootstrapClustered() therefore had no effect, every worker registered the
 * schedules, and the hourly absence sweep fired once per core: each factory
 * received a duplicate of every notification.
 *
 * CRON_WORKER works because cluster.fork() puts it in the child's environment
 * before the child process starts.
 */
describe('shouldRegisterSchedules', () => {
  it('registers schedules when not clustered', () => {
    // No CRON_WORKER at all: one process, and it owns the crons.
    expect(shouldRegisterSchedules({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('registers schedules in the designated cron worker', () => {
    expect(shouldRegisterSchedules({ CRON_WORKER: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does NOT register schedules in any other worker', () => {
    // The whole point: exactly one process runs the sweeps.
    expect(shouldRegisterSchedules({ CRON_WORKER: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('errs toward running them for an unrecognised value', () => {
    // A typo must not silently stop every scheduled job in the deployment;
    // duplicate notifications are recoverable, a payroll sweep that never runs
    // is not obvious until someone is paid wrongly.
    expect(shouldRegisterSchedules({ CRON_WORKER: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRegisterSchedules({ CRON_WORKER: '' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('ignores the old CRON_ENABLED flag, which could never be read in time', () => {
    expect(shouldRegisterSchedules({ CRON_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
