#!/usr/bin/env node
'use strict';

/**
 * reset-and-seed.js
 *
 * يمسح كل البيانات من الداتا بيز ويبدأ من الصفر مع:
 *   - tenant افتراضي (default)
 *   - role: superadmin, admin
 *   - مستخدم superadmin (بدون tenant — يرى كل شيء)
 *   - مستخدم admin مربوط بالـ tenant الافتراضي
 *
 * الاستخدام:
 *   node scripts/reset-and-seed.js
 *
 * متغيرات البيئة المطلوبة:
 *   DATABASE_URL
 *   SUPERADMIN_PASSWORD  (اختياري — افتراضي: SuperAdmin@2026!)
 *   ADMIN_BOOTSTRAP_PASSWORD (اختياري — افتراضي: Admin@2026!)
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@2026!';
const ADMIN_PASSWORD      = process.env.ADMIN_BOOTSTRAP_PASSWORD || 'Admin@2026!';

const ALL_PERMISSIONS = [
  'view_employees', 'edit_employees', 'delete_employees',
  'view_devices', 'manage_devices',
  'manage_users', 'manage_roles', 'manage_tenants',
  'view_attendance', 'edit_attendance',
  'view_payroll', 'run_payroll', 'approve_payroll',
  'view_inventory', 'edit_inventory',
  'view_imports', 'run_imports',
  'manage_salary', 'manage_advances', 'manage_insurance', 'manage_bonuses',
  'view_sales', 'edit_sales',
  'view_purchasing', 'edit_purchasing',
  'view_accounting', 'edit_accounting',
  'view_reports',
];

const ADMIN_PERMISSIONS = ALL_PERMISSIONS.filter(p => p !== 'manage_tenants');

async function truncateAll(prisma) {
  console.log('🗑️  مسح كل البيانات...');

  // الترتيب مهم — الجداول التي تعتمد على غيرها تُمسح أولاً
  const tables = [
    'account_mappings', 'webhook_endpoints', 'integration_sync_logs',
    'integration_connections', 'package_items', 'packages', 'shipments',
    'carriers', 'pick_list_items', 'pick_lists', 'quality_inspections',
    'cycle_count_items', 'cycle_counts', 'delivery_note_items', 'delivery_notes',
    'sales_invoice_items', 'sales_invoices', 'cost_history', 'purchase_payments',
    'landed_costs', 'purchase_invoice_items', 'purchase_invoices',
    'putaway_tasks', 'storage_bins', 'warehouse_zones', 'expiry_alert_rules',
    'batch_stock_levels', 'product_batches', 'notifications', 'audit_logs',
    'bus_passengers', 'buses', 'rehire_records', 'financial_settlements',
    'termination_records', 'employee_penalties', 'employee_bonuses',
    'employee_insurance', 'deleted_record_history', 'employee_advances',
    'employee_salaries', 'payroll_inputs', 'payroll_receipts', 'payroll_items',
    'payroll_runs', 'import_jobs', 'journal_entry_lines', 'journal_entries',
    'account_mappings', 'accounts', 'sales_payments', 'sales_order_items',
    'sales_orders', 'customers', 'goods_receipt_items', 'goods_receipts',
    'purchase_order_items', 'purchase_orders', 'suppliers', 'stock_movements',
    'warehouses', 'stock_levels', 'products', 'daily_attendance_logs',
    'attendance_records', 'devices', 'leave_requests', 'departments',
    'biometric_credentials', 'employees', 'tenant_entitlements', 'users',
    'roles', 'tenants',
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
    } catch {
      // الجدول غير موجود أو فارغ — تجاهل
    }
  }

  console.log('✅ تم مسح كل البيانات');
}

async function seed(prisma) {
  console.log('\n🌱 إنشاء البيانات الأساسية...\n');

  // 1. Tenant افتراضي
  const tenant = await prisma.tenant.create({
    data: {
      name: 'المستودع الرئيسي',
      code: 'default',
      status: 'active',
    },
  });
  console.log(`✅ Tenant: ${tenant.name} (${tenant.code})`);

  // 2. Roles
  const superadminRole = await prisma.role.create({
    data: {
      name: 'superadmin',
      description: 'مدير النظام الأعلى — يرى كل المستأجرين',
      permissions: ALL_PERMISSIONS,
    },
  });

  const adminRole = await prisma.role.create({
    data: {
      name: 'admin',
      description: 'مدير المستأجر',
      permissions: ADMIN_PERMISSIONS,
    },
  });

  const employeeRole = await prisma.role.create({
    data: {
      name: 'employee',
      description: 'موظف عادي',
      permissions: ['view_attendance', 'view_payroll'],
    },
  });

  console.log(`✅ Roles: superadmin, admin, employee`);

  // 3. Superadmin (بدون tenant — يرى كل شيء)
  const superHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 12);
  const superUser = await prisma.user.create({
    data: {
      username: 'superadmin',
      email: 'superadmin@warehouse.local',
      passwordHash: superHash,
      roleId: superadminRole.id,
      tenantId: null,
      status: 'active',
    },
  });
  console.log(`✅ Superadmin: ${superUser.username} / ${SUPERADMIN_PASSWORD}`);

  // 4. Admin مربوط بالـ tenant الافتراضي
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const adminUser = await prisma.user.create({
    data: {
      username: 'admin',
      email: 'admin@warehouse.local',
      passwordHash: adminHash,
      roleId: adminRole.id,
      tenantId: tenant.id,
      status: 'active',
    },
  });
  console.log(`✅ Admin: ${adminUser.username} / ${ADMIN_PASSWORD}`);

  // 5. TenantEntitlement — فتح كل الصفحات للـ tenant الافتراضي
  await prisma.tenantEntitlement.create({
    data: {
      tenantId: tenant.id,
      enabledPages: [
        'dashboard', 'employees', 'attendance', 'payroll', 'salary',
        'advances', 'bonuses', 'penalties', 'leaves', 'devices',
        'inventory', 'warehouses', 'purchasing', 'sales', 'accounting',
        'reports', 'settings', 'users', 'roles', 'transportation',
        'notifications', 'audit', 'imports', 'backup',
      ],
      updatedBy: superUser.id,
    },
  });
  console.log(`✅ TenantEntitlement: كل الصفحات مفتوحة`);

  console.log('\n' + '='.repeat(50));
  console.log('🎉 الداتا بيز جاهزة!');
  console.log('='.repeat(50));
  console.log('\nبيانات الدخول:');
  console.log(`  superadmin  →  ${SUPERADMIN_PASSWORD}`);
  console.log(`  admin       →  ${ADMIN_PASSWORD}`);
  console.log('='.repeat(50) + '\n');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL غير موجود في البيئة');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    await truncateAll(prisma);
    await seed(prisma);
  } catch (err) {
    console.error('❌ خطأ:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
