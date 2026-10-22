/**
 * صلاحيات النظام — the permission vocabulary the whole product speaks.
 *
 * ── Why a vocabulary and not a boolean per screen ────────────────────────────
 * The factory pages (entitlements) answer "what did this factory buy?".
 * Permissions answer a different question: "what may this PERSON do with it?".
 * A factory can sell the production module to an accountant who must only read
 * it, and to a production manager who must run it — same page, opposite verbs.
 * So every guarded endpoint declares a verb, and a role is a bag of verbs.
 *
 * ── The verb vocabulary ─────────────────────────────────────────────────────
 * Naming follows what the codebase already used (`view_x` / `edit_x` /
 * `delete_x` / `manage_x`), extended with the four verbs the brief calls out
 * explicitly and that the old flat list could not express:
 *
 *   post_x    move a document to a terminal state (ترحيل) — idempotent
 *   cancel_x  void a document without deleting it
 *   close_x   close a financial period (إغلاق) — not reversible by an edit
 *   print_x   produce a printout or an export
 *
 * ── Why role names are fixed strings ────────────────────────────────────────
 * The three roles below are seeded into the `roles` table (permissions is a
 * `String[]` column on that row), and the JWT carries the role's permission
 * list. Seeding is idempotent, so re-running it after a permission change
 * upgrades existing accounts instead of stranding them with a stale list.
 * See RolesService.
 */

/** The three first-class roles the product ships with. */
export const ROLE_ADMIN = 'admin';
export const ROLE_ACCOUNTANT = 'accountant';
export const ROLE_PRODUCTION_MANAGER = 'production_manager';

/**
 * The wildcard. A holder passes every tenant-scoped permission check.
 *
 * It is a permission like any other, so it lives in the same `String[]`
 * column and needs no special-casing in the guard beyond one `includes`.
 */
export const PERM_ADMIN_ALL = 'admin_all';

// ─── HR ──────────────────────────────────────────────────────────────────────
export const PERM_VIEW_EMPLOYEES = 'view_employees';
export const PERM_EDIT_EMPLOYEES = 'edit_employees';
export const PERM_DELETE_EMPLOYEES = 'delete_employees';
export const PERM_VIEW_ATTENDANCE = 'view_attendance';
export const PERM_EDIT_ATTENDANCE = 'edit_attendance';
export const PERM_VIEW_DEVICES = 'view_devices';
export const PERM_MANAGE_DEVICES = 'manage_devices';
export const PERM_MANAGE_USERS = 'manage_users';

// ─── Payroll ─────────────────────────────────────────────────────────────────
export const PERM_VIEW_PAYROLL = 'view_payroll';
export const PERM_RUN_PAYROLL = 'run_payroll';
export const PERM_APPROVE_PAYROLL = 'approve_payroll';
export const PERM_DELETE_PAYROLL = 'delete_payroll';
export const PERM_MANAGE_SALARY = 'manage_salary';
export const PERM_MANAGE_ADVANCES = 'manage_advances';
export const PERM_MANAGE_INSURANCE = 'manage_insurance';
export const PERM_MANAGE_BONUSES = 'manage_bonuses';
export const PERM_MANAGE_PENALTIES = 'manage_penalties';

// ─── Inventory ───────────────────────────────────────────────────────────────
export const PERM_VIEW_INVENTORY = 'view_inventory';
export const PERM_EDIT_INVENTORY = 'edit_inventory';
export const PERM_DELETE_INVENTORY = 'delete_inventory';
export const PERM_PRINT_INVENTORY = 'print_inventory';
export const PERM_VIEW_BATCHES = 'view_batches';
export const PERM_EDIT_BATCHES = 'edit_batches';
export const PERM_VIEW_FULFILLMENT = 'view_fulfillment';
export const PERM_EDIT_FULFILLMENT = 'edit_fulfillment';
export const PERM_TRANSFER_STOCK = 'transfer_stock';

// ─── Purchasing / purchase invoices ──────────────────────────────────────────
export const PERM_VIEW_PURCHASING = 'view_purchasing';
export const PERM_EDIT_PURCHASING = 'edit_purchasing';
export const PERM_DELETE_PURCHASING = 'delete_purchasing';
export const PERM_POST_PURCHASING = 'post_purchasing';
export const PERM_CANCEL_PURCHASING = 'cancel_purchasing';
export const PERM_PRINT_PURCHASING = 'print_purchasing';

