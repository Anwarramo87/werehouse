-- CreateEnum
CREATE TYPE "LeaveRequestType" AS ENUM ('PAID', 'UNPAID', 'SICK', 'ADMIN', 'DEATH', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DailyRecordType" AS ENUM ('ABSENCE', 'DELAY_MINUTES', 'OVERTIME_MINUTES', 'PAID_LEAVE', 'UNPAID_LEAVE', 'SICK_LEAVE', 'ADMIN_LEAVE', 'DEATH_LEAVE', 'EARLY_LEAVE_MINUTES');

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "roleId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockoutUntil" TIMESTAMP(3),
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_credentials" (
    "id" UUID NOT NULL,
    "keyId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "publicKeyDer" BYTEA NOT NULL,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "biometric_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "biometricNumber" INTEGER,
    "name" TEXT NOT NULL,
    "userId" UUID,
    "mobile" TEXT,
    "residence" VARCHAR(200),
    "nationalId" TEXT,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "jobTitle" TEXT,
    "profession" TEXT,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "dailyRate" DECIMAL(10,2),
    "baseSalary" DECIMAL(14,2),
    "livingAllowance" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "scheduledStart" TEXT,
    "scheduledEnd" TEXT,
    "employmentStartDate" DATE,
    "terminationDate" DATE,
    "terminationType" TEXT,
    "terminationReason" TEXT,
    "terminationNotes" TEXT,
    "financialSettlementStatus" TEXT NOT NULL DEFAULT 'pending',
    "financialSettlementDate" DATE,
    "rehireDate" DATE,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "isFinanciallySettled" BOOLEAN NOT NULL DEFAULT false,
    "department" TEXT NOT NULL DEFAULT 'Warehouse',
    "departmentId" UUID,
    "roleId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "workDaysInPeriod" INTEGER NOT NULL DEFAULT 26,
    "hoursPerDay" INTEGER NOT NULL DEFAULT 8,
    "overtimeCalculation" JSONB,
    "gracePeriodMinutes" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "employeeInsuranceId" UUID,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" "LeaveRequestType" NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isHourly" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT,
    "endTime" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'ZK Teco',
    "ip" TEXT,
    "port" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSync" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "deviceId" TEXT,
    "location" TEXT,
    "source" TEXT NOT NULL DEFAULT 'device',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "date" TEXT NOT NULL,
    "shiftPair" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_attendance_logs" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "recordType" "DailyRecordType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "reorderLevel" INTEGER NOT NULL DEFAULT 10,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "jobId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodType" TEXT NOT NULL DEFAULT 'monthly',
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvalStatus" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvalDate" TIMESTAMP(3),
    "totalEmployees" INTEGER NOT NULL DEFAULT 0,
    "totalGrossPay" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalNetPay" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'SYP',
    "notes" TEXT,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "hoursWorked" DECIMAL(8,2) NOT NULL,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "grossPay" DECIMAL(14,2) NOT NULL,
    "totalDeductions" DECIMAL(14,2) NOT NULL,
    "netPay" DECIMAL(14,2) NOT NULL,
    "netPayRounded" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundingDifference" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netPayWithAdvance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveDeduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "anomalies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_inputs" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "absenceDays" INTEGER NOT NULL DEFAULT 0,
    "sickLeaveDays" INTEGER NOT NULL DEFAULT 0,
    "adminLeaveDays" INTEGER NOT NULL DEFAULT 0,
    "unpaidLeaveDays" INTEGER NOT NULL DEFAULT 0,
    "deathLeaveDays" INTEGER NOT NULL DEFAULT 0,
    "unpaidHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "overtimeRegularMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeWeekendDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "penaltyAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "clothingDeduction" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonusAdjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advanceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "insuranceAmount" DECIMAL(14,2),
    "transportAllowanceOverride" DECIMAL(14,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salaries" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "profession" TEXT,
    "baseSalary" DECIMAL(14,2) NOT NULL,
    "lumpSumSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "livingAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "responsibilityAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extraEffortAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "productionIncentive" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "insuranceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "transportAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_advances" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "advanceType" TEXT NOT NULL DEFAULT 'salary',
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "installmentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remainingAmount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_record_history" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deletedBy" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredBy" TEXT,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "deleted_record_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_insurance" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "insuranceSalary" DECIMAL(14,2) NOT NULL,
    "socialSecurityNumber" TEXT,
    "registrationDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_insurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bonuses" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "bonusAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonusReason" TEXT,
    "assistanceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "period" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_penalties" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_penalties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "termination_records" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "terminationDate" DATE NOT NULL,
    "terminationType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "processedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "termination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_settlements" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "settlementDate" DATE NOT NULL,
    "processedBy" TEXT NOT NULL,
    "finalSalaryAmount" DECIMAL(14,2) NOT NULL,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonuses" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalSettlement" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehire_records" (
    "id" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "rehireDate" DATE NOT NULL,
    "processedBy" TEXT NOT NULL,
    "previousTerminationId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rehire_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buses" (
    "id" UUID NOT NULL,
    "busId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "companyDeductionPct" DECIMAL(5,2) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "employeeDeductionPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bus_passengers" (
    "id" UUID NOT NULL,
    "busId" UUID NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT,
    "subscriptionDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bus_passengers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorUsername" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_lockoutUntil_idx" ON "users"("lockoutUntil");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_credentials_userId_keyId_key" ON "biometric_credentials"("userId", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeId_key" ON "employees"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_biometricNumber_key" ON "employees"("biometricNumber");

-- CreateIndex
CREATE UNIQUE INDEX "employees_userId_key" ON "employees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_nationalId_key" ON "employees"("nationalId");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- CreateIndex
CREATE INDEX "employees_name_idx" ON "employees"("name");

-- CreateIndex
CREATE INDEX "employees_createdAt_idx" ON "employees"("createdAt");

-- CreateIndex
CREATE INDEX "employees_status_employeeId_idx" ON "employees"("status", "employeeId");

-- CreateIndex
CREATE INDEX "employees_department_status_idx" ON "employees"("department", "status");

-- CreateIndex
CREATE INDEX "employees_departmentId_idx" ON "employees"("departmentId");

-- CreateIndex
CREATE INDEX "employees_status_createdAt_idx" ON "employees"("status", "createdAt");

-- CreateIndex
CREATE INDEX "employees_department_status_createdAt_idx" ON "employees"("department", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE INDEX "departments_createdAt_idx" ON "departments"("createdAt");

-- CreateIndex
CREATE INDEX "leave_requests_employeeId_idx" ON "leave_requests"("employeeId");

-- CreateIndex
CREATE INDEX "leave_requests_employeeId_status_idx" ON "leave_requests"("employeeId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_leaveType_status_idx" ON "leave_requests"("leaveType", "status");

-- CreateIndex
CREATE INDEX "leave_requests_startDate_endDate_idx" ON "leave_requests"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceId_key" ON "devices"("deviceId");

-- CreateIndex
CREATE INDEX "devices_status_createdAt_idx" ON "devices"("status", "createdAt");

-- CreateIndex
CREATE INDEX "devices_location_status_createdAt_idx" ON "devices"("location", "status", "createdAt");

-- CreateIndex
CREATE INDEX "attendance_records_date_idx" ON "attendance_records"("date");

-- CreateIndex
CREATE INDEX "attendance_records_date_timestamp_idx" ON "attendance_records"("date", "timestamp");

-- CreateIndex
CREATE INDEX "attendance_records_employeeId_timestamp_idx" ON "attendance_records"("employeeId", "timestamp");

-- CreateIndex
CREATE INDEX "attendance_records_date_employeeId_idx" ON "attendance_records"("date", "employeeId");

-- CreateIndex
CREATE INDEX "attendance_records_deviceId_timestamp_idx" ON "attendance_records"("deviceId", "timestamp");

-- CreateIndex
CREATE INDEX "attendance_records_employeeId_type_date_idx" ON "attendance_records"("employeeId", "type", "date");

-- CreateIndex
CREATE INDEX "attendance_records_employeeId_date_timestamp_idx" ON "attendance_records"("employeeId", "date", "timestamp");

-- CreateIndex
CREATE INDEX "attendance_records_type_date_idx" ON "attendance_records"("type", "date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_employeeId_date_idx" ON "daily_attendance_logs"("employeeId", "date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_date_idx" ON "daily_attendance_logs"("date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_employeeId_recordType_date_idx" ON "daily_attendance_logs"("employeeId", "recordType", "date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_recordType_date_idx" ON "daily_attendance_logs"("recordType", "date");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_createdAt_idx" ON "products"("createdAt");

-- CreateIndex
CREATE INDEX "products_status_createdAt_idx" ON "products"("status", "createdAt");

-- CreateIndex
CREATE INDEX "products_category_status_createdAt_idx" ON "products"("category", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_sku_location_key" ON "stock_levels"("sku", "location");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_jobId_key" ON "import_jobs"("jobId");

-- CreateIndex
CREATE INDEX "import_jobs_entity_uploadedAt_idx" ON "import_jobs"("entity", "uploadedAt");

-- CreateIndex
CREATE INDEX "import_jobs_uploadedAt_idx" ON "import_jobs"("uploadedAt");

-- CreateIndex
CREATE INDEX "import_jobs_status_uploadedAt_idx" ON "import_jobs"("status", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_runId_key" ON "payroll_runs"("runId");

-- CreateIndex
CREATE INDEX "payroll_runs_runDate_idx" ON "payroll_runs"("runDate");

-- CreateIndex
CREATE INDEX "payroll_runs_status_runDate_idx" ON "payroll_runs"("status", "runDate");

-- CreateIndex
CREATE INDEX "payroll_runs_approvalStatus_runDate_idx" ON "payroll_runs"("approvalStatus", "runDate");

-- CreateIndex
CREATE INDEX "payroll_runs_periodStart_idx" ON "payroll_runs"("periodStart");

-- CreateIndex
CREATE INDEX "payroll_runs_periodStart_periodEnd_idx" ON "payroll_runs"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "payroll_items_payrollRunId_idx" ON "payroll_items"("payrollRunId");

-- CreateIndex
CREATE INDEX "payroll_items_employeeId_createdAt_idx" ON "payroll_items"("employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_payrollRunId_employeeId_key" ON "payroll_items"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_inputs_periodStart_periodEnd_idx" ON "payroll_inputs"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "payroll_inputs_employeeId_periodStart_idx" ON "payroll_inputs"("employeeId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_inputs_employeeId_periodStart_periodEnd_key" ON "payroll_inputs"("employeeId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salaries_employeeId_key" ON "employee_salaries"("employeeId");

-- CreateIndex
CREATE INDEX "employee_salaries_employeeId_idx" ON "employee_salaries"("employeeId");

-- CreateIndex
CREATE INDEX "employee_advances_employeeId_idx" ON "employee_advances"("employeeId");

-- CreateIndex
CREATE INDEX "employee_advances_employeeId_issueDate_idx" ON "employee_advances"("employeeId", "issueDate");

-- CreateIndex
CREATE INDEX "employee_advances_employeeId_remainingAmount_idx" ON "employee_advances"("employeeId", "remainingAmount");

-- CreateIndex
CREATE INDEX "deleted_record_history_entityType_recordId_idx" ON "deleted_record_history"("entityType", "recordId");

-- CreateIndex
CREATE INDEX "deleted_record_history_entityType_deletedAt_idx" ON "deleted_record_history"("entityType", "deletedAt");

-- CreateIndex
CREATE INDEX "deleted_record_history_entityType_restoredAt_deletedAt_idx" ON "deleted_record_history"("entityType", "restoredAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "employee_insurance_employeeId_key" ON "employee_insurance"("employeeId");

-- CreateIndex
CREATE INDEX "employee_bonuses_employeeId_idx" ON "employee_bonuses"("employeeId");

-- CreateIndex
CREATE INDEX "employee_bonuses_employeeId_period_idx" ON "employee_bonuses"("employeeId", "period");

-- CreateIndex
CREATE INDEX "employee_bonuses_period_createdAt_idx" ON "employee_bonuses"("period", "createdAt");

-- CreateIndex
CREATE INDEX "employee_penalties_employeeId_idx" ON "employee_penalties"("employeeId");

-- CreateIndex
CREATE INDEX "employee_penalties_employeeId_issueDate_idx" ON "employee_penalties"("employeeId", "issueDate");

-- CreateIndex
CREATE INDEX "termination_records_employeeId_idx" ON "termination_records"("employeeId");

-- CreateIndex
CREATE INDEX "termination_records_terminationDate_idx" ON "termination_records"("terminationDate");

-- CreateIndex
CREATE INDEX "termination_records_terminationType_idx" ON "termination_records"("terminationType");

-- CreateIndex
CREATE INDEX "termination_records_processedBy_idx" ON "termination_records"("processedBy");

-- CreateIndex
CREATE INDEX "termination_records_employeeId_terminationDate_idx" ON "termination_records"("employeeId", "terminationDate");

-- CreateIndex
CREATE INDEX "financial_settlements_employeeId_idx" ON "financial_settlements"("employeeId");

-- CreateIndex
CREATE INDEX "financial_settlements_settlementDate_idx" ON "financial_settlements"("settlementDate");

-- CreateIndex
CREATE INDEX "financial_settlements_status_idx" ON "financial_settlements"("status");

-- CreateIndex
CREATE INDEX "financial_settlements_processedBy_idx" ON "financial_settlements"("processedBy");

-- CreateIndex
CREATE INDEX "financial_settlements_employeeId_status_idx" ON "financial_settlements"("employeeId", "status");

-- CreateIndex
CREATE INDEX "rehire_records_employeeId_idx" ON "rehire_records"("employeeId");

-- CreateIndex
CREATE INDEX "rehire_records_rehireDate_idx" ON "rehire_records"("rehireDate");

-- CreateIndex
CREATE INDEX "rehire_records_processedBy_idx" ON "rehire_records"("processedBy");

-- CreateIndex
CREATE INDEX "rehire_records_employeeId_rehireDate_idx" ON "rehire_records"("employeeId", "rehireDate");

-- CreateIndex
CREATE UNIQUE INDEX "buses_busId_key" ON "buses"("busId");

-- CreateIndex
CREATE UNIQUE INDEX "buses_plateNumber_key" ON "buses"("plateNumber");

-- CreateIndex
CREATE INDEX "buses_status_idx" ON "buses"("status");

-- CreateIndex
CREATE INDEX "buses_route_status_idx" ON "buses"("route", "status");

-- CreateIndex
CREATE INDEX "bus_passengers_employeeId_idx" ON "bus_passengers"("employeeId");

-- CreateIndex
CREATE INDEX "bus_passengers_busId_status_idx" ON "bus_passengers"("busId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bus_passengers_busId_employeeId_key" ON "bus_passengers"("busId", "employeeId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_createdAt_idx" ON "audit_logs"("targetType", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetId_idx" ON "audit_logs"("targetId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_credentials" ADD CONSTRAINT "biometric_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_employeeInsuranceId_fkey" FOREIGN KEY ("employeeInsuranceId") REFERENCES "employee_insurance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendance_logs" ADD CONSTRAINT "daily_attendance_logs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_sku_fkey" FOREIGN KEY ("sku") REFERENCES "products"("sku") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_penalties" ADD CONSTRAINT "employee_penalties_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_previousTerminationId_fkey" FOREIGN KEY ("previousTerminationId") REFERENCES "termination_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bus_passengers" ADD CONSTRAINT "bus_passengers_busId_fkey" FOREIGN KEY ("busId") REFERENCES "buses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bus_passengers" ADD CONSTRAINT "bus_passengers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;
