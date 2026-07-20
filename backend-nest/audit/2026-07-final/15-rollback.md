# 15 — Rollback

## Code rollback
- Redeploy previous backend/frontend build (keep last 2). Hardening migrations
  are additive (unique + perf indexes) → no down-migration required; safe to
  keep. Future destructive migrations: author down-script, test in staging first.

## Secret rollback
- Revert `.env` `JWT_SECRET`/`DATABASE_URL` to last-known-good (secret manager)
  and restart. `JWT_SECRET` change invalidates all tokens → users re-login
  (expected during rotation, not a defect).

## Payroll data rollback
- `deletePayrollRun` is atomic (history snapshot + items + run). Approved runs
  cannot be deleted via API (guarded) — see O1/F1 for intended override policy.

## Constraint rollback (only if required)
- Drop additive indexes with `DROP INDEX CONCURRENTLY`:
  - `attendance_records_employeeId_timestamp_type_key`
  - `daily_attendance_logs_employeeId_date_recordType_source_key`
  - perf indexes. Non-destructive; app continues without them (loses concurrency guarantee).

## Resiliency
- `statement_timeout` / pool size are env-driven; revert via `.env`, no code change.
