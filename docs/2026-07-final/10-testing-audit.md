# 10 — Testing Audit

## Current coverage (measured)
| Type | Status | Notes |
|---|---|---|
| Unit | Partial | `*.spec.ts` exist (14 files). Formula tests strong. **3 suites fail** on missing `NotificationsService` test provider (penalties/employees/leaves) — unrelated to hardening, must be fixed. |
| Integration | Partial | `test/*.e2e-spec.ts` (security, imports, files) configured. |
| E2E | Partial | Available; not run in this audit. |
| Performance | None | No load/stress harness yet (OPEN_ITEMS O11). |
| Load | None | k6/Artillery not present. |
| Stress | None | — |
| Security | Partial | `test:security` e2e exists. |
| Chaos | None | — |
| Recovery | None | Backup/restore not exercised here. |

## Regression tests added during audit
- `payroll-async-dedup.spec.ts` (C1): parallel/duplicate/approved/lock/concurrent — **passing**.

## Coverage gaps
- Attendance unique-constraint behavior covered indirectly; add an integration
  test that asserts DB-level uniqueness under concurrent inserts.
- Payroll advisory-lock concurrency covered by unit mock; needs a real-PG
  integration test (two `calculate` for same period → one run).
- Frontend: no automated test suite run (Vitest configured; `npm test` available).
- Realtime invalidation: no automated test; verified manually via code review.

## Recommendations (testing roadmap)
1. Fix the 3 failing provider-setup suites (blocking for CI green).
2. Add real-DB integration tests for concurrency fixes (attendance dup, payroll lock).
3. Add Vitest component/query tests on the frontend (at least smoke).
4. Stand up load + replay tests (1-month biometric) in staging.
5. Add a chaos/recovery test for backup export/import.
6. CI: lint + typecheck + unit + e2e on every PR (see 19).