// ─── Sales ───────────────────────────────────────────────────────────────────
export const PERM_VIEW_SALES = 'view_sales';
export const PERM_EDIT_SALES = 'edit_sales';
export const PERM_DELETE_SALES = 'delete_sales';
export const PERM_POST_SALES = 'post_sales';
export const PERM_PRINT_SALES = 'print_sales';

// ─── Accounting ──────────────────────────────────────────────────────────────
export const PERM_VIEW_ACCOUNTING = 'view_accounting';
export const PERM_EDIT_ACCOUNTING = 'edit_accounting';
export const PERM_DELETE_ACCOUNTING = 'delete_accounting';
export const PERM_POST_ACCOUNTING = 'post_accounting';
export const PERM_CLOSE_ACCOUNTING = 'close_accounting';
export const PERM_PRINT_ACCOUNTING = 'print_accounting';
export const PERM_MANAGE_EXCHANGE_RATES = 'manage_exchange_rates';

// ─── Transportation (buses) ──────────────────────────────────────────────────
export const PERM_VIEW_TRANSPORTATION = 'view_transportation';
export const PERM_EDIT_TRANSPORTATION = 'edit_transportation';
export const PERM_DELETE_TRANSPORTATION = 'delete_transportation';
export const PERM_PRINT_TRANSPORTATION = 'print_transportation';
export const PERM_MANAGE_TRANSPORTATION = 'manage_transportation';

// ─── Production ──────────────────────────────────────────────────────────────
export const PERM_VIEW_PRODUCTION = 'view_production';
export const PERM_CREATE_PRODUCTION = 'create_production';
export const PERM_EDIT_PRODUCTION = 'edit_production';
export const PERM_DELETE_PRODUCTION = 'delete_production';
export const PERM_POST_PRODUCTION = 'post_production';
export const PERM_PRINT_PRODUCTION = 'print_production';
export const PERM_MANAGE_PRODUCTION_WAREHOUSES = 'manage_production_warehouses';

// ─── Settings / administration ───────────────────────────────────────────────
export const PERM_VIEW_IMPORTS = 'view_imports';
export const PERM_RUN_IMPORTS = 'run_imports';
export const PERM_MANAGE_TRASH = 'manage_trash';
export const PERM_MANAGE_BACKUPS = 'manage_backups';
export const PERM_MANAGE_SETTINGS = 'manage_settings';
export const PERM_NOTIFICATIONS_VIEW = 'notifications.view';

/** Every permission the system defines — used to seed and to validate. */
export const ALL_PERMISSIONS: string[] = [
  PERM_ADMIN_ALL,
  PERM_VIEW_EMPLOYEES,
  PERM_EDIT_EMPLOYEES,
  PERM_DELETE_EMPLOYEES,
  PERM_VIEW_ATTENDANCE,
  PERM_EDIT_ATTENDANCE,
  PERM_MANAGE_DEVICES,
  PERM_MANAGE_USERS,
  PERM_VIEW_PAYROLL,
  PERM_RUN_PAYROLL,
  PERM_APPROVE_PAYROLL,
  PERM_DELETE_PAYROLL,
  PERM_MANAGE_SALARY,
  PERM_MANAGE_ADVANCES,
  PERM_MANAGE_INSURANCE,
  PERM_MANAGE_BONUSES,
  PERM_MANAGE_PENALTIES,
  PERM_VIEW_INVENTORY,
  PERM_EDIT_INVENTORY,
  PERM_DELETE_INVENTORY,
  PERM_PRINT_INVENTORY,
  PERM_VIEW_BATCHES,
  PERM_EDIT_BATCHES,
  PERM_VIEW_FULFILLMENT,
  PERM_EDIT_FULFILLMENT,
  PERM_TRANSFER_STOCK,
  PERM_VIEW_PURCHASING,
  PERM_EDIT_PURCHASING,
  PERM_DELETE_PURCHASING,
  PERM_POST_PURCHASING,
  PERM_CANCEL_PURCHASING,
  PERM_PRINT_PURCHASING,
  PERM_VIEW_SALES,
  PERM_EDIT_SALES,
  PERM_DELETE_SALES,
  PERM_POST_SALES,
  PERM_PRINT_SALES,
  PERM_VIEW_ACCOUNTING,
  PERM_EDIT_ACCOUNTING,
  PERM_DELETE_ACCOUNTING,
  PERM_POST_ACCOUNTING,
  PERM_CLOSE_ACCOUNTING,
  PERM_PRINT_ACCOUNTING,
  PERM_MANAGE_EXCHANGE_RATES,
  PERM_VIEW_TRANSPORTATION,
  PERM_EDIT_TRANSPORTATION,
  PERM_DELETE_TRANSPORTATION,
  PERM_PRINT_TRANSPORTATION,
  PERM_MANAGE_TRANSPORTATION,
  PERM_VIEW_PRODUCTION,
  PERM_EDIT_PRODUCTION,
  PERM_DELETE_PRODUCTION,
  PERM_POST_PRODUCTION,
  PERM_PRINT_PRODUCTION,
  PERM_MANAGE_PRODUCTION_WAREHOUSES,
  PERM_VIEW_IMPORTS,
  PERM_RUN_IMPORTS,
  PERM_MANAGE_TRASH,
  PERM_MANAGE_BACKUPS,
  PERM_MANAGE_SETTINGS,
  PERM_NOTIFICATIONS_VIEW,
];

