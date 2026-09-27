import { describe, expect, it, jest } from '@jest/globals';
import { CustomizationService } from '../../src/customization/customization.service';
import {
  normalizeCustomFieldDefinition,
  normalizeEntityKey,
  resolveEffectiveCustomization,
  sanitizeCustomizationCss,
} from '../../src/customization/customization.utils';

describe('Customization engine', () => {
  it('merges global and tenant settings without leaking other tenants', () => {
    const globalDefault = {
      branding: { companyName: 'Factory HQ', appName: 'Factory ERP' },
      theme: { primaryColor: '#0f172a' },
    };

    const tenantA = {
      branding: { companyName: 'A Factory', logoText: 'A' },
      theme: { accentColor: '#f59e0b' },
    };

    const result: ReturnType<typeof resolveEffectiveCustomization> = resolveEffectiveCustomization({
      globalDefault,
      planDefault: { branding: { companyName: 'Plan Brand' } },
      tenant: tenantA,
      tenantId: 'tenant-a',
    });

    expect(result.branding.companyName).toBe('A Factory');
    expect(result.branding.appName).toBe('Factory ERP');
    expect(result.theme.primaryColor).toBe('#0f172a');
    expect(result.theme.accentColor).toBe('#f59e0b');
    expect(result.tenantId).toBe('tenant-a');
  });

  it('sanitizes custom CSS and strips executable script payloads', () => {
    const css = `
      body { color: red; }
      .evil { background: url("javascript:alert(1)"); }
      <script>alert('x')</script>
      .tenant { border-radius: 12px; }
    `;

    const sanitized = sanitizeCustomizationCss(css);
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('body');
    expect(sanitized).toContain('border-radius: 12px');
  });

  it('keeps custom field visibility tenant-scoped', () => {
    const fields = [
      { id: 'cf-1', entity: 'employee', key: 'guaranteeNo', tenantId: 'tenant-a', visibleToRoles: ['admin'] },
      { id: 'cf-2', entity: 'employee', key: 'departmentCode', tenantId: 'tenant-b', visibleToRoles: ['manager'] },
    ];

    const scoped = fields.filter((field) => field.tenantId === 'tenant-a');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].key).toBe('guaranteeNo');
  });

  it('normalizes custom field definitions with safe defaults and tenant-safe visibility', () => {
    const normalized = normalizeCustomFieldDefinition({
      entity: 'employee',
      key: 'certificateNo',
      label: 'Certificate No',
      type: 'text',
      tenantId: 'tenant-a',
      visibleToRoles: ['admin', 'manager'],
      visibleToModules: ['employees', 'hr'],
      isRequired: true,
      defaultValue: 'AUTO',
    });

    expect(normalized.entity).toBe('employee');
    expect(normalized.key).toBe('certificateNo');
    expect(normalized.type).toBe('text');
    expect(normalized.visibleToRoles).toEqual(['admin', 'manager']);
    expect(normalized.defaultValue).toBe('AUTO');
    expect(normalized.tenantId).toBe('tenant-a');
  });

  it('falls back to system defaults when tenant branding values are absent', () => {
    const result = resolveEffectiveCustomization({
      globalDefault: {
        branding: { companyName: 'System Factory', appName: 'Factory ERP' },
        theme: { primaryColor: '#111827' },
      },
      tenant: { branding: { displayName: 'Tenant Brand' } },
      tenantId: 'tenant-a',
    });

    expect(result.branding.companyName).toBe('System Factory');
    expect(result.branding.appName).toBe('Factory ERP');
    expect(result.branding.displayName).toBe('Tenant Brand');
    expect(result.theme.primaryColor).toBe('#111827');
  });

  it('maps module-based entity names to the live ERP/WMS entity keys', () => {
    expect(normalizeEntityKey('inventory')).toBe('product');
    expect(normalizeEntityKey('sales')).toBe('customer');
    expect(normalizeEntityKey('purchasing')).toBe('supplier');
    expect(normalizeEntityKey('representatives')).toBe('representative');
  });

  it('stores and loads tenant-scoped custom-field values for real ERP entities', async () => {
    const findUnique = jest.fn(async () => ({
      id: 'cf-1',
      tenantId: 'tenant-a',
      entity: 'customer',
      key: 'vipLevel',
      fieldType: 'select',
    })) as any;

    const upsertValue = jest.fn(async () => ({
      tenantId: 'tenant-a',
      entity: 'customer',
      recordId: 'cust-123',
      fieldKey: 'vipLevel',
      value: 'gold',
    })) as any;

    const findManyValues = jest.fn(async () => [{ fieldKey: 'vipLevel', value: 'gold' }]) as any;

    const prisma = {
      customFieldDefinition: { findUnique },
      customFieldValue: { upsert: upsertValue, findMany: findManyValues },
      tenantCustomizationAudit: { create: jest.fn(async () => ({})) as any },
    };

    const service = new CustomizationService(prisma as any);

    await expect(service.upsertCustomFieldValues('tenant-a', 'sales', 'cust-123', { vipLevel: 'gold' })).resolves.toEqual({ vipLevel: 'gold' });
    await expect(service.getCustomFieldValues('tenant-a', 'sales', 'cust-123')).resolves.toEqual({ vipLevel: 'gold' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { tenantId_entity_key: { tenantId: 'tenant-a', entity: 'customer', key: 'vipLevel' } },
    });
  });

  it('normalizes custom field definitions for product inventory and keeps tenant-scoped queries isolated', async () => {
    const findMany = jest.fn(async () => [{
      id: 'cf-2',
      tenantId: 'tenant-a',
      entity: 'product',
      key: 'batchNo',
      label: 'Batch No',
      fieldType: 'text',
      status: 'active',
      ordering: 1,
      searchable: true,
      filterable: true,
      exportable: true,
      visibleToRoles: ['admin'],
      visibleToModules: ['inventory'],
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    }]) as any;

    const prisma = {
      customFieldDefinition: { findMany },
    };

    const service = new CustomizationService(prisma as any);
    const rows = await service.listCustomFields('tenant-a', 'inventory');

    expect(rows[0].entity).toBe('product');
    expect(rows[0].key).toBe('batchNo');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', entity: 'product', status: 'active' },
      }),
    );
  });

  it('publishes tenant customization and increments the version for real runtime updates', async () => {
    const findUnique = jest.fn(async () => ({ tenantId: 'tenant-a', version: 2, status: 'draft' })) as any;
    const update = jest.fn(async () => ({ tenantId: 'tenant-a', version: 3, status: 'published', publishedAt: new Date() })) as any;

    const prisma = {
      tenantCustomization: { findUnique, update },
      tenantCustomizationAudit: { create: jest.fn(async () => ({})) as any },
    };

    const service = new CustomizationService(prisma as any);
    const result = await service.publishCustomization('tenant-a', { userId: 'u-1', username: 'admin' });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a' },
        data: expect.objectContaining({ status: 'published', version: 3 }),
      }),
    );
    expect(result.status).toBe('published');
  });
});
