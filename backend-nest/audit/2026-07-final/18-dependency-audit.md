# 18 — Dependency Audit

Installed versions read from `package.json` (backend) and `package.json`
(frontend). "Latest" column requires registry access (not performed); flagged
for a `npm audit` / `npm outdated` run in CI.

## Backend (selected)
| Package | Installed | Notes |
|---|---|---|
| @nestjs/core, common, etc. | ^11.1.27 | Current major (11). |
| @nestjs/jwt | ^11.0.2 | — |
| @nestjs/bullmq | ^11.0.4 | Optional queue. |
| @nestjs/throttler | ^6.5.0 | Rate limiting. |
| @nestjs/swagger | ^11.4.5 | API docs. |
| @nestjs/websockets + platform-socket.io | ^11.1.27 / ^4.8.3 | Realtime. |
| @prisma/client + adapters | ^7.6.0 / ^7.8.0 | Neon + pg adapters. |
| passport / passport-jwt | ^0.7.0 / ^4.0.1 | Auth. |
| pg | ^8.13.1 | Pool. |
| bullmq | ^5.72.1 | Queue. |
| ioredis | ^5.10.1 | Redis client. |
| class-validator | ^0.14.1 | DTO validation. |
| nestjs-zod | ^3.0.0 | Schema validation. |
| nest-winston | ^1.10.2 | Logging. |
| reflect-metadata | ^0.2.2 | Required by Nest. |
| @nestjs/schedule | ^5.0.1 | Cron (backup). |

## Frontend (selected)
| Package | Installed | Notes |
|---|---|---|
| next | (App Router, Turbopack) | Verify exact version in package.json. |
| react / react-dom | 18/19 | Verify. |
| @tanstack/react-query | v5 | Configured (staleTime 2m). |
| typescript | 5.x | — |
| tailwindcss | present | Styling. |
| zod | present | Validation. |

## Upgrade risk
- **Low** for patch/minor within current majors (Nest 11, Prisma 7, Next App
  Router are recent).
- **Medium** for Prisma major bumps (schema/migration semantics).
- **Medium** for Next major (App Router already adopted; future majors may
  change caching/route conventions).
- **Watch:** `nestjs-zod` and `nest-winston` peer-compat with Nest 11.

## Actions
- Run `npm audit --audit-level=high` (both apps) in CI; current scripts exist
  (`audit:deps`).
- Run `npm outdated` to populate the "latest" column.
- Pin transitive vuln fixes; review `bullmq`/`ioredis` for Redis CVEs.