/**
 * The factory Admin: full control over its own factory.
 *
 * `admin_all` is the wildcard the PermissionsGuard honours, so a factory that
 * later gains a module gets that module's verbs without a reseed. The legacy
 * explicit list is kept alongside it so a role row written before the
 * wildcard existed still grants everything it used to.
 */
export const ADMIN_PERMISSIONS: string[] = [
  PERM_ADMIN_ALL,
  PERM_VIEW_EMPLOYEES,
  PERM_EDIT_EMPLOYEES,
  PERM_DELETE_EMPLOYEES,
  PERM_VIEW_DEVICES,
  PERM_MANAGE_DEVICES,
  PERM_MANAGE_USERS,
  PERM_VIEW_ATTENDANCE,
  PERM_EDIT_ATTENDANCE,
  PERM_VIEW_PAYROLL,
  PERM_RUN_PAYROLL,
  PERM_APPROVE_PAYROLL,
  PERM_DELETE_PAYROLL,
  PERM_VIEW_INVENTORY,
  PERM_EDIT_INVENTORY,
  PERM_DELETE_INVENTORY,
  PERM_VIEW_IMPORTS,
  PERM_RUN_IMPORTS,
  PERM_MANAGE_SALARY,
  PERM_MANAGE_ADVANCES,
  PERM_MANAGE_INSURANCE,
  PERM_MANAGE_BONUSES,
  PERM_MANAGE_PENALTIES,
  PERM_MANAGE_TRASH,
  PERM_MANAGE_BACKUPS,
  PERM_MANAGE_SETTINGS,
  PERM_VIEW_PURCHASING,
  PERM_EDIT_PURCHASING,
  PERM_DELETE_PURCHASING,
  PERM_POST_PURCHASING,
  PERM_CANCEL_PURCHASING,
  PERM_PRINT_PURCHASING,
  PERM_VIEW_SALES,
  PERM_EDIT_SALES,
  PERM_DELETE_SALES,
  PERM_POST_SALES,
  PERM_PRINT_SALES,
  PERM_VIEW_ACCOUNTING,
  PERM_EDIT_ACCOUNTING,
  PERM_DELETE_ACCOUNTING,
  PERM_POST_ACCOUNTING,
  PERM_CLOSE_ACCOUNTING,
  PERM_PRINT_ACCOUNTING,
  PERM_MANAGE_EXCHANGE_RATES,
  PERM_VIEW_TRANSPORTATION,
  PERM_EDIT_TRANSPORTATION,
  PERM_DELETE_TRANSPORTATION,
  PERM_PRINT_TRANSPORTATION,
  PERM_MANAGE_TRANSPORTATION,
  PERM_VIEW_PRODUCTION,
  PERM_EDIT_PRODUCTION,
  PERM_DELETE_PRODUCTION,
  PERM_POST_PRODUCTION,
  PERM_PRINT_PRODUCTION,
  PERM_MANAGE_PRODUCTION_WAREHOUSES,
  PERM_TRANSFER_STOCK,
  PERM_VIEW_BATCHES,
  PERM_EDIT_BATCHES,
  PERM_VIEW_FULFILLMENT,
  PERM_EDIT_FULFILLMENT,
  PERM_NOTIFICATIONS_VIEW,
];

