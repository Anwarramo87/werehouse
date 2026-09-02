#!/usr/bin/env node
'use strict';

/**
 * Runs a Prisma CLI command against an explicitly verified database.
 *
 *   node scripts/prisma-safe.js local  db push --accept-data-loss
 *   node scripts/prisma-safe.js remote migrate deploy
 *
 * `local` refuses to run unless the resolved DATABASE_URL points at localhost or
 * a private address, and it resolves that URL from `.env.local` rather than
 * `.env` -- so a command named "local" can no longer reach the production
 * database that `.env` happens to name.
 *
 * `remote` allows a managed host, but never with a destructive flag, and only
 * when the operator names the host they are targeting in CONFIRM_REMOTE_DB.
 *
 * Both print the effective target before doing anything.
 */

const { spawnSync } = require('child_process');
const { resolveDatabaseUrl, assertLocal, describe } = require('./db-target');

const DESTRUCTIVE_FLAGS = ['--accept-data-loss', '--force-reset', '--skip-generate--force'];

function fail(message, detail) {
  console.error('\n  ✖ REFUSED: ' + message);
  if (detail) console.error('    ' + detail);
  console.error('');
  process.exit(1);
}

function printTarget(label, target, source) {
  console.log('');
  console.log('  ── database target ' + '─'.repeat(46));
  console.log('   mode     : ' + label);
  console.log('   source   : ' + source);
  console.log('   host     : ' + target.hostname + ':' + target.port);
  console.log('   database : ' + target.database);
  console.log('   user     : ' + target.user);
  console.log('  ' + '─'.repeat(65));
  console.log('');
}

function main() {
  const [mode, ...prismaArgs] = process.argv.slice(2);

  if (mode !== 'local' && mode !== 'remote') {
    fail('first argument must be "local" or "remote"', 'got: ' + JSON.stringify(mode));
  }
  if (prismaArgs.length === 0) {
    fail('no prisma command given', 'example: node scripts/prisma-safe.js local db push');
  }

  const { url, source } = resolveDatabaseUrl(mode);
  if (!url) {
    fail(
      'could not resolve DATABASE_URL for mode "' + mode + '"',
      'looked in: ' +
        source +
        (mode === 'local'
          ? '. Copy .env.local.example to .env.local and set a local DATABASE_URL.'
          : ''),
    );
  }

  const destructive = prismaArgs.some((a) => DESTRUCTIVE_FLAGS.includes(a));

  if (mode === 'local') {
    const verdict = assertLocal(url);
    if (!verdict.ok) {
      if (verdict.target) printTarget('local (REFUSED)', verdict.target, source);
      fail(
        'a "local" command may only touch a local database',
        verdict.reason +
          '. Set DATABASE_URL in .env.local to your local instance, ' +
          'or use the remote command deliberately.',
      );
    }
    printTarget('local', verdict.target, source);
  } else {
    const target = describe(url);
    if (!target) fail('DATABASE_URL is not a parseable URL');

    if (destructive) {
      printTarget('remote (REFUSED)', target, source);
      fail(
        'destructive flags are never allowed against a remote database',
        'offending flag(s): ' +
          prismaArgs.filter((a) => DESTRUCTIVE_FLAGS.includes(a)).join(', '),
      );
    }

    // Naming the host is the deliberate friction: it cannot be satisfied by
    // muscle memory or by a stale shell variable from another project.
    const confirm = process.env.CONFIRM_REMOTE_DB;
    if (confirm !== target.hostname) {
      printTarget('remote (REFUSED)', target, source);
      fail(
        'a remote database command must be confirmed',
        'set CONFIRM_REMOTE_DB="' + target.hostname + '" to proceed.',
      );
    }
    printTarget('remote (confirmed)', target, source);
  }

  const result = spawnSync('npx', ['prisma', ...prismaArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: url },
  });

  process.exit(result.status === null ? 1 : result.status);
}

main();
