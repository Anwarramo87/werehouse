/**
 * k6 Capacity Test — how many concurrent users before the server struggles.
 *
 * Complements load-test.js, which exercises the write paths at low concurrency.
 * This one models the READ path that actually sets capacity: opening /home fires
 * eight independent API calls in parallel (see app/(dashboard)/home/page.tsx),
 * and the heaviest of them, GET /dashboard/home, runs eight database queries of
 * its own (src/dashboard/dashboard.service.ts). One "page view" is therefore
 * ~20-25 queries and a burst of 8 concurrent connections against a pool whose
 * default max is 20 (src/prisma/prisma.service.ts).
 *
 * That ratio is the whole story: ~2-3 simultaneous page loads saturate the pool,
 * and everything after that queues. This test finds where that starts to hurt.
 *
 * RUN IT AGAINST STAGING, NEVER PRODUCTION — it logs in repeatedly and reads
 * real payroll data.
 *
 *   k6 run --env BASE_URL=https://staging-api.example.com \
 *          --env LOGIN_USERNAME=loadtest \
 *          --env LOGIN_PASSWORD='...' \
 *          test/load/dashboard-capacity.js
 *
 * READING THE RESULT
 *   The number you want is the VU count at which p95 crosses ~1.5s or errors
 *   pass 1%. Watch the ramp output, not the summary: the summary averages the
 *   healthy early stages with the saturated late ones and flatters the result.
 *
 *   Run `SELECT count(*) FROM pg_stat_activity;` on the database while this is
 *   ramping. If it pins at the pool max while p95 climbs, the bottleneck is
 *   connections, not CPU — raise DATABASE_MAX_CONNECTIONS before buying cores.
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:5003').replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;
const LOGIN_USERNAME = __ENV.LOGIN_USERNAME || 'admin';
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || 'REPLACE_ME';

// The month the dashboard defaults to. Override to test a period with real data.
const PERIOD = __ENV.PERIOD || new Date().toISOString().slice(0, 7);

const dashboardFanout = new Trend('dashboard_fanout_duration', true);
const loginDuration = new Trend('login_duration', true);
const failureRate = new Rate('failed_requests');

export const options = {
  // A staircase, so the report shows *where* it broke rather than an average
  // over healthy and saturated traffic alike.
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 25 },
    { duration: '1m', target: 50 },
    { duration: '1m', target: 75 },
    { duration: '2m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // Deliberately generous: this test is for finding the ceiling, not for
    // gating a release. Tighten once you know the real numbers.
    failed_requests: ['rate<0.01'],
    login_duration: ['p(95)<1000'],
    dashboard_fanout_duration: ['p(95)<2500'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  if (LOGIN_PASSWORD === 'REPLACE_ME') {
    throw new Error('Set --env LOGIN_PASSWORD=... (use a dedicated load-test account)');
  }
  return {};
}

export default function () {
  // ── Sign in ───────────────────────────────────────────────────────────────
  // The backend hashes with bcrypt at BCRYPT_ROUNDS (default 12), which is
  // ~250ms of pure CPU per login and single-threaded. At high VU counts this
  // alone can saturate a core, so it is measured separately from the reads.
  let jar;
  group('login', () => {
    const res = http.post(
      `${API}/auth/login`,
      JSON.stringify({ username: LOGIN_USERNAME, password: LOGIN_PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
    );
    loginDuration.add(res.timings.duration);
    const ok = check(res, { 'login 200/201': (r) => r.status === 200 || r.status === 201 });
    failureRate.add(!ok);
    jar = http.cookieJar();
  });

  if (!jar) return;

  // ── One dashboard page view ───────────────────────────────────────────────
  // Sent as a batch because that is what the browser does: TanStack Query fires
  // all of these in parallel on mount. Sending them serially would hide the
  // connection-pool contention that is the actual limit.
  group('dashboard page view', () => {
    const started = Date.now();
    const responses = http.batch([
      ['GET', `${API}/dashboard/home`, null, { tags: { name: 'dashboard/home' } }],
      ['GET', `${API}/employees?page=1&limit=50`, null, { tags: { name: 'employees' } }],
      ['GET', `${API}/departments`, null, { tags: { name: 'departments' } }],
      ['GET', `${API}/employees/resigned`, null, { tags: { name: 'resigned' } }],
      ['GET', `${API}/advances`, null, { tags: { name: 'advances' } }],
      ['GET', `${API}/penalties`, null, { tags: { name: 'penalties' } }],
      ['GET', `${API}/bonuses?period=${PERIOD}`, null, { tags: { name: 'bonuses' } }],
      ['GET', `${API}/payroll/report?month=${PERIOD}`, null, { tags: { name: 'payroll-report' } }],
    ]);

    dashboardFanout.add(Date.now() - started);

    for (const res of responses) {
      // 403 is a legitimate answer for a limited account and must not be
      // counted as a failure, or the error rate measures permissions instead
      // of capacity.
      const ok = res.status === 200 || res.status === 403;
      failureRate.add(!ok);
      check(res, { 'no server error': () => res.status < 500 });
    }
  });

  // A real user reads the screen before doing anything else. Without this pause
  // the test measures a hammering loop, not a workday, and wildly understates
  // how many people the server supports.
  sleep(Math.random() * 5 + 5); // 5-10s think time
}

export function handleSummary(data) {
  const p95 = data.metrics.dashboard_fanout_duration?.values?.['p(95)'];
  const errors = data.metrics.failed_requests?.values?.rate;
  const lines = [
    '',
    '─── capacity read ───────────────────────────────────────────',
    `  dashboard fan-out p95 : ${p95 ? p95.toFixed(0) + ' ms' : 'n/a'}`,
    `  error rate            : ${errors !== undefined ? (errors * 100).toFixed(2) + ' %' : 'n/a'}`,
    '',
    '  With 5-10s think time, 1 VU ~= 1 active user. The VU count where p95',
    '  crossed ~1500ms in the ramp output is your practical ceiling per node.',
    '─────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

  return { stdout: lines };
}
