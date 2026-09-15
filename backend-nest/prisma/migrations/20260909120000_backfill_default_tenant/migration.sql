-- Backfill every tenant-scoped row that predates multi-tenancy.
--
-- 20260823190000_multi_tenancy added a nullable "tenantId" to 73 tables but
-- never populated it, and nothing in the application creates a Tenant. The
-- result on any database that existed before that migration -- and on any
-- freshly deployed one -- is that every row carries tenantId NULL while the
-- bootstrapped `admin` user does too. TenantExtension.requireScope() then
-- fails closed for that principal, so every authenticated request answers 500,
-- and rows left at NULL are invisible to every non-superadmin query.
--
-- This migration creates the `default` factory and attaches every orphaned row
-- to it. Tables are updated parent-before-child so the composite
-- (tenantId, <business key>) foreign keys added by
-- 20260830120000_tenant_composite_foreign_keys are never transiently violated.
-- Every statement is idempotent: re-running it changes nothing.

INSERT INTO "tenants" ("id", "name", "code", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'Default', 'default', 'active', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "tenants" WHERE "code" = 'default');

-- The overseer deliberately belongs to no factory, so it is excluded here;
-- every other tenant-less user is a factory user that lost its factory.
UPDATE "users" u
SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE u."tenantId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "roles" r WHERE r."id" = u."roleId" AND r."name" = 'superadmin'
  );

UPDATE "account_mappings" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "accounts" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "audit_logs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "batch_stock_levels" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "buses" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "carriers" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "cost_history" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "customers" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "cycle_count_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "cycle_counts" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "deleted_record_history" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "delivery_note_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "delivery_notes" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "departments" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "devices" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employees" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "expiry_alert_rules" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "import_jobs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "integration_connections" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "integration_sync_logs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "journal_entries" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "landed_costs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "notifications" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "package_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "packages" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "payroll_runs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "pick_list_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "pick_lists" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "price_tiers" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "product_batches" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "product_prices" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "products" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "purchase_invoice_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "purchase_invoices" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "purchase_payments" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "putaway_tasks" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "quality_inspections" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "sales_invoice_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "sales_invoices" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "shipments" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "stock_movements" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "storage_bins" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "suppliers" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "tax_rates" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "warehouse_zones" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "warehouses" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "webhook_endpoints" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "attendance_records" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "biometric_credentials" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "bus_passengers" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "daily_attendance_logs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employee_advances" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employee_bonuses" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employee_insurance" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employee_penalties" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "employee_salaries" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "financial_settlements" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "journal_entry_lines" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "leave_requests" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "payroll_inputs" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "payroll_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "payroll_receipts" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "purchase_orders" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "rehire_records" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "sales_orders" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "stock_levels" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "termination_records" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "goods_receipts" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "purchase_order_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "sales_order_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "sales_payments" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;

UPDATE "goods_receipt_items" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "code" = 'default')
WHERE "tenantId" IS NULL;
