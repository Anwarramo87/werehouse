#!/usr/bin/env node
/**
 * dev:local — تشغيل الباك اند ضد Postgres + Redis محليين (Docker) بدل Neon السحابي البعيد.
 *
 *   1. يشغّل حاويات postgres + redis (docker compose up -d)
 *   2. ينتظر جاهزية Postgres
 *   3. يرفض البدء إذا البورت مشغول (يطبع المعرف لتخفيضه)
 *   4. يطبّق الـ migrations على القاعدة المحلية فقط
 *   5. يشغّل `nest start --watch` مع DATABASE_URL/REDIS_URL محليين
 *
 * الاستخدام: npm run dev:local
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5003);
const win = process.platform === 'win32';

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    stdio: opts.capture ? 'pipe' : 'inherit',
    shell: win,
    ...opts,
  });
}

function readEnvFile() {
  const out = {};
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function fatal(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function checkPortFree(port) {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function main() {
  const envFile = readEnvFile();
  const pgUser = envFile.POSTGRES_USER || 'postgres';
  const pgPass = envFile.POSTGRES_PASSWORD || 'localdev';
  const pgDb = envFile.POSTGRES_DB || 'warehouse_systemfinly';
  const localDbUrl = `postgresql://${pgUser}:${pgPass}@127.0.0.1:5432/${pgDb}?sslmode=disable`;

  // 1) Docker
  if (sh('docker', ['--version'], { capture: true }).status !== 0) {
    fatal('Docker غير مثبت أو غير متشغيل — شغّل Docker Desktop أولاً.');
  }

  // 2) تشغيل الحاويات
  console.log('▶ docker compose up -d postgres redis');
  if (sh('docker', ['compose', 'up', '-d', 'postgres', 'redis']).status !== 0) {
    fatal('فشل تشغيل حاويات Docker — تحقق من: docker compose logs postgres');
  }

  // 3) انتظار جاهزية Postgres
  process.stdout.write('▶ انتظار جاهزية Postgres');
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const r = sh('docker', ['exec', 'warehouse_postgres', 'pg_isready', '-U', pgUser, '-d', pgDb], {
      capture: true,
    });
    if (r.status === 0) {
      ready = true;
      break;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write('\n');
  if (!ready) {
    fatal('Postgres ما صار جاهز خلال 60 ثانية — تحقق من: docker compose logs postgres');
  }

  // 4) البورت لازم يكون فاضي
  if (!(await checkPortFree(PORT))) {
    const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    const line = (ns.stdout || '')
      .split(/\r?\n/)
      .find((l) => l.includes(`:${PORT}`) && l.includes('LISTENING'));
    const pid = line ? line.trim().split(/\s+/).pop() : '?';
    fatal(`البورت ${PORT} مشغول بالمعرف ${pid}.\n    اوقفه يدويًا:  taskkill /PID ${pid} /F`);
  }

  // 5) تطبيق الـ migrations على القاعدة المحلية
  console.log('▶ prisma migrate deploy (قاعدة بيانات محلية فقط)');
  const migrate = sh('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: localDbUrl, DIRECT_URL: localDbUrl },
  });
  if (migrate.status !== 0) {
    fatal('فشل تطبيق الـ migrations على القاعدة المحلية');
  }

  // 6) تشغيل السيرفر
  const masked = localDbUrl.replace(/:[^:@/]+@/, ':****@');
  console.log(`▶ nest start --watch  ← DATABASE_URL=${masked}`);
  const child = spawn('npx', ['nest', 'start', '--watch'], {
    cwd: root,
    stdio: 'inherit',
    shell: win,
    env: {
      ...process.env,
      DATABASE_URL: localDbUrl,
      DIRECT_URL: localDbUrl,
      REDIS_URL: 'redis://127.0.0.1:6379',
    },
  });
  const stop = () => {
    child.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
}

main().catch((err) => fatal(err.message));