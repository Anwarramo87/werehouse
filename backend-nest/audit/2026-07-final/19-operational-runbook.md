# 19 — Operational Runbook

## Infrastructure components
| Component | Tech | Notes |
|---|---|---|
| App runtime | Node.js (NestJS `dist/main`, Next `start`) | Single-instance default. |
| Database | Neon Postgres (serverless) | sslmode=require; UTC+3 app logic. |
| Cache/Revocation | In-memory (per instance) / Redis (optional) | Redis needed for multi-instance revocation. |
| Realtime | Socket.io | Fan-out on attendance updates. |
| Queue | BullMQ (optional, `QUEUES_ENABLED`) | Falls back to inline if unavailable. |
| Container | `docker:build` provided | Dockerfile present; not exercised here. |
| Reverse proxy / TLS | Not in repo | Provide Nginx/Caddy + TLS at deploy. |
| CI/CD | None in repo | Recommend GitHub Actions (lint/type/test/scan). |
| Monitoring | Structured logs (winston) | No metrics/tracing/alerting yet. |
| Backups | `backup.controller` export endpoints | Verify scheduled + off-site + restore test. |

## Health & restart
- Health endpoints: `GET /health/live`, `/health/ready` (verify they exist and
  what they check). Wire to orchestrator liveness/readiness probes.
- Auto-restart: process manager (pm2/systemd) or container restart policy.
- Resource limits: set memory/CPU; backend pool max 5 — size host accordingly.

## Scaling
- Horizontal API: stateless except in-memory cache/revocation → enable Redis for
  shared revocation before scaling.
- DB: Neon scales; for 10k employees add PgBouncer / read replica + tune pool.

## Observability gaps (O10)
- No correlation/request IDs, no metrics export, no alerting. Add before
  production maturity sign-off.

## CI/CD recommendation
- GitHub Actions: install → lint → typecheck → unit/e2e → `npm audit` → build
  → (staging deploy) → smoke. Block merge on lint/type/test failure.

## Daily ops checklist
- Monitor error logs; confirm no `uncaughtException`/`unhandledRejection`.
- Verify backup job ran; periodic restore test (O12).
- Watch DB pool saturation during payroll runs.
