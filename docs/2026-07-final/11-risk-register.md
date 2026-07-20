# 11 — Risk Register

| ID | Risk | Likelihood | Impact | State | Mitigation |
|----|------|-----------|--------|-------|------------|
| R1 | Approved payroll overwritten by `calculate()` (F1) | Med | High (financial) | Open (business decision) | `409 Conflict` + `forceRecalculate` + audit log before prod payroll |
| R2 | PII plaintext (nationalId/SSN) | Med | High (compliance) | Open (O7) | Encrypt at rest (AES-256-GCM) + secret-manager key |
| R3 | Revocation not shared across instances | Med (if scaled) | Med | Open (O8) | `TOKEN_REVOCATION_STRICT=true` + Redis |
| R4 | Duplicate payroll under concurrency | Low | High | Fixed (F3/F4) | Advisory-lock regression tested |
| R5 | Duplicate attendance punches | Low | Med | Fixed | Unique constraint + idempotent create |
| R6 | Long-held DB conn during payroll | Low | Med (scale) | Accepted | Review at 10k scale |
| R7 | `.env` copied elsewhere | Low | High | Open (O5, precautionary) | Rotation + secret manager; gitignored, no commits |
| R8 | Stale realtime after delete/restore | Low | Low | Fixed | Realtime emit added |
| R9 | Cache never refreshes post-mutation | Low | Med | Fixed | `exact:false` + invalidation |
| R10 | Runaway query exhausts pool | Low | High | Fixed | `statement_timeout` + pool size |
| R11 | Attendance endpoint invalid employeeId | Med | Med | Open (O3) | Verify device contract, then validate |
| R12 | Lost payroll items on partial delete | Low | High | Fixed | Atomic delete |

**Overall:** all Critical/High *code* risks closed. Remaining High risks (R1, R2)
are business/decision items, not unaddressed defects.
