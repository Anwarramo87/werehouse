-- DropForeignKey
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_parentId_fkey";

-- DropForeignKey
ALTER TABLE "biometric_credentials" DROP CONSTRAINT "biometric_credentials_userId_fkey";

-- DropForeignKey
ALTER TABLE "bus_passengers" DROP CONSTRAINT "bus_passengers_busId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipt_items" DROP CONSTRAINT "goods_receipt_items_goodsReceiptId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipt_items" DROP CONSTRAINT "goods_receipt_items_purchaseOrderItemId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipts" DROP CONSTRAINT "goods_receipts_purchaseOrderId_fkey";

-- DropForeignKey
ALTER TABLE "journal_entry_lines" DROP CONSTRAINT "journal_entry_lines_accountId_fkey";

-- DropForeignKey
ALTER TABLE "journal_entry_lines" DROP CONSTRAINT "journal_entry_lines_journalEntryId_fkey";

-- DropForeignKey
ALTER TABLE "payroll_items" DROP CONSTRAINT "payroll_items_payrollRunId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_purchaseOrderId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "sales_order_items" DROP CONSTRAINT "sales_order_items_salesOrderId_fkey";

-- DropForeignKey
ALTER TABLE "sales_orders" DROP CONSTRAINT "sales_orders_customerId_fkey";

-- DropForeignKey
ALTER TABLE "sales_payments" DROP CONSTRAINT "sales_payments_salesOrderId_fkey";

-- AlterTable
ALTER TABLE "accounts" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "attendance_records" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "biometric_credentials" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "bus_passengers" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "buses" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "daily_attendance_logs" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "deleted_record_history" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "departments" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "devices" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_advances" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_bonuses" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_insurance" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_penalties" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_salaries" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employees" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "financial_settlements" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipt_items" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipts" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "import_jobs" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "journal_entries" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "journal_entry_lines" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "leave_requests" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payroll_inputs" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payroll_items" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payroll_receipts" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payroll_runs" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "purchase_order_items" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "purchase_orders" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "rehire_records" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "sales_order_items" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "sales_orders" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "sales_payments" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "stock_levels" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "stock_movements" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "suppliers" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "termination_records" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "warehouses" ALTER COLUMN "tenantId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_id_key" ON "accounts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "buses_tenantId_id_key" ON "buses"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_tenantId_id_key" ON "goods_receipts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_id_key" ON "journal_entries"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenantId_id_key" ON "payroll_runs"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_tenantId_id_key" ON "purchase_order_items"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_id_key" ON "purchase_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenantId_id_key" ON "sales_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_id_key" ON "suppliers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_tenantId_goodsReceiptId_fkey" FOREIGN KEY ("tenantId", "goodsReceiptId") REFERENCES "goods_receipts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_tenantId_purchaseOrderItemId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderItemId") REFERENCES "purchase_order_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_tenantId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "salesOrderId") REFERENCES "sales_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_tenantId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "salesOrderId") REFERENCES "sales_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_tenantId_journalEntryId_fkey" FOREIGN KEY ("tenantId", "journalEntryId") REFERENCES "journal_entries"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_tenantId_payrollRunId_fkey" FOREIGN KEY ("tenantId", "payrollRunId") REFERENCES "payroll_runs"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bus_passengers" ADD CONSTRAINT "bus_passengers_tenantId_busId_fkey" FOREIGN KEY ("tenantId", "busId") REFERENCES "buses"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

