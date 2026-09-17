-- Per-account (per-admin) page entitlements.
--
-- Effective access for an admin = the pages the FACTORY holds that the USER
-- also holds here. A user with no row inherits the whole factory grant, which
-- is exactly the behaviour every existing factory has today — so nothing is
-- taken away by this migration and existing factories keep working untouched.
--
-- There is deliberately no backfill here (unlike tenant_entitlements): an empty
-- table means "every admin inherits", which is the correct, safe read. The
-- Super Admin UI writes rows per account through
-- /admin/tenants/:tenantId/users/:userId/entitlements.

CREATE TABLE "user_entitlements" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "enabledPages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_entitlements_userId_key" ON "user_entitlements"("userId");

ALTER TABLE "user_entitlements"
    ADD CONSTRAINT "user_entitlements_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_entitlements"
    ADD CONSTRAINT "user_entitlements_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
