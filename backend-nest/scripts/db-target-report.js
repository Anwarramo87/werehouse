#!/usr/bin/env node
'use strict';

/**
 * Prints which database each mode would touch, without touching any of them.
 *
 *   npm run db:target
 *
 * Answers the question that used to require reading three files and knowing how
 * Prisma resolves its datasource: "if I run this right now, what gets written?"
 */

const { resolveDatabaseUrl, assertLocal, describe } = require('./db-target');

function row(label, value) {
  console.log('   ' + String(label).padEnd(10) + ': ' + value);
}

for (const mode of ['local', 'remote']) {
  const { url, source } = resolveDatabaseUrl(mode);
  console.log('');
  console.log('  ── ' + mode + ' ' + '─'.repeat(60 - mode.length));

  if (!url) {
    row('source', source);
    row('status', 'no DATABASE_URL resolved');
    continue;
  }

  const target = describe(url);
  row('source', source);

  if (!target) {
    row('status', 'DATABASE_URL is not parseable');
    continue;
  }

  row('host', target.hostname + ':' + target.port);
  row('database', target.database);
  row('user', target.user);

  const verdict = assertLocal(url);
  if (mode === 'local') {
    row('status', verdict.ok ? 'ALLOWED (local)' : 'REFUSED — ' + verdict.reason);
  } else {
    row('status', verdict.ok ? 'local address' : 'remote — ' + verdict.reason);
    row('needs', 'CONFIRM_REMOTE_DB="' + target.hostname + '"');
  }
}

console.log('');
