# 09 — API Audit

## Surface (measured)
- 29 controllers, **100+ endpoint decorators** (`@Get/@Post/@Put/@Patch/@Delete`).
- Global prefix `/api/v1` (inferred from frontend proxy + `auth/login` path).
- Swagger/OpenAPI enabled (`@nestjs/swagger`).

## Sample endpoint map (representative)
| Area | Endpoints |
|---|---|
| Auth | `POST login/register`, `biometric/register|login start|finish`, `logout`, `refresh`, `GET me`, `users`, `roles` |
| Attendance | `GET`, `POST`, `upload`, `restore/:id`, `GET anomalies/alerts/daily-view`, `DELETE :recordId`, `public/check-in|check-out` |
| Payroll | `GET`, `GET summary/inputs`, `POST inputs`, `POST calculate*`, `GET :month` |
| Employees | CRUD + `terminate/resign/settle/rehire`, `financial-settlement`, `bulk-terminate-department`, `restore/:id` |
| Advances/Bonuses/Penalties | CRUD + `restore/:id` + `deleted/history` |
| Leaves | CRUD + approvals |
| Biometric | `trigger-sync`, `status`, `duplicate-config` |
| Notifications | `GET`, `unread-count`, `mark-read`, `mark-all-read`, `dismiss` |
| Backup | `GET export/full`, `export/month` |
| Health | `live`, `ready` |
| Trash | `GET`, `restore/:id`, `DELETE :id/permanent` |

## Authentication & Authorization
- Auth: JWT bearer OR HttpOnly cookie (passport-jwt). `JwtAuthGuard` + `PermissionsGuard`.
- Most endpoints guarded; verify each controller's guard coverage (not exhaustively enumerated).
- Public: `auth/login`, `auth/register`, `attendance/public/check-in|check-out` (device-facing).

## Validation
- DTOs with `class-validator` / `nestjs-zod` in places. Consistency not uniformly verified — recommend a DTO-coverage pass.

## Error responses
- Global `GlobalExceptionFilter` present. Envelope consistency not uniform (some raw throws). Recommend standardized error shape.

## Consistency / REST
- Largely RESTful; `restore/:historyId` and `deleted/history` follow a consistent soft-delete pattern. `calculate-deductions` (verb in path) is an RPC-style exception.

## Pagination / Filtering / Sorting
- Attendance uses server-side pagination + `safeLimit`. Other list endpoints vary; confirm consistent page/sort params.

## Rate limiting
- `@nestjs/throttler` configured (`THROTTLE_TTL_MS=60000`, `THROTTLE_LIMIT=120`). Auth endpoint should have stricter limits (recommend dedicated auth throttle).

## Versioning
- `v1` path segment used. No explicit Nest versioning strategy; acceptable for single-version API.

## Top API actions
1. Lock down `attendance/public/*` (validate employeeId existence — O3).
2. Add auth-specific rate limiting + lockout.
3. Standardize error envelope + DTO validation coverage.
4. Confirm every mutating endpoint has the correct permission guard (IDOR/A01 review).
