import {
  ALL_PAGE_KEYS,
  ALWAYS_AVAILABLE_ROUTES,
  MODULES,
  isKnownPage,
  moduleState,
  pageKeyForRoute,
  pageKeysForModule,
} from '../../../../src/common/entitlements/catalogue';

describe('entitlement catalogue', () => {
  it('has no duplicate page keys', () => {
    // A duplicate would make one page silently ungrantable, since the later
    // definition wins in every lookup map built from this list.
    expect(new Set(ALL_PAGE_KEYS).size).toBe(ALL_PAGE_KEYS.length);
  });

  it('has no duplicate routes', () => {
    const routes = MODULES.flatMap((m) => m.pages.map((p) => p.route));
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('never gates the routes a signed-out or refused user is sent to', () => {
    // /home is the redirect target when access is refused. If it were gateable
    // a factory could be configured into a loop with no way back in.
    for (const route of ALWAYS_AVAILABLE_ROUTES) {
      expect(pageKeyForRoute(route)).toBeNull();
    }
  });

  describe('pageKeyForRoute', () => {
    it('matches an exact route', () => {
      expect(pageKeyForRoute('/employees')).toBe('hr.employees');
    });

    it('ignores a trailing slash', () => {
      expect(pageKeyForRoute('/employees/')).toBe('hr.employees');
    });

    it('matches a nested route to its page', () => {
      expect(pageKeyForRoute('/employees/EMP001')).toBe('hr.employees');
    });

    it('prefers the longest match, so a sub-page is not swallowed by its parent', () => {
      // Both /inventory and /inventory/batches are pages in their own right.
      expect(pageKeyForRoute('/inventory')).toBe('inventory.products');
      expect(pageKeyForRoute('/inventory/batches')).toBe('inventory.batches');
      expect(pageKeyForRoute('/inventory/batches/anything')).toBe('inventory.batches');
    });

    it('returns null for a route outside the catalogue', () => {
      expect(pageKeyForRoute('/not-a-page')).toBeNull();
    });
  });

  describe('modules bundle pages', () => {
    it('lists the pages of a known module', () => {
      expect(pageKeysForModule('purchasing')).toEqual([
        'purchasing.orders',
        'purchasing.invoices',
      ]);
    });

    it('returns nothing for an unknown module rather than throwing', () => {
      expect(pageKeysForModule('nope')).toEqual([]);
    });

    it('reports a module as partial when only some pages are held', () => {
      // The state the UI needs in order to show a mixed module honestly instead
      // of rounding it to on or off.
      const enabled = new Set(['purchasing.orders']);
      expect(moduleState('purchasing', enabled)).toBe('partial');
    });

    it('reports all and none at the extremes', () => {
      expect(moduleState('purchasing', new Set(pageKeysForModule('purchasing')))).toBe('all');
      expect(moduleState('purchasing', new Set<string>())).toBe('none');
    });
  });

  describe('isKnownPage', () => {
    it('accepts every catalogue key', () => {
      for (const key of ALL_PAGE_KEYS) expect(isKnownPage(key)).toBe(true);
    });

    it('rejects a typo, so it cannot be stored as a granted page', () => {
      expect(isKnownPage('inventory.batchs')).toBe(false);
      expect(isKnownPage('')).toBe(false);
    });
  });
});
