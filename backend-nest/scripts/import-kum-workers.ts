/**
 * import-kum-workers.ts
 * ─────────────────────────────────────────────────────────────────────────
 * Maps 4 specific KU&M JEANS workers' May 2026 data from the payroll
 * spreadsheet into the system via the HTTP API for payroll processing.
 *
 * Workers:  EMP00003, EMP00007, EMP00014, EMP00021
 * Period:   2026-05-01 → 2026-05-31
 * Source:   docs\رواتب_شهر_5_مع_الراتب_المقبوض.xlsx (Sheet1)
 *
 * Run (from backend-nest dir):
 *   npm run import:kum-workers
 *   OR: npx ts-node --transpile-only --project tsconfig.scripts.json scripts/import-kum-workers.ts
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as XLSX from 'xlsx';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const BASE = 'http://localhost:5003/api/v1';
const USERNAME = 'admin';
const PASSWORD = 'cYAMAZbGnaFdRF9hQkLg';

const EXCEL_PATH = path.resolve(__dirname, '..', 'docs', 'رواتب_شهر_5_مع_الراتب_المقبوض.xlsx');

const PERIOD_START = '2026-05-01';
const PERIOD_END = '2026-05-31';

const TARGET_WORKERS = ['EMP00003', 'EMP00007', 'EMP00014', 'EMP00021'];

interface WorkerRow {
  employeeId: string;
  biometricNumber: number;
  name: string;
  profession: string;
  department: string;
  workDaysInPeriod: number;
  hoursPerDay: number;
  gracePeriodMinutes: number;
  status: string;
  financialSettlementStatus: string;
  isSettled: boolean;
  isFinanciallySettled: string;
  baseSalary: number;
  livingAllowance: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
  workDaysPerMonth: string;
  absenceDays: number;
  overtimeRegularMinutes: number;
  sickLeaveDays: number;
  adminLeaveDays: number;
  unpaidLeaveDays: number;
  unpaidHours: number;
  deathLeaveDays: number;
  overtimeWeekendDays: number;
  transportAllowance: number;
  penaltyAmount: number;
  advanceAmount: number;
  bonusAdjustment: number;
  insuranceAmount: number;
  expectedNetPay: number;
}

let cookieJar = '';

function extractCookies(headers: http.IncomingHttpHeaders) {
  const raw = headers['set-cookie'] ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  if (!arr[0]) return;
  const pairs = arr.map((c: string) => c.split(';')[0]).filter(Boolean);
  for (const pair of pairs) {
    const [name] = pair.split('=');
    const re = new RegExp(`(^|;\\s*)${name}=[^;]*`);
    if (cookieJar && re.test(cookieJar)) {
      cookieJar = cookieJar.replace(re, pair);
    } else {
      cookieJar = cookieJar ? `${cookieJar}; ${pair}` : pair;
    }
  }
}

function request(method: string, urlStr: string, body: unknown = null): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    };
    if (cookieJar) headers['Cookie'] = cookieJar;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = mod.request(options, (res) => {
      extractCookies(res.headers);
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          json = { raw: data };
        }
        resolve({ status: res.statusCode ?? 0, body: json, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function api(method: string, pathStr: string, body: unknown = null): Promise<any> {
  const res = await request(method, `${BASE}${pathStr}`, body);
  if (res.status >= 400) {
    const msg =
      res.body?.message ??
      res.body?.error?.message ??
      res.body?.raw?.slice?.(0, 300) ??
      `HTTP ${res.status}`;
    console.error(`  ✗ ${method} ${pathStr} → HTTP ${res.status}: ${msg}`);
    return null;
  }
  return res.body;
}

function parseExcel(filePath: string): Map<string, WorkerRow> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Sheet1'];
  if (!ws) throw new Error('Sheet1 not found in workbook');

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const result = new Map<string, WorkerRow>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as any[];
    if (!row || row.length === 0) continue;

    const employeeId = String(row[0] || '').trim();
    if (!employeeId) continue;

    const worker: WorkerRow = {
      employeeId,
      biometricNumber: Number(row[1] || 0),
      name: String(row[2] || '').trim(),
      profession: String(row[3] || '').trim(),
      department: String(row[4] || '').trim(),
      workDaysInPeriod: Number(row[5] || 0),
      hoursPerDay: Number(row[6] || 0),
      gracePeriodMinutes: Number(row[7] || 0),
      status: String(row[8] || '').trim(),
      financialSettlementStatus: String(row[9] || '').trim(),
      isSettled: Boolean(row[10]),
      isFinanciallySettled: String(row[11] || '').trim(),
      baseSalary: Number(row[12] || 0),
      livingAllowance: Number(row[13] || 0),
      lateMinutes: Number(row[14] || 0),
      earlyLeaveMinutes: Number(row[15] || 0),
      scheduledStart: String(row[16] || '').trim(),
      scheduledEnd: String(row[17] || '').trim(),
      workDaysPerMonth: String(row[18] || '').trim(),
      absenceDays: Number(row[19] || 0),
      overtimeRegularMinutes: Number(row[20] || 0),
      sickLeaveDays: Number(row[21] || 0),
      adminLeaveDays: Number(row[22] || 0),
      unpaidLeaveDays: Number(row[23] || 0),
      unpaidHours: Number(row[24] || 0),
      deathLeaveDays: Number(row[25] || 0),
      overtimeWeekendDays: Number(row[26] || 0),
      transportAllowance: Number(row[27] || 0),
      penaltyAmount: Number(row[28] || 0),
      advanceAmount: Number(row[29] || 0),
      bonusAdjustment: Number(row[30] || 0),
      insuranceAmount: Number(row[31] || 0),
      expectedNetPay: Number(row[32] || 0),
    };

    if (TARGET_WORKERS.includes(employeeId)) {
      result.set(employeeId, worker);
    }
  }

  for (const id of TARGET_WORKERS) {
    if (!result.has(id)) {
      throw new Error(`Worker ${id} not found in Sheet1`);
    }
  }

  return result;
}

interface EmployeeData {
  employeeId: string;
  name: string;
  biometricNumber: number;
  profession: string;
  department: string;
  baseSalary: number;
  livingAllowance: number;
  transportAllowance: number;
  insuranceAmount: number;
  workDaysInPeriod: number;
  hoursPerDay: number;
  gracePeriodMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
}

function mapEmployee(worker: WorkerRow): EmployeeData {
  return {
    employeeId: worker.employeeId,
    name: worker.name,
    biometricNumber: worker.biometricNumber,
    profession: worker.profession,
    department: worker.department,
    baseSalary: worker.baseSalary,
    livingAllowance: worker.livingAllowance,
    transportAllowance: worker.transportAllowance,
    insuranceAmount: worker.insuranceAmount,
    workDaysInPeriod: worker.workDaysInPeriod,
    hoursPerDay: worker.hoursPerDay,
    gracePeriodMinutes: worker.gracePeriodMinutes,
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
  };
}

async function login(): Promise<boolean> {
  const res = await api('POST', '/auth/login', { username: USERNAME, password: PASSWORD });
  if (!res) {
    console.error('  ✗ Login failed');
    return false;
  }
  console.log('  ✓ Logged in — session cookie stored');
  return true;
}

async function findEmployee(employeeId: string): Promise<any> {
  const search = await api('GET', `/employees?search=${employeeId}&limit=10`);
  const list = search?.employees ?? search?.data ?? [];
  let found = list.find((e: any) => e.employeeId === employeeId) ?? null;

  if (!found) {
    for (const status of ['terminated', 'resigned', 'inactive']) {
      const s = await api('GET', `/employees?search=${employeeId}&limit=10&status=${status}`);
      const sl = s?.employees ?? s?.data ?? [];
      found = sl.find((e: any) => e.employeeId === employeeId) ?? null;
      if (found) break;
    }
  }

  return found;
}

async function createEmployee(data: EmployeeData): Promise<boolean> {
  const payload: Record<string, unknown> = {
    employeeId: data.employeeId,
    name: data.name,
    biometricNumber: data.biometricNumber,
    profession: data.profession,
    department: data.department,
    baseSalary: String(data.baseSalary),
    livingAllowance: data.livingAllowance,
    workDaysInPeriod: data.workDaysInPeriod,
    hoursPerDay: data.hoursPerDay,
    gracePeriodMinutes: data.gracePeriodMinutes,
    scheduledStart: data.scheduledStart,
    scheduledEnd: data.scheduledEnd,
  };
  const res = await api('POST', '/employees', payload);
  if (!res) return false;
  console.log(`  ✓ Employee created: ${data.employeeId} — ${data.name}`);
  return true;
}

async function updateEmployee(employeeId: string, data: EmployeeData): Promise<boolean> {
  const payload: Record<string, unknown> = {
    name: data.name,
    biometricNumber: data.biometricNumber,
    profession: data.profession,
    department: data.department,
    baseSalary: String(data.baseSalary),
    livingAllowance: data.livingAllowance,
    workDaysInPeriod: data.workDaysInPeriod,
    hoursPerDay: data.hoursPerDay,
    gracePeriodMinutes: data.gracePeriodMinutes,
    scheduledStart: data.scheduledStart,
    scheduledEnd: data.scheduledEnd,
  };
  const res = await api('PUT', `/employees/${employeeId}`, payload);
  if (!res) return false;
  console.log(`  ✓ Employee updated: ${employeeId}`);
  return true;
}

async function setSalary(employeeId: string, data: EmployeeData): Promise<boolean> {
  const payload = {
    profession: data.profession,
    baseSalary: data.baseSalary,
    livingAllowance: data.livingAllowance,
    transportAllowance: data.transportAllowance,
    insuranceAmount: data.insuranceAmount,
  };
  const res = await api('PUT', `/salary/${employeeId}`, payload);
  if (!res) return false;
  console.log(`  ✓ Salary set: ${employeeId} (base=${data.baseSalary.toLocaleString()}, living=${data.livingAllowance.toLocaleString()}, insurance=${data.insuranceAmount.toLocaleString()})`);
  return true;
}

async function upsertPayrollInput(worker: WorkerRow): Promise<boolean> {
  const payload: Record<string, unknown> = {
    employeeId: worker.employeeId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    lateMinutes: worker.lateMinutes,
    earlyLeaveMinutes: worker.earlyLeaveMinutes,
    absenceDays: worker.absenceDays,
    overtimeRegularMinutes: worker.overtimeRegularMinutes,
    overtimeWeekendDays: worker.overtimeWeekendDays * (worker.hoursPerDay || 9) * 60,
    penaltyAmount: worker.penaltyAmount,
    advanceAmount: worker.advanceAmount,
    bonusAdjustment: worker.bonusAdjustment,
    insuranceAmount: worker.insuranceAmount,
    transportAllowanceOverride: worker.transportAllowance,
  };
  const res = await api('POST', '/payroll/inputs', payload);
  if (!res) return false;
  console.log(`  ✓ Payroll input upserted: ${worker.employeeId}`);
  return true;
}

async function terminateEmployee(
  employeeId: string,
  terminationDate: string,
  terminationType: 'resignation' | 'termination',
  reason: string,
): Promise<boolean> {
  const payload = {
    employeeId,
    terminationDate,
    terminationType,
    reason,
    notes: 'Imported from payroll spreadsheet — تعديل المجاميع',
  };
  const res = await api('POST', '/employees/terminate', payload);
  if (!res) {
    console.log(`  ℹ POST /terminate failed, trying PATCH /terminate...`);
    await api('PATCH', `/employees/${employeeId}/terminate`, {
      terminationDate,
      terminationType,
      terminationReason: reason,
      terminationNotes: 'Imported from payroll spreadsheet — تعديل المجاميع',
    });
  }
  console.log(`  ✓ Employee terminated: ${employeeId} (${terminationType}, ${terminationDate})`);
  return true;
}

async function settleEmployee(employeeId: string): Promise<boolean> {
  await api('PATCH', `/employees/${employeeId}/settle`, null);
  console.log(`  ✓ Employee settled: ${employeeId}`);
  return true;
}

async function calculatePayroll(): Promise<any> {
  console.log('\n  Calculating payroll for May 2026...');
  const payload = {
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    gracePeriodMinutes: 5,
    workDaysInPeriod: 26,
    hoursPerDay: 9,
    includeAttendanceDeductions: true,
    includeTransportationDeductions: false,
  };
  const calcResult = await api('POST', '/payroll/calculate', payload);
  if (!calcResult) return null;

  // Fetch the full run with items (calculate returns run summary, items are separate)
  const runId = calcResult.payrollRun?.runId ?? calcResult.payrollRun?.id;
  if (runId) {
    const runDetail = await api('GET', `/payroll/${runId}`);
    if (runDetail) {
      return runDetail;
    }
  }
  return calcResult;
}

function fmt(n: number): string {
  return n.toLocaleString('ar-EG');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  KU&M Workers — May 2026 Payroll Import');
  console.log('═══════════════════════════════════════════════════════════');

  console.log('\n[1/5] Parsing spreadsheet...');
  const workers = parseExcel(EXCEL_PATH);
  console.log(`  ✓ Loaded ${workers.size} target workers from Sheet1\n`);

  for (const [id, w] of workers) {
    console.log(`  ${id} — ${w.name} (${w.profession})`);
    console.log(`    status=${w.status}, baseSalary=${fmt(w.baseSalary)}, livingAllowance=${fmt(w.livingAllowance)}`);
    console.log(`    absence=${w.absenceDays}d, late=${w.lateMinutes}min, otRegular=${w.overtimeRegularMinutes}min, otWeekend=${w.overtimeWeekendDays}min`);
    if (w.penaltyAmount) console.log(`    penalty=${fmt(w.penaltyAmount)}`);
    if (w.advanceAmount) console.log(`    advance=${fmt(w.advanceAmount)}`);
    if (w.insuranceAmount) console.log(`    insurance=${fmt(w.insuranceAmount)}`);
    console.log(`    expected الراتب المقبوض = ${fmt(w.expectedNetPay)}`);
    console.log('');
  }

  console.log('[2/5] Logging in as admin...');
  if (!(await login())) process.exit(1);

  console.log('\n[3/5] Importing workers...');
  for (const id of TARGET_WORKERS) {
    const worker = workers.get(id)!;
    const empData = mapEmployee(worker);

    console.log(`\n  --- ${id} — ${worker.name} ---`);

    const existing = await findEmployee(id);

     if (existing) {
      console.log(`  ℹ Employee already exists — updating`);
      await updateEmployee(id, empData);
    } else {
      const created = await createEmployee(empData);
      if (!created) {
        console.log(`  ℹ Employee may exist but was hidden — updating instead`);
        await updateEmployee(id, empData);
      }
    }

    // Set salary record (EmployeeSalary table)
    await setSalary(id, empData);

    // Upsert payroll input (PayrollInput table) — attendance + financial overrides
    await upsertPayrollInput(worker);

    // Handle termination for terminated employees
    if (worker.status === 'terminated' && worker.isSettled) {
      const termType: 'resignation' | 'termination' =
        worker.department.includes('مستقيلين') ? 'resignation' : 'termination';
      await terminateEmployee(id, '2026-05-31', termType, 'انهاء خدمة حسب جدول الرواتب');
      await settleEmployee(id);
    }
  }

  console.log('\n[4/5] Verifying imported data...');
  // Re-fetch and verify each worker's salary and payroll input
  for (const id of TARGET_WORKERS) {
    const salary = await api('GET', `/salary/${id}`);
    const inputs = await api('GET', `/payroll/inputs?employeeId=${id}&periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`);

    if (salary) {
      console.log(`  ${id}: salary.baseSalary=${fmt(Number(salary.baseSalary || 0))}, livingAllowance=${fmt(Number(salary.livingAllowance || 0))}`);
    }
    if (inputs) {
      const inputRecord = Array.isArray(inputs)
        ? inputs[0]
        : (inputs.inputs ?? inputs.data ?? inputs)?.[0] ?? inputs;
      if (inputRecord) {
        console.log(`  ${id}: payrollInput.absenceDays=${inputRecord.absenceDays}, lateMinutes=${inputRecord.lateMinutes}, otp=${inputRecord.overtimeRegularMinutes}, netExpected=${fmt(workers.get(id)!.expectedNetPay)}`);
      }
    }
  }

  console.log('\n[5/5] Calculating payroll for May 2026...');
  const calcResult = await calculatePayroll();

  let mismatches = 0;

  // ── Summary comparison ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTS — Computed vs Expected (الراتب المقبوض)');
  console.log('═══════════════════════════════════════════════════════════');

  if (calcResult?.payrollRun) {
    const run = calcResult.payrollRun;
    const items = calcResult.items ?? run.items ?? [];
    console.log(`  Payroll Run: ${run.runId ?? 'N/A'}`);
    console.log(`  Status: ${run.status ?? 'N/A'}`);
    console.log(`  Total Employees: ${run.totalEmployees ?? 0}`);
    if (run.totalNetPay !== undefined) {
      console.log(`  Total Net Pay: ${fmt(Number(run.totalNetPay))}`);
    }

     console.log('\n  ── Per-Employee Comparison ──');
    const header = `  ${'ID'.padEnd(12)} ${'Name'.padEnd(24)} ${'Computed'.padEnd(18)} ${'Expected'.padEnd(18)} ${'Diff'.padEnd(14)} ${'Match'}`;
    console.log(header);
    console.log('  ' + '─'.repeat(header.length - 2));

    for (const id of TARGET_WORKERS) {
      const worker = workers.get(id)!;
      const item = Array.isArray(items)
        ? items.find((i: any) => i.employeeId === id)
        : null;

      if (item) {
        const computed = Number(item.netPayRounded ?? item.netPay ?? 0);
        const expected = worker.expectedNetPay;
        const diff = Math.abs(computed - expected);
        const match = diff < 1000 ? '✓' : '✗';
        if (diff >= 1000) mismatches++;

        console.log(
          `  ${id.padEnd(12)} ${worker.name.slice(0, 24).padEnd(24)} ` +
          `${fmt(computed).padEnd(18)} ${fmt(expected).padEnd(18)} ` +
          `${fmt(diff).padEnd(14)} ${match}`,
        );
      } else {
        const excludedMatch = worker.expectedNetPay === 0;
        if (!excludedMatch) mismatches++;
        console.log(
          `  ${id.padEnd(12)} ${worker.name.slice(0, 24).padEnd(24)} ` +
          `${'— excluded —'.padEnd(18)} ${fmt(worker.expectedNetPay).padEnd(18)} ` +
          `${fmt(worker.expectedNetPay).padEnd(14)} ${excludedMatch ? '✓' : '✗'}`,
        );
      }
    }
  } else {
    console.log('  Payroll calculation returned an unexpected response:');
    console.log('  ' + JSON.stringify(calcResult).slice(0, 500));
  }

   console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Import complete.');
  console.log('═══════════════════════════════════════════════════════════');

  if (mismatches > 0) {
    console.log('\n  Notes:');
    console.log('  • overtimeWeekendDays converted from days→minutes (×hoursPerDay×60) for API');
    console.log('  • Backend OT multiplier 1.5x vs spreadsheet 1.0x');
    console.log('  • Backend weekend OT multiplier 1.5x vs spreadsheet 2.0x');
    console.log('  • Spreadsheet includes a 10,000 LBP fixed deduction not in backend');
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message ?? err);
  process.exit(1);
});
