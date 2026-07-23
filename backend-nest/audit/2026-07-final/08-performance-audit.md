# 08 — Performance Audit

## Expected load profile (estimates — validate in staging)
| Scale | Employees | Concurrent users | Notes |
|---|---|---|---|
| Small | 100 | ~10 | Current dev profile; trivial. |
| Medium | 1,000 | ~50 | Fine with single instance. |
| Large | 5,000 | ~200 | Single instance OK; watch DB pool (max 5). |
| X-Large | 10,000 | ~500 | Needs connection-pool tuning / read replica / horizontal API. |

## Potential bottlenecks
| Resource | Risk | Mitigation |
|---|---|---|
| DB connection pool | High at scale | `DATABASE_MAX_CONNECTIONS` configurable; raise + PgBouncer. |
| `calculate()` holds 1 connection for full payroll | Med | Acceptable <5k; review at 10k. |
| Payroll aggregation N×relations | Med | Parallel `Promise.all`; indexes added; consider chunking. |
| Prisma per-request overhead | Low | Acceptable; consider `$queryRaw` for hot reports. |
| React Query refetch storms | Low | staleTime 2m; invalidation scoped. |
| Realtime (Socket.io) | Low–Med | Fan-out to all clients on attendance update; throttle. |
| Next.js rendering | Low | Mostly client; server components for data pages. |
| Bundle size | Low–Med | Static chunks ~3.47 MB total; route-level code-splitting available. |
| Redis / Queue | Low | Optional; only if async payroll scaled. |
| Network | Low | Single region (Neon + Vercel-class host). |

## Measured
- Backend: `statement_timeout=30s` prevents runaway queries holding connections.
- Frontend: production build succeeds; 26 pages; no hydration warnings.
- DB: 148 indexes; composite perf indexes added for payroll/leave/bonus hot paths.

## Not yet measured (requires staging + load tooling)
- p50/p95/p99 latency at each scale.
- CPU/RAM under payroll compute.
- Real biometric replay (1 month) — see OPEN_ITEMS O11.
- Concurrent `calculateAsync` under load (unit regression exists; load not run).

## Recommendations
- Add a load-test harness (k6/Artillery) + 1-month biometric replay before 10k scale.
- Introduce PgBouncer or raise pool + DB read replica for X-Large.
- Add response-time metrics + slow-query logging (Prisma `PRISMA_SLOW_QUERY_MS=800` already set).
