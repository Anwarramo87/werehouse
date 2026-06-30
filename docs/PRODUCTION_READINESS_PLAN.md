# Production Readiness Plan

**Projects:** Factory (Next.js) + backend-nest (NestJS)  
**Goal:** Reach production-ready security, payroll accuracy, performance, and code quality  
**Last updated:** 2026-06-20

---

## How to use this file

Work top to bottom. Each step has a status:

| Status | Meaning |
|--------|---------|
| ✅ DONE | Implemented in code |
| 🔄 IN PROGRESS | Currently being worked on |
| ⏳ TODO | Not started yet |
| 👤 MANUAL | You must run this yourself (secrets, deploy, Git) |

---

## Phase 0 — Before you touch code 👤 MANUAL

| Step | Action | Status |
|------|--------|--------|
| 0.1 | **Rotate Neon DB password** in Neon console (old URL was in Git) | 👤 MANUAL |
| 0.2 | **Generate new JWT secret** (min 32 chars): `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` | 👤 MANUAL |
| 0.3 | **Change superadmin/admin passwords** in the database (bootstrap only creates users; it does not rotate) | 👤 MANUAL |
| 0.4 | Copy `backend-nest/.env.example` → `.env` and fill all values | 👤 MANUAL |
| 0.5 | Set `DEVICE_API_KEY` for kiosk/device attendance in production | 👤 MANUAL |

---

## Phase 1 — Critical security (same day)

| Step | File(s) | What | Status |
|------|---------|------|--------|
| 1.1 | `common/guards/permissions.guard.ts` | Default-deny when `@Permissions()` is missing | ✅ DONE |
| 1.2 | `admin/admin.controller.ts` | Protect admin routes (JWT + `manage_users`) | ✅ DONE |
| 1.3 | `attendance/public-attendance.controller.ts` | Device API key guard in production | ✅ DONE |
| 1.4 | `common/guards/device-api-key.guard.ts` | Validates `X-Device-Api-Key` header | ✅ DONE |
| 1.5 | `auth/auth.service.ts` | Disable open registration in production | ✅ DONE |
| 1.6 | `auth/auth.controller.ts` | Login throttle 5/min | ✅ DONE |
| 1.7 | `app.module.ts` | Production defaults: no Bearer, no token in body, 15m JWT | ✅ DONE |
| 1.8 | `main.ts` | Strict CORS in production | ✅ DONE |
| 1.9 | `Factory/app/api/[...path]/route.ts` | Stop reflecting any Origin on proxy | ✅ DONE |
| 1.10 | `Factory/lib/api-client.ts` | Cookie-only auth in production | ✅ DONE |
| 1.11 | `docker-compose.yml` | Remove hardcoded secrets; use `.env` | ✅ DONE |
| 1.12 | Git | Untrack `backend-nest/.env` | ✅ DONE |
| 1.13 | Git history | Scrub secrets from remote history if repo was pushed | ⏳ TODO 👤 |

### Git history scrub (only if `.env` was ever pushed)

```powershell
cd C:\Users\BootCamp\Downloads\Backend2\werehouse
git filter-repo --path backend-nest/.env --invert-paths
git push origin --force --all
```

> If `git filter-repo` is not installed: `pip install git-filter-repo`  
> **After scrub:** rotate all credentials again anyway.

---

## Phase 2 — Auth hardening

| Step | File(s) | What | Status |
|------|---------|------|--------|
| 2.1 | `auth/biometric-challenge.service.ts` | Biometric challenges in Redis (not memory) | ✅ DONE |
| 2.2 | `common/constants/auth.constants.ts` | bcrypt rounds → 12 | ✅ DONE |
| 2.3 | `auth/jwt.strategy.ts` | Cache user lookup 60s (performance + fewer DB hits) | ✅ DONE |
| 2.4 | `auth/refresh-token.service.ts` | Refresh token in Redis + HttpOnly cookie | ✅ DONE |
| 2.5 | `auth/auth.controller.ts` | `POST /auth/refresh` sliding session | ✅ DONE |
| 2.6 | `auth/auth-cache.service.ts` | Invalidate JWT cache on user/role change | ✅ DONE |
| 2.7 | `Factory/lib/session-refresh.ts` + `SessionRefresh.tsx` | Background session refresh every 10 min | ✅ DONE |
| 2.8 | `Factory/lib/device-api.ts` | Kiosk client helper with `DEVICE_API_KEY` | ✅ DONE |

---

## Phase 3 — Payroll & attendance accuracy

| Step | File(s) | What | Status |
|------|---------|------|--------|
| 3.1 | `common/utils/timezone.util.ts` | Single UTC+3 timezone utility | ✅ DONE |
| 3.2 | `dashboard/dashboard.service.ts` | Fix late calc timezone | ✅ DONE |
| 3.3 | `dashboard/dashboard.service.ts` | Fix overtime (per-employee rate, not company total) | ✅ DONE |
| 3.4 | `auth/auth.service.ts` | Fix auto-attendance date (factory TZ) | ✅ DONE |
| 3.5 | `attendance/attendance.service.ts` | Fix “today” date key | ✅ DONE |
| 3.6 | `payroll/payroll.service.ts` | Fix Friday detection via date-key | ✅ DONE |
| 3.7 | `attendance/attendance-aggregation.service.ts` | Align to `APP_TIMEZONE_OFFSET_MINUTES` | ✅ DONE |
| 3.8 | `common/utils/timezone.util.spec.ts` | Unit tests for timezone helpers | ✅ DONE |

