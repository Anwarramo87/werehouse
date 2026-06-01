-- CreateTable
CREATE TABLE "termination_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" TEXT NOT NULL,
    "termination_date" DATE NOT NULL,
    "termination_type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "processed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "termination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" TEXT NOT NULL,
    "settlement_date" DATE NOT NULL,
    "processed_by" TEXT NOT NULL,
    "final_salary_amount" DECIMAL(14,2) NOT NULL,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bonuses" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_settlement" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehire_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" TEXT NOT NULL,
    "rehire_date" DATE NOT NULL,
    "processed_by" TEXT NOT NULL,
    "previous_termination_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rehire_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "termination_records_employee_id_idx" ON "termination_records"("employee_id");

-- CreateIndex
CREATE INDEX "termination_records_termination_date_idx" ON "termination_records"("termination_date");

-- CreateIndex
CREATE INDEX "termination_records_termination_type_idx" ON "termination_records"("termination_type");

-- CreateIndex
CREATE INDEX "termination_records_processed_by_idx" ON "termination_records"("processed_by");

-- CreateIndex
CREATE INDEX "termination_records_employee_id_termination_date_idx" ON "termination_records"("employee_id", "termination_date");

-- CreateIndex
CREATE INDEX "financial_settlements_employee_id_idx" ON "financial_settlements"("employee_id");

-- CreateIndex
CREATE INDEX "financial_settlements_settlement_date_idx" ON "financial_settlements"("settlement_date");

-- CreateIndex
CREATE INDEX "financial_settlements_status_idx" ON "financial_settlements"("status");

-- CreateIndex
CREATE INDEX "financial_settlements_processed_by_idx" ON "financial_settlements"("processed_by");

-- CreateIndex
CREATE INDEX "financial_settlements_employee_id_status_idx" ON "financial_settlements"("employee_id", "status");

-- CreateIndex
CREATE INDEX "rehire_records_employee_id_idx" ON "rehire_records"("employee_id");

-- CreateIndex
CREATE INDEX "rehire_records_rehire_date_idx" ON "rehire_records"("rehire_date");

-- CreateIndex
CREATE INDEX "rehire_records_processed_by_idx" ON "rehire_records"("processed_by");

-- CreateIndex
CREATE INDEX "rehire_records_employee_id_rehire_date_idx" ON "rehire_records"("employee_id", "rehire_date");

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_settlements" ADD CONSTRAINT "financial_settlements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehire_records" ADD CONSTRAINT "rehire_records_previous_termination_id_fkey" FOREIGN KEY ("previous_termination_id") REFERENCES "termination_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;