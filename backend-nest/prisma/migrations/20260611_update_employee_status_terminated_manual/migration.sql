-- Manual data migration: set employees.status = 'terminated' for resignation this month + old resignations
-- and set daily hours to 9 for all employees.

BEGIN;

-- 1) Update daily hours for all employees
UPDATE "employees"
SET "hoursPerDay" = 9;

-- 2) Update status for resigned employees
-- Requirement: change only for employees who are in the target department.
-- We DON’T delete any data; this is an UPDATE only.
-- Target departments (as per your message):
--   - "المستقيليم القدماء"
--   - "مستقيلين هذا الشهر"

UPDATE "employees"
SET "status" = 'terminated'
WHERE "terminationType" = 'resignation'
  AND "terminationDate" IS NOT NULL
  AND "department" IN ('المستقيليم القدماء', 'مستقيلين هذا الشهر')
  AND (
    -- this month
    ("terminationDate" >= date_trunc('month', CURRENT_DATE)::date AND "terminationDate" < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date)
    OR
    -- old (before this month)
    ("terminationDate" < date_trunc('month', CURRENT_DATE)::date)
  );

COMMIT;


