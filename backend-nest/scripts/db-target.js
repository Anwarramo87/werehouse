'use strict';

/**
 * Single source of truth for "which database is this command about to touch?".
 *
 * Exists because `npm run prisma:push:local` ran `prisma db push
 * --accept-data-loss` with no URL of its own. Prisma resolves DATABASE_URL from
 * `.env`, and `.env` points at the production Neon instance -- so a command with
 * "local" in its name would have destructively rewritten production.
 *
 * Everything here is deliberately dependency-free and fails closed: anything it
 * cannot positively identify as a local development database is refused.
 */

const fs = require('fs');
const path = require('path');

/** Hosts that are unambiguously this machine. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Managed-database providers. Matching one of these is an immediate refusal in
 * local mode, ahead of any other check, so a hostname that also happens to look
 * private cannot slip through.
 */
const REMOTE_PROVIDER = /neon\.tech|amazonaws\.com|rds\.|azure|supabase|render\.com|railway|planetscale|heroku|digitalocean|timescale|cockroachlabs/i;

/** RFC1918 and friends -- a database on the developer's own network. */
function isPrivateHost(hostname) {
  if (LOOPBACK.has(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
  // Docker Compose service names resolve only inside the compose network.
  if (/^(postgres|db|database|localdb)$/i.test(hostname)) return true;
  if (/\.local$/i.test(hostname)) return true;
  return false;
}

/** Reads KEY=VALUE pairs out of a dotenv file without pulling in a dependency. */
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function maskUrl(url) {
  return String(url).replace(/(:\/\/[^:/?#]*):[^@]*@/, '$1:***@');
}

function describe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return {
    href: url,
    masked: maskUrl(url),
    hostname: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, '') || '(none)',
    user: parsed.username || '(none)',
  };
}

/**
 * Resolves the URL a command in `mode` would actually use.
 *
 * local  -> `.env.local` first, so a local command never silently inherits the
 *           production URL from `.env`. An explicit DATABASE_URL in the
 *           environment still wins, which is what CI and the e2e suite rely on.
 * remote -> the ordinary Prisma resolution: environment, then `.env`.
 */
function resolveDatabaseUrl(mode, cwd = process.cwd()) {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'process.env.DATABASE_URL' };
  }

  if (mode === 'local') {
    const localPath = path.resolve(cwd, '.env.local');
    const local = readEnvFile(localPath);
    if (local.DATABASE_URL) {
      return { url: local.DATABASE_URL, source: '.env.local' };
    }
    return { url: null, source: '.env.local (missing or has no DATABASE_URL)' };
  }

  const dotenv = readEnvFile(path.resolve(cwd, '.env'));
  if (dotenv.DATABASE_URL) return { url: dotenv.DATABASE_URL, source: '.env' };
  return { url: null, source: '.env (missing or has no DATABASE_URL)' };
}

/**
 * @returns {{ ok: boolean, reason?: string, target?: object }}
 */
function assertLocal(url) {
  const target = describe(url);
  if (!target) {
    return { ok: false, reason: 'DATABASE_URL is not a parseable URL' };
  }

  if (REMOTE_PROVIDER.test(target.hostname)) {
    return {
      ok: false,
      target,
      reason: `host "${target.hostname}" belongs to a managed database provider`,
    };
  }

  if (!isPrivateHost(target.hostname)) {
    return {
      ok: false,
      target,
      reason: `host "${target.hostname}" is not localhost or a private address`,
    };
  }

  return { ok: true, target };
}

module.exports = {
  LOOPBACK,
  REMOTE_PROVIDER,
  isPrivateHost,
  readEnvFile,
  maskUrl,
  describe,
  resolveDatabaseUrl,
  assertLocal,
};
