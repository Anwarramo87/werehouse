# 04 — Backend Audit

## Quality metrics (measured)
| Metric | Count |
|---|---|
| Source LOC | ~21,020 |
| Modules | 31 |
| Controllers | 29 |
| Services | 35 |
| DTOs | 73 |
| Guards | 4 |
| Interceptors | 1 |
| Decorators | 3 |
| Spec files | 14 (3 pre-existing suites fail on test-provider setup) |
| ESLint errors | 0 (143 warnings) |
| Typecheck | clean |

## Module-by-module
Each module rated on the dimensions: Strengths / Weaknesses / Known Bugs /
Future Improvements / Performance Risks / Security Risks / Complexity / Dependencies / Confidence.

### Attendance (3 services)
- Strengths: night-shift aware; unique constraints; idempotent create; restore flow.
- Weaknesses: `computeWorkedMinutes`-style helpers defined-but-unused (dead code).
- Known Bugs: none open (duplicate-punch fixed).
- Perf risks: aggregation reads many punch rows per employee per day.
- Security: public check-in/out endpoint validates little (see OPEN_ITEMS O3).
- Complexity: High. Dependencies: prisma, realtime, notifications. Confidence: 100%.

### Payroll (1 service, 3 entry points)
- Strengths: advisory-lock serialization; atomic delete; async dedup (C1).
- Weaknesses: long-held connection during compute; F1 asymmetry (see 13).
- Known Bugs: none open.
- Perf risks: O(employees × relations) in one pass; review at 10k scale.
- Security: financial — must be access-controlled (guards present).
- Complexity: Very High. Dependencies: prisma, queue, cache, notifications. Confidence: 100%.

### Auth (5 services)
- Strengths: JWT cookie + biometric challenge + refresh; revocation present.
- Weaknesses: revocation in-memory unless Redis; bearer allowed in dev.
- Security: see 07 (OWASP). Complexity: High. Confidence: 100%.

### Employees / Leaves / Advances / Penalties / Bonuses / Salaries / Insurance
- Strengths: consistent CRUD + soft-delete + restore.
- Weaknesses: `employees.service` has unused vars; some high-complexity methods.
- Complexity: Medium–High. Confidence: 95%.

### Biometric (2 services)
- Strengths: simulator + duplicate-handling strategies.
- Weaknesses: device contract undocumented (blocks validation work).
- Complexity: Medium. Confidence: 90%.

### Notifications (1 service)
- Strengths: single source for attendance notifications.
- Weaknesses: fire-and-forget, no delivery guarantee/retry. Score 8.3.
- Complexity: Low. Confidence: 95%.

### Realtime / Queues / Health / Common
- Realtime: Socket.io gateway; client sync works. Complexity: Medium.
- Queues: BullMQ optional; inline fallback if queue unavailable.
- Health: `live`/`ready` endpoints exist (light). 
- Common: guards, interceptors, cache, constants — stable.

## Code-quality issues (non-blocking)
- 143 ESLint warnings: mostly `any` and unused vars; 13 frontend warnings
  (cognitive-complexity on several large components). No errors.
- Dead code: unused helper functions in attendance/payroll/employee services.
- No duplicate service/DTO class names detected.
