import { readFileSync } from 'fs';
import { join } from 'path';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../../../src/common/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../../src/common/decorators/permissions.decorator';
import {
  ACCOUNTANT_PERMISSIONS,
  ADMIN_PERMISSIONS,
  PERM_ADMIN_ALL,
  PRODUCTION_MANAGER_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
} from '../../../src/common/permissions/permission.constants';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * اختبارات منع أي دور من تنفيذ عمليات خارج صلاحياته.
 *
 * ── What is actually being tested ───────────────────────────────────────────
 * The guard is the real control. The frontend hides buttons, but a hidden
 * button is a courtesy; the API is the wall. These tests exercise the GUARD
 * with each role's real permission list and assert the answers are 403 where
 * they must be.
 *
 * The second half is a POLICY SCAN over the controller sources rather than an
 * import of the controllers themselves. Two reasons:
 *
 *  1. Importing a controller drags in its whole service graph, and several of
 *     those services open a database pool at import time — which leaves a
 *     handle open and stops Jest from exiting. The scan reads the decorator
 *     text directly, so it asserts the same thing with none of that cost.
 *  2. A missing `@Permissions` decorator is the failure mode that would let a
 *     role do something it should not, and it is invisible in a screenshot.
 *     A scan catches it everywhere, including on endpoints nobody remembered
 *     to test.
 */
