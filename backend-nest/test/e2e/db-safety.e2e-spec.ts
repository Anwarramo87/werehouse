import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const guard = require('../../scripts/db-target');

const REPO = resolve(__dirname, '..');
const SAFE = resolve(REPO, 'scripts/prisma-safe.js');

const NEON =
  'postgresql://neondb_owner:secret@ep-rapid-pond-ayxfbua2-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://postgres:pw@127.0.0.1:5434/warehouse_p0_test?schema=public';

/**
 * Guards on the developer database commands.
 *
 * `npm run prisma:push:local` used to run `prisma db push --accept-data-loss`
 * with no URL of its own, and Prisma resolves DATABASE_URL from `.env` -- which
 * names the production database. A command with "local" in its name could
 * therefore destructively rewrite production. These tests are the regression
 * fence around that.
 *
 * No database is contacted: every case is decided before Prisma is invoked.
 */
describe('database command safety', () => {
  /** Runs prisma-safe.js and returns its exit code and combined output. */
  const run = (
    args: string[],
    env: Record<string, string | undefined> = {},
  ): { code: number; out: string } => {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
    }

    try {
      const out = execFileSync(process.execPath, [SAFE, ...args], {
        cwd: REPO,
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  describe('host classification', () => {
    it('accepts loopback and private addresses', () => {
      for (const host of ['localhost', '127.0.0.1', '::1', '10.0.0.5', '192.168.1.10', '172.16.0.3', 'postgres', 'db']) {
        expect(guard.isPrivateHost(host)).toBe(true);
      }
    });

    it('rejects public and managed-provider hosts', () => {
      for (const host of [
        'ep-rapid-pond-ayxfbua2-pooler.c-5.us-east-2.aws.neon.tech',
        'mydb.abcdef.us-east-1.rds.amazonaws.com',
        'db.supabase.co',
        '8.8.8.8',
        'example.com',
        // 172.32 is outside the private 172.16–172.31 range.
        '172.32.0.1',
      ]) {
        expect(guard.isPrivateHost(host)).toBe(false);
      }
    });

    it('refuses a Neon URL in local mode', () => {
      const verdict = guard.assertLocal(NEON);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/managed database provider/);
    });

    it('allows a localhost URL in local mode', () => {
      const verdict = guard.assertLocal(LOCAL);
      expect(verdict.ok).toBe(true);
      expect(verdict.target.database).toBe('warehouse_p0_test');
    });

    it('refuses an unparseable URL rather than guessing', () => {
      expect(guard.assertLocal('not a url').ok).toBe(false);
    });

    it('masks the password when describing a target', () => {
      expect(guard.maskUrl(NEON)).not.toContain('secret');
      expect(guard.maskUrl(NEON)).toContain(':***@');
    });
  });

  describe('prisma-safe.js — local mode', () => {
    it('refuses to push to Neon even when DATABASE_URL names it', () => {
      const { code, out } = run(['local', 'db', 'push', '--accept-data-loss'], {
        DATABASE_URL: NEON,
      });
      expect(code).toBe(1);
      expect(out).toMatch(/REFUSED/);
      expect(out).toMatch(/managed database provider/);
      // The target is printed before the refusal, so the operator sees what
      // they nearly hit.
      expect(out).toMatch(/neon\.tech/);
    });

    it('never leaks the password into its output', () => {
      const { out } = run(['local', 'db', 'push', '--accept-data-loss'], { DATABASE_URL: NEON });
      expect(out).not.toContain('secret');
    });

    it('fails closed when no local URL is configured, rather than falling back to .env', () => {
      // This is the case that matters most: a developer with a bare shell runs
      // `npm run prisma:push:local`. Previously Prisma read .env and hit
      // production. Now it stops, and it must NOT mention the .env host.
      const { code, out } = run(['local', 'db', 'push', '--accept-data-loss'], {
        DATABASE_URL: undefined,
      });

      if (existsSync(resolve(REPO, '.env.local'))) {
        // A developer machine may legitimately have one; then it must be local.
        expect(out).toMatch(/mode\s+: local/);
      } else {
        expect(code).toBe(1);
        expect(out).toMatch(/could not resolve DATABASE_URL/);
        expect(out).not.toMatch(/neon\.tech/);
      }
    });
  });

  describe('prisma-safe.js — remote mode', () => {
    it('never allows a destructive flag against a remote database', () => {
      const { code, out } = run(['remote', 'db', 'push', '--accept-data-loss'], {
        DATABASE_URL: NEON,
        CONFIRM_REMOTE_DB: 'ep-rapid-pond-ayxfbua2-pooler.c-5.us-east-2.aws.neon.tech',
      });
      expect(code).toBe(1);
      expect(out).toMatch(/destructive flags are never allowed/);
    });

    it('requires the operator to name the host being targeted', () => {
      const { code, out } = run(['remote', 'migrate', 'deploy'], {
        DATABASE_URL: NEON,
        CONFIRM_REMOTE_DB: undefined,
      });
      expect(code).toBe(1);
      expect(out).toMatch(/must be confirmed/);
      expect(out).toMatch(/CONFIRM_REMOTE_DB=/);
    });

    it('rejects a confirmation naming a different host', () => {
      const { code, out } = run(['remote', 'migrate', 'deploy'], {
        DATABASE_URL: NEON,
        CONFIRM_REMOTE_DB: 'some-other-host',
      });
      expect(code).toBe(1);
      expect(out).toMatch(/must be confirmed/);
    });
  });

  describe('argument validation', () => {
    it('refuses an unknown mode', () => {
      const { code, out } = run(['production', 'migrate', 'deploy'], { DATABASE_URL: LOCAL });
      expect(code).toBe(1);
      expect(out).toMatch(/must be "local" or "remote"/);
    });

    it('refuses when no prisma command is given', () => {
      const { code, out } = run(['local'], { DATABASE_URL: LOCAL });
      expect(code).toBe(1);
      expect(out).toMatch(/no prisma command given/);
    });
  });

  describe('docker-compose wiring', () => {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const compose = require('fs').readFileSync(resolve(REPO, 'docker-compose.yml'), 'utf8');

    it('pins the api service DATABASE_URL to the postgres container', () => {
      // The api service carries `env_file: .env` and runs `prisma migrate
      // deploy`. Compose gives `environment:` precedence over `env_file:`, so
      // this explicit line is the only thing keeping that migration off the
      // deployed database. If it is ever deleted, `docker compose up` migrates
      // whatever .env names.
      expect(compose).toMatch(/DATABASE_URL:\s*postgresql:\/\/[^\n]*@postgres:5432\//);
    });

    it('still declares the api service as the one running migrations', () => {
      // If the command moves, the reasoning above needs revisiting.
      expect(compose).toMatch(/prisma migrate deploy/);
    });
  });

  describe('package.json wiring', () => {
    it('has no bare prisma command that could inherit .env', () => {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      const pkg = require('../../package.json');
      const scripts: Record<string, string> = pkg.scripts;

      for (const [name, body] of Object.entries(scripts)) {
        if (name === 'prisma:generate') continue; // generate touches no database
        if (/prisma\s+(db\s+push|migrate\s+deploy|migrate\s+dev|migrate\s+reset)/.test(body)) {
          expect(`${name}: ${body}`).toMatch(/prisma-safe\.js/);
        }
      }
    });

    it('routes every destructive script through the guard', () => {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      const pkg = require('../../package.json');
      const scripts: Record<string, string> = pkg.scripts;

      for (const [name, body] of Object.entries(scripts)) {
        if (body.includes('--accept-data-loss')) {
          expect(`${name}: ${body}`).toMatch(/prisma-safe\.js local/);
        }
      }
    });
  });
});
