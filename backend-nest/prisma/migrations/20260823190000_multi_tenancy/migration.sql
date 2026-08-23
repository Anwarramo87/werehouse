-- DropForeignKey
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "bus_passengers" DROP CONSTRAINT "bus_passengers_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "daily_attendance_logs" DROP CONSTRAINT "daily_attendance_logs_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "employee_advances" DROP CONSTRAINT "employee_advances_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "employee_bonuses" DROP CONSTRAINT "employee_bonuses_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "employee_insurance" DROP CONSTRAINT "employee_insurance_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "employee_penalties" DROP CONSTRAINT "employee_penalties_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "employee_salaries" DROP CONSTRAINT "employee_salaries_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "financial_settlements" DROP CONSTRAINT "financial_settlements_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipt_items" DROP CONSTRAINT "goods_receipt_items_sku_fkey";

-- DropForeignKey
ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "payroll_inputs" DROP CONSTRAINT "payroll_inputs_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "payroll_receipts" DROP CONSTRAINT "payroll_receipts_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_sku_fkey";

-- DropForeignKey
ALTER TABLE "rehire_records" DROP CONSTRAINT "rehire_records_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "sales_order_items" DROP CONSTRAINT "sales_order_items_sku_fkey";

-- DropForeignKey
ALTER TABLE "stock_levels" DROP CONSTRAINT "stock_levels_sku_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sku_fkey";

-- DropForeignKey
ALTER TABLE "termination_records" DROP CONSTRAINT "termination_records_employeeId_fkey";

-- DropIndex
DROP INDEX "accounts_code_key";

-- DropIndex
DROP INDEX "attendance_records_employeeId_timestamp_type_key";

-- DropIndex
DROP INDEX "bus_passengers_busId_employeeId_key";

-- DropIndex
DROP INDEX "buses_busId_key";

-- DropIndex
DROP INDEX "buses_plateNumber_key";

-- DropIndex
DROP INDEX "daily_attendance_logs_employeeId_date_recordType_source_key";

-- DropIndex
DROP INDEX "departments_name_key";

-- DropIndex
DROP INDEX "devices_deviceId_key";

-- DropIndex
DROP INDEX "employee_insurance_employeeId_key";

-- DropIndex
DROP INDEX "employee_salaries_employeeId_key";

-- DropIndex
DROP INDEX "employees_biometricNumber_key";

-- DropIndex
DROP INDEX "employees_employeeId_key";

-- DropIndex
DROP INDEX "employees_nationalId_key";

-- DropIndex
DROP INDEX "goods_receipts_receiptNumber_key";

-- DropIndex
DROP INDEX "import_jobs_jobId_key";

-- DropIndex
DROP INDEX "journal_entries_entryNumber_key";

-- DropIndex
DROP INDEX "notifications_dedupeKey_key";

-- DropIndex
DROP INDEX "payroll_inputs_employeeId_periodStart_periodEnd_key";

-- DropIndex
DROP INDEX "payroll_items_payrollRunId_employeeId_key";

-- DropIndex
DROP INDEX "payroll_receipts_employeeId_month_key";

-- DropIndex
DROP INDEX "payroll_runs_runId_key";

-- DropIndex
DROP INDEX "products_sku_key";

-- DropIndex
DROP INDEX "purchase_orders_poNumber_key";

-- DropIndex
DROP INDEX "sales_orders_soNumber_key";

-- DropIndex
DROP INDEX "stock_levels_sku_location_key";

-- DropIndex
DROP INDEX "warehouses_code_key";

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "biometric_credentials" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "bus_passengers" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "buses" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "daily_attendance_logs" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "deleted_record_history" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employee_advances" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employee_bonuses" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employee_insurance" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employee_penalties" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employee_salaries" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "financial_settlements" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipt_items" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "journal_entry_lines" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "payroll_inputs" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "payroll_items" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "payroll_receipts" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "rehire_records" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "sales_order_items" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "sales_payments" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "stock_levels" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "termination_records" ADD COLUMN     "tenantId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "tenantId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "accounts_tenantId_idx" ON "accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_code_key" ON "accounts"("tenantId", "code");

-- CreateIndex
CREATE INDEX "attendance_records_tenantId_idx" ON "attendance_records"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_tenantId_employeeId_timestamp_type_key" ON "attendance_records"("tenantId", "employeeId", "timestamp", "type");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "biometric_credentials_tenantId_idx" ON "biometric_credentials"("tenantId");

-- CreateIndex
CREATE INDEX "bus_passengers_tenantId_idx" ON "bus_passengers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "bus_passengers_tenantId_busId_employeeId_key" ON "bus_passengers"("tenantId", "busId", "employeeId");

-- CreateIndex
CREATE INDEX "buses_tenantId_idx" ON "buses"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "buses_tenantId_busId_key" ON "buses"("tenantId", "busId");

-- CreateIndex
CREATE UNIQUE INDEX "buses_tenantId_plateNumber_key" ON "buses"("tenantId", "plateNumber");

-- CreateIndex
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_tenantId_idx" ON "daily_attendance_logs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_attendance_logs_tenantId_employeeId_date_recordType_s_key" ON "daily_attendance_logs"("tenantId", "employeeId", "date", "recordType", "source");

-- CreateIndex
CREATE INDEX "deleted_record_history_tenantId_idx" ON "deleted_record_history"("tenantId");

-- CreateIndex
CREATE INDEX "departments_tenantId_idx" ON "departments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenantId_name_key" ON "departments"("tenantId", "name");

