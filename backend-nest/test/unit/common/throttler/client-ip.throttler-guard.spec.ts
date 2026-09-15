import { ClientIpThrottlerGuard } from '../../../../src/common/throttler/client-ip.throttler-guard';

/**
 * Reaches the protected getTracker without standing up the whole guard, which
 * would need the throttler's own options and storage injected.
 */
class TestableGuard extends ClientIpThrottlerGuard {
  constructor() {
    super(undefined as never, undefined as never, undefined as never);
  }

  track(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}

/*
 * Every browser request reaches this API through the Next.js proxy, so req.ip is
 * ONE address for the entire user base. Keying rate limits on it made the login
 * limit of five per minute a limit of five per minute in total: a shift change
 * would lock everyone out, and one attacker could exhaust everybody's budget.
 */
describe('ClientIpThrottlerGuard tracker', () => {
  const guard = new TestableGuard();
  const originalTrustProxy = process.env.TRUST_PROXY;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.TRUST_PROXY = originalTrustProxy;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('prefers the authenticated user, the one identifier nobody can forge', async () => {
    // Also stops a whole office behind one NAT address sharing a single budget.
    const key = await guard.track({
      user: { userId: 'user-1' },
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(key).toBe('user:user-1');
  });

  it('uses the left-most forwarded address behind a trusted proxy', async () => {
    process.env.TRUST_PROXY = 'true';

    // Left-most is the original client; everything right of it is the chain.
    const key = await guard.track({
      headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' },
      ip: '10.0.0.1',
    });

    expect(key).toBe('ip:203.0.113.9');
  });

  it('ignores the forwarded header when not behind a proxy', async () => {
    // Otherwise anyone could set it and mint themselves an unlimited budget.
    process.env.TRUST_PROXY = 'false';
    process.env.NODE_ENV = 'development';

    const key = await guard.track({
      headers: { 'x-forwarded-for': '203.0.113.9' },
      ip: '10.0.0.1',
    });

    expect(key).toBe('ip:10.0.0.1');
  });

  it('falls back to the socket address when the header is absent', async () => {
    process.env.TRUST_PROXY = 'true';
    expect(await guard.track({ headers: {}, ip: '10.0.0.7' })).toBe('ip:10.0.0.7');
  });

  it('never returns an empty tracker', async () => {
    // An empty key would put every anonymous caller in one bucket.
    process.env.TRUST_PROXY = 'true';
    expect(await guard.track({ headers: { 'x-forwarded-for': '  ' } })).toBe('ip:unknown');
    expect(await guard.track({})).toBe('ip:unknown');
  });

  it('separates two clients behind the same proxy', async () => {
    process.env.TRUST_PROXY = 'true';

    const first = await guard.track({ headers: { 'x-forwarded-for': '203.0.113.1' } });
    const second = await guard.track({ headers: { 'x-forwarded-for': '203.0.113.2' } });

    expect(first).not.toBe(second);
  });
});
