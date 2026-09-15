import { TenantBackupService } from '../../../src/backup/tenant-backup.service';
import { currentTenant } from '../../../src/common/tenant/tenant-context';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';
const RIVAL = 'bbbbbbb2-0000-4000-8000-00000000000b';

/** Waits for the fire-and-forget run() to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const prismaStub = (name = 'Acme Denim') =>
  ({ tenant: { findUnique: jest.fn(async () => ({ name })) } }) as never;

const storageStub = () => {
  const put = jest.fn(async (tenantId: string, fileName: string) => ({
    tenantId,
    fileName,
    sizeBytes: 1234,
    createdAt: new Date().toISOString(),
  }));
  const prune = jest.fn(async () => 0);
  const list = jest.fn(async () => []);
  return { put, prune, list } as never;
};

/*
 * A snapshot walks 74 models and holds the result in memory before writing — the
 * audit measured the restore buffer at up to 256 MB. Running that inside a
 * request would block the event loop for every other user, which is the exact
 * failure inline payroll already demonstrated. So the HTTP call registers a job
 * and returns; these tests pin that contract and the scoping it depends on.
 */
describe('TenantBackupService', () => {
  it('returns a queued job immediately rather than waiting for the snapshot', async () => {
    let snapshotStarted = false;
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => {
        snapshotStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Buffer.from('{}');
      }),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    const job = await service.enqueue(ACME, 'overseer');

    // The caller has its answer while the snapshot is still being built.
    expect(job.state).toMatch(/queued|running/);
    expect(job.finishedAt).toBeNull();
    expect(job.tenantName).toBe('Acme Denim');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(snapshotStarted).toBe(true);
    expect(service.jobFor(ACME)?.state).toBe('done');
  });

  it('takes the snapshot under the factory’s own scope, not the super admin’s', async () => {
    // Otherwise the overseer's bypass would produce a snapshot containing every
    // factory's rows under one factory's name.
    let seenTenantId: string | null | undefined;
    let seenBypass: boolean | undefined;

    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => {
        seenTenantId = currentTenant()?.tenantId;
        seenBypass = currentTenant()?.bypass;
        return Buffer.from('{}');
      }),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    await service.enqueue(RIVAL, 'overseer');
    await settle();

    expect(seenTenantId).toBe(RIVAL);
    expect(seenBypass).toBe(false);
  });

  it('writes the snapshot and prunes to the retention window', async () => {
    const storage = storageStub();
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => Buffer.from('{"rows":1}')),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storage);
    await service.enqueue(ACME, 'overseer');
    await settle();

    const put = (storage as unknown as { put: jest.Mock }).put;
    expect(put).toHaveBeenCalledTimes(1);
    const [tenantId, fileName] = put.mock.calls[0];
    expect(tenantId).toBe(ACME);
    // Colons are illegal in filenames on Windows and awkward everywhere else.
    expect(fileName).toMatch(/^snapshot-[\d-]+T[\d-]+Z?\.json$/);
    expect(fileName).not.toContain(':');

    expect((storage as unknown as { prune: jest.Mock }).prune).toHaveBeenCalledWith(
      ACME,
      expect.any(Number),
    );
  });

  it('does not start a second backup while one is in flight', async () => {
    // A double-clicked button would otherwise double the memory cost for nothing.
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return Buffer.from('{}');
      }),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    const first = await service.enqueue(ACME, 'overseer');
    const second = await service.enqueue(ACME, 'overseer');

    expect(second.id).toBe(first.id);
    expect(
      (snapshots as unknown as { createSnapshotBuffer: jest.Mock }).createSnapshotBuffer,
    ).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('allows a second backup once the first has finished', async () => {
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => Buffer.from('{}')),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    await service.enqueue(ACME, 'overseer');
    await settle();

    const second = await service.enqueue(ACME, 'overseer');
    await settle();

    expect(second.state).toBe('done');
    expect(
      (snapshots as unknown as { createSnapshotBuffer: jest.Mock }).createSnapshotBuffer,
    ).toHaveBeenCalledTimes(2);
  });

  it('records a failure on the job instead of throwing into nowhere', async () => {
    // run() is intentionally un-awaited, so an unhandled rejection here would be
    // invisible. The failure has to land somewhere the UI can read it.
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => {
        throw new Error('disk full');
      }),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    await service.enqueue(ACME, 'overseer');
    await settle();

    const job = service.jobFor(ACME);
    expect(job?.state).toBe('failed');
    expect(job?.error).toBe('disk full');
    expect(job?.finishedAt).not.toBeNull();
  });

  it('frees a failed factory so it can be retried', async () => {
    let attempts = 0;
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return Buffer.from('{}');
      }),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    await service.enqueue(ACME, 'overseer');
    await settle();
    expect(service.jobFor(ACME)?.state).toBe('failed');

    await service.enqueue(ACME, 'overseer');
    await settle();
    expect(service.jobFor(ACME)?.state).toBe('done');
  });

  it('falls back to the id when the factory has no name', async () => {
    const prisma = { tenant: { findUnique: jest.fn(async () => null) } } as never;
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => Buffer.from('{}')),
    } as never;

    const service = new TenantBackupService(prisma, snapshots, storageStub());
    const job = await service.enqueue(ACME, 'overseer');
    await settle();

    expect(job.tenantName).toBe(ACME);
  });

  it('keeps each factory’s jobs distinguishable', async () => {
    const snapshots = {
      createSnapshotBuffer: jest.fn(async () => Buffer.from('{}')),
    } as never;

    const service = new TenantBackupService(prismaStub(), snapshots, storageStub());
    await service.enqueue(ACME, 'overseer');
    await service.enqueue(RIVAL, 'overseer');
    await settle();

    expect(service.jobFor(ACME)?.tenantId).toBe(ACME);
    expect(service.jobFor(RIVAL)?.tenantId).toBe(RIVAL);
    expect(service.listJobs()).toHaveLength(2);
  });
});
