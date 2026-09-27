/**
 * What a factory can be sold, and what each part unlocks.
 *
 * ── Why pages are the unit of storage, not modules ──────────────────────────
 * The Super Admin thinks in modules ("this factory bought HR only"), but the
 * requirement is also that individual pages can be toggled. Storing both would
 * mean answering "module on, page off — which wins?" on every request, and
 * every such scheme eventually disagrees with itself.
 *
 * So only PAGES are stored. A module is a bundle operation: enabling one adds
 * its pages, disabling one removes them. There is exactly one source of truth,
 * and "HR only" and "HR minus the bus page" are both expressible.
 *
 * ── Why the order mirrors the factory sidebar ───────────────────────────────
 * Module order here is the order the Super Admin panel renders and the order a
 * buyer sees. It deliberately follows the factory application's sidebar (HR →
 * payroll → inventory → purchasing → sales → fulfillment → production →
 * representatives → WMS setup → imports → administration) so that configuring
 * a factory is as easy as walking its own pages, and nothing feels "out of
 * sequence".
 *
 * ── Why /home is not in here ────────────────────────────────────────────────
 * It is the landing page after login and the redirect target when access is
 * refused. Making it revocable would let a factory be configured into a
 * redirect loop with no way back. It is always available to a signed-in user;
 * what it *shows* is already governed by permissions.
 */

/** A page a factory can be granted. `route` is the frontend path. */
export interface PageDefinition {
  key: string;
  route: string;
  /** Arabic label, matching the sidebar the operator already knows. */
  label: string;
}

export interface ModuleDefinition {
  key: string;
  label: string;
  description: string;
  pages: PageDefinition[];
}

export const MODULES: ModuleDefinition[] = [
  {
    key: 'hr',
    label: 'الموارد البشرية',
    description: 'الموظفون، المستقيلون، سجل الحضور، أجهزة البصمة والمواصلات.',
    pages: [
      { key: 'hr.employees', route: '/employees', label: 'إدارة الموظفين' },
      { key: 'hr.resigned', route: '/resigned', label: 'المستقيلون' },
      { key: 'hr.attendance', route: '/attendance', label: 'سجل الحضور' },
      { key: 'hr.biometric', route: '/attendance/biometric', label: 'أجهزة البصمة' },
      { key: 'hr.transportation', route: '/Transportation', label: 'الباص' },
    ],
  },
  {
    key: 'payroll',
    label: 'الرواتب',
    description: 'إعدادات الرواتب، المكافآت والحوافز، الخصومات والسلف، جدول الدوام، التقارير والسندات.',
    pages: [
      { key: 'payroll.settings', route: '/salaries/salariesSetting', label: 'إعدادات الرواتب' },
      { key: 'payroll.rewards', route: '/salaries/rewards', label: 'المكافآت والحوافز' },
      { key: 'payroll.discounts', route: '/salaries/discounts', label: 'الخصومات والسلف' },
      { key: 'payroll.timetable', route: '/salaries/timeTable', label: 'جدول الدوام' },
      { key: 'payroll.reports', route: '/salaries/payroll', label: 'تقارير الرواتب' },
      { key: 'payroll.vouchers', route: '/vouchers', label: 'السندات' },
    ],
  },
  {
    key: 'inventory',
    label: 'المخزن',
    description: 'الأصناف، الدفعات والصلاحية، الحركات، المخازن، المواقع والخانات، الجرد، الجودة ومؤشرات المخزن.',
    pages: [
      { key: 'inventory.products', route: '/inventory', label: 'الأصناف' },
      { key: 'inventory.batches', route: '/inventory/batches', label: 'الدفعات والصلاحية' },
      { key: 'inventory.expiry', route: '/inventory/expiry', label: 'لوحة الصلاحية' },
      { key: 'inventory.movements', route: '/inventory/movements', label: 'حركات المخزون' },
      { key: 'inventory.warehouses', route: '/inventory/warehouses', label: 'المخازن' },
      { key: 'inventory.locations', route: '/inventory/locations', label: 'المواقع والخانات' },
      { key: 'inventory.counts', route: '/inventory/counts', label: 'الجرد الدوري' },
      { key: 'inventory.quality', route: '/inventory/quality', label: 'فحص الجودة' },
      { key: 'inventory.analytics', route: '/wms/analytics', label: 'مؤشرات المخزن' },
    ],
  },
  {
    key: 'purchasing',
    label: 'المشتريات',
    description: 'أوامر الشراء وفواتير الشراء والموردون.',
    pages: [
      { key: 'purchasing.orders', route: '/purchasing', label: 'أوامر الشراء' },
      { key: 'purchasing.invoices', route: '/purchasing/invoices', label: 'فواتير الشراء' },
    ],
  },
  {
    key: 'sales',
    label: 'المبيعات',
    description: 'طلبات البيع وفواتير البيع والتسعير والضرائب.',
    pages: [
      { key: 'sales.orders', route: '/sales', label: 'طلبات البيع' },
      { key: 'sales.invoices', route: '/sales/invoices', label: 'فواتير البيع' },
      { key: 'sales.pricing', route: '/sales/pricing', label: 'التسعير والضرائب' },
    ],
  },
  {
    key: 'fulfillment',
    label: 'التجهيز والشحن',
    description: 'جولات الالتقاط والشحنات (تجهيز وتوصيل الطلبات).',
    pages: [
      { key: 'fulfillment.picking', route: '/fulfillment', label: 'جولات الالتقاط' },
      { key: 'fulfillment.shipments', route: '/fulfillment/shipments', label: 'الشحنات' },
    ],
  },
  {
    key: 'production',
    label: 'الإنتاج والتصنيع',
    description: 'أوامر الإنتاج وقوائم المواد (BOM) وحساب تكاليف الإنتاج.',
    pages: [
      { key: 'production.orders', route: '/wms/production', label: 'أوامر الإنتاج' },
      { key: 'production.bom', route: '/wms/production/bom', label: 'قوائم المواد (BOM)' },
    ],
  },
  {
    key: 'reps',
    label: 'المندوبون',
    description: 'إدارة المندوبين ومساحة المندوب: الطرقات والمحلات والمبيعات وجباية المندوب.',
    pages: [
      { key: 'reps.management', route: '/representatives', label: 'إدارة المندوبين' },
      { key: 'reps.workspace', route: '/representatives/workspace', label: 'مساحة المندوب' },
    ],
  },
  {
    key: 'wms',
    label: 'إعداد WMS',
    description: 'الخطوات الإرشادية لترتيب المخازن والمواد والخانات والأسعار.',
    pages: [{ key: 'wms.setup', route: '/wms/setup', label: 'إعداد WMS' }],
  },
  {
    key: 'imports',
    label: 'استيراد البيانات',
    description: 'استيراد الموظفين والأصناف بالجملة وتخزين الملفات.',
    pages: [
      { key: 'imports.data', route: '/importData', label: 'استيراد البيانات' },
      { key: 'imports.files', route: '/files', label: 'الملفات' },
    ],
  },
  {
    key: 'administration',
    label: 'الإدارة',
    description: 'الإعدادات، الربط مع الأنظمة الخارجية وسلة المهملات.',
    pages: [
      { key: 'admin.settings', route: '/settings', label: 'الإعدادات' },
      { key: 'admin.integrations', route: '/settings/integrations', label: 'الربط والتكامل' },
      { key: 'admin.trash', route: '/trash', label: 'سلة المهملات' },
    ],
  },
];

