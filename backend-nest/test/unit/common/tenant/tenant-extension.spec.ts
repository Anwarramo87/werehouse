import { assertTenantNamed } from '../../../../src/common/tenant/tenant-extension';

const FACTORY = 'aaaaaaa1-0000-4000-8000-00000000000a';

/*
 * The super admin's queries bypass tenant filtering, which is right for reads
 * but silently wrong for creates: nothing gets stamped, the row lands with
 * tenantId NULL, and it is then invisible to every factory — including the one
 * that meant to own it. Production carried four such orphaned attendance rows.
 */
describe('assertTenantNamed — super admin creates', () => {
  it('rejects a create that never names a factory', () => {
    expect(() =>
      assertTenantNamed('Employee', 'create', { data: { name: 'A' } }),
    ).toThrow(/without a tenantId/);
  });

  it('accepts a create that names one', () => {
    expect(() =>
      assertTenantNamed('Employee', 'create', {
        data: { name: 'A', tenantId: FACTORY },
      }),
    ).not.toThrow();
  });

  it('accepts a deliberate null — restoring a legacy snapshot reproduces it', () => {
    expect(() =>
      assertTenantNamed('User', 'create', {
        data: { username: 'superadmin', tenantId: null },
      }),
    ).not.toThrow();
  });

  it('rejects a createMany where any row is silent', () => {
    expect(() =>
      assertTenantNamed('Product', 'createMany', {
        data: [{ sku: 'A', tenantId: FACTORY }, { sku: 'B' }],
      }),
    ).toThrow(/without a tenantId/);
  });

  it('accepts a createMany where every row names a factory', () => {
    expect(() =>
      assertTenantNamed('Product', 'createMany', {
        data: [{ sku: 'A', tenantId: FACTORY }, { sku: 'B', tenantId: FACTORY }],
      }),
    ).not.toThrow();
  });

  it('checks the create half of an upsert, not the update half', () => {
    expect(() =>
      assertTenantNamed('Product', 'upsert', {
        where: { id: '1' },
        create: { sku: 'A' },
        update: { sku: 'A' },
      }),
    ).toThrow(/without a tenantId/);

    expect(() =>
      assertTenantNamed('Product', 'upsert', {
        where: { id: '1' },
        create: { sku: 'A', tenantId: FACTORY },
        update: { sku: 'A' },
      }),
    ).not.toThrow();
  });
});
