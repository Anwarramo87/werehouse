-- ===========================================================================
-- Performance indexes for the hot payroll fan-out queries.
--
-- These are additive, non-blocking CREATE INDEX CONCURRENTLY-free builds
-- (Prisma runs migrations in a transaction; for very large tables prefer
-- running the CONCURRENTLY variants manually, but the table sizes here are
-- small enough that a transactional build is safe and atomic).
-- ===========================================================================

-- payroll_items: getEmployeeHistory filters by employeeId + order by createdAt.
CREATE INDEX IF NOT EXISTS "payroll_items_employeeId_createdAt_idx"
  ON "payroll_items" ("employeeId", "createdAt");

-- leave_requests: payroll batches by employeeId + status + date range.
CREATE INDEX IF NOT EXISTS "leave_requests_employeeId_status_startDate_endDate_idx"
  ON "leave_requests" ("employeeId", "status", "startDate", "endDate");

-- employee_bonuses: payroll batches by employeeId + createdAt range.
CREATE INDEX IF NOT EXISTS "employee_bonuses_employeeId_createdAt_idx"
  ON "employee_bonuses" ("employeeId", "createdAt");
