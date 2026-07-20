# 14 — Deployment

## Pre-deploy checklist
- [ ] `npm run lint` + `npm run typecheck` (backend) → 0 errors
- [ ] `npm run build` (frontend) → success
- [ ] `npx prisma migrate deploy` (NEVER `migrate dev` on Neon — no shadow DB)
- [ ] **Secret rotation (E1/O5):** `rotate-secrets.ps1 -Apply` + rotate Neon password in console + update `DATABASE_URL` + restart. Do LAST, before deploy.
- [ ] Provision Redis if `TOKEN_REVOCATION_STRICT=true`.
- [ ] Prod env: `NODE_ENV=production`, `JWT_EXPIRE=15m`, `JWT_COOKIE_SECURE=true`, `JWT_ALLOW_BEARER=false`, `CORS_ORIGIN` locked, `TOKEN_REVOCATION_STRICT=true`.
- [ ] Start backend (`node dist/main`); worker if `QUEUES_ENABLED` (`node dist/payroll-worker.js`).
- [ ] Start frontend (`npm run start`).

## Env variable checklist (verified wired into code)
- `JWT_SECRET` → `src/auth/jwt.strategy.ts:43`
- `JWT_EXPIRE` → `src/auth/auth.module.ts:30`
- `JWT_COOKIE_SECURE` → `src/auth/auth.controller.ts:255/282` (forced true in prod)
- `TOKEN_REVOCATION_STRICT` → `src/auth/token-revocation.service.ts:29` (gates Redis)
- `JWT_COOKIE_NAME` → `src/auth/jwt.strategy.ts:33`
- `DATABASE_URL`, admin/dev/superadmin passwords, `REDIS_URL`, `CORS_ORIGIN`.

## Runbook
1. Build & typecheck both apps. 2. `prisma migrate deploy`. 3. Rotate secrets + restart. 4. Start backend (+worker) and frontend. 5. Smoke tests.

## Post-deploy smoke tests
1. `POST /api/v1/auth/login` → 200 + Set-Cookie. 2. Protected route → 200. 3. Duplicate punch → idempotent, DB tuple count == 1. 4. `calculateAsync` twice for one period → one non-approved run. 5. `remove()` emits realtime + cache invalidates. 6. Cookie has Secure;HttpOnly;SameSite. 7. No console errors on login/attendance. 8. (Redis) revoke on A rejected on B.