/** Every page key in the catalogue. This is what a new factory gets by default. */
export const ALL_PAGE_KEYS: string[] = MODULES.flatMap((m) => m.pages.map((p) => p.key));

/**
 * Pages that were added to the catalogue AFTER it first shipped.
 *
 * These routes were previously reachable by every factory with no entitlement
 * check at all — a buyer who never saw "الإنتاج" in a contract could still open
 * it. Making them sellable would silent-break every configured factory, so
 * EntitlementsService grants this exact list to factories on boot (idempotent).
 */
export const BACKFILL_PAGE_KEYS: string[] = [
  'production.orders',
  'production.bom',
  'reps.management',
  'reps.workspace',
  'wms.setup',
  'imports.files',
];

const PAGES_BY_KEY = new Map<string, PageDefinition>(
  MODULES.flatMap((m) => m.pages.map((p) => [p.key, p] as const)),
);

const MODULE_BY_KEY = new Map<string, ModuleDefinition>(MODULES.map((m) => [m.key, m]));

/** Routes that stay reachable regardless of entitlements. See the note above. */
export const ALWAYS_AVAILABLE_ROUTES = ['/home', '/login', '/clear-cache'];

export const isKnownPage = (key: string): boolean => PAGES_BY_KEY.has(key);

export const pageKeysForModule = (moduleKey: string): string[] =>
  MODULE_BY_KEY.get(moduleKey)?.pages.map((p) => p.key) ?? [];

/**
 * The page key a frontend route belongs to, or null when the route is not
 * gated. Longest route wins, so `/inventory/batches` does not match
 * `/inventory`.
 */
export function pageKeyForRoute(route: string): string | null {
  const normalised = route.replace(/\/+$/, '') || '/';

  let best: { key: string; length: number } | null = null;
  for (const page of PAGES_BY_KEY.values()) {
    if (normalised === page.route || normalised.startsWith(`${page.route}/`)) {
      if (!best || page.route.length > best.length) {
        best = { key: page.key, length: page.route.length };
      }
    }
  }

  return best?.key ?? null;
}

/**
 * How many of a module's pages a factory holds — so the UI can show a module as
 * fully on, fully off, or partially enabled rather than pretending it is binary.
 */
export function moduleState(
  moduleKey: string,
  enabledPages: ReadonlySet<string>,
): 'all' | 'none' | 'partial' {
  const keys = pageKeysForModule(moduleKey);
  if (keys.length === 0) return 'none';

  const on = keys.filter((k) => enabledPages.has(k)).length;
  if (on === 0) return 'none';
  return on === keys.length ? 'all' : 'partial';
}