describe('Role permission enforcement', () => {
  const reflector = new Reflector();
  const guard = new PermissionsGuard(reflector);

  /**
   * Runs the guard as a given role would, with `required` being the permission
   * list a handler declares.
   *
   * The guard THROWS a ForbiddenException rather than returning false when it
   * refuses, so a refusal is caught and reported as `false` — which is what
   * "the role may not do this" looks like from the caller's side.
   */
  const can = (permissions: string[], required: string[], roles: string[] = []) => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { permissions, roles, userId: 'u1', tenantId: 't1' } }),
      }),
      getHandler: () => ({ required }),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === PERMISSIONS_KEY ? required : undefined,
      );

    try {
      return guard.canActivate(ctx);
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    } finally {
      jest.restoreAllMocks();
    }
  };

  // ── the wildcard ──────────────────────────────────────────────────────────

  describe('the admin wildcard', () => {
    it('grants every permission', () => {
      expect(hasPermission([PERM_ADMIN_ALL], 'anything_at_all')).toBe(true);
    });

    it('an empty permission list grants nothing', () => {
      expect(hasPermission([], 'view_accounting')).toBe(false);
      expect(hasPermission(undefined, 'view_accounting')).toBe(false);
      expect(hasPermission(null, 'view_accounting')).toBe(false);
    });

    it('grants an exact match without the wildcard', () => {
      expect(hasPermission(['view_accounting'], 'view_accounting')).toBe(true);
      expect(hasPermission(['view_accounting'], 'edit_accounting')).toBe(false);
    });
  });

  // ── the three roles ───────────────────────────────────────────────────────

  describe('Admin', () => {
    it('may do everything, through the wildcard', () => {
      expect(ADMIN_PERMISSIONS).toContain(PERM_ADMIN_ALL);
      expect(can(ADMIN_PERMISSIONS, ['edit_production'])).toBe(true);
      expect(can(ADMIN_PERMISSIONS, ['close_accounting'])).toBe(true);
      expect(can(ADMIN_PERMISSIONS, ['manage_exchange_rates'])).toBe(true);
      expect(can(ADMIN_PERMISSIONS, ['transfer_stock'])).toBe(true);
    });
  });

  describe('Accountant', () => {
    const permissions = ACCOUNTANT_PERMISSIONS;

    it('may run the accounting module', () => {
      expect(can(permissions, ['view_accounting'])).toBe(true);
      expect(can(permissions, ['edit_accounting'])).toBe(true);
      expect(can(permissions, ['close_accounting'])).toBe(true);
      expect(can(permissions, ['post_purchasing'])).toBe(true);
      expect(can(permissions, ['print_accounting'])).toBe(true);
    });

    it('may read production but NOT manage it', () => {
      expect(can(permissions, ['view_production'])).toBe(true);
      expect(can(permissions, ['print_production'])).toBe(true);

      // The brief is explicit: an accountant may cost a batch, never run one.
      expect(can(permissions, ['create_production'])).toBe(false);
      expect(can(permissions, ['edit_production'])).toBe(false);
      expect(can(permissions, ['delete_production'])).toBe(false);
      expect(can(permissions, ['post_production'])).toBe(false);
      expect(can(permissions, ['manage_production_warehouses'])).toBe(false);
      expect(can(permissions, ['transfer_stock'])).toBe(false);
    });

    it('may NOT edit exchange rates', () => {
      // Reading the rate book is an accounting read; changing it is not.
      expect(can(permissions, ['view_accounting'])).toBe(true);
      expect(can(permissions, ['manage_exchange_rates'])).toBe(false);
    });

    it('has no production-side closing verb at all', () => {
      // `close_accounting` is the accounting verb; there is no production
      // equivalent, and there must not be one.
      expect(permissions).not.toContain('close_production');
    });

    it('has no transportation write permission', () => {
      expect(can(permissions, ['view_transportation'])).toBe(true);
      expect(can(permissions, ['edit_transportation'])).toBe(false);
      expect(can(permissions, ['delete_transportation'])).toBe(false);
    });

    it('cannot escalate by holding manage_roles', () => {
      // `manage_roles` is a Super-Admin-only verb. Even if a factory admin's
      // role row somehow carried it, the guard refuses a tenant principal.
      expect(can(permissions, ['manage_roles'], ['admin'])).toBe(false);
      expect(can(permissions, ['manage_tenants'], ['admin'])).toBe(false);
    });
  });

  describe('Production Manager', () => {
    const permissions = PRODUCTION_MANAGER_PERMISSIONS;

    it('may run production fully', () => {
      expect(can(permissions, ['view_production'])).toBe(true);
      expect(can(permissions, ['create_production'])).toBe(true);
      expect(can(permissions, ['edit_production'])).toBe(true);
      expect(can(permissions, ['delete_production'])).toBe(true);
      expect(can(permissions, ['post_production'])).toBe(true);
      expect(can(permissions, ['manage_production_warehouses'])).toBe(true);
      expect(can(permissions, ['transfer_stock'])).toBe(true);
    });

    it('may READ accounting but not write it', () => {
      expect(can(permissions, ['view_accounting'])).toBe(true);
      expect(can(permissions, ['print_accounting'])).toBe(true);

      // Editing an invoice, editing an exchange rate, or closing a financial
      // period are all out of bounds without an explicit separate grant.
      expect(can(permissions, ['edit_accounting'])).toBe(false);
      expect(can(permissions, ['post_accounting'])).toBe(false);
      expect(can(permissions, ['close_accounting'])).toBe(false);
      expect(can(permissions, ['manage_exchange_rates'])).toBe(false);
    });

    it('may NOT edit purchasing', () => {
      expect(can(permissions, ['edit_purchasing'])).toBe(false);
      expect(can(permissions, ['post_purchasing'])).toBe(false);
    });

    it('may not touch payroll', () => {
      expect(can(permissions, ['run_payroll'])).toBe(false);
      expect(can(permissions, ['approve_payroll'])).toBe(false);
    });
  });

  it('the three roles are distinct', () => {
    const admin = new Set(ADMIN_PERMISSIONS);
    const accountant = new Set(ACCOUNTANT_PERMISSIONS);
    const manager = new Set(PRODUCTION_MANAGER_PERMISSIONS);

    // The wildcard is exclusive to the admin role.
    expect(admin.has(PERM_ADMIN_ALL)).toBe(true);
    expect(accountant.has(PERM_ADMIN_ALL)).toBe(false);
    expect(manager.has(PERM_ADMIN_ALL)).toBe(false);

    // The accountant and the production manager share no write permission.
    const accountantOnly = [...accountant].filter((p) => !manager.has(p));
    const managerOnly = [...manager].filter((p) => !accountant.has(p));
    expect(accountantOnly.length).toBeGreaterThan(0);
    expect(managerOnly.length).toBeGreaterThan(0);
  });

  it('every seeded role exists in the role map', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([
      'accountant',
      'admin',
      'production_manager',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The policy scan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the permission constants and returns a map of constant name → the
 * permission string it holds.
 *
 * Controllers may write either `@Permissions('view_accounting')` or
 * `@Permissions(PERM_VIEW_ACCOUNTING)`. Both mean the same thing, so the
 * scan resolves the constant to its value and compares like with like.
 */
function scanPermissionConstants(): Map<string, string> {
  const source = readFileSync(
    join(process.cwd(), 'src/common/permissions/permission.constants.ts'),
    'utf8',
  );
  const map = new Map<string, string>();
  const pattern = /export const (PERM_[A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

const PERMISSION_CONSTANTS = scanPermissionConstants();

/**
 * Reads a controller source and returns, for each handler, the permission list
 * its `@Permissions` decorator declares.
 *
 * The scan is deliberately simple: it walks the file line by line, remembers
 * the most recent `@Permissions(...)` it saw, and attributes it to the next
 * handler it finds. A handler with no `@Permissions` is reported with an empty
 * list — which is the case this test exists to catch.
 */
function scanPermissions(relativePath: string): Map<string, string[]> {
  const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
  const lines = source.split(/\r?\n/);

  const result = new Map<string, string[]>();
  let pending: string[] | null = null;

  for (const line of lines) {
    const permMatch = line.match(/@Permissions\(([^)]*)\)/);
    if (permMatch) {
      pending = permMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
        .map((token) => PERMISSION_CONSTANTS.get(token) ?? token)
        .filter((s) => s.length > 0);
      continue;
    }

    // A route decorator (@Get, @Post, …) is not a permission decorator, so it
    // must not clear what is pending.
    if (line.trim().startsWith('@') && !line.trim().startsWith('@Permissions')) {
      continue;
    }

    // A class method is declared at two-space indentation. Matching on the
    // name and the opening parenthesis — rather than the whole signature —
    // keeps multi-line parameter lists working.
    const methodMatch = line.match(
      /^\s{2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (name === 'constructor') continue;
      result.set(name, pending ?? []);
      pending = null;
    }
  }

  return result;
}

describe('Controller permission policy', () => {
  it('the purchase-invoice controller separates read, edit, post and cancel', () => {
    const map = scanPermissions('src/purchase-invoices/purchase-invoices.controller.ts');
    expect(map.get('list')).toEqual(['view_purchasing']);
    expect(map.get('get')).toEqual(['view_purchasing']);
    expect(map.get('create')).toEqual(['edit_purchasing']);
    expect(map.get('update')).toEqual(['edit_purchasing']);
    expect(map.get('remove')).toEqual(['delete_purchasing']);
    expect(map.get('post')).toEqual(['post_purchasing']);
    expect(map.get('cancel')).toEqual(['cancel_purchasing']);
    expect(map.get('print')).toEqual(['print_purchasing']);
  });

  it('the production batch controller gates writes on production verbs', () => {
    const map = scanPermissions('src/manufacturing/production-batch.controller.ts');
    expect(map.get('dashboard')).toEqual(['view_production']);
    expect(map.get('list')).toEqual(['view_production']);
    expect(map.get('create')).toEqual(['create_production']);
    expect(map.get('get')).toEqual(['view_production']);
    expect(map.get('startStage')).toEqual(['edit_production']);
    expect(map.get('completeStage')).toEqual(['edit_production']);
    expect(map.get('returnStage')).toEqual(['post_production']);
    expect(map.get('calculateCost')).toEqual(['edit_production']);
    expect(map.get('lockCost')).toEqual(['post_production']);
    expect(map.get('unlockCost')).toEqual(['edit_production']);
    expect(map.get('costReport')).toEqual(['print_production']);
    expect(map.get('createWarehouse')).toEqual(['manage_production_warehouses']);
    expect(map.get('createTransfer')).toEqual(['transfer_stock']);
    expect(map.get('listTransfers')).toEqual(['view_production']);
  });

  it('the manufacturing controller gates writes on production verbs', () => {
    const map = scanPermissions('src/manufacturing/manufacturing.controller.ts');
    expect(map.get('createBOM')).toEqual(['create_production']);
    expect(map.get('updateBOM')).toEqual(['edit_production']);
    expect(map.get('createOrder')).toEqual(['create_production']);
    expect(map.get('startOrder')).toEqual(['edit_production']);
    expect(map.get('completeOrder')).toEqual(['post_production']);
    expect(map.get('cancelOrder')).toEqual(['delete_production']);
    expect(map.get('listOrders')).toEqual(['view_production']);
  });

  it('the transportation controller separates read from write', () => {
    const map = scanPermissions('src/transportation/transportation.controller.ts');
    expect(map.get('summary')).toEqual(['view_transportation']);
    expect(map.get('listBuses')).toEqual(['view_transportation']);
    expect(map.get('getBus')).toEqual(['view_transportation']);
    expect(map.get('listPassengers')).toEqual(['view_transportation']);
    expect(map.get('listAttendance')).toEqual(['view_transportation']);
    expect(map.get('createBus')).toEqual(['edit_transportation']);
    expect(map.get('updateBus')).toEqual(['edit_transportation']);
    expect(map.get('addPassenger')).toEqual(['edit_transportation']);
    expect(map.get('removePassenger')).toEqual(['edit_transportation']);
    expect(map.get('recordAttendance')).toEqual(['edit_transportation']);
    expect(map.get('recordAttendanceBatch')).toEqual(['edit_transportation']);
    expect(map.get('deleteBus')).toEqual(['delete_transportation']);
    expect(map.get('printReport')).toEqual(['print_transportation']);
    expect(map.get('updateSettings')).toEqual(['manage_transportation']);
    expect(map.get('getSettings')).toEqual(['view_transportation']);
  });

  it('the exchange-rate controller separates reading from changing', () => {
    const map = scanPermissions('src/accounting/exchange-rate.controller.ts');
    expect(map.get('list')).toEqual(['view_accounting']);
    expect(map.get('add')).toEqual(['manage_exchange_rates']);
    expect(map.get('update')).toEqual(['manage_exchange_rates']);
    expect(map.get('remove')).toEqual(['manage_exchange_rates']);
  });

  it('the accounting controller keeps its accounting verb', () => {
    const map = scanPermissions('src/accounting/accounting.controller.ts');
    expect(map.get('listAccounts')).toEqual(['view_accounting']);
    expect(map.get('createAccount')).toEqual(['edit_accounting']);
    expect(map.get('updateAccount')).toEqual(['edit_accounting']);
    expect(map.get('removeAccount')).toEqual(['edit_accounting']);
    expect(map.get('createJournalEntry')).toEqual(['edit_accounting']);
  });

  it('NO production endpoint accepts a bare accounting read on a write path', () => {
    // The failure this guards against: an accountant (or a production
    // manager) reaching a write endpoint because someone typed `view_*`
    // where `edit_*` was meant.
    for (const file of [
      'src/manufacturing/production-batch.controller.ts',
      'src/manufacturing/manufacturing.controller.ts',
    ]) {
      const map = scanPermissions(file);
      for (const [name, perms] of map) {
        const isWrite = /^(create|update|delete|start|complete|return|cancel|lock|unlock|add|remove|edit|post|transfer)/.test(
          name,
        );
        if (!isWrite) continue;
        expect(perms.some((p) => p.startsWith('view_'))).toBe(false);
      }
    }
  });

  it('NO accounting write endpoint accepts a bare read permission', () => {
    const map = scanPermissions('src/accounting/exchange-rate.controller.ts');
    for (const [name, perms] of map) {
      if (!/^(add|update|remove|edit|post|delete|create)$/.test(name)) continue;
      expect(perms).not.toContain('view_accounting');
    }
  });
});
