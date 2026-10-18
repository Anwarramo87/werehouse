// Read-only production inspection: table row counts + tenants + users (no passwords printed).
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: 'C:/Users/BootCamp/Downloads/anwarfinly/back/werehouse/backend-nest/.env' });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const pool = new Pool({ connectionString: url });

const TABLES = [
  'users', 'roles', 'tenants', 'tenant_entitlements', 'user_entitlements', 'tenant_subscriptions',
  'employees', 'departments', 'attendance_records', 'daily_attendance_logs', 'leave_requests', 'biometric_credentials',
  'employee_salaries', 'payroll_runs', 'payroll_items', 'payroll_inputs', 'employee_advances',
  'employee_bonus', 'employee_penalties', 'employee_insurance', 'termination_records',
  'products', 'product_batches', 'stock_levels', 'stock_movements', 'warehouses',
  'suppliers', 'purchase_orders', 'purchase_order_items', 'goods_receipts', 'purchase_invoices',
  'customers', 'sales_orders', 'sales_invoices', 'sales_payments', 'delivery_notes',
  'accounts', 'journal_entries',
  'bus', 'bus_passengers',
  'boms', 'production_orders',
  'representatives', 'rep_sales',
  'audit_logs', 'system_settings', 'custom_field_definitions', 'tax_rates', 'integration_connections',
  'cycles_counts_placeholder',
];

const text = async (sql, params) => (await pool.query(sql, params)).rows;

(async () => {
  const exists = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  const have = new Set(exists.rows.map(r => r.table_name));

  console.log('=========== TABLE COUNTS ===========');
  for (const t of TABLES) {
    if (!have.has(t)) continue;
    try {
      const r = await pool.query(`SELECT count(*)::int AS c FROM "${t}"`);
      console.log(`${r.rows[0].c}`.padStart(10) + `  ${t}`);
    } catch (e) {
      console.log(`ERR       ${t}: ${e.message}`);
    }
  }

  console.log('\n=========== ROLES ===========');
  const roles = await text(`SELECT name, array_length(permissions,1) AS perms FROM roles ORDER BY name`);
  roles.forEach(r => console.log(`${r.name}  (perms: ${r.perms ?? 0})`));

  console.log('\n=========== TENANTS ===========');
  for (const t of await text(`SELECT id, name, code, status, "createdAt" FROM tenants ORDER BY "createdAt"`)) {
    console.log(`${t.id}  ${t.name}  (${t.code}) [${t.status}] created ${String(t."createdAt")}`);
  }

  console.log('\n=========== USERS ===========');
  const users = await text(`
    SELECT u.username, u.email, u.status, u.tenant_id, r.name AS role, t.name AS tenant_name, u."createdAt"
    FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id
    ORDER BY u."createdAt"`);
  for (const u of users) {
    console.log(`${u.username}  role=${u.role ?? '—'}  tenant=${u.tenant_name ?? '(SUPERADMIN)' }  status=${u.status}`);
  }

  console.log('\n=========== DB NAME ===========');
  console.log(pool.database);

  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
