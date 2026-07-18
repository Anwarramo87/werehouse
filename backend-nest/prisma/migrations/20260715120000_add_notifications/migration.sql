-- Create notifications system: enum types + notifications table.

-- Enums (idempotent create)
DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM (
    'CHECK_IN', 'CHECK_OUT', 'BONUS', 'PENALTY', 'ADVANCE',
    'LEAVE', 'TERMINATION', 'RESIGNATION', 'LATE', 'ABSENT'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationSeverity" AS ENUM (
    'INFO', 'SUCCESS', 'WARNING', 'DANGER'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "type" "NotificationType" NOT NULL,
  "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "employeeId" TEXT,
  "employeeName" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "metadata" JSONB,
  "dedupeKey" TEXT,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "readAt" TIMESTAMP(3),
  "isDismissed" BOOLEAN NOT NULL DEFAULT false,
  "dismissedAt" TIMESTAMP(3),
  "dismissedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on dedupeKey (NULL values are not considered duplicates)
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications" ("dedupeKey");

-- Indexes
CREATE INDEX "notifications_isRead_createdAt_idx" ON "notifications" ("isRead", "createdAt");
CREATE INDEX "notifications_isDismissed_type_idx" ON "notifications" ("isDismissed", "type");
CREATE INDEX "notifications_type_createdAt_idx" ON "notifications" ("type", "createdAt");
CREATE INDEX "notifications_employeeId_idx" ON "notifications" ("employeeId");
