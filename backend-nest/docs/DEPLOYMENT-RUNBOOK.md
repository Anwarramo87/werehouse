# Deployment runbook — closing the three gates

Written 10 Sep 2026. Covers the three migrations pending against production and
the order they must be applied in.

Run every step against a **Neon branch first**. Nothing here is destructive by
design, but one of the three is a data migration touching 73 tables, and a
branch costs nothing.

---

## What is pending, and what each unblocks

`npx prisma migrate status` reports three unapplied migrations:

| Migration | What it does | What is broken without it |
|---|---|---|
| `20260905220000_add_ledger_posting` | Creates `account_mappings`; adds `journal_entries.isAutomatic`, indexes, `sourceRef` unique | **`LedgerPostingService` is live in the deployed code and the tables do not exist.** Any invoice posting to the ledger fails |
| `20260905230000_stock_movement_referential_integrity` | Adds `(tenantId, sku)` FK on `stock_movements` as `NOT VALID`; creates the `stock_movement_orphans` view; adds two indexes | Stock movements can reference products that do not exist |
| `20260909120000_backfill_default_tenant` | Creates the `default` factory; sets `tenantId` on every orphaned row across 73 tables | 22 rows are invisible to every factory. A fresh deploy leaves the bootstrap admin with no factory and answers 500 on every request |

Verified directly against production on 10 Sep 2026: `account_mappings` is
**absent**, `journal_entries.isAutomatic` is **absent**.

### A note on the `_prisma_migrations` table

There is a rolled-back row for `20260823190000_multi_tenancy` (23 Aug,
`finished_at` NULL, `rolled_back_at` set), followed by a second row that applied
cleanly. **This does not block anything** — `migrate status` reports no failed
migration, and `migrate deploy` will proceed. It looks alarming and is not.

---

## ⚠️ The ordering hazard

The migrations apply in timestamp order, so the `stock_movements` foreign key is
added **before** the tenant backfill runs.

That FK is added `NOT VALID`, meaning existing rows are not scanned — but rows
the backfill **updates** are checked. If any `stock_movements` row had a NULL
`tenantId` and a `sku` with no matching product in the default factory, the
backfill's `UPDATE` would fail against that constraint.

**Currently safe**: `stock_movements` has zero NULL-`tenantId` rows, so the
backfill updates none of them. Confirm this still holds before applying:

```sql
SELECT count(*) FROM stock_movements WHERE "tenantId" IS NULL;   -- expect 0
```

If it is not zero, resolve the orphans first — the migration ships a view for
exactly this:

```sql
SELECT * FROM stock_movement_orphans;   -- only exists after migration 2
```

---

## Step 1 — rehearse on a branch

```bash
cd back/werehouse/backend-nest

# In the Neon console: create a branch from production, then copy its
# connection strings. Do not reuse the production ones.
export DATABASE_URL="postgresql://…branch-pooler…/neondb?sslmode=require"
export DIRECT_URL="postgresql://…branch…/neondb?sslmode=require"

npx prisma migrate status        # expect the same three pending
npx prisma migrate deploy        # applies all three, in order
```

Expected: three migrations applied, no error.

## Step 2 — verify on the branch

```bash
psql "$DIRECT_URL" -f - <<'SQL'
-- 1. Ledger objects now exist
SELECT to_regclass('public.account_mappings') AS account_mappings;
SELECT count(*) AS is_automatic_col FROM information_schema.columns
 WHERE table_name='journal_entries' AND column_name='isAutomatic';

-- 2. The default factory exists, exactly once
SELECT id, name, code, status FROM tenants WHERE code = 'default';

-- 3. No orphans remain, except the super admin, which is deliberate
SELECT 'users' AS t, count(*) FROM users WHERE "tenantId" IS NULL
UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records WHERE "tenantId" IS NULL
UNION ALL SELECT 'audit_logs',         count(*) FROM audit_logs         WHERE "tenantId" IS NULL
UNION ALL SELECT 'notifications',      count(*) FROM notifications      WHERE "tenantId" IS NULL
UNION ALL SELECT 'employee_advances',  count(*) FROM employee_advances  WHERE "tenantId" IS NULL
UNION ALL SELECT 'employee_bonuses',   count(*) FROM employee_bonuses   WHERE "tenantId" IS NULL;
-- expect: users = 1 (the superadmin, by design), everything else = 0

-- 4. Nothing was moved between factories
SELECT t.code, count(*) FROM employees e JOIN tenants t ON t.id = e."tenantId" GROUP BY t.code;
-- expect KU&M's 299 employees still under KUM, not moved to default
SQL
```

Then point the app at the branch and confirm it starts and serves:

```bash
DATABASE_URL="$DATABASE_URL" npm run start:prod
curl -s localhost:5003/v1/health/ready
```

## Step 3 — apply to production

Only after step 2 is clean.

```bash
export DATABASE_URL="…production-pooler…"
export DIRECT_URL="…production-direct…"

npx prisma migrate status     # confirm the same three, and nothing new
npx prisma migrate deploy
npx prisma migrate status     # expect: "Database schema is up to date!"
```

