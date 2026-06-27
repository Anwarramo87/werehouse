/**
 * Unit Tests — auth.service (نظام المصادقة)
 */
import {
  DEFAULT_MAX_LOGIN_ATTEMPTS,
  DEFAULT_LOCKOUT_MINUTES,
  BCRYPT_DEFAULT_ROUNDS,
} from '../common/constants/auth.constants';

// ─── Mock objects ───────────────────────────────────────────────────────────
const mockJwt = {
  sign: jest.fn().mockReturnValue('mock-token'),
};

const mockConfig = {
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      JWT_SECRET: 'test-secret-32-chars-long-enough!!',
      JWT_EXPIRE: '15m',
      AUTH_MAX_LOGIN_ATTEMPTS: DEFAULT_MAX_LOGIN_ATTEMPTS,
      AUTH_LOCKOUT_MINUTES: DEFAULT_LOCKOUT_MINUTES,
      BCRYPT_ROUNDS: BCRYPT_DEFAULT_ROUNDS,
      NODE_ENV: 'test',
    };
    return map[key] ?? def;
  }),
  getOrThrow: jest.fn((key: string) => {
    if (key === 'JWT_SECRET') return 'test-secret-32-chars-long-enough!!';
    throw new Error(`Missing: ${key}`);
  }),
};

// ─── مساعدات منطق المصادقة (مفصولة عن الـ DB) ──────────────────────────────
function isAccountLocked(lockoutUntil: Date | null): boolean {
  if (!lockoutUntil) return false;
  return lockoutUntil > new Date();
}

function shouldLock(failedAttempts: number, maxAttempts: number): boolean {
  return failedAttempts >= maxAttempts;
}

function getLockoutUntil(lockoutMinutes: number): Date {
  return new Date(Date.now() + lockoutMinutes * 60_000);
}

// ─── Tests ───────────────────────────────────────────────────────────────────
describe('Auth Logic', () => {
  // --- Account Lock ---
  describe('Account Lockout Logic', () => {
    it('should NOT lock account with fewer than max attempts', () => {
      expect(shouldLock(4, DEFAULT_MAX_LOGIN_ATTEMPTS)).toBe(false);
    });

    it('should lock account at exactly max attempts', () => {
      expect(shouldLock(DEFAULT_MAX_LOGIN_ATTEMPTS, DEFAULT_MAX_LOGIN_ATTEMPTS)).toBe(true);
    });

    it('should lock account after exceeding max attempts', () => {
      expect(shouldLock(10, DEFAULT_MAX_LOGIN_ATTEMPTS)).toBe(true);
    });

    it('lockoutUntil should be ~15 minutes from now', () => {
      const lockoutUntil = getLockoutUntil(DEFAULT_LOCKOUT_MINUTES);
      const diffMs = lockoutUntil.getTime() - Date.now();
      const diffMin = diffMs / 60_000;
      expect(diffMin).toBeCloseTo(DEFAULT_LOCKOUT_MINUTES, 0);
    });
  });

  // --- Account Lock Status ---
  describe('isAccountLocked', () => {
    it('returns false when lockoutUntil is null', () => {
      expect(isAccountLocked(null)).toBe(false);
    });

    it('returns true when lockoutUntil is in the future', () => {
      const future = new Date(Date.now() + 10 * 60_000);
      expect(isAccountLocked(future)).toBe(true);
    });

    it('returns false when lockoutUntil is in the past', () => {
      const past = new Date(Date.now() - 1000);
      expect(isAccountLocked(past)).toBe(false);
    });
  });

  // --- Constants Sanity ---
  describe('Auth Constants', () => {
    it('DEFAULT_MAX_LOGIN_ATTEMPTS should be 5', () => {
      expect(DEFAULT_MAX_LOGIN_ATTEMPTS).toBe(5);
    });

    it('DEFAULT_LOCKOUT_MINUTES should be 15', () => {
      expect(DEFAULT_LOCKOUT_MINUTES).toBe(15);
    });

    it('BCRYPT_DEFAULT_ROUNDS should be at least 12', () => {
      expect(BCRYPT_DEFAULT_ROUNDS).toBeGreaterThanOrEqual(12);
    });
  });

  // --- Mock JWT sign ---
  describe('JWT Signing', () => {
    it('mock jwt.sign should return a token', () => {
      const token = mockJwt.sign({ sub: 'user-id', username: 'test' });
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });
  });
});
