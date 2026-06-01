-- Migration: 20260601_add_hourly_leave_fields
-- Description: إضافة حقول الإجازة الساعية (isHourly, startTime, endTime) لجدول leave_requests

ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "isHourly"  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "startTime" TEXT,
  ADD COLUMN IF NOT EXISTS "endTime"   TEXT;

-- index لتسريع الاستعلام عن الإجازات الساعية
CREATE INDEX IF NOT EXISTS "leave_requests_isHourly_idx"
  ON "leave_requests" ("isHourly");
