# 02 — System Overview

## Purpose
Workforce-management platform for a single factory. Handles attendance (biometric
punches, manual edits, night shifts), leave, advances, penalties, bonuses,
transportation, inventory, and full payroll calculation. Payroll correctness is
financially sensitive.

## Components
| Component | Tech | Port | Notes |
|---|---|---|---|
| Backend API | NestJS 11, Prisma 7, PostgreSQL | 5003 | Modular monolith; optional BullMQ queue; Socket.io realtime |
| Frontend | Next.js (App Router), React Query v5, TS | 3000 | Server + client components; Arabic/English UI |
| Database | PostgreSQL (Neon, UTC+3) | — | 30 tables, 148 indexes, 24 FKs |
| Cache | React Query (client) + in-memory `ShortCacheService` (server) | — | Redis optional for token revocation |
| Realtime | Socket.io gateway | — | Attendance update events → `RealtimeInvalidator` |
| Auth | JWT in HttpOnly cookie (+ optional bearer), passport-jwt | — | Role/permission guards; revocation in-memory unless `TOKEN_REVOCATION_STRICT` |

## Request flow
1. Client calls API (cookie or bearer); JWT validated by `JwtStrategy`.
2. Guard checks role/permission; controller delegates to service.
3. Service uses Prisma (pg pool, max 5, `statement_timeout=30s`).
4. Mutations emit realtime + invalidate React Query caches.
5. Payroll may run synchronously (`calculate`) or queued (`calculateAsync`).

## Key design choices
- Factory timezone UTC+3 baked into date logic (`DEFAULT_TIMEZONE_OFFSET_MINUTES=180`).
- Night-shift-aware attendance date resolution.
- Soft-delete pattern: deletions archived to `deleted_record_history`, restorable.
- Realtime + React Query kept consistent via `queryKeys` + `RealtimeInvalidator`.

## Boundaries / assumptions
- Single-factory tenancy (no multi-tenant isolation in schema).
- `.env` is gitignored; repo has zero commits (no history-leak surface).
- Horizontal scaling requires Redis for shared token revocation.
