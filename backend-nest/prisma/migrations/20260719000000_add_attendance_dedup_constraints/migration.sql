-- ===========================================================================
-- Prevent duplicate attendance punches and duplicate daily attendance logs.
--
-- AttendanceRecord: a duplicate punch (same employee + timestamp + type) can be
-- created by concurrent biometric syncs / manual edits because de-duplication
-- was only done in application code (a non-atomic read-then-write). We first
-- collapse existing duplicates (keeping the earliest recorded row per group),
-- then add a unique index so the DB itself rejects future duplicates.
--
-- DailyAttendanceLog: aggregateEmployeeDay does deleteMany(source:'calculated')
-- + create. Under concurrency two runs could double-insert. A unique index on
-- (employeeId, date, recordType, source) makes that idempotent. Current data
-- has zero duplicates on this key, so only the index is added.
-- ===========================================================================

-- 1) De-duplicate attendance_records, keeping the earliest createdAt per
--    (employeeId, timestamp, type). Safe: identical punches collapse to one.
DELETE FROM "attendance_records"
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY "employeeId", "timestamp", "type"
        ORDER BY "createdAt" ASC, "id" ASC
      ) AS rn
    FROM "attendance_records"
  ) t
  WHERE rn > 1
);

-- 2) Enforce uniqueness at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_records_employeeId_timestamp_type_key"
  ON "attendance_records" ("employeeId", "timestamp", "type");

-- 3) Make daily attendance log aggregation idempotent under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS "daily_attendance_logs_employeeId_date_recordType_source_key"
  ON "daily_attendance_logs" ("employeeId", "date", "recordType", "source");
