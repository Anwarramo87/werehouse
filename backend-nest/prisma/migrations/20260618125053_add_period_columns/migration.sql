-- AlterTable
ALTER TABLE "employee_advances" ADD COLUMN     "period" TEXT;

-- AlterTable
ALTER TABLE "employee_penalties" ADD COLUMN     "period" TEXT;

-- CreateIndex
CREATE INDEX "employee_advances_employeeId_period_idx" ON "employee_advances"("employeeId", "period");

-- CreateIndex
CREATE INDEX "employee_advances_period_createdAt_idx" ON "employee_advances"("period", "createdAt");

-- CreateIndex
CREATE INDEX "employee_penalties_employeeId_period_idx" ON "employee_penalties"("employeeId", "period");

-- CreateIndex
CREATE INDEX "employee_penalties_period_createdAt_idx" ON "employee_penalties"("period", "createdAt");
