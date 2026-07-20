# 06 — Database Audit

Measured against the live Neon database (2026-07).

## Tables (30)
`users, roles, biometric_credentials, employees, departments, devices,
attendance_records, daily_attendance_logs, leave_requests, stock_levels,
products, import_jobs, payroll_runs, payroll_items, payroll_receipts,
payroll_inputs, employee_salaries, employee_advances, employee_insurance,
employee_bonuses, employee_penalties, termination_records, rehire_records,
financial_settlements, buses, bus_passengers, notifications, audit_logs,
deleted_record_history, _prisma_migrations`

## Indexes — 148 total
Healthy. Includes Prisma default single-column indexes plus three added during
hardening:
- `attendance_records_employeeId_timestamp_type_key` (UNIQUE) — de-dups punches.
- `daily_attendance_logs_employeeId_date_recordType_source_key` (UNIQUE) — idempotent aggregation.
- Composite perf indexes: `payroll_items(employeeId,createdAt)`,
  `leave_requests(employeeId,status,startDate,endDate)`,
  `employee_bonuses(employeeId,createdAt)`.

## Foreign keys — 24 (all referential)
All employee-linked tables FK to `employees`; payroll items/receipts FK to
`payroll_runs`; `rehire_records` self-references `termination_records`.
No orphan-FK patterns observed. Cascade behavior: Prisma `onDelete` rules should
be reviewed per relation (not enumerated here; verify in `schema.prisma`).

## Schema characteristics
- Models: 29 · Enums: 5 · Relations: 26 · JSON fields: 8 · Nullable fields: 40.
- JSON usage: `payload` in `deleted_record_history`, `audit_logs`, some config
  columns — acceptable for archival/audit, but not queryable; avoid JSON for
  fields needing indexing.
- Normalization: generally 3NF; `employee_salaries`/`employee_advances` are
  separate entities (good). Some duplication risk in snapshot columns inside
  `payroll_receipts` (intentional financial snapshot — acceptable).

## Missing indexes / bottlenecks
- Composite indexes added for the three hottest queries. Other high-frequency
  filters (e.g., attendance by `employeeId`+`date` range) rely on single-column
  indexes — adequate but could be compounded if query volume grows.
- Heavy queries: payroll aggregation (N employees × multiple relation tables in
  parallel `Promise.all`); attendance monthly fetch. Both benefit from the added
  indexes and `statement_timeout` guard.
- No unindexed FK detected among the 24 (Prisma creates them).

## Data duplication
- `payroll_receipts` intentionally snapshots computed values (financial integrity).
- `daily_attendance_logs` is a derived aggregate of `attendance_records`
  (acceptable; made idempotent via unique constraint).
- No unintended duplication found.

## Recommended checks before scale
- Run `EXPLAIN ANALYZE` on payroll aggregation and monthly attendance at 10k
  employees; confirm index usage.
- Verify Prisma `onDelete` cascade rules match business intent (esp. employee
  deletion). Verify `_prisma_migrations` is the only migration-tracking table.
