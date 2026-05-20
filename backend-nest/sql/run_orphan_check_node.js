const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set in environment or .env');
  process.exit(2);
}

const sql = `
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
`;

(async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(sql);
    const rows = res.rows;
    const csvPath = path.join(__dirname, 'orphan_employeeid_check_results.csv');
    const header = 'table_name,orphaned_count\n';
    const csv = header + rows.map(r => `${r.table_name},${r.orphaned_count}`).join('\n') + '\n';
    fs.writeFileSync(csvPath, csv);
    console.log('Results saved to', csvPath);
    console.table(rows);
    process.exit(0);
  } catch (err) {
    console.error('Error executing query:', err.message || err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {};
  }
})();
