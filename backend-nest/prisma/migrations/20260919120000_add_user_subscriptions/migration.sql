-- Per-account (per-admin) subscription window: plan + window.
--
-- Enforcement lives in EntitlementsService: while a row exists and now is past
-- endsAt, THAT account alone holds nothing — the per-admin counterpart of the
-- factory-level rule on tenant_subscriptions. A user with no row inherits the
-- factory subscription, which is exactly the behaviour every existing factory
-- has today — so nothing is taken away by this migration and existing
-- factories keep working untouched.
--
-- There is deliberately no backfill here: an empty table means "every admin
-- inherits the factory", which is the correct, safe read. The Super Admin UI
-- writes rows per account through
-- /admin/tenants/:tenantId/users/:userId/subscription.

CREATE TABLE "user_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_subscriptions_userId_key" ON "user_subscriptions"("userId");

CREATE INDEX "user_subscriptions_endsAt_idx" ON "user_subscriptions"("endsAt");

ALTER TABLE "user_subscriptions"
    ADD CONSTRAINT "user_subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;