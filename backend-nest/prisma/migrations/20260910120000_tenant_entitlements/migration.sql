-- Per-factory page entitlements.
--
-- Existing factories are backfilled with EVERY page in the catalogue, which is
-- exactly the access they have today: nothing is taken away by this migration.
-- The Super Admin narrows it afterwards, deliberately, through the UI.

CREATE TABLE "tenant_entitlements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "enabledPages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_entitlements_tenantId_key" ON "tenant_entitlements"("tenantId");

ALTER TABLE "tenant_entitlements"
  ADD CONSTRAINT "tenant_entitlements_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Grandfather every existing factory into full access.
INSERT INTO "tenant_entitlements" ("id", "tenantId", "enabledPages", "updatedBy", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       t."id",
       ARRAY['hr.employees', 'hr.resigned', 'hr.attendance', 'hr.biometric', 'hr.transportation', 'payroll.settings', 'payroll.rewards', 'payroll.discounts', 'payroll.timetable', 'payroll.reports', 'payroll.vouchers', 'inventory.products', 'inventory.batches', 'inventory.expiry', 'inventory.movements', 'inventory.warehouses', 'inventory.locations', 'inventory.counts', 'inventory.quality', 'inventory.analytics', 'purchasing.orders', 'purchasing.invoices', 'sales.orders', 'sales.invoices', 'sales.pricing', 'fulfillment.picking', 'fulfillment.shipments', 'imports.data', 'admin.settings', 'admin.integrations', 'admin.trash']::TEXT[],
       'migration:20260910120000',
       NOW(),
       NOW()
  FROM "tenants" t
 WHERE NOT EXISTS (
   SELECT 1 FROM "tenant_entitlements" e WHERE e."tenantId" = t."id"
 );
