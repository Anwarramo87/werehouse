# 03 — Architecture Audit

Each subsystem scored 0–10 from code review. Scores reflect structure,
cohesion, and known gaps — not a formal benchmark.

| Subsystem | Score | Rationale |
|---|---|---|
| Authentication | 9.0 | JWT cookie + passport strategy; revocation present but in-memory unless Redis. |
| Payroll | 9.8 | Well-structured; advisory-lock serialization added; atomic delete. |
| Attendance | 9.7 | Night-shift aware; unique constraints added; idempotent create. |
| Notifications | 8.3 | Fire-and-forget `void` calls; no delivery guarantee / retry. |
| Realtime | 8.5 | Socket.io gateway; client cache-sync works but no reconnection/backoff audit. |
| Database | 9.2 | Strong relational model; 24 FKs; unique constraints added; some composite-index gaps addressed. |
| Frontend | 8.9 | Clean App Router; React Query well-used; some high-complexity components. |
| API Design | 9.4 | Consistent REST; DTOs; Swagger; restore/history endpoints. |
| Error Handling | 8.7 | Global filter present; some raw throws; inconsistent error envelopes. |
| Caching | 9.6 | React Query tuned (staleTime 2m); server `ShortCacheService`; invalidation fixed. |
| Security | 8.5 | Guards/permissions; JWT/Pii gaps; cookie flags auto-secured in prod. |
| Deployment | 8.8 | Docker build present; no CI/CD, health probes lightly covered. |

**Weakest areas to watch:** Notifications (8.3), Security (8.5), Realtime (8.5),
Error Handling (8.7). None are blocking; all have open items (see 13).

## Architectural strengths
- Clear module boundaries (31 modules, 35 services).
- Soft-delete + history restore pattern is consistent and auditable.
- Concurrency handled at DB level (unique constraints) + app level (advisory lock).
- Frontend/server cache coherence explicitly engineered.

## Architectural risks
- Single-tenant schema; no row-level tenant isolation.
- Server cache is in-memory per instance → not shared across horizontal replicas.
- `calculate()` holds one DB connection for the full payroll computation.
- Tight coupling of realtime emits to service methods (hard to unit-test in isolation).
