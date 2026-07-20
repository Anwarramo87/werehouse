# 07 — Security Audit (OWASP Top 10)

Status legend: ✅ Addressed · ⚠️ Partial / config-dependent · ❌ Open / deferred

| # | Category | Status | Notes |
|---|---|---|---|
| A01 | Broken Access Control | ⚠️ | Role/permission guards present; `PermissionsGuard` + `@Permissions`. Public attendance endpoint under-validates (OPEN_ITEMS O3). IDOR not formally reviewed. |
| A02 | Cryptographic Failures | ❌ | PII (`nationalId`, `socialSecurityNumber`) stored in plaintext (OPEN_ITEMS O7, HIGH). |
| A03 | Injection (SQL) | ✅ | All DB access via Prisma parameterized queries; no raw string SQL except `pg_advisory_xact_lock(${key})` where `key` is a computed bigint (safe). |
| A04 | Insecure Design | ⚠️ | F1 approved-run asymmetry is a design ambiguity (business decision). |
| A05 | Security Misconfiguration | ⚠️ | `JWT_COOKIE_SECURE` auto-true in prod; `JWT_ALLOW_BEARER` should be false in prod; `CORS_ORIGIN` must be locked (DEPLOYMENT.md). |
| A06 | Vulnerable Components | ⚠️ | Dependency audit pending (see 18). |
| A07 | Auth Failures | ✅/⚠️ | JWT + refresh + revocation; revocation in-memory unless Redis (cross-instance gap). |
| A08 | Data Integrity Failures | ✅ | Unique constraints + atomic deletes + history restore prevent concurrency corruption. |
| A09 | Logging/Monitoring | ⚠️ | Structured logging present; no centralized log/audit export; `audit_logs` table exists but observability lacking. |
| A10 | SSRF | ⚠️ | File/upload endpoints exist (`files.controller`); SSRF surface not formally reviewed. |

## Focused checks
- **XSS:** Frontend React escapes by default; no `dangerouslySetInnerHTML` found in review. CSV export escapes formula-injection chars (verified in payroll CSV util).
- **CSRF:** Cookie is `HttpOnly`; bearer also allowed in dev. With cookie auth + SameSite, CSRF risk is low; confirm `JWT_COOKIE_SAME_SITE` in prod.
- **JWT:** `JWT_SECRET` required (throws if missing). Rotation invalidates all tokens (expected). `expiresIn` configurable (set 15m in prod).
- **Cookies:** `Secure; HttpOnly; SameSite` set; `Secure` forced true when `NODE_ENV=production`.
- **Secrets:** `.env` gitignored; repo has zero commits (no history leak). Rotation procedure in DEPLOYMENT.md / rotate-secrets.ps1.
- **Password policy:** bootstrap admin passwords present in `.env` (rotate; prefer seeded + forced reset).
- **Encryption at rest:** DB-level TLS (`sslmode=require`). Application PII NOT encrypted (O7).
- **Audit trail:** `audit_logs` + `deleted_record_history` capture key actions — good foundation; ensure all privileged actions log.

## Highest-priority security actions
1. Encrypt PII at rest (O7).
2. Enable Redis-backed revocation for multi-instance (O8).
3. Lock prod security env (DEPLOYMENT.md checklist).
4. Review public attendance endpoint + file/SSRF surface (O3, A10).
5. Run dependency vulnerability scan (18).
