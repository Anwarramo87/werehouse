-- Orphaned employeeId check across key tables

SELECT 'attendance_records' AS table_name, COUNT(*) AS orphaned_count 
FROM attendance_records child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'daily_attendance_logs', COUNT(*) 
FROM daily_attendance_logs child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'leave_requests', COUNT(*) 
FROM leave_requests child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'payroll_items', COUNT(*) 
FROM payroll_items child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'payroll_inputs', COUNT(*) 
FROM payroll_inputs child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'employee_salaries', COUNT(*) 
FROM employee_salaries child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'employee_advances', COUNT(*) 
FROM employee_advances child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'employee_bonuses', COUNT(*) 
FROM employee_bonuses child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'employee_penalties', COUNT(*) 
FROM employee_penalties child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'employee_insurance', COUNT(*) 
FROM employee_insurance child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL

UNION ALL

SELECT 'bus_passengers', COUNT(*) 
FROM bus_passengers child 
LEFT JOIN employees parent ON child."employeeId" = parent."employeeId" 
WHERE parent."employeeId" IS NULL AND child."employeeId" IS NOT NULL;
