const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set in environment or .env');
  process.exit(2);
}

const queries = [
  {
    name: 'payroll_inputs',
    sql: `SELECT 'payroll_inputs' AS source_table, "employeeId", "periodStart", "periodEnd", "penaltyAmount"
FROM payroll_inputs 
WHERE "employeeId" NOT IN (SELECT "employeeId" FROM employees)
LIMIT 20;`
  },
  {
    name: 'employee_salaries',
    sql: `SELECT 'employee_salaries' AS source_table, "employeeId", "baseSalary" AS "baseSalary", NULL::numeric AS "monthlySalary"
FROM employee_salaries 
WHERE "employeeId" NOT IN (SELECT "employeeId" FROM employees)
LIMIT 20;`
  },
  {
    name: 'employee_penalties',
    sql: `SELECT 'employee_penalties' AS source_table, "employeeId", "amount", "issueDate", "category"
FROM employee_penalties 
WHERE "employeeId" NOT IN (SELECT "employeeId" FROM employees)
LIMIT 20;`
  }
];

(async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    for (const q of queries) {
      const res = await client.query(q.sql);
      const rows = res.rows;
      console.log(`\n--- ${q.name} (rows: ${rows.length}) ---`);
      console.table(rows);
      const csvPath = path.join(__dirname, `${q.name}_orphans_examples.csv`);
      if (rows.length > 0) {
        const headers = Object.keys(rows[0]);
        const csv = headers.join(',') + '\n' + rows.map(r => headers.map(h => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          return typeof v === 'string' && v.includes(',') ? '"' + v.replace(/"/g,'""') + '"' : v.toString();
        }).join(',')).join('\n') + '\n';
        fs.writeFileSync(csvPath, csv);
        console.log('Saved:', csvPath);
      } else {
        fs.writeFileSync(csvPath, '');
        console.log('Saved (empty):', csvPath);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {};
  }
})();