Railway's `preDeployCommand` in `railway.json` already runs
`npx prisma migrate deploy`, so a deploy will do this on its own. Running it by
hand first means you see the output rather than discovering it in a deploy log.

---

## Rollback

### `add_ledger_posting` — reversible

```sql
DROP TABLE IF EXISTS "account_mappings";
DROP INDEX IF EXISTS "journal_entries_tenantId_sourceType_sourceId_idx";
DROP INDEX IF EXISTS "journal_entries_tenantId_sourceRef_key";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "isAutomatic";
DELETE FROM _prisma_migrations WHERE migration_name = '20260905220000_add_ledger_posting';
```

### `stock_movement_referential_integrity` — reversible

```sql
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_tenantId_sku_fkey";
DROP VIEW IF EXISTS "stock_movement_orphans";
DROP INDEX IF EXISTS "stock_levels_tenantId_location_idx";
DROP INDEX IF EXISTS "stock_movements_tenantId_location_idx";
DELETE FROM _prisma_migrations WHERE migration_name = '20260905230000_stock_movement_referential_integrity';
```

### `backfill_default_tenant` — **not automatically reversible**

It is a data migration. Once `tenantId` is written, the previous NULL is gone
and nothing records which rows were changed.

**So capture that before you run it**, on production, in the same session:

```sql
CREATE TABLE IF NOT EXISTS _backfill_undo AS
SELECT 'attendance_records' AS tbl, id FROM attendance_records WHERE "tenantId" IS NULL
UNION ALL SELECT 'audit_logs',        id FROM audit_logs        WHERE "tenantId" IS NULL
UNION ALL SELECT 'notifications',     id FROM notifications     WHERE "tenantId" IS NULL
UNION ALL SELECT 'employee_advances', id FROM employee_advances WHERE "tenantId" IS NULL
UNION ALL SELECT 'employee_bonuses',  id FROM employee_bonuses  WHERE "tenantId" IS NULL;
```

To undo:

```sql
UPDATE attendance_records SET "tenantId" = NULL
 WHERE id IN (SELECT id FROM _backfill_undo WHERE tbl = 'attendance_records');
-- …repeat per table…
DELETE FROM _prisma_migrations WHERE migration_name = '20260909120000_backfill_default_tenant';
```

Leave `_backfill_undo` in place until you are satisfied, then drop it.

Given the size — 22 rows — the honest alternative is a **Neon point-in-time
restore**, which is faster and less error-prone than hand-written undo SQL. Take
the branch, note the timestamp, and prefer restore over rollback.

---

## Gate — do not start feature work until all four pass

- [ ] `npx prisma migrate status` → "Database schema is up to date!"
- [ ] `npm run build` (backend) and `npx next build` (frontend) both succeed
- [ ] `npx jest --testEnvironment=node` → all green, count recorded
- [ ] `npx tsc --noEmit` clean on both projects, `eslint` reports 0 errors

---

## Deployment topology (changed 11 Sep 2026)

The image now selects its role from `ROLE`, so the same build serves both
processes. **Two Railway services from one image:**

| Service | `ROLE` | What it does |
|---|---|---|
| api | `api` (default) | The HTTP server |
| worker | `worker` | The BullMQ payroll worker |

**Deploy the worker.** Without it `PayrollService` finds no connected worker and
falls back to running payroll **inline on the API event loop** — a 300-employee
run then blocks every other request for its whole duration.

### Volumes

Two paths must point at a **mounted volume**, not container-local disk:

```
UPLOAD_ROOT=/data/uploads     # the app refuses to start in production without it
BACKUP_ROOT=                  # defaults to <UPLOAD_ROOT>/backups
```

A volume survives redeploys. It is **not** an offsite backup — if the volume
dies the backups die with the database. Copy them off the box on a schedule.

### Clustering

```
CLUSTER_WORKERS=auto    # one worker per core; unset or "1" keeps a single process
```

Each worker costs roughly 150 MB. Only the first registers `@Cron` schedules —
otherwise the hourly absence sweep would fire once per worker and every factory
would get N copies of each notification.

### Redis is now load-bearing

`TOKEN_REVOCATION_STRICT=true` makes the app refuse to start without it. Rate
limit counters, refresh tokens and the revocation list all live there now; the
in-memory fallbacks exist only so a Redis blip degrades rather than fails, and
they are per-instance.

### Migration for this release

`20260910120000_tenant_entitlements` creates per-factory module/page
entitlements and **grandfathers every existing factory into full access** —
nothing is taken away by deploying it.

---

## Still outstanding, separately from the migrations

- **`SUPERADMIN_PASSWORD` has never been rotated** and is readable in the public
  git history of `Anwarramo87/werehouse`. Note that changing the environment
  variable alone does nothing — see `AUTH_FORCE_PASSWORD_RESET` in
  `.env.production.example`.
- **`UPLOAD_ROOT` must be set to a mounted volume** before the next deploy, or
  the app will now refuse to start in production. That is deliberate: the old
  behaviour silently destroyed every uploaded file on redeploy.