-- CreateIndex
CREATE INDEX "devices_tenantId_idx" ON "devices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenantId_deviceId_key" ON "devices"("tenantId", "deviceId");

-- CreateIndex
CREATE INDEX "employee_advances_tenantId_idx" ON "employee_advances"("tenantId");

-- CreateIndex
CREATE INDEX "employee_bonuses_tenantId_idx" ON "employee_bonuses"("tenantId");

-- CreateIndex
CREATE INDEX "employee_insurance_tenantId_idx" ON "employee_insurance"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_insurance_tenantId_employeeId_key" ON "employee_insurance"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "employee_penalties_tenantId_idx" ON "employee_penalties"("tenantId");

-- CreateIndex
CREATE INDEX "employee_salaries_tenantId_idx" ON "employee_salaries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salaries_tenantId_employeeId_key" ON "employee_salaries"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "employees_tenantId_idx" ON "employees"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_employeeId_key" ON "employees"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_biometricNumber_key" ON "employees"("tenantId", "biometricNumber");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenantId_nationalId_key" ON "employees"("tenantId", "nationalId");

-- CreateIndex
CREATE INDEX "financial_settlements_tenantId_idx" ON "financial_settlements"("tenantId");

-- CreateIndex
CREATE INDEX "goods_receipt_items_tenantId_idx" ON "goods_receipt_items"("tenantId");

-- CreateIndex
CREATE INDEX "goods_receipts_tenantId_idx" ON "goods_receipts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_tenantId_receiptNumber_key" ON "goods_receipts"("tenantId", "receiptNumber");

-- CreateIndex
CREATE INDEX "import_jobs_tenantId_idx" ON "import_jobs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_tenantId_jobId_key" ON "import_jobs"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_idx" ON "journal_entries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_entryNumber_key" ON "journal_entries"("tenantId", "entryNumber");

-- CreateIndex
CREATE INDEX "journal_entry_lines_tenantId_idx" ON "journal_entry_lines"("tenantId");

-- CreateIndex
CREATE INDEX "leave_requests_tenantId_idx" ON "leave_requests"("tenantId");

-- CreateIndex
CREATE INDEX "notifications_tenantId_idx" ON "notifications"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenantId_dedupeKey_key" ON "notifications"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "payroll_inputs_tenantId_idx" ON "payroll_inputs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_inputs_tenantId_employeeId_periodStart_periodEnd_key" ON "payroll_inputs"("tenantId", "employeeId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "payroll_items_tenantId_idx" ON "payroll_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_tenantId_payrollRunId_employeeId_key" ON "payroll_items"("tenantId", "payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_receipts_tenantId_idx" ON "payroll_receipts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_receipts_tenantId_employeeId_month_key" ON "payroll_receipts"("tenantId", "employeeId", "month");

-- CreateIndex
CREATE INDEX "payroll_runs_tenantId_idx" ON "payroll_runs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenantId_runId_key" ON "payroll_runs"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "purchase_order_items_tenantId_idx" ON "purchase_order_items"("tenantId");

-- CreateIndex
CREATE INDEX "purchase_orders_tenantId_idx" ON "purchase_orders"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_poNumber_key" ON "purchase_orders"("tenantId", "poNumber");

-- CreateIndex
CREATE INDEX "rehire_records_tenantId_idx" ON "rehire_records"("tenantId");

-- CreateIndex
CREATE INDEX "sales_order_items_tenantId_idx" ON "sales_order_items"("tenantId");

-- CreateIndex
CREATE INDEX "sales_orders_tenantId_idx" ON "sales_orders"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_tenantId_soNumber_key" ON "sales_orders"("tenantId", "soNumber");

-- CreateIndex
CREATE INDEX "sales_payments_tenantId_idx" ON "sales_payments"("tenantId");

-- CreateIndex
CREATE INDEX "stock_levels_tenantId_idx" ON "stock_levels"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_tenantId_sku_location_key" ON "stock_levels"("tenantId", "sku", "location");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_idx" ON "stock_movements"("tenantId");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

-- CreateIndex
CREATE INDEX "termination_records_tenantId_idx" ON "termination_records"("tenantId");

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- CreateIndex
CREATE INDEX "warehouses_tenantId_idx" ON "warehouses"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenantId_code_key" ON "warehouses"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendance_logs" ADD CONSTRAINT "daily_attendance_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendance_logs" ADD CONSTRAINT "daily_attendance_logs_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenantId_sku_fkey" FOREIGN KEY ("tenantId", "sku") REFERENCES "products"("tenantId", "sku") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_sku_fkey" FOREIGN KEY ("tenantId", "sku") REFERENCES "products"("tenantId", "sku") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_tenantId_sku_fkey" FOREIGN KEY ("tenantId", "sku") REFERENCES "products"("tenantId", "sku") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_tenantId_sku_fkey" FOREIGN KEY ("tenantId", "sku") REFERENCES "products"("tenantId", "sku") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_receipts" ADD CONSTRAINT "payroll_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_receipts" ADD CONSTRAINT "payroll_receipts_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_record_history" ADD CONSTRAINT "deleted_record_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_insurance" ADD CONSTRAINT "employee_insurance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_insurance" ADD CONSTRAINT "employee_insurance_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_penalties" ADD CONSTRAINT "employee_penalties_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_penalties" ADD CONSTRAINT "employee_penalties_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buses" ADD CONSTRAINT "buses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bus_passengers" ADD CONSTRAINT "bus_passengers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bus_passengers" ADD CONSTRAINT "bus_passengers_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "employees"("tenantId", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

