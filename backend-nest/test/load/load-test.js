/**
 * k6 Load Test — HRM Warehouse Backend
 *
 * Covers the three highest-risk write paths:
 *   1. Login (auth)
 *   2. Attendance check-in (POST /api/v1/attendance)
 *   3. Payroll run creation (POST /api/v1/payroll/calculate)
 *
 * HOW TO RUN (point at staging before any release):
 *   k6 run --env BASE_URL=http://staging.example.com test/load/load-test.js
 *
 * INSTALL k6:
 *   https://k6.io/docs/getting-started/installation/
 *
 * THRESHOLDS (adjust before promoting to production):
 *   - p95 response time < 500ms for login and attendance
 *   - p95 response time < 2000ms for payroll (heavier computation)
 *   - Error rate < 1%
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5003';
const LOGIN_USERNAME = __ENV.LOGIN_USERNAME || 'admin';
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || 'REPLACE_ME';

// ── Custom metrics ────────────────────────────────────────────────────────────
const errorRate = new Rate('errors');
const loginDuration = new Trend('login_duration', true);
const attendanceDuration = new Trend('attendance_duration', true);
const payrollDuration = new Trend('payroll_duration', true);

// ── Thresholds ────────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: '30s', target: 10 },  // ramp up
    { duration: '1m',  target: 10 },  // steady state
    { duration: '20s', target: 0 },   // ramp down
  ],
  thresholds: {
    errors:              ['rate<0.01'],          // < 1% error rate
    login_duration:      ['p(95)<500'],          // p95 < 500ms
    attendance_duration: ['p(95)<500'],          // p95 < 500ms
    payroll_duration:    ['p(95)<2000'],         // p95 < 2s (heavier)
    http_req_duration:   ['p(95)<1000'],         // overall p95 < 1s
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function jsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function todayISO() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// ── Main VU scenario ──────────────────────────────────────────────────────────
export default function () {
  // ── 1. Login ────────────────────────────────────────────────────────────────
  const loginStart = Date.now();
  const loginRes = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ username: LOGIN_USERNAME, password: LOGIN_PASSWORD }),
    { headers: jsonHeaders(null) },
  );
  loginDuration.add(Date.now() - loginStart);

  const loginOk = check(loginRes, {
    'login: status 200 or 201': (r) => r.status === 200 || r.status === 201,
    'login: has token or cookie': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!body.accessToken || !!body.token || r.headers['Set-Cookie'];
      } catch {
        return false;
      }
    },
  });

  if (!loginOk) {
    errorRate.add(1);
    return;
  }
  errorRate.add(0);

  let token = null;
  try {
    const body = JSON.parse(loginRes.body);
    token = body.accessToken || body.token || null;
  } catch {
    // cookie-based auth — token stays null, cookie is sent automatically
  }

  sleep(0.5);

  // ── 2. Attendance check-in ──────────────────────────────────────────────────
  const attendanceStart = Date.now();
  const attendanceRes = http.post(
    `${BASE_URL}/api/v1/attendance`,
    JSON.stringify({
      employeeId: 'EMP000001',
      timestamp: todayISO(),
      type: 'IN',
      source: 'manual',
    }),
    {
      headers: {
        ...jsonHeaders(token),
        'Idempotency-Key': `load-test-${__VU}-${__ITER}`,
      },
    },
  );
  attendanceDuration.add(Date.now() - attendanceStart);

  const attendanceOk = check(attendanceRes, {
    'attendance: status 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  errorRate.add(attendanceOk ? 0 : 1);

  sleep(1);

  // ── 3. Payroll run (only 1 in 10 VU iterations to avoid DB overload) ────────
  if (__ITER % 10 === 0) {
    const payrollStart = Date.now();
    const payrollRes = http.post(
      `${BASE_URL}/api/v1/payroll/calculate`,
      JSON.stringify({
        periodStart: `${todayDate().slice(0, 7)}-01`,
        periodEnd: todayDate(),
        workDaysInPeriod: 26,
        hoursPerDay: 8,
        includeAttendanceDeductions: true,
        includeTransportationDeductions: false,
      }),
      {
        headers: {
          ...jsonHeaders(token),
          'Idempotency-Key': `payroll-load-${__VU}-${__ITER}`,
        },
        timeout: '30s',
      },
    );
    payrollDuration.add(Date.now() - payrollStart);

    const payrollOk = check(payrollRes, {
      'payroll: status 2xx': (r) => r.status >= 200 && r.status < 300,
    });
    errorRate.add(payrollOk ? 0 : 1);
  }

  sleep(1);
}
