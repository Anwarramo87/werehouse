-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('AVAILABLE', 'QUARANTINE', 'NEAR_EXPIRY', 'EXPIRED', 'CONSUMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PickStrategy" AS ENUM ('SINGLE', 'BATCH', 'ZONE', 'WAVE');

-- CreateEnum
CREATE TYPE "PickStatus" AS ENUM ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CountStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CountItemStatus" AS ENUM ('PENDING', 'COUNTED', 'RECOUNT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PutawayStatus" AS ENUM ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'LABELED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('WEIGHTED_AVERAGE', 'LAST_COST', 'STANDARD');

-- CreateEnum
CREATE TYPE "AllocationMethod" AS ENUM ('VALUE', 'QUANTITY', 'WEIGHT', 'MANUAL');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('ODOO', 'SAP', 'ORACLE', 'SHOPIFY', 'WOOCOMMERCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('RECEIVING', 'PICKING', 'BULK', 'QUARANTINE', 'PACKING', 'STAGING', 'SHIPPING', 'RETURNS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'STOCK_LOW';
ALTER TYPE "NotificationType" ADD VALUE 'STOCK_OUT';
ALTER TYPE "NotificationType" ADD VALUE 'EXPIRY_WARNING';
ALTER TYPE "NotificationType" ADD VALUE 'EXPIRY_CRITICAL';
ALTER TYPE "NotificationType" ADD VALUE 'EXPIRED';
ALTER TYPE "NotificationType" ADD VALUE 'BATCH_QUARANTINED';
ALTER TYPE "NotificationType" ADD VALUE 'QC_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'CYCLE_COUNT_VARIANCE';
ALTER TYPE "NotificationType" ADD VALUE 'PUTAWAY_PENDING';
ALTER TYPE "NotificationType" ADD VALUE 'PICK_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'SHIPMENT_DISPATCHED';
ALTER TYPE "NotificationType" ADD VALUE 'PO_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'INVOICE_DUE';
ALTER TYPE "NotificationType" ADD VALUE 'INTEGRATION_ERROR';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "abcClass" TEXT,
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "batchTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "costingMethod" "CostingMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
ADD COLUMN     "defaultBinCode" TEXT,
ADD COLUMN     "shelfLifeDays" INTEGER,
ADD COLUMN     "taxRateId" UUID,
ADD COLUMN     "volumeM3" DECIMAL(10,4),
ADD COLUMN     "weightKg" DECIMAL(10,3);

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
ADD COLUMN     "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "goods_receipt_items" ADD COLUMN     "batchId" UUID,
ADD COLUMN     "batchNumber" TEXT,
ADD COLUMN     "expiryDate" DATE,
ADD COLUMN     "productionDate" DATE,
ADD COLUMN     "qcAt" TIMESTAMP(3),
ADD COLUMN     "qcBy" UUID,
ADD COLUMN     "qcNotes" TEXT,
ADD COLUMN     "qcStatus" "QcStatus" NOT NULL DEFAULT 'PASSED';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "priceTierId" UUID;

-- AlterTable
ALTER TABLE "sales_order_items" ADD COLUMN     "batchId" UUID,
ADD COLUMN     "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
ADD COLUMN     "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "product_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "sku" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "productionDate" DATE,
    "expiryDate" DATE,
    "status" "BatchStatus" NOT NULL DEFAULT 'AVAILABLE',
    "initialQuantity" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "barcode" TEXT,
    "supplierId" UUID,
    "purchaseInvoiceId" UUID,
    "goodsReceiptItemId" UUID,
    "quarantineReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_stock_levels" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "batchId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expiry_alert_rules" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "sku" TEXT,
    "warnDays" INTEGER NOT NULL DEFAULT 60,
    "criticalDays" INTEGER NOT NULL DEFAULT 30,
    "blockDays" INTEGER NOT NULL DEFAULT 0,
    "notifyEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifySales" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expiry_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_zones" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "warehouseId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ZoneType" NOT NULL DEFAULT 'PICKING',
    "pickSequence" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_bins" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "zoneId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "aisle" TEXT,
    "rack" TEXT,
    "level" TEXT,
    "position" TEXT,
    "maxWeightKg" DECIMAL(10,3),
    "maxVolumeM3" DECIMAL(10,4),
    "capacityUnits" INTEGER,
    "currentUnits" INTEGER NOT NULL DEFAULT 0,
    "pickPriority" INTEGER NOT NULL DEFAULT 100,
    "dedicatedSku" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_bins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "putaway_tasks" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "taskNumber" TEXT NOT NULL,
    "goodsReceiptItemId" UUID,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "quantity" INTEGER NOT NULL,
    "fromLocation" TEXT NOT NULL,
    "suggestedBin" TEXT,
    "suggestionScore" DECIMAL(6,2),
    "suggestionRule" TEXT,
    "actualBin" TEXT,
    "status" "PutawayStatus" NOT NULL DEFAULT 'PENDING',
    "assignedTo" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "putaway_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(6,3) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tiers" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "sku" TEXT NOT NULL,
    "priceTierId" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "validFrom" DATE,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "invoiceNumber" TEXT NOT NULL,
    "supplierInvoiceNumber" TEXT,
    "supplierId" UUID NOT NULL,
    "purchaseOrderId" UUID,
    "goodsReceiptId" UUID,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "landedCostTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "postedAt" TIMESTAMP(3),
    "postedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "invoiceId" UUID NOT NULL,
    "purchaseOrderItemId" UUID,
    "sku" TEXT NOT NULL,
    "batchNumber" TEXT,
    "productionDate" DATE,
    "expiryDate" DATE,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "allocatedLandedCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "finalUnitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL DEFAULT 'WH-A',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landed_costs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "purchaseInvoiceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "allocationMethod" "AllocationMethod" NOT NULL DEFAULT 'VALUE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landed_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "purchaseInvoiceId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'cash',
    "paidBy" UUID NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "sku" TEXT NOT NULL,
    "method" "CostingMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "oldCost" DECIMAL(12,4) NOT NULL,
    "newCost" DECIMAL(12,4) NOT NULL,
    "oldQuantity" INTEGER NOT NULL DEFAULT 0,
    "quantityIn" INTEGER NOT NULL DEFAULT 0,
    "incomingCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "invoiceNumber" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "salesOrderId" UUID,
    "priceTierId" UUID,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cogsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "postedAt" TIMESTAMP(3),
    "postedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "invoiceId" UUID NOT NULL,
    "salesOrderItemId" UUID,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "batchNumber" TEXT,
    "expiryDate" DATE,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL DEFAULT 'WH-A',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "noteNumber" TEXT NOT NULL,
    "salesInvoiceId" UUID,
    "salesOrderId" UUID,
    "customerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_note_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "deliveryNoteId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "batchNumber" TEXT,
    "quantity" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_counts" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "countNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'cycle',
    "scope" TEXT NOT NULL DEFAULT 'all',
    "scopeValue" TEXT,
    "status" "CountStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledDate" DATE,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "countedBy" UUID,
    "approvedBy" UUID,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "countedLines" INTEGER NOT NULL DEFAULT 0,
    "varianceLines" INTEGER NOT NULL DEFAULT 0,
    "varianceValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustmentsPosted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_count_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "cycleCountId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "location" TEXT NOT NULL,
    "systemQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "variance" INTEGER NOT NULL DEFAULT 0,
    "varianceValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "CountItemStatus" NOT NULL DEFAULT 'PENDING',
    "recountRequired" BOOLEAN NOT NULL DEFAULT false,
    "countedBy" UUID,
    "countedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_count_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspections" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "inspectionNumber" TEXT NOT NULL,
    "goodsReceiptId" UUID,
    "goodsReceiptItemId" UUID,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "quantityInspected" INTEGER NOT NULL,
    "quantityPassed" INTEGER NOT NULL DEFAULT 0,
    "quantityFailed" INTEGER NOT NULL DEFAULT 0,
    "status" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "checklist" JSONB,
    "failureReason" TEXT,
    "notes" TEXT,
    "inspectedBy" UUID,
    "inspectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_lists" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "pickNumber" TEXT NOT NULL,
    "strategy" "PickStrategy" NOT NULL DEFAULT 'SINGLE',
    "status" "PickStatus" NOT NULL DEFAULT 'PENDING',
    "salesOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zoneCode" TEXT,
    "assignedTo" UUID,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "completedLines" INTEGER NOT NULL DEFAULT 0,
    "estimatedDistanceM" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pick_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_list_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "pickListId" UUID NOT NULL,
    "salesOrderId" UUID,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "location" TEXT NOT NULL,
    "quantityRequested" INTEGER NOT NULL,
    "quantityPicked" INTEGER NOT NULL DEFAULT 0,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" "PickStatus" NOT NULL DEFAULT 'PENDING',
    "pickedBy" UUID,
    "pickedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pick_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carriers" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPhone" TEXT,
    "trackingUrlTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "shipmentNumber" TEXT NOT NULL,
    "salesOrderId" UUID,
    "salesInvoiceId" UUID,
    "carrierId" UUID,
    "trackingNumber" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "totalWeightKg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "packageCount" INTEGER NOT NULL DEFAULT 0,
    "shippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "labelPayload" TEXT,
    "labelFormat" TEXT,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "address" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "packageNumber" TEXT NOT NULL,
    "shipmentId" UUID,
    "salesOrderId" UUID,
    "weightKg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "lengthCm" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "widthCm" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "heightCm" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "packagingType" TEXT,
    "barcode" TEXT,
    "packedBy" UUID,
    "packedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "packageId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "batchId" UUID,
    "batchNumber" TEXT,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "provider" "IntegrationProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEncrypted" TEXT,
    "apiSecretEncrypted" TEXT,
    "config" JSONB,
    "syncEntities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncInterval" INTEGER NOT NULL DEFAULT 15,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "connectionId" UUID NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "entity" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "integration_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_tenantId_sku_expiryDate_idx" ON "product_batches"("tenantId", "sku", "expiryDate");

-- CreateIndex
CREATE INDEX "product_batches_tenantId_status_expiryDate_idx" ON "product_batches"("tenantId", "status", "expiryDate");

-- CreateIndex
CREATE INDEX "product_batches_tenantId_expiryDate_idx" ON "product_batches"("tenantId", "expiryDate");

-- CreateIndex
CREATE INDEX "product_batches_tenantId_idx" ON "product_batches"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_tenantId_sku_batchNumber_key" ON "product_batches"("tenantId", "sku", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_tenantId_barcode_key" ON "product_batches"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "batch_stock_levels_tenantId_sku_location_idx" ON "batch_stock_levels"("tenantId", "sku", "location");

-- CreateIndex
CREATE INDEX "batch_stock_levels_tenantId_idx" ON "batch_stock_levels"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_stock_levels_tenantId_batchId_location_key" ON "batch_stock_levels"("tenantId", "batchId", "location");

-- CreateIndex
CREATE INDEX "expiry_alert_rules_tenantId_isActive_idx" ON "expiry_alert_rules"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "expiry_alert_rules_tenantId_idx" ON "expiry_alert_rules"("tenantId");

-- CreateIndex
CREATE INDEX "warehouse_zones_tenantId_warehouseId_idx" ON "warehouse_zones"("tenantId", "warehouseId");

-- CreateIndex
CREATE INDEX "warehouse_zones_tenantId_idx" ON "warehouse_zones"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_zones_tenantId_code_key" ON "warehouse_zones"("tenantId", "code");

-- CreateIndex
CREATE INDEX "storage_bins_tenantId_zoneId_pickPriority_idx" ON "storage_bins"("tenantId", "zoneId", "pickPriority");

-- CreateIndex
CREATE INDEX "storage_bins_tenantId_idx" ON "storage_bins"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_bins_tenantId_code_key" ON "storage_bins"("tenantId", "code");

-- CreateIndex
CREATE INDEX "putaway_tasks_tenantId_status_idx" ON "putaway_tasks"("tenantId", "status");

-- CreateIndex
CREATE INDEX "putaway_tasks_tenantId_idx" ON "putaway_tasks"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "putaway_tasks_tenantId_taskNumber_key" ON "putaway_tasks"("tenantId", "taskNumber");

-- CreateIndex
CREATE INDEX "tax_rates_tenantId_idx" ON "tax_rates"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_tenantId_code_key" ON "tax_rates"("tenantId", "code");

-- CreateIndex
CREATE INDEX "price_tiers_tenantId_idx" ON "price_tiers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "price_tiers_tenantId_code_key" ON "price_tiers"("tenantId", "code");

-- CreateIndex
CREATE INDEX "product_prices_tenantId_sku_idx" ON "product_prices"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "product_prices_tenantId_idx" ON "product_prices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_tenantId_sku_priceTierId_minQuantity_key" ON "product_prices"("tenantId", "sku", "priceTierId", "minQuantity");

-- CreateIndex
CREATE INDEX "purchase_invoices_tenantId_supplierId_idx" ON "purchase_invoices"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "purchase_invoices_tenantId_status_idx" ON "purchase_invoices"("tenantId", "status");

-- CreateIndex
CREATE INDEX "purchase_invoices_tenantId_invoiceDate_idx" ON "purchase_invoices"("tenantId", "invoiceDate");

-- CreateIndex
CREATE INDEX "purchase_invoices_tenantId_idx" ON "purchase_invoices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_tenantId_invoiceNumber_key" ON "purchase_invoices"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "purchase_invoice_items_tenantId_invoiceId_idx" ON "purchase_invoice_items"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "purchase_invoice_items_tenantId_sku_idx" ON "purchase_invoice_items"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "purchase_invoice_items_tenantId_idx" ON "purchase_invoice_items"("tenantId");

-- CreateIndex
CREATE INDEX "landed_costs_tenantId_purchaseInvoiceId_idx" ON "landed_costs"("tenantId", "purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "landed_costs_tenantId_idx" ON "landed_costs"("tenantId");

-- CreateIndex
CREATE INDEX "purchase_payments_tenantId_purchaseInvoiceId_idx" ON "purchase_payments"("tenantId", "purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "purchase_payments_tenantId_idx" ON "purchase_payments"("tenantId");

-- CreateIndex
CREATE INDEX "cost_history_tenantId_sku_createdAt_idx" ON "cost_history"("tenantId", "sku", "createdAt");

-- CreateIndex
CREATE INDEX "cost_history_tenantId_idx" ON "cost_history"("tenantId");

-- CreateIndex
CREATE INDEX "sales_invoices_tenantId_customerId_idx" ON "sales_invoices"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "sales_invoices_tenantId_status_idx" ON "sales_invoices"("tenantId", "status");

-- CreateIndex
CREATE INDEX "sales_invoices_tenantId_invoiceDate_idx" ON "sales_invoices"("tenantId", "invoiceDate");

-- CreateIndex
CREATE INDEX "sales_invoices_tenantId_idx" ON "sales_invoices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_tenantId_invoiceNumber_key" ON "sales_invoices"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "sales_invoice_items_tenantId_invoiceId_idx" ON "sales_invoice_items"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "sales_invoice_items_tenantId_sku_idx" ON "sales_invoice_items"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "sales_invoice_items_tenantId_idx" ON "sales_invoice_items"("tenantId");

-- CreateIndex
CREATE INDEX "delivery_notes_tenantId_customerId_idx" ON "delivery_notes"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "delivery_notes_tenantId_idx" ON "delivery_notes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_tenantId_noteNumber_key" ON "delivery_notes"("tenantId", "noteNumber");

-- CreateIndex
CREATE INDEX "delivery_note_items_tenantId_deliveryNoteId_idx" ON "delivery_note_items"("tenantId", "deliveryNoteId");

-- CreateIndex
CREATE INDEX "delivery_note_items_tenantId_idx" ON "delivery_note_items"("tenantId");

-- CreateIndex
CREATE INDEX "cycle_counts_tenantId_status_idx" ON "cycle_counts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "cycle_counts_tenantId_idx" ON "cycle_counts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_counts_tenantId_countNumber_key" ON "cycle_counts"("tenantId", "countNumber");

-- CreateIndex
CREATE INDEX "cycle_count_items_tenantId_cycleCountId_idx" ON "cycle_count_items"("tenantId", "cycleCountId");

-- CreateIndex
CREATE INDEX "cycle_count_items_tenantId_sku_idx" ON "cycle_count_items"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "cycle_count_items_tenantId_idx" ON "cycle_count_items"("tenantId");

-- CreateIndex
CREATE INDEX "quality_inspections_tenantId_status_idx" ON "quality_inspections"("tenantId", "status");

-- CreateIndex
CREATE INDEX "quality_inspections_tenantId_idx" ON "quality_inspections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "quality_inspections_tenantId_inspectionNumber_key" ON "quality_inspections"("tenantId", "inspectionNumber");

-- CreateIndex
CREATE INDEX "pick_lists_tenantId_status_idx" ON "pick_lists"("tenantId", "status");

-- CreateIndex
CREATE INDEX "pick_lists_tenantId_assignedTo_idx" ON "pick_lists"("tenantId", "assignedTo");

-- CreateIndex
CREATE INDEX "pick_lists_tenantId_idx" ON "pick_lists"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "pick_lists_tenantId_pickNumber_key" ON "pick_lists"("tenantId", "pickNumber");

-- CreateIndex
CREATE INDEX "pick_list_items_tenantId_pickListId_sequence_idx" ON "pick_list_items"("tenantId", "pickListId", "sequence");

-- CreateIndex
CREATE INDEX "pick_list_items_tenantId_idx" ON "pick_list_items"("tenantId");

-- CreateIndex
CREATE INDEX "carriers_tenantId_idx" ON "carriers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "carriers_tenantId_code_key" ON "carriers"("tenantId", "code");

-- CreateIndex
CREATE INDEX "shipments_tenantId_status_idx" ON "shipments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "shipments_tenantId_idx" ON "shipments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenantId_shipmentNumber_key" ON "shipments"("tenantId", "shipmentNumber");

-- CreateIndex
CREATE INDEX "packages_tenantId_shipmentId_idx" ON "packages"("tenantId", "shipmentId");

-- CreateIndex
CREATE INDEX "packages_tenantId_idx" ON "packages"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "packages_tenantId_packageNumber_key" ON "packages"("tenantId", "packageNumber");

-- CreateIndex
CREATE INDEX "package_items_tenantId_packageId_idx" ON "package_items"("tenantId", "packageId");

-- CreateIndex
CREATE INDEX "package_items_tenantId_idx" ON "package_items"("tenantId");

-- CreateIndex
CREATE INDEX "integration_connections_tenantId_idx" ON "integration_connections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_tenantId_provider_name_key" ON "integration_connections"("tenantId", "provider", "name");

-- CreateIndex
CREATE INDEX "integration_sync_logs_tenantId_connectionId_startedAt_idx" ON "integration_sync_logs"("tenantId", "connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "integration_sync_logs_tenantId_idx" ON "integration_sync_logs"("tenantId");

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenantId_isActive_idx" ON "webhook_endpoints"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenantId_idx" ON "webhook_endpoints"("tenantId");

-- CreateIndex
CREATE INDEX "products_tenantId_batchTracked_idx" ON "products"("tenantId", "batchTracked");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_barcode_key" ON "products"("tenantId", "barcode");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "price_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_stock_levels" ADD CONSTRAINT "batch_stock_levels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_stock_levels" ADD CONSTRAINT "batch_stock_levels_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expiry_alert_rules" ADD CONSTRAINT "expiry_alert_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_zones" ADD CONSTRAINT "warehouse_zones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_zones" ADD CONSTRAINT "warehouse_zones_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bins" ADD CONSTRAINT "storage_bins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bins" ADD CONSTRAINT "storage_bins_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "warehouse_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_tasks" ADD CONSTRAINT "putaway_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_tasks" ADD CONSTRAINT "putaway_tasks_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "price_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_payments" ADD CONSTRAINT "purchase_payments_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "price_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_deliveryNoteId_fkey" FOREIGN KEY ("deliveryNoteId") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_cycleCountId_fkey" FOREIGN KEY ("cycleCountId") REFERENCES "cycle_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_items" ADD CONSTRAINT "pick_list_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_items" ADD CONSTRAINT "pick_list_items_pickListId_fkey" FOREIGN KEY ("pickListId") REFERENCES "pick_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_items" ADD CONSTRAINT "pick_list_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "carriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_logs" ADD CONSTRAINT "integration_sync_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_logs" ADD CONSTRAINT "integration_sync_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
