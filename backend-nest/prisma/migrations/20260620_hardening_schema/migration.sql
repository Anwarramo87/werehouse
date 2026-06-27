-- Department manager + EmployeeInsurance 1:1 cleanup

ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "manager" TEXT;

ALTER TABLE "employees" DROP COLUMN IF EXISTS "employeeInsuranceId";

-- Performance indexes for dashboard/payroll hot paths
CREATE INDEX IF NOT EXISTS "attendance_records_date_type_idx" ON "attendance_records"("date", "type");
CREATE INDEX IF NOT EXISTS "attendance_records_employeeId_date_type_idx" ON "attendance_records"("employeeId", "date", "type");
CREATE INDEX IF NOT EXISTS "employees_status_departmentId_idx" ON "employees"("status", "departmentId");
CREATE INDEX IF NOT EXISTS "employees_departmentId_status_idx" ON "employees"("departmentId", "status");
CREATE INDEX IF NOT EXISTS "payroll_items_employeeId_period_idx" ON "payroll_items"("employeeId", "createdAt");
