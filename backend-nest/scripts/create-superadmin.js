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
  'view_employees', 'edit_employees', 'delete_employees',
  'view_devices', 'manage_devices',
  'manage_users', 'manage_roles',
  'view_attendance', 'edit_attendance',
  'view_payroll', 'run_payroll', 'approve_payroll',
  'view_inventory', 'edit_inventory',
  'view_imports', 'run_imports',
  'manage_salary', 'manage_advances', 'manage_insurance',
  'manage_bonuses', 'manage_penalties',
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
    console.log('  Admin role already exists');
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
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
