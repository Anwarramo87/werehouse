-- تحديث نظام المعمل: عملات متعددة، حضور الباص اليومي، مراحل الإنتاج،
-- مستودعات الإنتاج الفرعية، نقل المخزون، سجل تكاليف الإنتاج، وسجل تدقيق المعاملات.
--
-- All new tables are additive; no existing row is modified except the new
-- nullable/defaulted columns, so this migration is safe to apply on a live
-- database and safe to re-apply through `prisma migrate deploy`.

-- ---------------------------------------------------------------------------
-- 1) Exchange rates — سجل يومي مؤرشف لأسعار الصرف
-- ---------------------------------------------------------------------------
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "pair" TEXT NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "rateDate" DATE NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_tenantId_pair_rateDate_key" ON "exchange_rates"("tenantId", "pair", "rateDate");
CREATE INDEX "exchange_rates_tenantId_pair_rateDate_idx" ON "exchange_rates"("tenantId", "pair", "rateDate");
CREATE INDEX "exchange_rates_tenantId_idx" ON "exchange_rates"("tenantId");

ALTER TABLE "exchange_rates"
    ADD CONSTRAINT "exchange_rates_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2) Bus daily attendance — تسجيل حضور يومي لكل باص
-- ---------------------------------------------------------------------------
CREATE TABLE "bus_daily_attendance" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "busId" UUID NOT NULL,
    "attendDate" DATE NOT NULL,
    "attended" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bus_daily_attendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bus_daily_attendance_tenantId_busId_attendDate_key" ON "bus_daily_attendance"("tenantId", "busId", "attendDate");
CREATE INDEX "bus_daily_attendance_tenantId_busId_attendDate_idx" ON "bus_daily_attendance"("tenantId", "busId", "attendDate");
CREATE INDEX "bus_daily_attendance_tenantId_attendDate_idx" ON "bus_daily_attendance"("tenantId", "attendDate");
CREATE INDEX "bus_daily_attendance_tenantId_idx" ON "bus_daily_attendance"("tenantId");

ALTER TABLE "bus_daily_attendance"
    ADD CONSTRAINT "bus_daily_attendance_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bus_daily_attendance"
    ADD CONSTRAINT "bus_daily_attendance_tenantId_busId_fkey"
    FOREIGN KEY ("tenantId", "busId") REFERENCES "buses"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3) Production stages — مراحل الإنتاج (قص / خياطة / أمبلاج / منتج تام)
-- ---------------------------------------------------------------------------
CREATE TYPE "ProductionStageType" AS ENUM ('CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHED');
CREATE TYPE "ProductionStageStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

CREATE UNIQUE INDEX "production_orders_tenantId_id_key" ON "production_orders"("tenantId", "id");

CREATE TABLE "production_stages" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "productionOrderId" UUID NOT NULL,
    "stageType" "ProductionStageType" NOT NULL,
    "status" "ProductionStageStatus" NOT NULL DEFAULT 'PENDING',
    "responsibleId" UUID,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "inputQty" INTEGER NOT NULL DEFAULT 0,
    "outputQty" INTEGER NOT NULL DEFAULT 0,
    "wasteQty" INTEGER NOT NULL DEFAULT 0,
    "defectiveQty" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "stageCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_stages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "production_stages_tenantId_productionOrderId_stageType_idx" ON "production_stages"("tenantId", "productionOrderId", "stageType");
CREATE INDEX "production_stages_tenantId_status_idx" ON "production_stages"("tenantId", "status");
CREATE INDEX "production_stages_tenantId_idx" ON "production_stages"("tenantId");

