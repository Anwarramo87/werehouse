# 16 — Roadmap

## Version 1.1 (near-term, post-review)
- Resolve F1 (approved-payroll guard + `forceRecalculate` + audit).
- Fix 3 failing test suites (O13).
- Lock prod security env (O9).
- Secret rotation + staging validation (O5/O6).

## Version 1.2 (hardening)
- PII encryption at rest (O7) with migration.
- Redis-backed token revocation (O8).
- Attendance endpoint validation after device-contract review (O3).
- Standardize API error envelope + DTO validation coverage (09).
- Auth-specific rate limiting + lockout (09).

## Version 2.0 (scale & observability)
- Observability: correlation IDs, health probes, Sentry, OpenTelemetry (O10).
- Load + 1-month biometric replay; tune pool/replica at 5k–10k (08, O11).
- Disaster recovery: backup restore + PITR verified (O12).
- CI/CD pipeline: lint + typecheck + tests + secret scan + dep audit (19).

## Version 3.0 (maturity)
- Multi-tenant isolation (if new factories).
- ADRs for every major change.
- Public API versioning strategy.
- Automated chaos/recovery testing.
