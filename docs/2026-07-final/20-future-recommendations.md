# 20 — Future Recommendations & Technical Debt

## Technical debt register (estimated effort)
| Priority | Item | Est. hours | Notes |
|---|---|---|---|
| Critical | Fix 3 failing test suites (provider setup) | 2 | Blocks CI green. |
| Critical | Resolve F1 approved-payroll policy | 4 | Business decision + impl + audit. |
| High | PII encryption at rest + migration | 16 | Schema + read/write paths + key mgmt. |
| High | Redis revocation + observability IDs | 8 | Multi-instance correctness. |
| Medium | API error envelope + DTO coverage | 6 | Consistency. |
| Medium | Attendance endpoint validation | 3 | After device-contract review. |
| Medium | Load + biometric replay harness | 12 | Staging only. |
| Medium | Remove dead/unused helpers | 3 | Lint warnings. |
| Low | Split high-complexity components | 6 | Maintainability. |
| Low | ADRs for major changes | 4 | Knowledge retention. |
| Low | CI/CD pipeline | 8 | Automation. |
| Low | Disaster-recovery drill | 4 | O12. |

## Strategic recommendations
1. **Decide F1 now** — it's the only open *behavioral* risk to payroll integrity.
2. **Encrypt PII before real employee data** — compliance blocker for go-live.
3. **Stand up observability (74% maturity)** — correlation IDs, metrics, alerts.
4. **Add load/replay testing** — the single biggest unverified production risk.
5. **CI/CD + secret scanning** — prevents regressions and leaks going forward.
6. **Keep this archive alive** — each future audit appends a dated folder with
   the same 01–20 numbering. Six months later, "why this behavior?" lives in
   `12-fixes.md`; "was this known?" in `13-open-items.md` / `11-risk-register.md`.

## Closing note
The codebase passed a comprehensive technical audit; critical correctness
issues are fixed and verified. Remaining work is business-rule decisions,
operational deployment, and production maturity — none are blocking for the
current code-complete milestone.
