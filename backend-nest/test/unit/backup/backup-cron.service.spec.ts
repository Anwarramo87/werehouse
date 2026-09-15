import { BackupCronService } from '../../../src/backup/backup-cron.service';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';
const RIVAL = 'bbbbbbb2-0000-4000-8000-00000000000b';

describe('BackupCronService', () => {
  const originalDaily = process.env.BACKUP_DAILY_ENABLED;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BACKUP_DAILY_ENABLED = originalDaily;
    process.env.NODE_ENV = originalNodeEnv;
  });

  const makeBackups = (overrides: Record<string, unknown> = {}) => ({
    enqueue: jest.fn(async (tenantId: string) => ({
      id: `job-${tenantId}`,
      tenantId,
      state: 'queued',
    })),
    listFiles: jest.fn(async () => []),
    listJobs: jest.fn(async () => []),
    readFile: jest.fn(),
    ...overrides,
  });

  const makePrisma = (tenantIds: string[]) =>
    ({
      tenant: {
        findMany: jest.fn(async () => tenantIds.map((id) => ({ id }))),
      },
    }) as never;

  const makeService = (tenantIds: string[], backups: Record<string, unknown>) =>
    new BackupCronService(makePrisma(tenantIds), backups as never);

  it('does nothing when disabled outside production', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.BACKUP_DAILY_ENABLED;
    const backups = makeBackups();

    await makeService([ACME], backups).runDailyBackups();

    expect(backups.enqueue).not.toHaveBeenCalled();
  });

  it('runs when explicitly enabled even in a non-production environment', async () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKUP_DAILY_ENABLED = 'true';
    const backups = makeBackups();

    await makeService([ACME, RIVAL], backups).runDailyBackups();

    expect(backups.enqueue).toHaveBeenCalledTimes(2);
    expect(backups.enqueue).toHaveBeenCalledWith(ACME, 'daily');
    expect(backups.enqueue).toHaveBeenCalledWith(RIVAL, 'daily');
  });

  it('enqueues one job per factory in a daily run', async () => {
    process.env.BACKUP_DAILY_ENABLED = 'true';
    const backups = makeBackups();

    await makeService([ACME, RIVAL], backups).runDailyBackups();

    expect(backups.enqueue).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one factory refuses to queue', async () => {
    process.env.BACKUP_DAILY_ENABLED = 'true';
    let calls = 0;
    const backups = makeBackups({
      enqueue: jest.fn(async (tenantId: string) => {
        calls += 1;
        if (calls === 1) throw new Error('tenant gone');
        return { id: `job-${tenantId}`, tenantId, state: 'queued' };
      }),
    });

    const service = makeService([ACME, RIVAL], backups);
    await expect(service.runDailyBackups()).resolves.toBeUndefined();

    expect(backups.enqueue).toHaveBeenCalledTimes(2);
  });

  it('starts a missing backup at boot for a factory with no stored files', async () => {
    process.env.BACKUP_DAILY_ENABLED = 'true';
    const backups = makeBackups({ listFiles: jest.fn(async () => []) });

    await makeService([ACME], backups).runPendingBackup();

    expect(backups.enqueue).toHaveBeenCalledWith(ACME, 'boot');
  });

  it('skips a factory at boot that already has stored backups', async () => {
    process.env.BACKUP_DAILY_ENABLED = 'true';
    const backups = makeBackups({
      listFiles: jest.fn(async () => [{ id: 'snapshot-2026-01-01.json' }]),
    });

    await makeService([ACME], backups).runPendingBackup();

    expect(backups.enqueue).not.toHaveBeenCalled();
  });
});