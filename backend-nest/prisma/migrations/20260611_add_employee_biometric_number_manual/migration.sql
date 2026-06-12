ALTER TABLE "employees"
ADD COLUMN IF NOT EXISTS "biometricNumber" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_biometricNumber_key"
ON "employees"("biometricNumber");
