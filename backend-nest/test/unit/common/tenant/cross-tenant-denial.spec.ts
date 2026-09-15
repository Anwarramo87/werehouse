import { applyTenantScope } from '../../../../src/common/tenant/tenant-extension';

const ACME = 'aaaaaaa1-0000-4000-8000-00000000000a';
const RIVAL = 'bbbbbbb2-0000-4000-8000-00000000000b';

const asAcme = { tenantId: ACME, bypass: false };
const asRival = { tenantId: RIVAL, bypass: false };
const asSuperAdmin = { tenantId: null, bypass: true };

/*
 * One factory's admin must not be able to read, change or delete another
 * factory's rows by ANY route — including by naming the other factory
 * explicitly in the query, which is the obvious attempt.
 *
 * These assert on the args actually handed to Prisma. A `where` that carries
 * the caller's own tenantId cannot match another factory's row, so "denial"
 * here means "narrowed until it cannot match", not an exception.
 */
describe('cross-tenant denial', () => {
  describe('reads', () => {
    it.each(['findFirst', 'findMany', 'findUnique', 'count', 'aggregate', 'groupBy'])(
      '%s is narrowed to the caller’s factory',
      (operation) => {
        const out = applyTenantScope('Employee', operation, {}, asAcme);
        expect(out.where).toEqual({ tenantId: ACME });
      },
    );

    it('overrides a tenantId the caller supplied, rather than trusting it', () => {
      // The direct attempt: ask for the rival's rows by name.
      const out = applyTenantScope(
        'Employee',
        'findMany',
        { where: { tenantId: RIVAL, status: 'active' } },
        asAcme,
      );

      expect(out.where).toEqual({ tenantId: ACME, status: 'active' });
    });

    it('keeps a foreign id in the filter but pins the factory, so nothing matches', () => {
      // Reading a known row id from another factory: the id survives, the
      // tenantId is forced, and the pair cannot exist.
      const out = applyTenantScope(
        'Employee',
        'findUnique',
        { where: { id: 'a-row-owned-by-the-rival' } },
        asAcme,
      );

      expect(out.where).toMatchObject({ id: 'a-row-owned-by-the-rival', tenantId: ACME });
    });

    it('narrows the two admins differently for the identical query', () => {
      const query = { where: { status: 'active' } };
      const acme = applyTenantScope('Employee', 'findMany', { ...query }, asAcme);
      const rival = applyTenantScope('Employee', 'findMany', { ...query }, asRival);

      expect((acme.where as Record<string, unknown>).tenantId).toBe(ACME);
      expect((rival.where as Record<string, unknown>).tenantId).toBe(RIVAL);
    });
  });

  describe('writes', () => {
    it('stamps a create with the caller’s factory, ignoring one they claim', () => {
      const out = applyTenantScope(
        'Employee',
        'create',
        { data: { name: 'Mole', tenantId: RIVAL } },
        asAcme,
      );

      expect((out.data as Record<string, unknown>).tenantId).toBe(ACME);
    });

    it('stamps every row of a createMany', () => {
      const out = applyTenantScope(
        'Product',
        'createMany',
        { data: [{ sku: 'A' }, { sku: 'B', tenantId: RIVAL }] },
        asAcme,
      );

      for (const row of out.data as Array<Record<string, unknown>>) {
        expect(row.tenantId).toBe(ACME);
      }
    });

    it.each(['update', 'delete', 'updateMany', 'deleteMany'])(
      '%s cannot reach another factory’s row',
      (operation) => {
        const out = applyTenantScope(
          'Employee',
          operation,
          { where: { id: 'rival-row' }, data: { name: 'changed' } },
          asAcme,
        );

        expect(out.where).toMatchObject({ tenantId: ACME });
      },
    );

    it('narrows an upsert’s where and stamps its create half', () => {
      const out = applyTenantScope(
        'Product',
        'upsert',
        { where: { id: 'x' }, create: { sku: 'A' }, update: { sku: 'A' } },
        asAcme,
      );

      expect(out.where).toMatchObject({ tenantId: ACME });
      expect((out.create as Record<string, unknown>).tenantId).toBe(ACME);
    });

    it('folds a business key into the compound key so it stays factory-unique', () => {
      // employeeId is unique per factory, not globally, so `where: { employeeId }`
      // alone no longer identifies a row.
      const out = applyTenantScope(
        'Employee',
        'update',
        { where: { employeeId: 'EMP001' }, data: { name: 'x' } },
        asAcme,
      );

      // tenantId is kept alongside the compound key rather than replaced by it:
      // Prisma's extended where-unique permits the extra non-unique field, and
      // leaving it in place means the filter is narrowed twice over.
      expect(out.where).toEqual({
        tenantId: ACME,
        tenantId_employeeId: { tenantId: ACME, employeeId: 'EMP001' },
      });
    });
  });

  describe('the super admin', () => {
    it('reads across factories untouched — that is the point of the tier', () => {
      const args = { where: { status: 'active' } };
      const out = applyTenantScope('Employee', 'findMany', args, asSuperAdmin);

      expect(out).toBe(args);
      expect((out.where as Record<string, unknown>).tenantId).toBeUndefined();
    });

    it('cannot create a row without saying which factory owns it', () => {
      // The known failure mode: bypass skips stamping, so an unnamed create
      // lands at tenantId NULL and is invisible to everyone.
      expect(() =>
        applyTenantScope('Employee', 'create', { data: { name: 'Orphan' } }, asSuperAdmin),
      ).toThrow(/without a tenantId/);
    });

    it('creates fine once the factory is named — the write is attributable', () => {
      const out = applyTenantScope(
        'Employee',
        'create',
        { data: { name: 'Attributable', tenantId: RIVAL } },
        asSuperAdmin,
      );

      // Named factory is preserved exactly; the super admin may write into any.
      expect((out.data as Record<string, unknown>).tenantId).toBe(RIVAL);
    });
  });
});
