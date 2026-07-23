# 12 — Fixes Implemented

All behavior-preserving unless noted. Preceded by a "prove-yourself-wrong" pass.

- **F1-attend (dup punches, 100%):** unique `(employeeId,timestamp,type)` on `attendance_records`; de-duped 9 live dup groups; `create()` now idempotent on P2002.
- **F2 (aggregation, 100%):** unique `(employeeId,date,recordType,source)` on `daily_attendance_logs` → idempotent.
- **F3 (payroll lock, 100%):** `calculate()` + `calculateAsync()` use `pg_advisory_xact_lock` inside a Prisma interactive tx (single pinned connection; auto-release). **Corrected an earlier flawed `pg_advisory_lock`/`unlock` implementation that could leak locks across pooled connections.**
- **F4 / C1 (async dedup, 95%):** `calculateAsync()` replaces existing non-approved run for period before create. Regression-tested (passing).
- **F5 (atomic delete, 100%):** `deletePayrollRun` single tx; direct on `tx` when nested.
- **F6 (cache/realtime, 100%):** frontend `exact:false` + invalidate deductions/payroll; `RealtimeInvalidator` adds punches/monthlyLeaves; realtime emit on remove/restore.
- **F7 (queryKeys, 100%):** salaries/buses detail roots fixed; discounts update/delete invalidate bonuses/advances/dashboard.
- **F8 (resiliency, 100%):** pool `max` from env; `statement_timeout=30s`; removed dead `DB_PASSWORD`.
- **F9 (perf indexes, 100%):** composite indexes on payroll_items, leave_requests, employee_bonuses.
- **F10 (lint, 100%):** 19 backend + 3 frontend ESLint *errors* resolved (floating promises → `void`/`useCallback`; `==` → `??`; duplicate imports merged). Warnings retained.

## Retracted findings (discipline)
- **Git history secret leak:** reported; verified FALSE (zero commits, `.env` gitignored). E2 removed.
- **JWT vars unwired:** assumed dead; verified wired in code (auth.module/controller/token-revocation). Revocation falls back in-memory when strict=false.
