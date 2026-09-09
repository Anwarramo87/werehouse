/**
 * بيانات تجريبية كاملة لامتداد الـ WMS.
 *
 * ينشئ سيناريو مخزن حقيقي يمرّ بكل ميزة بُنيت: مورّدون وعملاء، فئات تسعير،
 * مناطق وخانات، منتجات متتبَّعة بالدفعات، دفعات بتواريخ صلاحية موزّعة عمداً
 * (منتهية / حرجة / تحذير / سليمة) لتُضيء لوحة الصلاحية فوراً، فاتورة شراء
 * مُرحَّلة بمصاريف ملحقة، جولة التقاط، شحنة، وجرد دوري بفروقات.
 *
 * التشغيل:
 *   node scripts/seed-wms-demo.js            # إنشاء البيانات
 *   node scripts/seed-wms-demo.js --clean    # حذفها ثم إعادة إنشائها
 *
 * كل الصفوف تحمل بادئة DEMO- في أكوادها، فحذفها لا يمسّ بياناتك الحقيقية.
 */
require('dotenv/config');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const D = (v) => new Prisma.Decimal(v);
const CLEAN = process.argv.includes('--clean');

/** تاريخ بإزاحة أيام عن اليوم — أساس توزيع تواريخ الصلاحية. */
const daysFromNow = (days) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const log = (step, detail = '') =>
  console.log(`  ✓ ${step}${detail ? ` — ${detail}` : ''}`);

// ---------------------------------------------------------------------------

