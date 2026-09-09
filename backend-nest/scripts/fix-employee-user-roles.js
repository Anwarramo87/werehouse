/**
 * One-off repair: tenant-scoped users whose roleId is NULL cannot pass
 * PermissionsGuard on any guarded endpoint (permissions come only from the
 * role), which is why the assistant answers 403 for them. Assigns the
 * default `staff` role -- the same fallback imports.service.ts applies to
 * users without one -- then prints exactly what it changed.
 *
 * Idempotent: only touches users with roleId IS NULL and a tenantId, so
 * re-running it is harmless. Superadmin is intentionally out of scope: the
 * assistant requires a factory (tenantId) that a superadmin deliberately
 * does not hold -- sign in as a factory user to use it.
 *
 * Usage: node scripts/fix-employee-user-roles.js
 */
require('dotenv/config');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const staffRole = await pool.query(
    "SELECT id, name, permissions FROM roles WHERE name = 'staff'",
  );
  if (!staffRole.rows.length) {
    throw new Error("لم يتم العثور على دور 'staff' في قاعدة البيانات");
  }
  const role = staffRole.rows[0];

  const orphans = await pool.query(`
    SELECT username FROM users
    WHERE "roleId" IS NULL AND "tenantId" IS NOT NULL
    ORDER BY username
  `);

  if (!orphans.rows.length) {
    console.log('لا يوجد مستخدمون بلا دور — لا شيء لتعديله.');
    await pool.end();
    return;
  }

  console.log('مستخدمون بلا دور (قبل الإصلاح):');
  for (const u of orphans.rows) console.log(`  - ${u.username}`);

  const updated = await pool.query(
    `UPDATE users
     SET "roleId" = $1, "updatedAt" = NOW()
     WHERE "roleId" IS NULL AND "tenantId" IS NOT NULL
     RETURNING username`,
    [role.id],
  );

  console.log(`\nتم إسناد دور "${role.name}" إلى ${updated.rows.length} مستخدم:`);
  for (const u of updated.rows) console.log(`  - ${u.username}`);
  console.log(`صلاحيات الدور: [${(role.permissions || []).join(', ')}]`);

  await pool.end();
}

main().catch((e) => {
  console.error('فشل الإصلاح:', e.message);
  process.exit(1);
});
