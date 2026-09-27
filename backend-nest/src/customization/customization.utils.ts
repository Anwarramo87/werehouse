export type DeepRecord = Record<string, unknown>;

export type CustomizationBranding = {
  companyName?: string;
  displayName?: string;
  appName?: string;
  primaryLogoUrl?: string;
  darkLogoUrl?: string;
  faviconUrl?: string;
  appIconUrl?: string;
  loginBackgroundUrl?: string;
  welcomeText?: string;
  contactEmail?: string;
  phone?: string;
  address?: string;
};

export type CustomizationTheme = {
  mode?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  background?: string;
  surface?: string;
  card?: string;
  text?: string;
  mutedText?: string;
  border?: string;
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
  sidebar?: string;
  header?: string;
  buttons?: string;
  tables?: string;
  inputs?: string;
  badges?: string;
  charts?: string;
  focus?: string;
  borderRadius?: number;
  shadowStyle?: string;
  density?: string;
  typographyScale?: string;
  fontPreset?: string;
  customCss?: string;
};

export type CustomFieldDefinition = {
  id?: string;
  tenantId?: string | null;
  entity: string;
  key: string;
  label: string;
  fieldType: string;
  type?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: unknown;
  validation?: Record<string, unknown>;
  ordering?: number;
  searchable?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  visibleToRoles?: string[];
  visibleToModules?: string[];
  status?: string;
};

export type EffectiveCustomization = {
  branding: CustomizationBranding;
  theme: CustomizationTheme;
  tenantId: string | null;
  [key: string]: unknown;
};

export function normalizeEntityKey(entity: unknown): string {
  const cleaned = String(entity ?? 'general').trim().replace(/[_\-\s]+/g, '').toLowerCase();
  if (!cleaned) return 'general';

  const aliases: Record<string, string> = {
    employee: 'employee',
    employees: 'employee',
    customer: 'customer',
    customers: 'customer',
    sales: 'customer',
    supplier: 'supplier',
    suppliers: 'supplier',
    purchasing: 'supplier',
    product: 'product',
    products: 'product',
    inventory: 'product',
    item: 'product',
    items: 'product',
    representative: 'representative',
    representatives: 'representative',
    user: 'user',
    users: 'user',
    general: 'general',
  };

  return aliases[cleaned] ?? cleaned;
}

export function normalizeCustomFieldDefinition(input: Record<string, unknown> = {}): CustomFieldDefinition {
  const entity = normalizeEntityKey(input.entity);
  const label = String(input.label ?? input.key ?? 'Custom Field').trim();
  const rawKey = String(input.key ?? '').trim();
  const key = rawKey || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `field_${Date.now()}`;
  const rawFieldType = typeof input.fieldType === 'string' ? input.fieldType : typeof input.type === 'string' ? input.type : 'text';
  const visibleToRoles = Array.isArray(input.visibleToRoles)
    ? [...new Set((input.visibleToRoles as unknown[]).filter((v): v is string => typeof v === 'string'))]
    : [];
  const visibleToModules = Array.isArray(input.visibleToModules)
    ? [...new Set((input.visibleToModules as unknown[]).filter((v): v is string => typeof v === 'string'))]
    : [];

  const fieldType = ['text', 'textarea', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select', 'file', 'url', 'relation'].includes(rawFieldType)
    ? rawFieldType
    : 'text';

  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    tenantId: typeof input.tenantId === 'string' ? input.tenantId : null,
    entity,
    key,
    label,
    fieldType,
    type: fieldType,
    description: typeof input.description === 'string' ? input.description : undefined,
    placeholder: typeof input.placeholder === 'string' ? input.placeholder : undefined,
    required: Boolean(input.required || input.isRequired),
    defaultValue: Object.prototype.hasOwnProperty.call(input, 'defaultValue') ? input.defaultValue : undefined,
    validation: isPlainObject(input.validation) ? (input.validation as Record<string, unknown>) : {},
    ordering: Number(input.ordering ?? 0),
    searchable: Boolean(input.searchable),
    filterable: Boolean(input.filterable),
    exportable: Boolean(input.exportable),
    visibleToRoles,
    visibleToModules,
    status: typeof input.status === 'string' ? input.status : 'active',
  };
}