async function resolveTenant() {
  const tenant = await prisma.tenant.findFirst({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  if (!tenant) {
    throw new Error(
      'لا يوجد مستأجر (tenant) نشط. شغّل seed-demo.js أولاً لإنشاء المنشأة والمستخدم الإداري.',
    );
  }
  return tenant;
}

async function resolveActor(tenantId) {
  const user = await prisma.user.findFirst({ where: { tenantId } });
  if (!user) throw new Error('لا يوجد مستخدم في هذه المنشأة. شغّل seed-demo.js أولاً.');
  return user;
}

// ---------------------------------------------------------------------- clean

async function clean(tenantId) {
  console.log('\n🧹 حذف البيانات التجريبية السابقة...');

  // بالترتيب العكسي للتبعيات: الأبناء قبل الآباء.
  const demoProducts = await prisma.product.findMany({
    where: { tenantId, sku: { startsWith: 'DEMO-' } },
    select: { sku: true },
  });
  const skus = demoProducts.map((p) => p.sku);

  const demoBatches = await prisma.productBatch.findMany({
    where: { tenantId, sku: { in: skus } },
    select: { id: true },
  });
  const batchIds = demoBatches.map((b) => b.id);

  await prisma.packageItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.package.deleteMany({ where: { tenantId, packageNumber: { contains: 'PKG-' } } });
  await prisma.shipment.deleteMany({ where: { tenantId, recipientName: { startsWith: 'DEMO' } } });
  await prisma.carrier.deleteMany({ where: { tenantId, code: { startsWith: 'DEMO-' } } });

  await prisma.pickListItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.pickList.deleteMany({ where: { tenantId, notes: { startsWith: 'DEMO' } } });

  await prisma.cycleCountItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.cycleCount.deleteMany({ where: { tenantId, notes: { startsWith: 'DEMO' } } });

  await prisma.qualityInspection.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.putawayTask.deleteMany({ where: { tenantId, sku: { in: skus } } });

  await prisma.deliveryNoteItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.deliveryNote.deleteMany({ where: { tenantId, noteNumber: { contains: 'DN-' } } });

  await prisma.salesInvoiceItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.salesInvoice.deleteMany({ where: { tenantId, notes: { startsWith: 'DEMO' } } });

  await prisma.purchaseInvoiceItem.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.landedCost.deleteMany({ where: { tenantId, description: { startsWith: 'DEMO' } } });
  await prisma.purchaseInvoice.deleteMany({ where: { tenantId, notes: { startsWith: 'DEMO' } } });

  await prisma.costHistory.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.batchStockLevel.deleteMany({ where: { tenantId, batchId: { in: batchIds } } });
  await prisma.productBatch.deleteMany({ where: { tenantId, id: { in: batchIds } } });

  await prisma.stockMovement.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.stockLevel.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.productPrice.deleteMany({ where: { tenantId, sku: { in: skus } } });
  await prisma.product.deleteMany({ where: { tenantId, sku: { in: skus } } });

  await prisma.storageBin.deleteMany({ where: { tenantId, code: { startsWith: 'DEMO-' } } });
  await prisma.warehouseZone.deleteMany({ where: { tenantId, code: { startsWith: 'DEMO-' } } });
  await prisma.warehouse.deleteMany({ where: { tenantId, code: { startsWith: 'DEMO-' } } });

  await prisma.expiryAlertRule.deleteMany({ where: { tenantId, name: { startsWith: 'DEMO' } } });
  await prisma.customer.deleteMany({ where: { tenantId, name: { startsWith: 'DEMO' } } });
  await prisma.supplier.deleteMany({ where: { tenantId, name: { startsWith: 'DEMO' } } });

  log('حُذفت البيانات التجريبية');
}

// ---------------------------------------------------------------------- seed

async function main() {
  const tenant = await resolveTenant();
  const actor = await resolveActor(tenant.id);
  const tenantId = tenant.id;

  console.log(`\n🏭 المنشأة: ${tenant.name} (${tenant.code})`);
  console.log(`👤 المستخدم: ${actor.username}\n`);

  if (CLEAN) await clean(tenantId);

  // ------------------------------------------------- 0. خريطة الحسابات
  console.log('📒 شجرة الحسابات وخريطة الترحيل');

  const LEDGER_PLAN = [
    { code: '1300', name: 'المخزون', type: 'asset', role: 'inventory' },
    { code: '1200', name: 'ذمم مدينة - عملاء', type: 'asset', role: 'accountsReceivable' },
    { code: '1450', name: 'ضريبة مشتريات مستردة', type: 'asset', role: 'taxInput' },
    { code: '2100', name: 'ذمم دائنة - موردون', type: 'liability', role: 'accountsPayable' },
    { code: '2450', name: 'ضريبة مبيعات مستحقة', type: 'liability', role: 'taxOutput' },
    { code: '4100', name: 'إيراد المبيعات', type: 'revenue', role: 'salesRevenue' },
    { code: '4150', name: 'خصم مبيعات', type: 'expense', role: 'salesDiscount' },
    { code: '5100', name: 'تكلفة البضاعة المباعة', type: 'expense', role: 'cogs' },
    { code: '5150', name: 'فروقات جرد المخزون', type: 'expense', role: 'inventoryAdjustment' },
  ];

  // الترحيل المحاسبي اختياري: إن لم تكن هجرة account_mappings مطبَّقة بعد،
  // يتخطّى السكربت هذا الجزء بدل أن يفشل — باقي بيانات المخزن لا تعتمد عليه.
  try {
    for (const item of LEDGER_PLAN) {
      const account = await prisma.account.upsert({
        where: { tenantId_code: { tenantId, code: item.code } },
        update: {},
        create: { tenantId, code: item.code, name: item.name, type: item.type },
      });

      await prisma.accountMapping.upsert({
        where: { tenantId_role: { tenantId, role: item.role } },
        update: {},
        create: { tenantId, role: item.role, accountId: account.id },
      });
    }
    log('خريطة الحسابات', `${LEDGER_PLAN.length} دور مربوط بحساب`);
  } catch (error) {
    if (error.code === 'P2021') {
      console.log('  ⚠ تُخطّي المحاسبة — جدول account_mappings غير موجود.');
      console.log('    طبّق الهجرة 20260905220000_add_ledger_posting ثم أعد التشغيل.');
    } else {
      throw error;
    }
  }

  // ---------------------------------------------------------- 1. التسعير
  console.log('\n💰 فئات التسعير والضريبة');

  const vat = await prisma.taxRate.upsert({
    where: { tenantId_code: { tenantId, code: 'VAT' } },
    update: {},
    create: { tenantId, code: 'VAT', name: 'ضريبة القيمة المضافة', rate: D(11), isDefault: true },
  });
  log('نسبة ضريبة', `${vat.code} = ${vat.rate}%`);

  const tiers = {};
  for (const t of [
    { code: 'RETAIL', name: 'مفرق', discountPercent: 0, isDefault: true },
    { code: 'WHOLESALE', name: 'جملة', discountPercent: 15, isDefault: false },
    { code: 'DISTRIBUTOR', name: 'موزّع', discountPercent: 25, isDefault: false },
  ]) {
    tiers[t.code] = await prisma.priceTier.upsert({
      where: { tenantId_code: { tenantId, code: t.code } },
      update: {},
      create: { tenantId, ...t, discountPercent: D(t.discountPercent) },
    });
  }
  log('فئات التسعير', 'مفرق / جملة / موزّع');

  // ------------------------------------------------- 2. المخزن والمناطق
  console.log('\n🏢 المخزن والمناطق والخانات');

  const warehouse = await prisma.warehouse.upsert({
    where: { tenantId_code: { tenantId, code: 'DEMO-WH1' } },
    update: {},
    create: { tenantId, code: 'DEMO-WH1', name: 'المخزن الرئيسي (تجريبي)', address: 'دمشق' },
  });

  const zones = {};
  for (const z of [
    { code: 'DEMO-RECV', name: 'ساحة الاستلام', type: 'RECEIVING', pickSequence: 10 },
    { code: 'DEMO-PICK', name: 'منطقة الالتقاط', type: 'PICKING', pickSequence: 20 },
    { code: 'DEMO-BULK', name: 'التخزين الكثيف', type: 'BULK', pickSequence: 40 },
    { code: 'DEMO-QUAR', name: 'الحجر الصحي', type: 'QUARANTINE', pickSequence: 90 },
  ]) {
    zones[z.code] = await prisma.warehouseZone.upsert({
      where: { tenantId_code: { tenantId, code: z.code } },
      update: {},
      create: { tenantId, warehouseId: warehouse.id, ...z },
    });
  }
  log('المناطق', '4 مناطق');

  // خانات منطقة الالتقاط: ممرّان × 3 رفوف × طابقان = 12 خانة
  const binCodes = [];
  for (const aisle of ['A', 'B']) {
    for (let rack = 1; rack <= 3; rack++) {
      for (let level = 1; level <= 2; level++) {
        const code = `DEMO-PICK-${aisle}-0${rack}-${level}`;
        binCodes.push(code);
        await prisma.storageBin.upsert({
          where: { tenantId_code: { tenantId, code } },
          update: {},
          create: {
            tenantId,
            zoneId: zones['DEMO-PICK'].id,
            code,
            aisle,
            rack: `0${rack}`,
            level: String(level),
            capacityUnits: 200,
            // الطوابق السفلى أسهل وصولاً فتُزار أولاً في مسار الجولة
            pickPriority: rack * 10 + level,
          },
        });
      }
    }
  }
  // خانة استلام وأخرى للحجر
  for (const [code, zoneCode, cap] of [
    ['DEMO-RECV-01', 'DEMO-RECV', null],
    ['DEMO-QUAR-01', 'DEMO-QUAR', null],
  ]) {
    await prisma.storageBin.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: {},
      create: { tenantId, zoneId: zones[zoneCode].id, code, capacityUnits: cap },
    });
  }
  log('الخانات', `${binCodes.length} خانة التقاط + استلام + حجر`);

  // -------------------------------------------------------- 3. المنتجات
  console.log('\n📦 المنتجات');

  const products = [
    {
      sku: 'DEMO-MED-01',
      name: 'باراسيتامول 500 مغ — علبة 20 قرص',
      category: 'أدوية',
      unitPrice: 12000,
      costPrice: 7000,
      unit: 'علبة',
      batchTracked: true,
      shelfLifeDays: 730,
      weightKg: 0.08,
      reorderLevel: 100,
    },
    {
      sku: 'DEMO-MED-02',
      name: 'أموكسيسيلين 250 مغ — شراب',
      category: 'أدوية',
      unitPrice: 18000,
      costPrice: 11000,
      unit: 'زجاجة',
      batchTracked: true,
      shelfLifeDays: 540,
      weightKg: 0.22,
      reorderLevel: 60,
    },
    {
      sku: 'DEMO-FOOD-01',
      name: 'حليب مبستر 1 لتر',
      category: 'أغذية',
      unitPrice: 9000,
      costPrice: 6200,
      unit: 'كرتونة',
      batchTracked: true,
      shelfLifeDays: 21,
      weightKg: 1.05,
      reorderLevel: 200,
    },
    {
      sku: 'DEMO-FOOD-02',
      name: 'جبنة بيضاء 500 غ',
      category: 'أغذية',
      unitPrice: 15000,
      costPrice: 9800,
      unit: 'عبوة',
      batchTracked: true,
      shelfLifeDays: 90,
      weightKg: 0.52,
      reorderLevel: 80,
    },
    {
      sku: 'DEMO-HW-01',
      name: 'برغي فولاذ 6 مم — كيس 100',
      category: 'عدّة',
      unitPrice: 4500,
      costPrice: 2600,
      unit: 'كيس',
      // غير متتبَّع بالدفعات عمداً: ليُظهر أن النظام يتعامل مع النوعين معاً
      batchTracked: false,
      weightKg: 0.9,
      reorderLevel: 50,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { tenantId_sku: { tenantId, sku: p.sku } },
      update: {},
      create: {
        tenantId,
        sku: p.sku,
        name: p.name,
        category: p.category,
        unitPrice: D(p.unitPrice),
        costPrice: D(p.costPrice),
        unit: p.unit,
        reorderLevel: p.reorderLevel ?? 10,
        batchTracked: p.batchTracked,
        shelfLifeDays: p.shelfLifeDays ?? null,
        weightKg: D(p.weightKg),
        barcode: p.sku.replace('DEMO-', 'BC'),
        taxRateId: vat.id,
        abcClass: p.category === 'أدوية' ? 'A' : p.category === 'أغذية' ? 'B' : 'C',
        status: 'active',
      },
    });
  }
  log('المنتجات', `${products.length} أصناف (4 متتبَّعة بالدفعات + 1 غير متتبَّع)`);

  // سعر جملة خاص على صنفين
  for (const [sku, price, minQty] of [
    ['DEMO-MED-01', 9500, 50],
    ['DEMO-FOOD-01', 7800, 100],
  ]) {
    await prisma.productPrice.upsert({
      where: {
        tenantId_sku_priceTierId_minQuantity: {
          tenantId,
          sku,
          priceTierId: tiers.WHOLESALE.id,
          minQuantity: minQty,
        },
      },
      update: {},
      create: {
        tenantId,
        sku,
        priceTierId: tiers.WHOLESALE.id,
        price: D(price),
        minQuantity: minQty,
      },
    });
  }
  log('كسور الكمية', 'سعران خاصان لفئة الجملة');

  // ------------------------------------------- 4. الموردون والعملاء
  console.log('\n🤝 الموردون والعملاء');

  const supplier = await prisma.supplier.create({
    data: {
      tenantId,
      name: 'DEMO — شركة الشام للتوريدات الطبية',
      phone: '0111234567',
      email: 'supply@demo.local',
      taxNumber: 'TAX-DEMO-001',
    },
  });

  const customers = [];
  for (const c of [
    { name: 'DEMO — صيدلية النور', tier: 'RETAIL', creditLimit: 0 },
    { name: 'DEMO — موزّع دمشق الكبرى', tier: 'WHOLESALE', creditLimit: 5000000 },
    { name: 'DEMO — سوبرماركت الأمانة', tier: 'DISTRIBUTOR', creditLimit: 2000000 },
  ]) {
    customers.push(
      await prisma.customer.create({
        data: {
          tenantId,
          name: c.name,
          phone: '0999000111',
          priceTierId: tiers[c.tier].id,
          creditLimit: D(c.creditLimit),
        },
      }),
    );
  }
  log('الموردون والعملاء', '1 مورّد + 3 عملاء بفئات تسعير مختلفة');

  // --------------------------------------------- 5. قواعد الصلاحية
  console.log('\n⏰ قواعد التنبيه');

  await prisma.expiryAlertRule.create({
    data: {
      tenantId,
      name: 'DEMO — أدوية',
      category: 'أدوية',
      warnDays: 180,
      criticalDays: 90,
      blockDays: 30, // حجر تلقائي قبل 30 يوماً من الانتهاء
      notifySales: true,
    },
  });
  await prisma.expiryAlertRule.create({
    data: {
      tenantId,
      name: 'DEMO — أغذية',
      category: 'أغذية',
      warnDays: 30,
      criticalDays: 10,
      blockDays: 3,
      notifySales: true,
    },
  });
  log('قواعد الصلاحية', 'أدوية (180/90/حجر 30) — أغذية (30/10/حجر 3)');

  // ------------------------------------------------------- 6. الدفعات
  console.log('\n🏷️  الدفعات — موزّعة عمداً على كل مستويات الخطورة');

  /**
   * توزيع تواريخ الصلاحية مقصود: كل صف يُضيء خانة مختلفة في لوحة الصلاحية،
   * فتظهر اللوحة ممتلئة من أول فتح بدل أن تكون فارغة.
   */
  const batchPlan = [
    // منتهية فعلاً
    { sku: 'DEMO-FOOD-01', batch: 'MLK-2601', expiryDays: -4, qty: 40, cost: 6000, bin: 'DEMO-PICK-A-01-1' },
    // حرجة (ضمن blockDays للأغذية → ستُحجَر عند أول مسح)
    { sku: 'DEMO-FOOD-01', batch: 'MLK-2602', expiryDays: 2, qty: 120, cost: 6100, bin: 'DEMO-PICK-A-01-2' },
    // تحذير أغذية
    { sku: 'DEMO-FOOD-02', batch: 'CHS-2611', expiryDays: 25, qty: 90, cost: 9500, bin: 'DEMO-PICK-A-02-1' },
    // سليمة أغذية
    { sku: 'DEMO-FOOD-02', batch: 'CHS-2612', expiryDays: 80, qty: 150, cost: 9900, bin: 'DEMO-PICK-A-02-2' },
    // حرجة أدوية
    { sku: 'DEMO-MED-01', batch: 'PAR-2501', expiryDays: 75, qty: 200, cost: 6800, bin: 'DEMO-PICK-B-01-1' },
    // تحذير أدوية
    { sku: 'DEMO-MED-01', batch: 'PAR-2502', expiryDays: 150, qty: 350, cost: 7100, bin: 'DEMO-PICK-B-01-2' },
    // سليمة أدوية — الأبعد صلاحية، يجب أن تخرج أخيراً في FEFO
    { sku: 'DEMO-MED-01', batch: 'PAR-2503', expiryDays: 600, qty: 500, cost: 7300, bin: 'DEMO-PICK-B-02-1' },
    { sku: 'DEMO-MED-02', batch: 'AMX-2521', expiryDays: 120, qty: 80, cost: 10800, bin: 'DEMO-PICK-B-02-2' },
    { sku: 'DEMO-MED-02', batch: 'AMX-2522', expiryDays: 400, qty: 140, cost: 11200, bin: 'DEMO-PICK-B-03-1' },
  ];

  for (const b of batchPlan) {
    const expiryDate = daysFromNow(b.expiryDays);
    const productionDate = daysFromNow(b.expiryDays - 365);
    const barcode = `${b.sku}-${b.batch}-${expiryDate.toISOString().slice(2, 10).replace(/-/g, '')}`;

    const batch = await prisma.productBatch.create({
      data: {
        tenantId,
        sku: b.sku,
        batchNumber: b.batch,
        productionDate,
        expiryDate,
        status: 'AVAILABLE',
        initialQuantity: b.qty,
        quantity: b.qty,
        unitCost: D(b.cost),
        barcode,
        supplierId: supplier.id,
      },
    });

    await prisma.batchStockLevel.create({
      data: {
        tenantId,
        batchId: batch.id,
        sku: b.sku,
        location: b.bin,
        quantity: b.qty,
        reserved: 0,
        available: b.qty,
      },
    });

    // الدفتر المجمّع يتحرّك مع الدفتر الفرعي — وإلا اختلف الرصيدان
    await prisma.stockLevel.upsert({
      where: { tenantId_sku_location: { tenantId, sku: b.sku, location: b.bin } },
      update: {
        quantity: { increment: b.qty },
        available: { increment: b.qty },
      },
      create: {
        tenantId,
        sku: b.sku,
        location: b.bin,
        quantity: b.qty,
        reserved: 0,
        available: b.qty,
      },
    });

    await prisma.stockMovement.create({
      data: {
        tenantId,
        sku: b.sku,
        type: 'IN',
        quantity: b.qty,
        location: b.bin,
        reason: `رصيد افتتاحي تجريبي — دفعة ${b.batch}`,
        referenceType: 'seed',
        referenceId: batch.id,
        createdById: actor.id,
      },
    });
  }
  log('الدفعات', `${batchPlan.length} دفعات — منتهية وحرجة وتحذير وسليمة`);

  // الصنف غير المتتبَّع: رصيد مباشر بلا دفعة
  await prisma.stockLevel.upsert({
    where: {
      tenantId_sku_location: { tenantId, sku: 'DEMO-HW-01', location: 'DEMO-PICK-B-03-2' },
    },
    update: {},
    create: {
      tenantId,
      sku: 'DEMO-HW-01',
      location: 'DEMO-PICK-B-03-2',
      quantity: 300,
      reserved: 0,
      available: 300,
    },
  });
  log('صنف غير متتبَّع', 'DEMO-HW-01 — 300 كيس بلا دفعة');

  // ------------------------------------------------ 7. فاتورة شراء مُرحَّلة
  console.log('\n🧾 فاتورة شراء مُرحَّلة بمصاريف ملحقة');

  const year = new Date().getFullYear();
  const pinvNumber = `PINV-${year}-900001`;

  const purchaseInvoice = await prisma.purchaseInvoice.create({
    data: {
      tenantId,
      invoiceNumber: pinvNumber,
      supplierInvoiceNumber: 'SUP-INV-77123',
      supplierId: supplier.id,
      invoiceDate: daysFromNow(-10),
      dueDate: daysFromNow(20),
      status: 'POSTED',
      postedAt: daysFromNow(-10),
      postedBy: actor.id,
      currency: 'SYP',
      notes: 'DEMO — فاتورة شراء تجريبية مُرحَّلة',
      createdBy: actor.id,
      subtotal: D(2_800_000),
      discountAmount: D(0),
      taxAmount: D(308_000),
      landedCostTotal: D(150_000),
      totalAmount: D(3_258_000),
      paidAmount: D(1_000_000),
      items: {
        create: [
          {
            tenantId,
            sku: 'DEMO-MED-01',
            batchNumber: 'PAR-2503',
            quantity: 200,
            unitCost: D(7000),
            taxRate: D(11),
            taxAmount: D(154_000),
            lineTotal: D(1_554_000),
            // 150,000 مصاريف موزّعة بالقيمة: نصفها لكل بند (القيمتان متساويتان)
            allocatedLandedCost: D(75_000),
            finalUnitCost: D(7375),
            location: 'DEMO-PICK-B-02-1',
          },
          {
            tenantId,
            sku: 'DEMO-MED-02',
            batchNumber: 'AMX-2522',
            quantity: 100,
            unitCost: D(14_000),
            taxRate: D(11),
            taxAmount: D(154_000),
            lineTotal: D(1_554_000),
            allocatedLandedCost: D(75_000),
            finalUnitCost: D(14_750),
            location: 'DEMO-PICK-B-03-1',
          },
        ],
      },
      landedCosts: {
        create: [
          {
            tenantId,
            type: 'freight',
            description: 'DEMO — أجور شحن برّي',
            amount: D(100_000),
            allocationMethod: 'VALUE',
          },
          {
            tenantId,
            type: 'customs',
            description: 'DEMO — رسوم جمركية',
            amount: D(50_000),
            allocationMethod: 'VALUE',
          },
        ],
      },
      payments: {
        create: [
          {
            tenantId,
            amount: D(1_000_000),
            method: 'transfer',
            paidBy: actor.id,
            notes: 'دفعة أولى',
          },
        ],
      },
    },
  });
  log('فاتورة شراء', `${pinvNumber} — مُرحَّلة، رصيد مستحق 2,258,000`);

  // أثر إعادة تقييم التكلفة
  for (const [sku, oldCost, newCost, qty] of [
    ['DEMO-MED-01', 7000, 7375, 200],
    ['DEMO-MED-02', 11000, 14750, 100],
  ]) {
    await prisma.costHistory.create({
      data: {
        tenantId,
        sku,
        method: 'WEIGHTED_AVERAGE',
        oldCost: D(oldCost),
        newCost: D(newCost),
        oldQuantity: 0,
        quantityIn: qty,
        incomingCost: D(newCost),
        referenceType: 'purchase_invoice',
        referenceId: purchaseInvoice.id,
        createdById: actor.id,
      },
    });
  }
  log('سجل التكلفة', 'صفّان يوثّقان إعادة التقييم');

  // ------------------------------------------------------ 8. فحص جودة
  console.log('\n🔬 فحص جودة');

  const quarantinedBatch = await prisma.productBatch.findFirst({
    where: { tenantId, batchNumber: 'AMX-2521' },
  });
  await prisma.qualityInspection.create({
    data: {
      tenantId,
      inspectionNumber: `QC-${year}-900001`,
      sku: 'DEMO-MED-02',
      batchId: quarantinedBatch.id,
      quantityInspected: 80,
      status: 'PENDING',
      checklist: [
        { criterion: 'سلامة التغليف', expected: 'سليم', actual: null, passed: null },
        { criterion: 'درجة الحرارة عند الاستلام', expected: '≤ 8°م', actual: null, passed: null },
        { criterion: 'مطابقة رقم الدفعة للشهادة', expected: 'مطابق', actual: null, passed: null },
      ],
      notes: 'DEMO — فحص وارد قيد التنفيذ',
    },
  });
  await prisma.productBatch.update({
    where: { id: quarantinedBatch.id },
    data: { status: 'QUARANTINE', quarantineReason: 'قيد فحص الجودة QC-900001' },
  });
  log('فحص جودة', 'دفعة AMX-2521 محجورة قيد الفحص');

  // ------------------------------------------------ 9. مهمة تخزين معلّقة
  await prisma.putawayTask.create({
    data: {
      tenantId,
      taskNumber: `PUT-${year}-900001`,
      sku: 'DEMO-FOOD-02',
      quantity: 60,
      fromLocation: 'DEMO-RECV-01',
      suggestedBin: 'DEMO-PICK-A-02-2',
      suggestionScore: D(370),
      suggestionRule: 'تحتوي أصلاً على نفس المنتج',
      status: 'PENDING',
    },
  });
  log('مهمة تخزين', 'PUT-900001 معلّقة مع خانة مقترحة');

  // ------------------------------------------------- 10. فاتورة بيع مُرحَّلة
  console.log('\n💵 فاتورة بيع مُرحَّلة (خصم FEFO)');

  const sinvNumber = `SINV-${year}-900001`;
  const wholesaleCustomer = customers[1];

  // FEFO: أقدم صلاحية سليمة لـ MED-01 هي PAR-2501 (75 يوماً)
  const fefoBatch = await prisma.productBatch.findFirst({
    where: { tenantId, batchNumber: 'PAR-2501' },
  });

  const salesInvoice = await prisma.salesInvoice.create({
    data: {
      tenantId,
      invoiceNumber: sinvNumber,
      customerId: wholesaleCustomer.id,
      priceTierId: tiers.WHOLESALE.id,
      invoiceDate: daysFromNow(-3),
      dueDate: daysFromNow(27),
      status: 'POSTED',
      postedAt: daysFromNow(-3),
      postedBy: actor.id,
      currency: 'SYP',
      notes: 'DEMO — فاتورة بيع تجريبية مُرحَّلة',
      createdBy: actor.id,
      subtotal: D(950_000),
      discountAmount: D(0),
      taxAmount: D(104_500),
      totalAmount: D(1_054_500),
      paidAmount: D(0),
      cogsAmount: D(680_000), // 100 × 6,800 تكلفة الدفعة المسحوبة
      items: {
        create: [
          {
            tenantId,
            sku: 'DEMO-MED-01',
            batchId: fefoBatch.id,
            batchNumber: 'PAR-2501',
            expiryDate: fefoBatch.expiryDate,
            quantity: 100,
            unitPrice: D(9500), // سعر الجملة الخاص عند كمية ≥ 50
            taxRate: D(11),
            taxAmount: D(104_500),
            lineTotal: D(1_054_500),
            unitCost: D(6800),
            location: 'DEMO-PICK-B-01-1',
          },
        ],
      },
    },
  });

  // خصم الكمية من الدفترين
  await prisma.productBatch.update({
    where: { id: fefoBatch.id },
    data: { quantity: { decrement: 100 } },
  });
  await prisma.batchStockLevel.updateMany({
    where: { tenantId, batchId: fefoBatch.id, location: 'DEMO-PICK-B-01-1' },
    data: { quantity: { decrement: 100 }, available: { decrement: 100 } },
  });
  await prisma.stockLevel.updateMany({
    where: { tenantId, sku: 'DEMO-MED-01', location: 'DEMO-PICK-B-01-1' },
    data: { quantity: { decrement: 100 }, available: { decrement: 100 } },
  });
  await prisma.stockMovement.create({
    data: {
      tenantId,
      sku: 'DEMO-MED-01',
      type: 'OUT',
      quantity: -100,
      location: 'DEMO-PICK-B-01-1',
      reason: `فاتورة بيع ${sinvNumber} (دفعة PAR-2501)`,
      referenceType: 'sales_invoice',
      referenceId: salesInvoice.id,
      createdById: actor.id,
    },
  });

  // إذن الخروج
  await prisma.deliveryNote.create({
    data: {
      tenantId,
      noteNumber: `DN-${year}-900001`,
      salesInvoiceId: salesInvoice.id,
      customerId: wholesaleCustomer.id,
      status: 'issued',
      issuedAt: daysFromNow(-3),
      createdBy: actor.id,
      items: {
        create: [
          {
            tenantId,
            sku: 'DEMO-MED-01',
            batchId: fefoBatch.id,
            batchNumber: 'PAR-2501',
            quantity: 100,
            location: 'DEMO-PICK-B-01-1',
          },
        ],
      },
    },
  });
  log('فاتورة بيع', `${sinvNumber} — هامش 270,000 وإذن خروج DN-900001`);

  // ------------------------------------------------- 11. الشحن
  console.log('\n🚚 الشحن');

  const carrier = await prisma.carrier.upsert({
    where: { tenantId_code: { tenantId, code: 'DEMO-EXP' } },
    update: {},
    create: {
      tenantId,
      code: 'DEMO-EXP',
      name: 'DEMO — البريد السريع',
      contactPhone: '0955000222',
      trackingUrlTemplate: 'https://track.demo.local/{tracking}',
    },
  });

  const shipment = await prisma.shipment.create({
    data: {
      tenantId,
      shipmentNumber: `SHP-${year}-900001`,
      salesInvoiceId: salesInvoice.id,
      carrierId: carrier.id,
      trackingNumber: 'DEMOTRK00099',
      status: 'DISPATCHED',
      packageCount: 1,
      totalWeightKg: D(8),
      shippingCost: D(45_000),
      recipientName: 'DEMO — موزّع دمشق الكبرى',
      recipientPhone: '0999000111',
      address: 'دمشق — المزة',
      shippedAt: daysFromNow(-2),
      createdBy: actor.id,
    },
  });

  await prisma.package.create({
    data: {
      tenantId,
      packageNumber: `PKG-${year}-900001`,
      shipmentId: shipment.id,
      weightKg: D(8),
      lengthCm: D(40),
      widthCm: D(30),
      heightCm: D(25),
      packagingType: 'box',
      barcode: `PKG-${year}-900001`,
      packedBy: actor.id,
      packedAt: daysFromNow(-2),
      items: {
        create: [
          { tenantId, sku: 'DEMO-MED-01', batchNumber: 'PAR-2501', quantity: 100 },
        ],
      },
    },
  });
  log('الشحن', 'شحنة SHP-900001 خرجت مع طرد واحد ورقم تتبّع');

  // -------------------------------------------- 12. جولة التقاط مفتوحة
  console.log('\n📋 جولة التقاط وجرد دوري');

  const pickList = await prisma.pickList.create({
    data: {
      tenantId,
      pickNumber: `PICK-${year}-900001`,
      strategy: 'BATCH',
      status: 'IN_PROGRESS',
      salesOrderIds: [],
      totalLines: 3,
      completedLines: 1,
      estimatedDistanceM: 34,
      startedAt: daysFromNow(0),
      notes: 'DEMO — جولة التقاط مجمّعة',
      createdBy: actor.id,
      items: {
        create: [
          {
            tenantId,
            sku: 'DEMO-MED-01',
            location: 'DEMO-PICK-B-01-2',
            quantityRequested: 50,
            quantityPicked: 50,
            sequence: 1,
            status: 'COMPLETED',
            pickedBy: actor.id,
            pickedAt: new Date(),
          },
          {
            tenantId,
            sku: 'DEMO-FOOD-02',
            location: 'DEMO-PICK-A-02-2',
            quantityRequested: 30,
            quantityPicked: 0,
            sequence: 2,
            status: 'PENDING',
          },
          {
            tenantId,
            sku: 'DEMO-HW-01',
            location: 'DEMO-PICK-B-03-2',
            quantityRequested: 20,
            quantityPicked: 0,
            sequence: 3,
            status: 'PENDING',
          },
        ],
      },
    },
  });
  log('جولة التقاط', `${pickList.pickNumber} — 1 من 3 أسطر مكتملة`);

  // -------------------------------------------------- 13. جرد بفروقات
  const cycleCount = await prisma.cycleCount.create({
    data: {
      tenantId,
      countNumber: `CC-${year}-900001`,
      type: 'cycle',
      scope: 'zone',
      scopeValue: 'DEMO-PICK',
      status: 'REVIEW',
      startedAt: daysFromNow(-1),
      countedBy: actor.id,
      totalLines: 3,
      countedLines: 3,
      varianceLines: 2,
      varianceValue: D(-42_400),
      notes: 'DEMO — جرد دوري لمنطقة الالتقاط',
      createdBy: actor.id,
      items: {
        create: [
          {
            tenantId,
            sku: 'DEMO-MED-01',
            location: 'DEMO-PICK-B-01-2',
            systemQuantity: 350,
            countedQuantity: 344,
            variance: -6,
            varianceValue: D(-42_600),
            status: 'COUNTED',
            recountRequired: true, // 6 وحدات ≥ حدّ إعادة الجرد
            countedBy: actor.id,
            countedAt: daysFromNow(-1),
            notes: 'نقص — يحتاج إعادة عدّ',
          },
          {
            tenantId,
            sku: 'DEMO-FOOD-02',
            location: 'DEMO-PICK-A-02-1',
            systemQuantity: 90,
            countedQuantity: 90,
            variance: 0,
            varianceValue: D(0),
            status: 'COUNTED',
            countedBy: actor.id,
            countedAt: daysFromNow(-1),
          },
          {
            tenantId,
            sku: 'DEMO-HW-01',
            location: 'DEMO-PICK-B-03-2',
            systemQuantity: 300,
            countedQuantity: 302,
            variance: 2,
            varianceValue: D(200),
            status: 'COUNTED',
            countedBy: actor.id,
            countedAt: daysFromNow(-1),
            notes: 'زيادة طفيفة',
          },
        ],
      },
    },
  });
  log('جرد دوري', `${cycleCount.countNumber} — قيد المراجعة، سطران بفروقات`);

  // ---------------------------------------------------------------- summary
  console.log('\n' + '─'.repeat(66));
  console.log('✅ اكتملت البيانات التجريبية\n');
  console.log('  افتح هذه الصفحات لترى النتيجة:');
  console.log('   /inventory/expiry     → 3 مستويات خطورة مملوءة');
  console.log('   /inventory/batches    → 9 دفعات، واحدة محجورة');
  console.log('   /inventory/locations  → خريطة إشغال 14 خانة');
  console.log('   /inventory/counts     → جرد بفروقات وإعادة عدّ');
  console.log('   /inventory/quality    → فحص معلّق');
  console.log('   /purchasing/invoices  → فاتورة بمصاريف ملحقة موزّعة');
  console.log('   /sales/invoices       → فاتورة بهامش وإذن خروج');
  console.log('   /sales/pricing        → 3 فئات + كسور كمية');
  console.log('   /fulfillment          → جولة التقاط جارية');
  console.log('   /wms/analytics        → مؤشرات ودوران وتنبؤ');
  console.log('\n  جرّب أيضاً:');
  console.log('   • «تشغيل الفحص الآن» في صفحة الصلاحية → سيَحجر دفعة الحليب تلقائياً');
  console.log('   • امسح الباركود DEMO-MED-01-PAR-2503-... في صفحة الدفعات');
  console.log('   • اطبع ملصقات الدفعات المحدَّدة');
  console.log('\n  للحذف: node scripts/seed-wms-demo.js --clean');
  console.log('─'.repeat(66) + '\n');
}

main()
  .catch((error) => {
    console.error('\n❌ فشل السكربت:', error.message);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
