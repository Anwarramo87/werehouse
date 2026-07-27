ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "transportAllowanceOverride" DECIMAL(14, 2);
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "insuranceAmount" DECIMAL(14, 2);
