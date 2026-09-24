/**
 * RepIsolationGuard unit tests
 *
 * These tests verify the core security invariant:
 *   - A representative user can ONLY access data scoped to their own rep ID.
 *   - Admins pass through unconditionally.
 *   - Accessing another rep's data returns 403 ForbiddenException.
 *   - Even supplying a valid UUID that belongs to a different rep is rejected.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RepIsolationGuard } from '../../../src/representatives/guards/rep-isolation.guard';
import { PrismaService } from '../../../src/prisma/prisma.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContext(params: {
  user: { userId: string; role: string };
  urlRepId: string;
}): ExecutionContext {
  const request = {
    user: params.user,
    params: { repId: params.urlRepId },
    representativeId: undefined as string | undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

const prismaMock = {
  representative: {
    findUnique: jest.fn(),
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepIsolationGuard', () => {
  let guard: RepIsolationGuard;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        RepIsolationGuard,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    guard = module.get(RepIsolationGuard);
  });

  // ── Admin bypass ─────────────────────────────────────────────────────────

  it('allows admin regardless of repId', async () => {
    const ctx = buildContext({
      user: { userId: 'admin-user-id', role: 'admin' },
      urlRepId: 'some-rep-id',
    });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(prismaMock.representative.findUnique).not.toHaveBeenCalled();
  });

  it('allows superadmin regardless of repId', async () => {
    const ctx = buildContext({
      user: { userId: 'super-id', role: 'superadmin' },
      urlRepId: 'any-rep-id',
    });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  // ── Representative — own data ─────────────────────────────────────────────

  it('allows a representative to access their own data', async () => {
    const repId = 'rep-uuid-1';
    prismaMock.representative.findUnique.mockResolvedValue({
      id: repId,
      status: 'active',
    });

    const ctx = buildContext({
      user: { userId: 'user-of-rep-1', role: 'representative' },
      urlRepId: repId,
    });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('injects representativeId into request after allowing access', async () => {
    const repId = 'rep-uuid-1';
    prismaMock.representative.findUnique.mockResolvedValue({ id: repId, status: 'active' });

    const request = {
      user: { userId: 'user-of-rep-1', role: 'representative' },
      params: { repId },
      representativeId: undefined as string | undefined,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(request.representativeId).toBe(repId);
  });

  // ── Representative — cross-rep isolation (THE CRITICAL SECURITY TEST) ─────

  it('throws ForbiddenException when rep tries to access ANOTHER rep ID', async () => {
    const myRepId = 'rep-uuid-MINE';
    const otherRepId = 'rep-uuid-OTHER';

    prismaMock.representative.findUnique.mockResolvedValue({
      id: myRepId,   // ← the DB says this user's rep ID is myRepId
      status: 'active',
    });

    const ctx = buildContext({
      user: { userId: 'user-of-rep-1', role: 'representative' },
      urlRepId: otherRepId,   // ← but the URL has a DIFFERENT rep ID
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when the requesting user is not a registered rep', async () => {
    prismaMock.representative.findUnique.mockResolvedValue(null); // no rep record

    const ctx = buildContext({
      user: { userId: 'random-user-id', role: 'representative' },
      urlRepId: 'any-rep-id',
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when the rep account is suspended', async () => {
    prismaMock.representative.findUnique.mockResolvedValue({
      id: 'rep-1',
      status: 'suspended',   // ← account not active
    });

    const ctx = buildContext({
      user: { userId: 'user-of-rep-1', role: 'representative' },
      urlRepId: 'rep-1',
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('throws ForbiddenException with no user in request', async () => {
    const request = {
      user: null,
      params: { repId: 'some-rep' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a rep even if they manually craft a valid UUID for another rep', async () => {
    // Simulates an attacker changing the UUID in the URL manually
    const attackerRepId = 'rep-uuid-ATTACKER';
    const victimRepId = 'rep-uuid-VICTIM';

    prismaMock.representative.findUnique.mockResolvedValue({
      id: attackerRepId,
      status: 'active',
    });

    const ctx = buildContext({
      user: { userId: 'attacker-user', role: 'representative' },
      urlRepId: victimRepId,  // ← manually crafted victim's ID
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