ALTER TABLE "production_stages"
    ADD CONSTRAINT "production_stages_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_stages"
    ADD CONSTRAINT "production_stages_tenantId_productionOrderId_fkey"
    FOREIGN KEY ("tenantId", "productionOrderId") REFERENCES "production_orders"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_stages"
    ADD CONSTRAINT "production_stages_tenantId_responsibleId_fkey"
    FOREIGN KEY ("tenantId", "responsibleId") REFERENCES "users"("tenantId", "id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4) Production warehouses + stock levels — مستودعات الإنتاج الفرعية
-- ---------------------------------------------------------------------------
CREATE TABLE "production_warehouses" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "stageType" "ProductionStageType",
    "location" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_warehouses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_warehouses_tenantId_id_key" ON "production_warehouses"("tenantId", "id");
CREATE UNIQUE INDEX "production_warehouses_tenantId_code_key" ON "production_warehouses"("tenantId", "code");
CREATE INDEX "production_warehouses_tenantId_stageType_idx" ON "production_warehouses"("tenantId", "stageType");
CREATE INDEX "production_warehouses_tenantId_idx" ON "production_warehouses"("tenantId");

ALTER TABLE "production_warehouses"
    ADD CONSTRAINT "production_warehouses_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "production_stock_levels" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "warehouseId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_stock_levels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_stock_levels_tenantId_warehouseId_sku_key" ON "production_stock_levels"("tenantId", "warehouseId", "sku");
CREATE INDEX "production_stock_levels_tenantId_sku_idx" ON "production_stock_levels"("tenantId", "sku");
CREATE INDEX "production_stock_levels_tenantId_idx" ON "production_stock_levels"("tenantId");

ALTER TABLE "production_stock_levels"
    ADD CONSTRAINT "production_stock_levels_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_stock_levels"
    ADD CONSTRAINT "production_stock_levels_tenantId_warehouseId_fkey"
    FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "production_warehouses"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5) Stock transfers — نقل المخزون بين مستودعات الإنتاج
-- ---------------------------------------------------------------------------
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "transferNumber" TEXT NOT NULL,
    "fromWarehouseId" UUID,
    "toWarehouseId" UUID,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_transfers_tenantId_transferNumber_key" ON "stock_transfers"("tenantId", "transferNumber");
CREATE INDEX "stock_transfers_tenantId_fromWarehouseId_idx" ON "stock_transfers"("tenantId", "fromWarehouseId");
CREATE INDEX "stock_transfers_tenantId_toWarehouseId_idx" ON "stock_transfers"("tenantId", "toWarehouseId");
CREATE INDEX "stock_transfers_tenantId_sku_idx" ON "stock_transfers"("tenantId", "sku");
CREATE INDEX "stock_transfers_tenantId_createdAt_idx" ON "stock_transfers"("tenantId", "createdAt");
CREATE INDEX "stock_transfers_tenantId_idx" ON "stock_transfers"("tenantId");

ALTER TABLE "stock_transfers"
    ADD CONSTRAINT "stock_transfers_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
    ADD CONSTRAINT "stock_transfers_tenantId_fromWarehouseId_fkey"
    FOREIGN KEY ("tenantId", "fromWarehouseId") REFERENCES "production_warehouses"("tenantId", "id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
    ADD CONSTRAINT "stock_transfers_tenantId_toWarehouseId_fkey"
    FOREIGN KEY ("tenantId", "toWarehouseId") REFERENCES "production_warehouses"("tenantId", "id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
    ADD CONSTRAINT "stock_transfers_tenantId_createdById_fkey"
    FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6) Production cost records — تكلفة مقدرة / فعلية / نهائية لكل دفعة
-- ---------------------------------------------------------------------------
CREATE TABLE "production_cost_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "productionOrderId" UUID NOT NULL,
    "materialCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "directCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overheadCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalActualCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitActualCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitFinalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "goodQty" INTEGER NOT NULL DEFAULT 0,
    "wasteQty" INTEGER NOT NULL DEFAULT 0,
    "defectiveQty" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "exchangeRateDate" TIMESTAMP(3),
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_cost_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_cost_records_tenantId_productionOrderId_key" ON "production_cost_records"("tenantId", "productionOrderId");
CREATE INDEX "production_cost_records_tenantId_idx" ON "production_cost_records"("tenantId");

ALTER TABLE "production_cost_records"
    ADD CONSTRAINT "production_cost_records_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_cost_records"
    ADD CONSTRAINT "production_cost_records_tenantId_productionOrderId_fkey"
    FOREIGN KEY ("tenantId", "productionOrderId") REFERENCES "production_orders"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7) Transaction audit — سجل تدقيق المعاملات والدفعات وحركات المخزون