/**
 * The Accountant: owns the money, reads the production it is costing.
 *
 * Full control over accounting, invoices and financial reports, including
 * closing a financial period. Read-only on production — the brief is explicit
 * that an accountant may cost a batch but never run a cutting table. No
 * production management, no stage changes, no stock transfers out of a
 * production warehouse, no editing exchange rates.
 */
export const ACCOUNTANT_PERMISSIONS: string[] = [
  PERM_VIEW_ACCOUNTING,
  PERM_EDIT_ACCOUNTING,
  PERM_DELETE_ACCOUNTING,
  PERM_POST_ACCOUNTING,
  PERM_CLOSE_ACCOUNTING,
  PERM_PRINT_ACCOUNTING,

  PERM_VIEW_PURCHASING,
  PERM_EDIT_PURCHASING,
  PERM_POST_PURCHASING,
  PERM_CANCEL_PURCHASING,
  PERM_PRINT_PURCHASING,

  PERM_VIEW_SALES,
  PERM_EDIT_SALES,
  PERM_POST_SALES,
  PERM_PRINT_SALES,

  PERM_VIEW_INVENTORY,
  PERM_PRINT_INVENTORY,
  PERM_VIEW_BATCHES,
  PERM_VIEW_FULFILLMENT,

  // الوصول إلى بيانات النقل والتكاليف والتقارير المالية المرتبطة به
  PERM_VIEW_TRANSPORTATION,
  PERM_PRINT_TRANSPORTATION,

  // قراءة الإنتاج فقط — لا إدارة ولا تعديل مراحل
  PERM_VIEW_PRODUCTION,
  PERM_PRINT_PRODUCTION,
];

/**
 * The Production Manager: runs the factory floor, reads the money.
 *
 * Full control over production batches, stages and the production
 * warehouses. Read-only on accounting — the brief allows an explicitly
 * permitted accounting read, but never editing an invoice, editing an
 * exchange rate, or closing a financial period.
 */
export const PRODUCTION_MANAGER_PERMISSIONS: string[] = [
  PERM_VIEW_PRODUCTION,
  PERM_CREATE_PRODUCTION,
  PERM_EDIT_PRODUCTION,
  PERM_DELETE_PRODUCTION,
  PERM_POST_PRODUCTION,
  PERM_PRINT_PRODUCTION,
  PERM_MANAGE_PRODUCTION_WAREHOUSES,
  PERM_TRANSFER_STOCK,

  // قراءة المحاسبة والمخزون والنقل دون أي تعديل
  PERM_VIEW_ACCOUNTING,
  PERM_PRINT_ACCOUNTING,
  PERM_VIEW_INVENTORY,
  PERM_VIEW_BATCHES,
  PERM_VIEW_TRANSPORTATION,
  PERM_PRINT_INVENTORY,
];

/** The permission set seeded for each first-class role. */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  [ROLE_ADMIN]: ADMIN_PERMISSIONS,
  [ROLE_ACCOUNTANT]: ACCOUNTANT_PERMISSIONS,
  [ROLE_PRODUCTION_MANAGER]: PRODUCTION_MANAGER_PERMISSIONS,
};

/**
 * Whether a permission list grants a requested permission.
 *
 * `admin_all` is the wildcard. It is checked here rather than in the guard so
 * every caller — guard, service-level checks, and the frontend mirror — agrees
 * on one definition of "full access".
 */
export function hasPermission(
  granted: readonly string[] | undefined | null,
  required: string,
): boolean {
  if (!granted || granted.length === 0) return false;
  if (granted.includes(PERM_ADMIN_ALL)) return true;
  if (granted.includes(required)) return true;
  return false;
}
