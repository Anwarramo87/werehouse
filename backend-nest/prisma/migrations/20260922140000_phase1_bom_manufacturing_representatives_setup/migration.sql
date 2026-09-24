-- Phase 1: BOM, Manufacturing, Representatives, WMS Setup, System Settings
-- Fully idempotent — safe to re-run at any state

-- ===========================================================================
-- ENUMS (safe — skip if already exists)
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE "ProductType" AS ENUM ('RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProductionStatus" AS ENUM ('DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RepMovementType" AS ENUM ('RECEIVED', 'SOLD', 'RETURNED', 'ADJUSTED', 'SETTLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RepSaleStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'DISPUTED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===========================================================================
-- PRODUCT: add productType + description (safe — skip if already exists)
-- ===========================================================================

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "productType" "ProductType" NOT NULL DEFAULT 'FINISHED',
  ADD COLUMN IF NOT EXISTS "description" TEXT;

-- ===========================================================================
-- DROP partial tables if they exist without full structure, then recreate
-- ===========================================================================

-- Drop constraints first (safe to ignore errors)
ALTER TABLE IF EXISTS "bom_items" DROP CONSTRAINT IF EXISTS "bom_items_bomId_fkey";
ALTER TABLE IF EXISTS "bom_items" DROP CONSTRAINT IF EXISTS "bom_items_tenantId_fkey";
ALTER TABLE IF EXISTS "boms" DROP CONSTRAINT IF EXISTS "boms_tenantId_fkey";
ALTER TABLE IF EXISTS "production_orders" DROP CONSTRAINT IF EXISTS "production_orders_tenantId_fkey";
ALTER TABLE IF EXISTS "production_orders" DROP CONSTRAINT IF EXISTS "production_orders_bomId_fkey";
ALTER TABLE IF EXISTS "material_consumptions" DROP CONSTRAINT IF EXISTS "material_consumptions_tenantId_fkey";
ALTER TABLE IF EXISTS "material_consumptions" DROP CONSTRAINT IF EXISTS "material_consumptions_productionOrderId_fkey";
ALTER TABLE IF EXISTS "representatives" DROP CONSTRAINT IF EXISTS "representatives_tenantId_fkey";
ALTER TABLE IF EXISTS "representatives" DROP CONSTRAINT IF EXISTS "representatives_userId_fkey";

-- Drop tables if they exist (in dependency order)
DROP TABLE IF EXISTS "material_consumptions" CASCADE;
DROP TABLE IF EXISTS "production_orders" CASCADE;
DROP TABLE IF EXISTS "bom_items" CASCADE;
DROP TABLE IF EXISTS "boms" CASCADE;
DROP TABLE IF EXISTS "rep_settlements" CASCADE;
DROP TABLE IF EXISTS "rep_returns" CASCADE;
DROP TABLE IF EXISTS "rep_collections" CASCADE;
DROP TABLE IF EXISTS "rep_sale_items" CASCADE;
DROP TABLE IF EXISTS "rep_sales" CASCADE;
DROP TABLE IF EXISTS "rep_stock_movements" CASCADE;
DROP TABLE IF EXISTS "rep_stocks" CASCADE;
DROP TABLE IF EXISTS "rep_products" CASCADE;
DROP TABLE IF EXISTS "rep_customers" CASCADE;
DROP TABLE IF EXISTS "rep_routes" CASCADE;
DROP TABLE IF EXISTS "representatives" CASCADE;
DROP TABLE IF EXISTS "wms_setup_states" CASCADE;
DROP TABLE IF EXISTS "system_settings" CASCADE;

-- ===========================================================================
-- BOM (Bill of Materials)
-- ===========================================================================

CREATE TABLE "boms" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID,
  "productSku" TEXT NOT NULL,
  "version"    INTEGER NOT NULL DEFAULT 1,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "notes"      TEXT,
  "createdBy"  UUID,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "boms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "boms_tenantId_productSku_version_key"
  ON "boms"("tenantId", "productSku", "version");
CREATE INDEX "boms_tenantId_productSku_isActive_idx"
  ON "boms"("tenantId", "productSku", "isActive");
CREATE INDEX "boms_tenantId_idx" ON "boms"("tenantId");

ALTER TABLE "boms"
  ADD CONSTRAINT "boms_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ===========================================================================
-- BOM ITEMS
-- ===========================================================================

CREATE TABLE "bom_items" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID,
  "bomId"        UUID NOT NULL,
  "materialSku"  TEXT NOT NULL,
  "quantity"     DECIMAL(12,4) NOT NULL,
  "unit"         TEXT NOT NULL DEFAULT 'قطعة',
  "wastePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bom_items_tenantId_bomId_materialSku_key"
  ON "bom_items"("tenantId", "bomId", "materialSku");
CREATE INDEX "bom_items_tenantId_bomId_idx" ON "bom_items"("tenantId", "bomId");
CREATE INDEX "bom_items_tenantId_materialSku_idx" ON "bom_items"("tenantId", "materialSku");
CREATE INDEX "bom_items_tenantId_idx" ON "bom_items"("tenantId");

ALTER TABLE "bom_items"
  ADD CONSTRAINT "bom_items_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "bom_items"
  ADD CONSTRAINT "bom_items_bomId_fkey"
  FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE CASCADE;

-- ===========================================================================
-- PRODUCTION ORDERS
-- ===========================================================================

CREATE TABLE "production_orders" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID,
  "orderNumber"   TEXT NOT NULL,
  "bomId"         UUID NOT NULL,
  "productSku"    TEXT NOT NULL,
  "plannedQty"    INTEGER NOT NULL,
  "actualQty"     INTEGER NOT NULL DEFAULT 0,
  "wasteQty"      INTEGER NOT NULL DEFAULT 0,
  "status"        "ProductionStatus" NOT NULL DEFAULT 'DRAFT',
  "plannedDate"   DATE NOT NULL,
  "startedAt"     TIMESTAMP(3),
  "completedAt"   TIMESTAMP(3),
  "completedDate" DATE,
  "materialCost"  DECIMAL(14,4) NOT NULL DEFAULT 0,
  "laborCost"     DECIMAL(14,4) NOT NULL DEFAULT 0,
  "overheadCost"  DECIMAL(14,4) NOT NULL DEFAULT 0,
  "packagingCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "otherCost"     DECIMAL(14,4) NOT NULL DEFAULT 0,
  "totalCost"     DECIMAL(14,4) NOT NULL DEFAULT 0,
  "unitCost"      DECIMAL(14,4) NOT NULL DEFAULT 0,
  "notes"         TEXT,
  "createdBy"     UUID NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_orders_tenantId_orderNumber_key"
  ON "production_orders"("tenantId", "orderNumber");
CREATE INDEX "production_orders_tenantId_productSku_idx"
  ON "production_orders"("tenantId", "productSku");
CREATE INDEX "production_orders_tenantId_status_idx"
  ON "production_orders"("tenantId", "status");
CREATE INDEX "production_orders_tenantId_plannedDate_idx"
  ON "production_orders"("tenantId", "plannedDate");
CREATE INDEX "production_orders_tenantId_idx" ON "production_orders"("tenantId");

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_bomId_fkey"
  FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE RESTRICT;

-- ===========================================================================
-- MATERIAL CONSUMPTIONS
-- ===========================================================================

CREATE TABLE "material_consumptions" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID,
  "productionOrderId"  UUID NOT NULL,
  "materialSku"        TEXT NOT NULL,
  "plannedQty"         DECIMAL(12,4) NOT NULL,
  "actualQty"          DECIMAL(12,4) NOT NULL,
  "wasteQty"           DECIMAL(12,4) NOT NULL DEFAULT 0,
  "unitCost"           DECIMAL(12,4) NOT NULL,
  "totalCost"          DECIMAL(14,4) NOT NULL,
  "location"           TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "material_consumptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "material_consumptions_productionOrderId_idx"
  ON "material_consumptions"("productionOrderId");
CREATE INDEX "material_consumptions_tenantId_materialSku_idx"
  ON "material_consumptions"("tenantId", "materialSku");
CREATE INDEX "material_consumptions_tenantId_idx"
  ON "material_consumptions"("tenantId");

ALTER TABLE "material_consumptions"
  ADD CONSTRAINT "material_consumptions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "material_consumptions"
  ADD CONSTRAINT "material_consumptions_productionOrderId_fkey"
  FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REPRESENTATIVES
-- ===========================================================================

CREATE TABLE "representatives" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID,
  "userId"     UUID NOT NULL,
  "employeeId" UUID,
  "name"       TEXT NOT NULL,
  "code"       TEXT NOT NULL,
  "phone"      TEXT,
  "email"      TEXT,
  "status"     TEXT NOT NULL DEFAULT 'active',
  "notes"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "representatives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "representatives_userId_key" ON "representatives"("userId");
CREATE UNIQUE INDEX "representatives_tenantId_code_key"
  ON "representatives"("tenantId", "code");
CREATE INDEX "representatives_tenantId_status_idx"
  ON "representatives"("tenantId", "status");
CREATE INDEX "representatives_tenantId_idx" ON "representatives"("tenantId");

ALTER TABLE "representatives"
  ADD CONSTRAINT "representatives_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "representatives"
  ADD CONSTRAINT "representatives_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT;

-- ===========================================================================
-- REP ROUTES
-- ===========================================================================

CREATE TABLE "rep_routes" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "name"             TEXT NOT NULL,
  "areas"            TEXT[] NOT NULL DEFAULT '{}',
  "schedule"         TEXT,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_routes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rep_routes_tenantId_representativeId_idx"
  ON "rep_routes"("tenantId", "representativeId");
CREATE INDEX "rep_routes_tenantId_idx" ON "rep_routes"("tenantId");

ALTER TABLE "rep_routes"
  ADD CONSTRAINT "rep_routes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_routes"
  ADD CONSTRAINT "rep_routes_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP CUSTOMERS
-- ===========================================================================

CREATE TABLE "rep_customers" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "customerId"       UUID NOT NULL,
  "assignedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "rep_customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rep_customers_tenantId_representativeId_customerId_key"
  ON "rep_customers"("tenantId", "representativeId", "customerId");
CREATE INDEX "rep_customers_tenantId_representativeId_idx"
  ON "rep_customers"("tenantId", "representativeId");
CREATE INDEX "rep_customers_tenantId_customerId_idx"
  ON "rep_customers"("tenantId", "customerId");
CREATE INDEX "rep_customers_tenantId_idx" ON "rep_customers"("tenantId");

ALTER TABLE "rep_customers"
  ADD CONSTRAINT "rep_customers_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_customers"
  ADD CONSTRAINT "rep_customers_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP PRODUCTS
-- ===========================================================================

CREATE TABLE "rep_products" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "sku"              TEXT NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "rep_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rep_products_tenantId_representativeId_sku_key"
  ON "rep_products"("tenantId", "representativeId", "sku");
CREATE INDEX "rep_products_tenantId_representativeId_idx"
  ON "rep_products"("tenantId", "representativeId");
CREATE INDEX "rep_products_tenantId_idx" ON "rep_products"("tenantId");

ALTER TABLE "rep_products"
  ADD CONSTRAINT "rep_products_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_products"
  ADD CONSTRAINT "rep_products_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP STOCKS
-- ===========================================================================

CREATE TABLE "rep_stocks" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "sku"              TEXT NOT NULL,
  "quantity"         INTEGER NOT NULL DEFAULT 0,
  "unitCost"         DECIMAL(12,4) NOT NULL DEFAULT 0,
  "totalValue"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_stocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rep_stocks_tenantId_representativeId_sku_key"
  ON "rep_stocks"("tenantId", "representativeId", "sku");
CREATE INDEX "rep_stocks_tenantId_representativeId_idx"
  ON "rep_stocks"("tenantId", "representativeId");
CREATE INDEX "rep_stocks_tenantId_idx" ON "rep_stocks"("tenantId");

ALTER TABLE "rep_stocks"
  ADD CONSTRAINT "rep_stocks_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_stocks"
  ADD CONSTRAINT "rep_stocks_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP STOCK MOVEMENTS
-- ===========================================================================

CREATE TABLE "rep_stock_movements" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "sku"              TEXT NOT NULL,
  "type"             "RepMovementType" NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "unitCost"         DECIMAL(12,4) NOT NULL,
  "totalValue"       DECIMAL(14,2) NOT NULL,
  "referenceType"    TEXT,
  "referenceId"      TEXT,
  "notes"            TEXT,
  "createdBy"        UUID NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rep_stock_movements_tenantId_representativeId_createdAt_idx"
  ON "rep_stock_movements"("tenantId", "representativeId", "createdAt");
CREATE INDEX "rep_stock_movements_tenantId_representativeId_type_idx"
  ON "rep_stock_movements"("tenantId", "representativeId", "type");
CREATE INDEX "rep_stock_movements_tenantId_sku_idx"
  ON "rep_stock_movements"("tenantId", "sku");
CREATE INDEX "rep_stock_movements_tenantId_idx" ON "rep_stock_movements"("tenantId");

ALTER TABLE "rep_stock_movements"
  ADD CONSTRAINT "rep_stock_movements_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_stock_movements"
  ADD CONSTRAINT "rep_stock_movements_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP SALES
-- ===========================================================================

CREATE TABLE "rep_sales" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "customerId"       UUID NOT NULL,
  "saleNumber"       TEXT NOT NULL,
  "saleDate"         DATE NOT NULL,
  "subtotal"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountAmount"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalAmount"      DECIMAL(14,2) NOT NULL,
  "paidAmount"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "status"           "RepSaleStatus" NOT NULL DEFAULT 'PENDING',
  "notes"            TEXT,
  "createdBy"        UUID NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_sales_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rep_sales_tenantId_saleNumber_key"
  ON "rep_sales"("tenantId", "saleNumber");
CREATE INDEX "rep_sales_tenantId_representativeId_saleDate_idx"
  ON "rep_sales"("tenantId", "representativeId", "saleDate");
CREATE INDEX "rep_sales_tenantId_representativeId_status_idx"
  ON "rep_sales"("tenantId", "representativeId", "status");
CREATE INDEX "rep_sales_tenantId_customerId_idx"
  ON "rep_sales"("tenantId", "customerId");
CREATE INDEX "rep_sales_tenantId_idx" ON "rep_sales"("tenantId");

ALTER TABLE "rep_sales"
  ADD CONSTRAINT "rep_sales_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_sales"
  ADD CONSTRAINT "rep_sales_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP SALE ITEMS
-- ===========================================================================

CREATE TABLE "rep_sale_items" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID,
  "saleId"          UUID NOT NULL,
  "sku"             TEXT NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "unitPrice"       DECIMAL(12,2) NOT NULL,
  "unitCost"        DECIMAL(12,4) NOT NULL,
  "lineTotal"       DECIMAL(14,2) NOT NULL,
  "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "discountAmount"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_sale_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rep_sale_items_saleId_idx" ON "rep_sale_items"("saleId");
CREATE INDEX "rep_sale_items_tenantId_sku_idx" ON "rep_sale_items"("tenantId", "sku");
CREATE INDEX "rep_sale_items_tenantId_idx" ON "rep_sale_items"("tenantId");

ALTER TABLE "rep_sale_items"
  ADD CONSTRAINT "rep_sale_items_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_sale_items"
  ADD CONSTRAINT "rep_sale_items_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "rep_sales"("id") ON DELETE CASCADE;

-- ===========================================================================
-- REP COLLECTIONS
-- ===========================================================================

CREATE TABLE "rep_collections" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "saleId"           UUID,
  "customerId"       UUID NOT NULL,
  "amount"           DECIMAL(14,2) NOT NULL,
  "method"           TEXT NOT NULL DEFAULT 'cash',
  "collectionDate"   DATE NOT NULL,
  "notes"            TEXT,
  "createdBy"        UUID NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_collections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rep_collections_tenantId_representativeId_collectionDate_idx"
  ON "rep_collections"("tenantId", "representativeId", "collectionDate");
CREATE INDEX "rep_collections_tenantId_saleId_idx"
  ON "rep_collections"("tenantId", "saleId");
CREATE INDEX "rep_collections_tenantId_idx" ON "rep_collections"("tenantId");

ALTER TABLE "rep_collections"
  ADD CONSTRAINT "rep_collections_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_collections"
  ADD CONSTRAINT "rep_collections_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;
ALTER TABLE "rep_collections"
  ADD CONSTRAINT "rep_collections_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "rep_sales"("id") ON DELETE SET NULL;

-- ===========================================================================
-- REP RETURNS
-- ===========================================================================

CREATE TABLE "rep_returns" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "representativeId" UUID NOT NULL,
  "saleId"           UUID,
  "customerId"       UUID NOT NULL,
  "sku"              TEXT NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "unitPrice"        DECIMAL(12,2) NOT NULL,
  "totalValue"       DECIMAL(14,2) NOT NULL,
  "reason"           TEXT,
  "returnDate"       DATE NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "notes"            TEXT,
  "createdBy"        UUID NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_returns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rep_returns_tenantId_representativeId_returnDate_idx"
  ON "rep_returns"("tenantId", "representativeId", "returnDate");
CREATE INDEX "rep_returns_tenantId_saleId_idx" ON "rep_returns"("tenantId", "saleId");
CREATE INDEX "rep_returns_tenantId_idx" ON "rep_returns"("tenantId");

ALTER TABLE "rep_returns"
  ADD CONSTRAINT "rep_returns_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_returns"
  ADD CONSTRAINT "rep_returns_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;
ALTER TABLE "rep_returns"
  ADD CONSTRAINT "rep_returns_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "rep_sales"("id") ON DELETE SET NULL;

-- ===========================================================================
-- REP SETTLEMENTS
-- ===========================================================================

CREATE TABLE "rep_settlements" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"            UUID,
  "representativeId"    UUID NOT NULL,
  "periodStart"         DATE NOT NULL,
  "periodEnd"           DATE NOT NULL,
  "receivedValue"       DECIMAL(14,2) NOT NULL,
  "soldValue"           DECIMAL(14,2) NOT NULL,
  "collectedValue"      DECIMAL(14,2) NOT NULL,
  "returnedValue"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "outstandingAmount"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  "expectedStock"       JSONB NOT NULL DEFAULT '[]',
  "actualStock"         JSONB NOT NULL DEFAULT '[]',
  "stockVarianceValue"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "varianceReason"      TEXT,
  "status"              "SettlementStatus" NOT NULL DEFAULT 'PENDING',
  "approvedBy"          UUID,
  "approvedAt"          TIMESTAMP(3),
  "notes"               TEXT,
  "createdBy"           UUID NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rep_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rep_settlements_tenantId_representativeId_periodStart_periodEnd_key"
  ON "rep_settlements"("tenantId", "representativeId", "periodStart", "periodEnd");
CREATE INDEX "rep_settlements_tenantId_representativeId_status_idx"
  ON "rep_settlements"("tenantId", "representativeId", "status");
CREATE INDEX "rep_settlements_tenantId_status_idx"
  ON "rep_settlements"("tenantId", "status");
CREATE INDEX "rep_settlements_tenantId_idx" ON "rep_settlements"("tenantId");

ALTER TABLE "rep_settlements"
  ADD CONSTRAINT "rep_settlements_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "rep_settlements"
  ADD CONSTRAINT "rep_settlements_representativeId_fkey"
  FOREIGN KEY ("representativeId") REFERENCES "representatives"("id") ON DELETE CASCADE;

-- ===========================================================================
-- WMS SETUP STATE
-- ===========================================================================

CREATE TABLE "wms_setup_states" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL,
  "currentStep" INTEGER NOT NULL DEFAULT 1,
  "stepsData"   JSONB NOT NULL DEFAULT '{}',
  "isCompleted" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wms_setup_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_setup_states_tenantId_key" ON "wms_setup_states"("tenantId");

ALTER TABLE "wms_setup_states"
  ADD CONSTRAINT "wms_setup_states_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ===========================================================================
-- SYSTEM SETTINGS
-- ===========================================================================

CREATE TABLE "system_settings" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID NOT NULL,
  "currency"         TEXT NOT NULL DEFAULT 'SYP',
  "currencySymbol"   TEXT NOT NULL DEFAULT 'ل.س',
  "currencyDecimals" INTEGER NOT NULL DEFAULT 0,
  "locale"           TEXT NOT NULL DEFAULT 'ar-SY',
  "timezone"         TEXT NOT NULL DEFAULT 'Asia/Damascus',
  "textDirection"    TEXT NOT NULL DEFAULT 'rtl',
  "settings"         JSONB NOT NULL DEFAULT '{}',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_settings_tenantId_key" ON "system_settings"("tenantId");

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