-- ---------------------------------------------------------------------------
CREATE TABLE "transaction_audit" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transaction_audit_tenantId_entityType_entityId_idx" ON "transaction_audit"("tenantId", "entityType", "entityId");
CREATE INDEX "transaction_audit_tenantId_action_createdAt_idx" ON "transaction_audit"("tenantId", "action", "createdAt");
CREATE INDEX "transaction_audit_tenantId_idx" ON "transaction_audit"("tenantId");

ALTER TABLE "transaction_audit"
    ADD CONSTRAINT "transaction_audit_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 8) Composite unique keys required by the new relations
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 8b) Production batch fields + size/colour variants
-- ---------------------------------------------------------------------------
ALTER TABLE "production_orders" ADD COLUMN "batchName" TEXT;
ALTER TABLE "production_orders" ADD COLUMN "productType" TEXT;
ALTER TABLE "production_orders" ADD COLUMN "createdDate" DATE;

CREATE TABLE "production_variants" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "productionOrderId" UUID NOT NULL,
    "color" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "cutQty" INTEGER NOT NULL DEFAULT 0,
    "sewnQty" INTEGER NOT NULL DEFAULT 0,
    "packedQty" INTEGER NOT NULL DEFAULT 0,
    "finishedQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_variants_tenantId_productionOrderId_color_size_key" ON "production_variants"("tenantId", "productionOrderId", "color", "size");
CREATE INDEX "production_variants_tenantId_productionOrderId_idx" ON "production_variants"("tenantId", "productionOrderId");
CREATE INDEX "production_variants_tenantId_idx" ON "production_variants"("tenantId");

ALTER TABLE "production_variants"
    ADD CONSTRAINT "production_variants_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_variants"
    ADD CONSTRAINT "production_variants_tenantId_productionOrderId_fkey"
    FOREIGN KEY ("tenantId", "productionOrderId") REFERENCES "production_orders"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 9) Bus daily cost — التكلفة اليومية الافتراضية (قابلة للتعديل من الإعدادات)
-- ---------------------------------------------------------------------------
ALTER TABLE "buses" ADD COLUMN "dailyCost" DECIMAL(14,2) NOT NULL DEFAULT 200000;

-- ---------------------------------------------------------------------------
-- 9b) Backup run log — وقت آخر نسخة احتياطية وحالتها
-- ---------------------------------------------------------------------------
CREATE TABLE "backup_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'daily',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "fileName" TEXT,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "error" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_runs_tenantId_createdAt_idx" ON "backup_runs"("tenantId", "createdAt");
CREATE INDEX "backup_runs_tenantId_status_idx" ON "backup_runs"("tenantId", "status");
CREATE INDEX "backup_runs_tenantId_idx" ON "backup_runs"("tenantId");

ALTER TABLE "backup_runs"
    ADD CONSTRAINT "backup_runs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 10) Currency columns on transactions — العملة الأصلية وسعر الصرف وتاريخه
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_invoices" ADD COLUMN "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_invoices" ADD COLUMN "exchangeRateDate" TIMESTAMP(3);

ALTER TABLE "sales_invoices" ADD COLUMN "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "sales_invoices" ADD COLUMN "exchangeRateDate" TIMESTAMP(3);

ALTER TABLE "journal_entry_lines" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'SYP';
ALTER TABLE "journal_entry_lines" ADD COLUMN "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "journal_entry_lines" ADD COLUMN "exchangeRateDate" TIMESTAMP(3);

ALTER TABLE "stock_movements" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'SYP';
ALTER TABLE "stock_movements" ADD COLUMN "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 0;
ALTER TABLE "stock_movements" ADD COLUMN "exchangeRateDate" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 11) Notification type for a failed backup — the alert the brief asks for
-- ---------------------------------------------------------------------------
ALTER TYPE "NotificationType" ADD VALUE 'BACKUP_FAILED';
