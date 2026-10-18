#!/usr/bin/env node
/**
 * prestart:dev hook — يشغّل `prisma generate` بس إذا schema.prisma (أو prisma.config.ts) تغيّر.
 * سابقًا كان `prestart:dev` يعيد توليد الكلاينت كل مرة (~10 ثوانٍ) حتى لو ما تغيّر شي.
 * للإجبار على إعادة التوليد: npm run prisma generate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const inputs = [
  path.join(root, 'prisma', 'schema.prisma'),
  path.join(root, 'prisma.config.ts'),
];
const stampFile = path.join(root, 'node_modules', '.prisma-generate.stamp.json');
const clientDir = path.join(root, 'node_modules', '@prisma', 'client');

const hash = crypto.createHash('sha256');
for (const file of inputs) {
  hash.update(fs.existsSync(file) ? fs.readFileSync(file) : '');
  hash.update('|');
}
const digest = hash.digest('hex');

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
} catch {
  /* لا يوجد stamp بعد — أول تشغيل */
}

if (previous && previous.digest === digest && fs.existsSync(clientDir)) {
  // الـ schema ما تغيّر والكلاينت موجود — تجاوز الـ ~10 ثوانٍ.
  process.exit(0);
}

console.log('[prisma-generate] schema/config تغيّر (أو أول تشغيل) — يتم توليد Prisma Client…');
const result = spawnSync('npx', ['prisma', 'generate'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error('[prisma-generate] فشل prisma generate');
  process.exit(result.status == null ? 1 : result.status);
}
fs.writeFileSync(stampFile, JSON.stringify({ digest, generatedAt: new Date().toISOString() }));