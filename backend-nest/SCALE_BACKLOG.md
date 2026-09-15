# Scale Backlog (Performance / Scale Debt)

Owned: back/werehouse/backend-nest. Last reviewed: 2026-09-13 (Phase 4).
This file documents scale debt that is intentionally NOT being fixed now. Items are
safe to attempt in a future phase once a real factory grows past current bounds.

## Fixed in Phase 4

- Dashboard backend is already efficient: `buildHomeStats()` runs 7 queries in
  parallel, cached 30 s, invalidated on mutations (`dashboard.service.ts`). No N+1.
- Fixed profiling-path bug: the per-query timing log was hardcoded to a developer
  temp path; now gated behind `DASHBOARD_PROFILE_LOG` (default off) — no-op in prod.
- Backup restore memory bound documented: Multer caps uploads at 256 MB
  (`backup.controller.ts:163`); restore parses the buffer in-process
  (`backup.controller.ts:189`). Bounded and acceptable today (see item below).

## Measured baseline (2026-09-13)

- Serverside list endpoints across inventory/fulfillment/sales/purchasing/
  attendance/payroll use `Promise.all` batches + `ShortCacheService` — no
  interactive N+1 hotspots found.
- `237` bare `findMany` calls exist in services. Each is a candidate for a
  `take`/cursor cap when data grows; none is currently unbounded on a hot list
  beyond the top-N capped queries.
- `7` `.map(async …)` sites: all in offline/bulk flows
  (`backup-storage.service.ts:92`, `files.service.ts:206/219`,
  `imports.service.ts:919/1031`, `integrations.service.ts:388`,
  `sales-invoices.service.ts:164`). Safe to parallelize with `Promise.all` +
  bounded batch size if file/import volumes grow. Not hot paths.

## Backlog items (do when needed, not now)

1. **Streaming restore** — replace in-memory `JSON.parse(file.buffer)` restore
   with a disk-backed/streaming parse so restores can exceed 256 MB without
   doubling RAM. Needs: temp-file write on upload, line-oriented snapshot format
   or JSON stream, and a new `mode=validate` path that re-reads the temp file.
2. **Composite pages without dedicated endpoints** — `payroll.timetable`,
   `payroll.vouchers`, `admin.settings` fan out to many shared endpoints (or,
   for settings, zero). If these pages ever do heavy work server-side, add
   purpose-built aggregation endpoints; today they are cheap UI composites.
3. **Frontend `/home` fan-out (~20 hooks)** — the page fires useEmployees /
   useDepartments / usePayrollReport / useResignedEmployees / useAdvances /
   usePenalties / useBonuses in addition to `useDashboard()`. These feed cards
   and modals the aggregate endpoint doesn't cover, so the cost is intrinsic to
   the current UI. Revisit when the dashboard UX is redesigned.
4. **Unbounded `findMany`** — audit top-N caps (`take`) on list endpoints and
   add cursor pagination to the 237 `findMany` calls when row counts cross
   ~10k. Not needed at a single factory's current size.
5. **Per-run payroll item writes** — `payrollRunService` composes items in
   memory and writes with `createMany` (`payroll.service.ts:2431`), which is
   fine; if runs exceed ~10k employees, consider chunked pushes. Watch item at
   the same time as #4.
6. **Snapshot export latency** — snapshot JSON assembly rebuilds at 100% on
   every export (`snapshot.service.ts`); consider incremental snapshots when
   data volume makes full rebuilds slow (> a few seconds already measured at
   small scale is not an issue; revisit at scale).
7. **Aggregation cron serial processing** — `aggregateAllForDate` / `aggregateRange`
   process employees one at a time (`attendance-aggregation.service.ts:837`).
   Intentional for memory stability and per-day idempotency; parallelize with a
   bounded worker pool only when a day's aggregation exceeds cron window.
8. **Refresh-token replay / family detection** — rotation and multi-device are
   already handled by opaque single-use tokens (consume→re-issue,
   `refresh-token.service.ts`); a stolen token replayed after rotation gets a
   401 rather than access. What is NOT implemented is revoking the *rest* of a
   device family when a replay is detected. That needs a durable sessions table
   (devices → refresh families) and is a schema migration — defer until a
   threat model shows it pays.
9. **Session-wide revocation endpoint** — logout (`auth.service.revokeRefreshToken`)
   kills only the presented token. A "sign out everywhere" action requires the
   per-user index that #8 introduces; today there is no way to enumerate a
   user's live refresh tokens.