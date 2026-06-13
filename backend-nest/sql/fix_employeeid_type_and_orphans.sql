-- =============================================================================
-- Migration: Fix employeeId type mismatch + orphan cleanup
-- Issue #1: Remove @db.Uuid annotation from employee_bonuses & employee_penalties
-- Issue #2: Delete orphan records that have no matching employee
-- =============================================================================

BEGIN;

-- ─── Step 1: Delete orphan records BEFORE altering column types ──────────────
-- These records have employeeId values that don't exist in the employees table

-- Orphan payroll_inputs (no FK existed before, so orphans may exist)
DELETE FROM payroll_inputs
WHERE employee_id NOT IN (SELECT employee_id FROM employees)
  AND employee_id IS NOT NULL;

-- Orphan employee_salaries
DELETE FROM employee_salaries
WHERE employee_id NOT IN (SELECT employee_id FROM employees)
  AND employee_id IS NOT NULL;

-- Orphan employee_penalties
DELETE FROM employee_penalties
WHERE employee_id NOT IN (SELECT employee_id FROM employees)
  AND employee_id IS NOT NULL;

-- Orphan employee_bonuses
DELETE FROM employee_bonuses
WHERE employee_id NOT IN (SELECT employee_id FROM employees)
  AND employee_id IS NOT NULL;

-- Orphan employee_advances
DELETE FROM employee_advances
WHERE employee_id NOT IN (SELECT employee_id FROM employees)
  AND employee_id IS NOT NULL;

-- ─── Step 2: Alter column types from UUID to TEXT ───────────────────────────
-- The @db.Uuid annotation was incorrect; employeeId is a text field (e.g. EMP001)

-- Fix employee_bonuses.employee_id: uuid → text
ALTER TABLE employee_bonuses
  ALTER COLUMN employee_id TYPE TEXT USING employee_id::TEXT;

-- Fix employee_penalties.employee_id: uuid → text
ALTER TABLE employee_penalties
  ALTER COLUMN employee_id TYPE TEXT USING employee_id::TEXT;

-- ─── Step 3: Add missing FK constraints ─────────────────────────────────────
-- PayrollInput had no FK to Employee — this prevented cascade deletes
-- and allowed orphan inserts

-- Add FK for payroll_inputs → employees
ALTER TABLE payroll_inputs
  ADD CONSTRAINT payroll_inputs_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
  ON DELETE CASCADE;

-- ─── Step 4: Verify cleanup ─────────────────────────────────────────────────
-- Run these SELECTs after migration to confirm no orphans remain

-- SELECT 'payroll_inputs orphans' AS check_name, COUNT(*) AS count
-- FROM payroll_inputs pi
-- LEFT JOIN employees e ON pi.employee_id = e.employee_id
-- WHERE e.employee_id IS NULL;

-- SELECT 'employee_salaries orphans' AS check_name, COUNT(*) AS count
-- FROM employee_salaries es
-- LEFT JOIN employees e ON es.employee_id = e.employee_id
-- WHERE e.employee_id IS NULL;

-- SELECT 'employee_bonuses orphans' AS check_name, COUNT(*) AS count
-- FROM employee_bonuses eb
-- LEFT JOIN employees e ON eb.employee_id = e.employee_id
-- WHERE e.employee_id IS NULL;

-- SELECT 'employee_penalties orphans' AS check_name, COUNT(*) AS count
-- FROM employee_penalties ep
-- LEFT JOIN employees e ON ep.employee_id = e.employee_id
-- WHERE e.employee_id IS NULL;

COMMIT;
