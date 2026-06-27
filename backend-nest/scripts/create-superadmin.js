/**
 * Create Superadmin Account
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const ADMIN_PERMISSIONS = [
  'manage_users',
  'manage_advances',
  'edit_attendance',
  'view_attendance',
  'run_payroll',
  'view_payroll',
  'edit_employees',
  'view_employees',
  'manage_bonuses',
  'manage_penalties',
  'manage_leaves',
  'manage_insurance',
  'manage_transportation',
  'manage_inventory',
  'manage_departments',
  'manage_salary',
  'manage_payroll',
  'manage_finances',
  'manage_files',
  'manage_imports',
  'manage_trash',
  'manage_backup',
  'manage_devices',
  'manage_dashboard',
];

async function main() {
  console.log('--- Create Superadmin ---\n');

  // 1. Ensure admin role exists
  let adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
  if (!adminRole) {
    adminRole = await prisma.role.create({
      data: { name: 'admin', permissions: ADMIN_PERMISSIONS },
    });
    console.log('  Created admin role');
  } else {
    // Update permissions on existing role
    adminRole = await prisma.role.update({
      where: { name: 'admin' },
      data: { permissions: ADMIN_PERMISSIONS },
    });
    console.log('  Admin role updated with full permissions');
  }

  const username = process.env.SUPERADMIN_USERNAME || 'superadmin';
  const email = process.env.SUPERADMIN_EMAIL || 'superadmin@warehouse.local';
  const password = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@2026!';

  // 2. Check if superadmin already exists
  let user = await prisma.user.findUnique({ where: { username } });

  if (user) {
    // Update password and role
    const hash = await bcrypt.hash(password, 10);
    user = await prisma.user.update({
      where: { username },
      data: { passwordHash: hash, roleId: adminRole.id, status: 'active' },
    });
    console.log(`  Superadmin "${username}" updated (password reset, role set to admin)`);
  } else {
    // Create superadmin
    const hash = await bcrypt.hash(password, 10);
    user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash: hash,
        roleId: adminRole.id,
        status: 'active',
      },
    });
    console.log(`  Superadmin "${username}" created`);
  }

  console.log('\n--- Superadmin Credentials ---');
  console.log(`  Username: ${username}`);
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Role:     admin (full permissions)`);
  console.log('\nDone!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
