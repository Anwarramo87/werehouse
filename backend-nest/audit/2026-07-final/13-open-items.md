# 13 — Open Items

Grouped: Business decisions / Operational / Production maturity / Code hygiene.

## A. Business decisions (stakeholder sign-off)
- **O1 / F1:** approved-payroll regeneration inconsistency. Proposal: `409 Conflict` + `forceRecalculate` (authorized) + audit log. Confidence risk 80%. **Not auto-changed.**
- **O2:** manual vs calculated payroll precedence rule.
- **O3:** attendance endpoint validation (don't break device contract first). Confidence bug exists: 60%.
- **O4:** override permission matrix (who may force-recalculate / restore / override).

## B. Operational (do before deploy)
- **O5 / E1:** secret rotation (`rotate-secrets.ps1 -Apply` + Neon password + restart). Precautionary (no git leak).
- **O6:** staging deploy + smoke tests (DEPLOYMENT.md §5).

## C. Production maturity (recommended before large rollout)
- **O7 (HIGH):** PII encryption at rest (nationalId/SSN). AES-256-GCM + key in secret manager + dual-write migration.
- **O8:** Redis-backed token revocation (`TOKEN_REVOCATION_STRICT=true` + `REDIS_URL`).
- **O9:** prod security env (JWT_EXPIRE=15m, cookie secure, bearer off, CORS locked).
- **O10:** observability (correlation IDs, health probes, Sentry, OpenTelemetry).
- **O11:** load + 1-month biometric replay (100/1k/5k/10k employees).
- **O12:** disaster recovery (backup restore, PITR, rollback tested).

## D. Code hygiene (separate)
- **O13:** 3 pre-existing suites (penalties/employees/leaves) fail on missing `NotificationsService` test provider — fix their setup.
- Dead/unused helper functions in attendance/payroll/employee services (lint warnings).
