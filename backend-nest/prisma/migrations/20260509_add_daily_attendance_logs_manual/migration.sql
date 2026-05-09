-- CreateEnum for DailyRecordType
CREATE TYPE "DailyRecordType" AS ENUM (
  'ABSENCE',
  'DELAY_MINUTES',
  'OVERTIME_MINUTES',
  'PAID_LEAVE',
  'UNPAID_LEAVE',
  'SICK_LEAVE',
  'ADMIN_LEAVE',
  'DEATH_LEAVE',
  'EARLY_LEAVE_MINUTES'
);

-- CreateTable: daily_attendance_logs
CREATE TABLE "daily_attendance_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

-- CreateIndex
CREATE INDEX "daily_attendance_logs_employeeId_date_idx" ON "daily_attendance_logs"("employeeId", "date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_date_idx" ON "daily_attendance_logs"("date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_employeeId_recordType_date_idx" ON "daily_attendance_logs"("employeeId", "recordType", "date");

-- CreateIndex
CREATE INDEX "daily_attendance_logs_recordType_date_idx" ON "daily_attendance_logs"("recordType", "date");

-- AddForeignKey
ALTER TABLE "daily_attendance_logs" ADD CONSTRAINT "daily_attendance_logs_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;
