// Proves the tenant extension actually isolates data, against the real DB.
require('dotenv').config({ quiet: true });
const { PrismaService } = require('../dist/prisma/prisma.service');
const {
  runWithTenant,
  runUnscoped,
} = require('../dist/common/tenant/tenant-context');

const prisma = new PrismaService();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let pass = 0;
let fail = 0;

function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (extra ? ' -- ' + extra : ''));
  }
}

(async () => {
  await prisma.$connect();

  // seed two factories
  await runUnscoped('test-setup', async () => {
    await prisma.warehouse.deleteMany({ where: { code: { in: ['W-SHARED'] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.tenant.create({ data: { id: A, name: 'Factory A', code: 'FA' } });
    await prisma.tenant.create({ data: { id: B, name: 'Factory B', code: 'FB' } });
  });

  console.log('\n1. create is stamped with the caller tenant');
  await runWithTenant({ tenantId: A, bypass: false }, async () => {
    await prisma.warehouse.create({ data: { name: 'A store', code: 'W-SHARED' } });
  });
  const rowA = await runUnscoped('verify', async () => await prisma.warehouse.findFirst({ where: { code: 'W-SHARED' } }));
  check('tenantId auto-stamped on create', rowA && rowA.tenantId === A, `got ${rowA && rowA.tenantId}`);

  console.log('\n2. the SAME business code is reusable in another factory');
  let reuseOk = true;
  let reuseErr = '';
  try {
    await runWithTenant({ tenantId: B, bypass: false }, async () => {
      await prisma.warehouse.create({ data: { name: 'B store', code: 'W-SHARED' } });
    });
  } catch (e) {
    reuseOk = false;
    reuseErr = e.message.split('\n')[0];
  }
  check('code W-SHARED reusable across factories', reuseOk, reuseErr);

  console.log('\n3. reads are narrowed to the caller factory');
  const seenByA = await runWithTenant({ tenantId: A, bypass: false }, async () => await prisma.warehouse.findMany({ where: { code: 'W-SHARED' } }));
  const seenByB = await runWithTenant({ tenantId: B, bypass: false }, async () => await prisma.warehouse.findMany({ where: { code: 'W-SHARED' } }));
  check('A sees exactly 1 row', seenByA.length === 1, `saw ${seenByA.length}`);
  check('B sees exactly 1 row', seenByB.length === 1, `saw ${seenByB.length}`);
  check('A and B see DIFFERENT rows', seenByA[0] && seenByB[0] && seenByA[0].id !== seenByB[0].id);
  check('A sees only its own name', seenByA[0] && seenByA[0].name === 'A store', seenByA[0] && seenByA[0].name);

  console.log('\n4. super admin sees every factory');
  const seenBySuper = await runWithTenant({ tenantId: null, bypass: true }, async () => await prisma.warehouse.findMany({ where: { code: 'W-SHARED' } }));
  check('superadmin sees both rows', seenBySuper.length === 2, `saw ${seenBySuper.length}`);

  console.log('\n5. one factory cannot UPDATE another factory row');
  const bRowId = seenByB[0].id;
  const updated = await runWithTenant({ tenantId: A, bypass: false }, async () => await prisma.warehouse.updateMany({ where: { id: bRowId }, data: { name: 'HACKED' } }));
  check('A updating B row affects 0 rows', updated.count === 0, `count=${updated.count}`);
  const bAfter = await runUnscoped('verify', async () => await prisma.warehouse.findFirst({ where: { id: bRowId } }));
  check('B row is untouched', bAfter.name === 'B store', bAfter.name);

  console.log('\n6. one factory cannot DELETE another factory row');
  const del = await runWithTenant({ tenantId: A, bypass: false }, async () => await prisma.warehouse.deleteMany({ where: { id: bRowId } }));
  check('A deleting B row affects 0 rows', del.count === 0, `count=${del.count}`);

  console.log('\n7. transactions inherit the tenant filter');
  const txSeen = await runWithTenant({ tenantId: A, bypass: false }, async () => await prisma.$transaction(async (tx) => tx.warehouse.findMany({ where: { code: 'W-SHARED' } })));
  check('tx.warehouse is filtered inside $transaction', txSeen.length === 1, `saw ${txSeen.length}`);

  console.log('\n8. missing scope fails closed');
  let threw = false;
  try {
    await prisma.warehouse.findMany({});
  } catch (e) {
    threw = /Tenant scope missing/.test(e.message);
  }
  check('query with NO scope throws', threw);


  console.log('\n9. upsert is tenant-scoped (where narrowed, create stamped)');
  await runWithTenant({ tenantId: B, bypass: false }, async () => {
    await prisma.warehouse.upsert({
      where: { code: 'W-SHARED' },
      update: { name: 'B store v2' },
      create: { name: 'B store new', code: 'W-SHARED' },
    });
  });
  const aAfterUpsert = await runUnscoped('verify', async () =>
    await prisma.warehouse.findFirst({ where: { tenantId: A, code: 'W-SHARED' } }),
  );
  const bAfterUpsert = await runUnscoped('verify', async () =>
    await prisma.warehouse.findFirst({ where: { tenantId: B, code: 'W-SHARED' } }),
  );
  check('B upsert updated B row', bAfterUpsert && bAfterUpsert.name === 'B store v2', bAfterUpsert && bAfterUpsert.name);
  check('B upsert did NOT touch A row', aAfterUpsert && aAfterUpsert.name === 'A store', aAfterUpsert && aAfterUpsert.name);

  // cleanup
  await runUnscoped('test-teardown', async () => {
    await prisma.warehouse.deleteMany({ where: { code: 'W-SHARED' } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
  });

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERROR:', e.message);
  process.exit(1);
});
