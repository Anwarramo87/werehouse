-- Manual termination management tables migration
-- Reason: Add new tables for termination records, financial settlements, and rehire history
-- Task: 1.2 Create new database tables for termination records
-- Requirements: 1.3, 2.5, 5.7, 6.5

-- Create termination_records table
CREATE TABLE IF NOT EXISTS "termination_records" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" TEXT NOT NULL,
  "termination_date" DATE NOT NULL,
  "termination_type" TEXT NOT NULL CHECK ("termination_type" IN ('resignation', 'termination')),
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "processed_by" TEXT NOT NULL,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create financial_settlements table
CREATE TABLE IF NOT EXISTS "financial_settlements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" TEXT NOT NULL,
  "settlement_date" DATE NOT NULL,
  "processed_by" TEXT NOT NULL,
  "final_salary_amount" DECIMAL(14,2) NOT NULL,
  "deductions" DECIMAL(14,2) DEFAULT 0,
  "bonuses" DECIMAL(14,2) DEFAULT 0,
  "total_settlement" DECIMAL(14,2) NOT NULL,
  "status" TEXT DEFAULT 'completed' CHECK ("status" IN ('pending', 'completed')),
  "notes" TEXT,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create rehire_records table
CREATE TABLE IF NOT EXISTS "rehire_records" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" TEXT NOT NULL,
  "rehire_date" DATE NOT NULL,
  "processed_by" TEXT NOT NULL,
  "previous_termination_id" UUID,
  "notes" TEXT,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraints
ALTER TABLE "termination_records" 
  ADD CONSTRAINT "termination_records_employee_id_fkey" 
  FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE;

ALTER TABLE "financial_settlements" 
  ADD CONSTRAINT "financial_settlements_employee_id_fkey" 
  FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE;

ALTER TABLE "rehire_records" 
  ADD CONSTRAINT "rehire_records_employee_id_fkey" 
  FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE;

ALTER TABLE "rehire_records" 
  ADD CONSTRAINT "rehire_records_previous_termination_id_fkey" 
  FOREIGN KEY ("previous_termination_id") REFERENCES "termination_records"("id") ON DELETE SET NULL;

-- Add indexes for performance optimization
CREATE INDEX IF NOT EXISTS "termination_records_employee_id_idx" 
  ON "termination_records" ("employee_id");

CREATE INDEX IF NOT EXISTS "termination_records_termination_date_idx" 
  ON "termination_records" ("termination_date");

CREATE INDEX IF NOT EXISTS "termination_records_termination_type_idx" 
  ON "termination_records" ("termination_type");

CREATE INDEX IF NOT EXISTS "termination_records_processed_by_idx" 
  ON "termination_records" ("processed_by");

CREATE INDEX IF NOT EXISTS "financial_settlements_employee_id_idx" 
  ON "financial_settlements" ("employee_id");

CREATE INDEX IF NOT EXISTS "financial_settlements_settlement_date_idx" 
  ON "financial_settlements" ("settlement_date");

CREATE INDEX IF NOT EXISTS "financial_settlements_status_idx" 
  ON "financial_settlements" ("status");

CREATE INDEX IF NOT EXISTS "financial_settlements_processed_by_idx" 
  ON "financial_settlements" ("processed_by");

CREATE INDEX IF NOT EXISTS "rehire_records_employee_id_idx" 
  ON "rehire_records" ("employee_id");

CREATE INDEX IF NOT EXISTS "rehire_records_rehire_date_idx" 
  ON "rehire_records" ("rehire_date");

CREATE INDEX IF NOT EXISTS "rehire_records_processed_by_idx" 
  ON "rehire_records" ("processed_by");

-- Add composite indexes for common queries
CREATE INDEX IF NOT EXISTS "termination_records_employee_date_idx" 
  ON "termination_records" ("employee_id", "termination_date");

CREATE INDEX IF NOT EXISTS "financial_settlements_employee_status_idx" 
  ON "financial_settlements" ("employee_id", "status");

CREATE INDEX IF NOT EXISTS "rehire_records_employee_date_idx" 
  ON "rehire_records" ("employee_id", "rehire_date");

-- Add updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at columns
CREATE TRIGGER update_termination_records_updated_at 
  BEFORE UPDATE ON "termination_records" 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_financial_settlements_updated_at 
  BEFORE UPDATE ON "financial_settlements" 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rehire_records_updated_at 
  BEFORE UPDATE ON "rehire_records" 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();