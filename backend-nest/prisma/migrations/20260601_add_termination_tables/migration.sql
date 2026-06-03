-- Create termination_records table
CREATE TABLE IF NOT EXISTS "termination_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" TEXT NOT NULL,
    "terminationDate" DATE NOT NULL,
    "terminationType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "processedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "termination_records_pkey" PRIMARY KEY ("id")
);

-- Create financial_settlements table
CREATE TABLE IF NOT EXISTS "financial_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "financial_settlements_pkey" PRIMARY KEY ("id")
);

-- Create rehire_records table
CREATE TABLE IF NOT EXISTS "rehire_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" TEXT NOT NULL,
    "rehireDate" DATE NOT NULL,
    "processedBy" TEXT NOT NULL,
    "previousTerminationId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rehire_records_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraints
ALTER TABLE "termination_records"
  ADD CONSTRAINT "termination_records_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "financial_settlements"
  ADD CONSTRAINT "financial_settlements_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rehire_records"
  ADD CONSTRAINT "rehire_records_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rehire_records"
  ADD CONSTRAINT "rehire_records_previousTerminationId_fkey"
  FOREIGN KEY ("previousTerminationId") REFERENCES "termination_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add new columns to employees table
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "terminationType" TEXT,
  ADD COLUMN IF NOT EXISTS "terminationNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "financialSettlementStatus" TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "financialSettlementDate" DATE,
  ADD COLUMN IF NOT EXISTS "rehireDate" DATE,
  ADD COLUMN IF NOT EXISTS "isFinanciallySettled" BOOLEAN DEFAULT FALSE;

-- Update existing employees with default values
UPDATE "employees" 
SET "financialSettlementStatus" = 'pending', "isFinanciallySettled" = FALSE 
WHERE "financialSettlementStatus" IS NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS "employees_terminationType_idx" ON "employees" ("terminationType");
CREATE INDEX IF NOT EXISTS "employees_financialSettlementStatus_idx" ON "employees" ("financialSettlementStatus");
CREATE INDEX IF NOT EXISTS "employees_terminationDate_idx" ON "employees" ("terminationDate");
CREATE INDEX IF NOT EXISTS "employees_status_terminationDate_idx" ON "employees" ("status", "terminationDate");
CREATE INDEX IF NOT EXISTS "employees_financialSettlementStatus_date_idx" ON "employees" ("financialSettlementStatus", "financialSettlementDate");

CREATE INDEX IF NOT EXISTS "termination_records_employeeId_idx" ON "termination_records" ("employeeId");
CREATE INDEX IF NOT EXISTS "termination_records_terminationDate_idx" ON "termination_records" ("terminationDate");
CREATE INDEX IF NOT EXISTS "financial_settlements_employeeId_idx" ON "financial_settlements" ("employeeId");
CREATE INDEX IF NOT EXISTS "financial_settlements_settlementDate_idx" ON "financial_settlements" ("settlementDate");
CREATE INDEX IF NOT EXISTS "rehire_records_employeeId_idx" ON "rehire_records" ("employeeId");
CREATE INDEX IF NOT EXISTS "rehire_records_rehireDate_idx" ON "rehire_records" ("rehireDate");