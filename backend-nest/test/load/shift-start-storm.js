/**
 * k6 Capacity Test — the shift-start login storm.
 *
 * The scenario this models: every employee gets an account, and at shift change
 * a few hundred of them sign in inside a two-minute window, then each opens
 * their own profile.
 *
 * This is a DIFFERENT shape of load from dashboard-capacity.js, and the
 * difference is the whole point:
 *
 *   dashboard-capacity.js  is pool-bound   — 8 parallel queries per page view
 *                                            against a pool of 20.
 *   this one               is CPU-bound    — bcrypt at 12 rounds costs ~269ms
 *                                            of pure CPU per login (measured on
 *                                            a dev laptop), single-threaded, and
 *                                            no pool connection is held while it
 *                                            runs.
 *
 * So watch different numbers here. Pool saturation is NOT the signal during the
 * storm; the signal is login p95 climbing while `iterations` flattens, which is
 * the event loop queueing behind bcrypt.
 *
 * ── BEFORE YOU RUN IT ──────────────────────────────────────────────────────
 * Two things in the app will otherwise stop this test from measuring anything:
 *
 *  1. POST /auth/login is throttled to 5 requests / 60s (auth.controller.ts).
 *     The throttler keys on client IP, and every browser request reaches the
 *     API through the Next.js proxy — so in production the backend may see ONE
 *     IP for all of them. If this test 429s immediately, that is not a k6
 *     problem, it is the finding: raise the limit for the test window, or fix
 *     the tracker to key on the forwarded client IP first.
 *
 *  2. Seed real accounts. Pass a CSV of usernames via --env USERS_FILE, or the
 *     test falls back to one shared account, which measures bcrypt but not the
 *     per-user query path.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────
 *   k6 run --env BASE_URL=https://staging-api... \
 *          --env EMPLOYEES=300 \
 *          --env LOGIN_PASSWORD='...' \
 *          test/load/shift-start-storm.js
 *
 * STAGING ONLY. It signs in hundreds of times and reads real payroll data.
 */

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:5003').replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;

/** How many employees arrive in the window. Raise to model a bigger factory. */
const EMPLOYEES = Number(__ENV.EMPLOYEES || 300);
/** How long they trickle in over. A real shift change is 2-5 minutes. */
const WINDOW_SECONDS = Number(__ENV.WINDOW_SECONDS || 120);

const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || 'REPLACE_ME';
const USER_PREFIX = __ENV.USER_PREFIX || 'emp';
const SHARED_USER = __ENV.LOGIN_USERNAME || '';

const loginDuration = new Trend('login_duration', true);
const profileDuration = new Trend('profile_duration', true);
const loginThrottled = new Counter('login_throttled_429');
const loginFailed = new Rate('login_failed');
const profileForbidden = new Counter('profile_forbidden_403');

export const options = {
  scenarios: {
    // Arrival rate, not VU count: a storm is defined by how many people show up
    // per second, and k6 will add VUs as needed to sustain that. If it cannot,
    // it reports dropped iterations — which is itself the ceiling signal.
    shift_start: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { duration: '20s', target: Math.ceil(EMPLOYEES / WINDOW_SECONDS) },
        { duration: `${WINDOW_SECONDS}s`, target: Math.ceil(EMPLOYEES / WINDOW_SECONDS) },
        { duration: '30s', target: Math.ceil((EMPLOYEES / WINDOW_SECONDS) * 3) },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Deliberately loose — this test exists to find the ceiling, not to gate a
    // release. A login slower than 3s is already a person staring at a spinner
    // at the factory gate.
    login_duration: ['p(95)<3000'],
    profile_duration: ['p(95)<2000'],
    login_failed: ['rate<0.02'],
    dropped_iterations: ['count<1'],
  },
};

export function setup() {
  if (LOGIN_PASSWORD === 'REPLACE_ME') {
    throw new Error('Set --env LOGIN_PASSWORD=... (use seeded load-test accounts)');
  }
  return { startedAt: Date.now() };
}

export default function () {
  // Spread across seeded accounts so each login exercises a different user row
  // and a different profile, rather than warming one cache entry.
  const n = (__VU * 7919 + __ITER) % EMPLOYEES; // 7919 prime — avoids clustering
  const username = SHARED_USER || `${USER_PREFIX}${String(1000 + n)}`;

  let signedIn = false;

  group('login', () => {
    const res = http.post(
      `${API}/auth/login`,
      JSON.stringify({ username, password: LOGIN_PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
    );

    loginDuration.add(res.timings.duration);

    if (res.status === 429) {
      // Counted, not treated as failure: hitting the 5/min login throttle means
      // the test is measuring the rate limiter, not the server. Fix that first.
      loginThrottled.add(1);
      return;
    }

    signedIn = res.status === 200 || res.status === 201;
    loginFailed.add(!signedIn);
    check(res, { 'login accepted': () => signedIn });
  });

  if (!signedIn) return;

  // What an employee actually does after signing in: look at their own record.
  // NOTE: as the code stands, this needs `view_employees`, which is a
  // see-everyone permission — there is no self-scoped endpoint. A 403 here is
  // the authorisation finding, not a load result, so it is counted separately.
  group('own profile', () => {
    const started = Date.now();
    const res = http.get(`${API}/employees/${USER_PREFIX.toUpperCase()}${1000 + n}/profile`, {
      tags: { name: 'employee-profile' },
    });
    profileDuration.add(Date.now() - started);

    if (res.status === 403) {
      profileForbidden.add(1);
      return;
    }
    check(res, { 'profile not a server error': () => res.status < 500 });
  });
}

export function handleSummary(data) {
  const v = (m, k = 'p(95)') => data.metrics[m]?.values?.[k];
  const n = (m) => data.metrics[m]?.values?.count ?? 0;

  const throttled = n('login_throttled_429');
  const forbidden = n('profile_forbidden_403');
  const dropped = n('dropped_iterations');

  const lines = [
    '',
    '─── shift-start storm ──────────────────────────────────────────',
    `  employees modelled     : ${EMPLOYEES} over ${WINDOW_SECONDS}s`,
    `  login p95              : ${v('login_duration')?.toFixed(0) ?? 'n/a'} ms`,
    `  profile p95            : ${v('profile_duration')?.toFixed(0) ?? 'n/a'} ms`,
    `  logins 429-throttled   : ${throttled}`,
    `  profiles 403-forbidden : ${forbidden}`,
    `  dropped iterations     : ${dropped}`,
    '',
  ];

  if (throttled > 0) {
    lines.push('  ⚠ The 5/min login throttle fired. This run measured the rate');
    lines.push('    limiter, not the server. Raise it for the test window.');
    lines.push('');
  }
  if (forbidden > 0) {
    lines.push('  ⚠ Profiles were forbidden. Employees have no self-scoped');
    lines.push('    endpoint — /employees/:id/profile needs view_employees,');
    lines.push('    which grants sight of every colleague. Fix the model first.');
    lines.push('');
  }
  if (dropped > 0) {
    lines.push('  → Dropped iterations mean k6 could not sustain the arrival');
    lines.push('    rate: the server is already past its ceiling here.');
    lines.push('');
  }

  lines.push('  Read login p95, not pool saturation. Logins are CPU-bound on');
  lines.push('  bcrypt and hold no connection while hashing; the profile reads');
  lines.push('  are what touch the pool.');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push('');

  return { stdout: lines.join('\n') };
}
