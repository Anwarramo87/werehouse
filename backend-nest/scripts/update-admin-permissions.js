/**
 * Update admin role permissions to include manage_trash and manage_backups
 * Usage: node scripts/update-admin-permissions.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const NEW_PERMISSIONS = ['manage_trash', 'manage_backups'];

async function main() {
  const adminRole = await prisma.role.findFirst({
    where: { name: 'admin' },
  });

  if (!adminRole) {
    console.log('Admin role not found — skipping');
    return;
  }

  const currentPermissions = adminRole.permissions || [];
  const missing = NEW_PERMISSIONS.filter((p) => !currentPermissions.includes(p));

  if (missing.length === 0) {
    console.log('Admin role already has all new permissions');
    return;
  }

  const updatedPermissions = [...currentPermissions, ...missing];

  await prisma.role.update({
    where: { id: adminRole.id },
    data: { permissions: updatedPermissions },
  });

  console.log(`Added ${missing.length} permissions to admin role: ${missing.join(', ')}`);
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
