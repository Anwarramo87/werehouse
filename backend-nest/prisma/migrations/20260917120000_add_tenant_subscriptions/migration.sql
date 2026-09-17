-- Time-boxed subscription of one factory: plan + window.
--
-- Enforcement lives in EntitlementsService.effectiveFactoryPages: while a row
-- exists and now is past endsAt, the factory holds NOTHING — sidebar modules
-- vanish and the API 403s, leaving only the always-available routes.
--
-- There is deliberately no backfill: a factory with NO row keeps the legacy
-- behaviour (fully entitled), so this migration takes nothing away from
-- existing factories. Nothing changes until the Super Admin actually sets a
-- subscription through /admin/tenants/:tenantId/subscription.

CREATE TABLE "tenant_subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_subscriptions_tenantId_key" ON "tenant_subscriptions"("tenantId");

CREATE INDEX "tenant_subscriptions_endsAt_idx" ON "tenant_subscriptions"("endsAt");

ALTER TABLE "tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