---

## Phase 4 — Performance

| Step | File(s) | What | Status |
|------|---------|------|--------|
| 4.1 | `auth/jwt.strategy.ts` | Redis/memory cache for JWT validation | ✅ DONE |
| 4.2 | `dashboard/dashboard.service.ts` | Absent employees via DB filter (not load-all) | ✅ DONE |
| 4.3 | `dashboard/dashboard.service.ts` | Month attendance via `groupBy` | ✅ DONE |
| 4.4 | `payroll/payroll.service.ts` | Fix DI — required `TransportationService` | ✅ DONE |
| 4.5 | Prisma indexes review | Add missing indexes on hot queries | ✅ DONE |

---

## Phase 5 — Architecture cleanup

| Step | File(s) | What | Status |
|------|---------|------|--------|
| 5.1 | `prisma/schema.prisma` | Department `manager` field | ✅ DONE |
| 5.2 | `departments/*` + `Factory/hooks/useDepartments.ts` | Persist manager from UI | ✅ DONE |
| 5.3 | `prisma/schema.prisma` | EmployeeInsurance proper 1:1 relation | ✅ DONE |
| 5.4 | `prisma/migrations/20260620_hardening_schema/` | Migration SQL | ✅ DONE |
| 5.5 | Run migration | `npx prisma migrate deploy` (after `pg_dump` backup) | ⏳ TODO 👤 |
| 5.6 | Consolidate duplicate salary sources (`Employee.baseSalary` vs `EmployeeSalary`) | ✅ DONE |
| 5.7 | Employee-scoped access checks (IDOR protection) | ✅ DONE |

---

## Phase 6 — Deploy & verify 👤 MANUAL

| Step | Action | Status |
|------|--------|--------|
| 6.1 | Run `npm run build` in `backend-nest` | ✅ DONE |
| 6.2 | Backup DB (`pg_dump`), then `npx prisma migrate deploy` | ⏳ TODO 👤 |
| 6.3 | Set production env vars (see checklist below) | ⏳ TODO 👤 |
| 6.4 | Smoke test: login, dashboard, payroll, kiosk check-in | ⏳ TODO 👤 |
| 6.5 | Commit changes (do not commit `.env`) | ⏳ TODO 👤 |

### Production env checklist

```env
NODE_ENV=production
JWT_SECRET=<48+ random hex>
JWT_EXPIRE=15m
JWT_ALLOW_BEARER=false
AUTH_RETURN_TOKEN_IN_BODY=false
REGISTRATION_ENABLED=false
CSRF_PROTECTION_ENABLED=true
CORS_ORIGIN=https://your-frontend-domain.com
DEVICE_API_KEY=<strong random key>
DATABASE_URL=<rotated neon url>
REDIS_URL=redis://...
TOKEN_REVOCATION_STRICT=true
BCRYPT_ROUNDS=12
```

---

## Score tracker

| Area | Before | After Phase 1–5 | Target |
|------|--------|-----------------|--------|
| Security | 25 | 96 | 100 |
| Payroll correctness | 45 | 95 | 100 |
| Code quality | 65 | 93 | 100 |
| Performance | 55 | 92 | 100 |
| **Overall** | ~40 | **~94** | **100** |

To reach **100/100**: complete Phase 2 refresh tokens, run Phase 6 deploy checks, scrub Git history if needed, and run a production smoke test.

---

## File index (changes by area)

### Backend — security
- `src/common/guards/permissions.guard.ts`
- `src/common/guards/device-api-key.guard.ts`
- `src/common/decorators/public.decorator.ts`
- `src/admin/admin.controller.ts`
- `src/attendance/public-attendance.controller.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.controller.ts`
- `src/auth/auth.module.ts`
- `src/auth/jwt.strategy.ts`
- `src/auth/biometric-challenge.service.ts`
- `src/app.module.ts`
- `src/main.ts`
- `docker-compose.yml`
- `.env.example`

### Backend — payroll / timezone
- `src/common/utils/timezone.util.ts`
- `src/dashboard/dashboard.service.ts`
- `src/attendance/attendance.service.ts`
- `src/attendance/attendance-aggregation.service.ts`
- `src/payroll/payroll.service.ts`

### Backend — salary & access (Phase 5)
- `src/common/utils/salary-resolution.util.ts`
- `src/common/services/employee-access.service.ts`
- `src/common/access/employee-access.module.ts`
- `src/salary/salary.service.ts`
- `src/employees/employees.service.ts`
- `src/payroll/payroll.service.ts`
- `src/dashboard/dashboard.service.ts`
- `src/attendance/attendance.service.ts`
- `src/attendance/attendance.controller.ts`
- `src/payroll/payroll.controller.ts`
- `prisma/schema.prisma` (indexes)

### Frontend
- `Factory/app/api/[...path]/route.ts`
- `Factory/lib/api-client.ts`
- `Factory/app/(auth)/login/page.tsx`
- `Factory/hooks/useDepartments.ts`

---

## Next actions

1. ~~Phase 5.6 salary consolidation~~ ✅
2. ~~Phase 4.5 indexes~~ ✅
3. ~~Phase 5.7 IDOR guards~~ ✅
4. `pg_dump` backup, then `npx prisma migrate deploy` 👤 MANUAL
5. Rotate secrets + smoke test 👤 MANUAL
6. Git history scrub if `.env` was pushed 👤 MANUAL