export function normalizeCustomFieldValueForStorage(value: unknown, fieldType: string = 'text'): unknown {
  if (value === undefined || value === null) return null;

  switch (fieldType) {
    case 'number':
    case 'currency': {
      if (typeof value === 'string') {
        const numeric = Number(value.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(numeric) ? numeric : null;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      return null;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
      return Boolean(value);
    case 'date': {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'string') return value;
      return String(value);
    }
    case 'multi_select':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
      return [value];
    case 'select':
      if (Array.isArray(value)) return value[0] ?? null;
      return value;
    default:
      return value;
  }
}

export function deepMerge<T>(base: T, override?: Partial<T> | null): T {
  if (!override || typeof override !== 'object') {
    return base;
  }

  const result = Array.isArray(base)
    ? [...(base as unknown[])]
    : ({ ...(base as Record<string, unknown>) } as Record<string, unknown>);

  if (Array.isArray(result)) {
    return deepMerge(result as unknown as T, override as Partial<T> | null);
  }

  const objectResult = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue;

    const current = objectResult[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      objectResult[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }

    objectResult[key] = value;
  }

  return objectResult as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function sanitizeCustomizationCss(css: string | null | undefined): string {
  if (!css) return '';

  const normalized = String(css)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/url\s*\(\s*(['"]?)\s*(?:javascript:|vbscript:|data\s*:\s*text\/html)/gi, 'url()')
    .replace(/expression\s*\(/gi, '')
    .replace(/\s+on[a-z0-9-]+\s*:/gi, ' ');

  return normalized.replace(/javascript\s*:/gi, '');
}

export function resolveEffectiveCustomization(params: {
  globalDefault?: Record<string, unknown> | null;
  planDefault?: Record<string, unknown> | null;
  tenant?: Record<string, unknown> | null;
  tenantId?: string | null;
}): EffectiveCustomization {
  const merged = deepMerge(
    deepMerge({} as Record<string, unknown>, params.globalDefault ?? {}),
    params.planDefault ?? {},
  );

  const tenantScoped = deepMerge(merged, params.tenant ?? {});
  const brandingSource = (tenantScoped.branding as Record<string, unknown> | undefined) ?? {};
  const branding = {
    ...((params.globalDefault?.branding as Record<string, unknown> | undefined) ?? {}),
    ...((params.planDefault?.branding as Record<string, unknown> | undefined) ?? {}),
    ...brandingSource,
    companyName:
      (brandingSource.companyName as string | undefined) ??
      ((params.globalDefault?.branding as Record<string, unknown> | undefined)?.companyName as string | undefined) ??
      'Factory',
    displayName:
      (brandingSource.displayName as string | undefined) ??
      ((params.globalDefault?.branding as Record<string, unknown> | undefined)?.displayName as string | undefined) ??
      'Factory ERP',
    appName:
      (brandingSource.appName as string | undefined) ??
      (brandingSource.displayName as string | undefined) ??
      (brandingSource.companyName as string | undefined) ??
      ((params.globalDefault?.branding as Record<string, unknown> | undefined)?.appName as string | undefined) ??
      'Factory ERP',
  } as CustomizationBranding;

  const theme = {
    ...((params.globalDefault?.theme as Record<string, unknown> | undefined) ?? {}),
    ...((params.planDefault?.theme as Record<string, unknown> | undefined) ?? {}),
    ...((tenantScoped.theme as Record<string, unknown> | undefined) ?? {}),
  } as CustomizationTheme;

  return {
    ...tenantScoped,
    branding,
    theme,
    tenantId: params.tenantId ?? null,
  };
}

export const baseCustomizationState = () => ({
  status: 'draft',
  version: 1,
  branding: {
    companyName: 'Factory',
    displayName: 'Factory ERP',
    appName: 'Factory ERP',
    primaryLogoUrl: '',
    darkLogoUrl: '',
    faviconUrl: '',
    appIconUrl: '',
    loginBackgroundUrl: '',
    welcomeText: 'مرحباً بك في نظام المعمل',
    contactEmail: '',
    phone: '',
    address: '',
  },
  theme: {
    mode: 'light',
    primaryColor: '#0f172a',
    secondaryColor: '#475569',
    accentColor: '#c89355',
    background: '#f8fafc',
    surface: '#ffffff',
    card: '#ffffff',
    text: '#0f172a',
    mutedText: '#64748b',
    border: '#e2e8f0',
    success: '#16a34a',
    warning: '#f59e0b',
    error: '#dc2626',
    info: '#0ea5e9',
    sidebar: '#1f2937',
    header: '#ffffff',
    buttons: '#0f172a',
    tables: '#f8fafc',
    inputs: '#ffffff',
    badges: '#e2e8f0',
    charts: '#c89355',
    focus: '#2563eb',
    borderRadius: 16,
    shadowStyle: 'soft',
    density: 'comfortable',
    typographyScale: 'medium',
    fontPreset: 'system',
    customCss: '',
  },
  layout: {
    sidebarPosition: 'right',
    sidebarStyle: 'modern',
    sidebarCollapsed: false,
    headerStyle: 'compact',
    contentWidth: 'wide',
    pageSpacing: 'comfortable',
    cardLayout: 'grid',
    tableDensity: 'comfortable',
    breadcrumbVisible: true,
    pageHeaderStyle: 'standard',
    tabsMode: 'underline',
    actionBar: 'top',
    quickActions: true,
  },
  navigation: {
    modules: [],
    sections: [],
    defaultRoute: '/dashboard',
    visibleByRole: {},
  },
  dashboard: {
    widgets: [],
    columns: 12,
    views: {},
  },
  customFields: [],
  terminology: {
    products: 'منتجات',
    customers: 'عملاء',
    representatives: 'مناديب',
  },
  documents: {
    invoiceHeader: '',
    invoiceFooter: '',
    reportTitle: '',
    printTheme: 'standard',
  },
  settings: {
    mode: 'light',
    autoMode: true,
    sandbox: false,
    customCss: '',
  },
});
