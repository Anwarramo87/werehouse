-- Manual employee resignation management fields migration
-- Reason: Add missing resignation management fields for employee termination workflow
-- Task: 1.1 Create database migration for employee table modifications
-- Requirements: 1.3, 2.5, 5.5, 6.6

-- Add new columns for employee resignation management
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "termination_type" TEXT;

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "termination_notes" TEXT;

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "financial_settlement_status" TEXT DEFAULT 'pending';

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "financial_settlement_date" DATE;

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "rehire_date" DATE;

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "is_financially_settled" BOOLEAN DEFAULT FALSE;

-- Add indexes for performance optimization
CREATE INDEX IF NOT EXISTS "employees_termination_type_idx" 
  ON "employees" ("termination_type");

CREATE INDEX IF NOT EXISTS "employees_financial_settlement_status_idx" 
  ON "employees" ("financial_settlement_status");

CREATE INDEX IF NOT EXISTS "employees_termination_date_idx" 
  ON "employees" ("terminationDate");

CREATE INDEX IF NOT EXISTS "employees_status_termination_date_idx" 
  ON "employees" ("status", "terminationDate");

CREATE INDEX IF NOT EXISTS "employees_financial_settlement_status_date_idx" 
  ON "employees" ("financial_settlement_status", "financial_settlement_date");

-- Update existing employees to have proper default values
UPDATE "employees" 
SET "financial_settlement_status" = 'pending', 
    "is_financially_settled" = FALSE 
WHERE "financial_settlement_status" IS NULL;

-- Add check constraints for data integrity
ALTER TABLE "employees" 
  ADD CONSTRAINT "employees_termination_type_check" 
  CHECK ("termination_type" IN ('resignation', 'termination') OR "termination_type" IS NULL);

ALTER TABLE "employees" 
  ADD CONSTRAINT "employees_financial_settlement_status_check" 
  CHECK ("financial_settlement_status" IN ('pending', 'completed'));

-- Add constraint to ensure termination_type is set when terminationDate is set
ALTER TABLE "employees" 
  ADD CONSTRAINT "employees_termination_consistency_check" 
  CHECK (
    ("terminationDate" IS NULL AND "termination_type" IS NULL) OR 
    ("terminationDate" IS NOT NULL AND "termination_type" IS NOT NULL)
  );