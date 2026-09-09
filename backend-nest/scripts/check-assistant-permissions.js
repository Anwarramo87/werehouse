/**
 * Read-only diagnostic: lists roles and their permissions, then users with
 * their role and tenant, so an assistant 403 can be traced to its cause
 * (missing view_* permission, or a user without a factory/tenantId).
 *
 * Usage: node scripts/check-assistant-permissions.js
 */
require('dotenv/config');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ASSISTANT_PERMISSIONS = [
  'view_employees',
  'view_attendance',
  'view_payroll',
  'view_inventory',
  'view_sales',
  'view_purchasing',
];

async function main() {
  const roles = await pool.query(
    'SELECT name, description, permissions FROM roles ORDER BY name',
  );
  console.log('=== الأدوار (roles) ===');
  for (const r of roles.rows) {
    const perms = r.permissions || [];
    const canUseAssistant = perms.some((p) => ASSISTANT_PERMISSIONS.includes(p));
    console.log(
      `- ${r.name}: [${perms.join(', ')}]` +
        (canUseAssistant ? '  ✅ يستطيع فتح المساعد' : '  ❌ لا يستطيع فتح المساعد'),
    );
  }

  const users = await pool.query(`
    SELECT u.username, u.status, (u."tenantId" IS NULL) AS no_tenant,
           r.name AS role
    FROM users u
    LEFT JOIN roles r ON u."roleId" = r.id
    ORDER BY u.username
  `);
  console.log('\n=== المستخدمون (users) ===');
  for (const u of users.rows) {
    console.log(
      `- ${u.username} | الدور: ${u.role ?? '—'} | الحالة: ${u.status}` +
        ` | مصنع: ${u.no_tenant ? 'لا يوجد (سوبر أدمن?)' : 'مرتبط بمصنع ✅'}`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error('فشل الفحص:', e.message);
  process.exit(1);
});
