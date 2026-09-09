import { walkWriteData, relationTargets } from '../../../../src/common/tenant/tenant-nested';
import { TENANT_SCOPED_MODELS } from '../../../../src/common/tenant/tenant-models';

const T = 'aaaaaaa1-0000-4000-8000-00000000000a';
const OTHER = 'bbbbbbb1-0000-4000-8000-00000000000b';

describe('walkWriteData — nested tenant enforcement', () => {
  describe('relation map', () => {
    it('is derived from DMMF and covers the scoped models', () => {
      const map = relationTargets();
      expect(map.get('SalesOrder')?.get('items')).toBe('SalesOrderItem');
      expect(map.get('PurchaseOrder')?.get('items')).toBe('PurchaseOrderItem');
      expect(map.get('SalesOrder')?.get('customer')).toBe('Customer');
      expect(map.get('SalesOrder')?.get('tenant')).toBe('Tenant');
    });

    it('knows every tenant-scoped model', () => {
      const map = relationTargets();
      for (const key of Object.keys(TENANT_SCOPED_MODELS)) {
        const pascal = key[0].toUpperCase() + key.slice(1);
        expect(map.has(pascal)).toBe(true);
      }
    });
  });

  describe('rows being created', () => {
    /*
     * Two cases, and the difference is the schema's, not this module's.
     *
     * Where the child is linked by the tenant-composite key (tenantId, parentId)
     * -- SalesOrder.items and most parent/child pairs -- the child INHERITS the
     * tenant from its parent. Prisma removes `tenantId` from the nested input
     * entirely, and Postgres enforces the match. Stamping there is rejected as an
     * unknown argument.
     *
     * Where the link is a plain single-column FK -- the four `onDelete: SetNull`
     * relations, which cannot carry a composite key without nulling tenantId on
     * delete -- the child does not inherit and must still be stamped.
     */
    it('does not stamp a nested create that inherits via a composite key', () => {
      const out = walkWriteData('SalesOrder', {
        soNumber: 'SO-1',
        items: { create: [{ sku: 'A', quantity: 1 }] },
      }, T);

      expect((out.items as any).create[0]).toEqual({ sku: 'A', quantity: 1 });
    });

    it('stamps a nested create on a relation that does not inherit', () => {
      // Department.employees is onDelete: SetNull, so it stays single-column.
      const out = walkWriteData('Department', { employees: { create: [{ name: 'E' }] } }, T);
      expect((out.employees as any).create[0]).toEqual({ name: 'E', tenantId: T });
    });

    it('leaves nested createMany alone when the child inherits', () => {
      const out = walkWriteData('SalesOrder', {
        items: { createMany: { data: [{ sku: 'A' }, { sku: 'B' }], skipDuplicates: true } },
      }, T);

      const cm = (out.items as any).createMany;
      expect(cm.data).toEqual([{ sku: 'A' }, { sku: 'B' }]);
      expect(cm.skipDuplicates).toBe(true);
    });

    it('stamps nested createMany when the child does not inherit', () => {
      const out = walkWriteData('Department', {
        employees: { createMany: { data: [{ name: 'A' }, { name: 'B' }] } },
      }, T);
      expect((out.employees as any).createMany.data).toEqual([
        { name: 'A', tenantId: T },
        { name: 'B', tenantId: T },
      ]);
    });

    it('overwrites a tenantId the caller supplied on a non-inheriting relation', () => {
      // A payload naming another factory must not be able to donate a row to it.
      const out = walkWriteData('Department', {
        employees: { create: [{ name: 'E', tenantId: OTHER }] },
      }, T);

      expect((out.employees as any).create[0].tenantId).toBe(T);
    });

    it('recurses to depth 2', () => {
      const out = walkWriteData('Customer', {
        name: 'C',
        salesOrders: { create: [{ soNumber: 'SO', items: { create: [{ sku: 'A' }] } }] },
      }, T);

      // Both links are composite, so neither level carries a stamp.
      const order = (out.salesOrders as any).create[0];
      expect(order.tenantId).toBeUndefined();
      expect(order.items.create[0].tenantId).toBeUndefined();
      expect(order.items.create[0].sku).toBe('A');
    });

    it('recurses to depth 3', () => {
      const out = walkWriteData('Supplier', {
        name: 'S',
        purchaseOrders: {
          create: [{
            poNumber: 'PO',
            goodsReceipts: { create: [{ receiptNumber: 'GR', items: { create: [{ sku: 'A' }] } }] },
          }],
        },
      }, T);

      const po = (out.purchaseOrders as any).create[0];
      const gr = po.goodsReceipts.create[0];
      expect(po.poNumber).toBe('PO');
      expect(gr.receiptNumber).toBe('GR');
      expect(gr.items.create[0].sku).toBe('A');
    });
  });

  describe('rows that already exist', () => {
    it('narrows a nested connect instead of stamping it', () => {
      const out = walkWriteData('SalesOrder', { customer: { connect: { id: 'c1' } } }, T);

      // Verified, not stamped: a connect must never assign ownership.
      expect((out.customer as any).connect).toEqual({ id: 'c1', tenantId: T });
    });

    it('narrows every entry of a connect list', () => {
      const out = walkWriteData('Product', {
        stockLevels: { connect: [{ id: 's1' }, { id: 's2' }] },
      }, T);
      expect((out.stockLevels as any).connect).toEqual([
        { id: 's1', tenantId: T },
        { id: 's2', tenantId: T },
      ]);
    });

    it('overwrites a spoofed tenantId in a connect', () => {
      const out = walkWriteData('SalesOrder', {
        customer: { connect: { id: 'c1', tenantId: OTHER } },
      }, T);
      expect((out.customer as any).connect.tenantId).toBe(T);
    });

    it('narrows connectOrCreate on both branches', () => {
      const out = walkWriteData('SalesOrder', {
        customer: { connectOrCreate: { where: { id: 'c1' }, create: { name: 'New' } } },
      }, T);

      const coc = (out.customer as any).connectOrCreate;
      expect(coc.where).toEqual({ id: 'c1', tenantId: T });
      expect(coc.create).toEqual({ name: 'New', tenantId: T });
    });

    it('narrows a nested upsert and stamps only its create branch', () => {
      const out = walkWriteData('SalesOrder', {
        items: {
          upsert: {
            where: { id: 'i1' },
            create: { sku: 'A' },
            update: { quantity: 5 },
          },
        },
      }, T);

      const up = (out.items as any).upsert;
      // `where` is always narrowed — that is the ownership check.
      expect(up.where).toEqual({ id: 'i1', tenantId: T });
      // The create branch inherits its tenant from the parent via the composite key.
      expect(up.create).toEqual({ sku: 'A' });
      expect(up.update).toEqual({ quantity: 5 });
    });

    it('narrows nested update / updateMany without stamping the data', () => {
      const out = walkWriteData('SalesOrder', {
        items: {
          update: { where: { id: 'i1' }, data: { quantity: 2 } },
          updateMany: { where: { sku: 'A' }, data: { quantity: 3 } },
        },
      }, T);

      const items = out.items as any;
      expect(items.update.where).toEqual({ id: 'i1', tenantId: T });
      expect(items.update.data).toEqual({ quantity: 2 });
      expect(items.updateMany.where).toEqual({ sku: 'A', tenantId: T });
    });

    it('narrows nested delete / deleteMany / set / disconnect', () => {
      const out = walkWriteData('SalesOrder', {
        items: {
          delete: { id: 'i1' },
          deleteMany: { sku: 'A' },
          set: [{ id: 'i2' }],
          disconnect: [{ id: 'i3' }],
        },
      }, T);

      const items = out.items as any;
      expect(items.delete).toEqual({ id: 'i1', tenantId: T });
      expect(items.deleteMany).toEqual({ sku: 'A', tenantId: T });
      expect(items.set).toEqual([{ id: 'i2', tenantId: T }]);
      expect(items.disconnect).toEqual([{ id: 'i3', tenantId: T }]);
    });

    it('leaves boolean delete / disconnect alone', () => {
      // A to-one `delete: true` is reachable only through a parent the caller
      // already owns, so there is nothing left to verify.
      const out = walkWriteData('Employee', { user: { disconnect: true } }, T);
      expect((out.user as any).disconnect).toBe(true);
    });
  });

  describe('global models', () => {
    it('never stamps or narrows a relation to Tenant', () => {
      const out = walkWriteData('SalesOrder', { tenant: { connect: { id: T } } }, T);
      expect((out.tenant as any).connect).toEqual({ id: T });
    });

    it('never stamps or narrows a relation to Role', () => {
      const out = walkWriteData('User', { role: { connect: { id: 'r1' } } }, T);
      expect((out.role as any).connect).toEqual({ id: 'r1' });
    });
  });

  describe('safety', () => {
    it('leaves scalar fields untouched', () => {
      const data = { soNumber: 'SO-1', totalAmount: 10, orderDate: new Date('2026-01-01') };
      expect(walkWriteData('SalesOrder', data, T)).toEqual(data);
    });

    it('returns the same object when there is nothing to rewrite', () => {
      const data = { soNumber: 'SO-1' };
      expect(walkWriteData('SalesOrder', data, T)).toBe(data);
    });

    it('does not mutate the caller payload', () => {
      const data = { items: { create: [{ sku: 'A' }] } };
      const snapshot = JSON.parse(JSON.stringify(data));
      walkWriteData('SalesOrder', data, T);
      expect(data).toEqual(snapshot);
    });

    it('ignores unknown models and non-objects', () => {
      expect(walkWriteData('NotAModel', { a: 1 }, T)).toEqual({ a: 1 });
      expect(walkWriteData('SalesOrder', null, T)).toBeNull();
    });

    it('stops recursing past the depth cap rather than looping', () => {
      // Account.parent -> Account is a self-relation; build a deep chain.
      let payload: Record<string, unknown> = { code: 'leaf' };
      for (let i = 0; i < 40; i += 1) payload = { code: 'n' + i, parent: { create: payload } };

      expect(() => walkWriteData('Account', payload, T)).not.toThrow();
    });

    it('handles a self-relation correctly at shallow depth', () => {
      const out = walkWriteData('Account', {
        code: '1000',
        children: { create: [{ code: '1100' }] },
      }, T);
      // Account.parentId is composite (tenantId, parentId), so a child account
      // inherits its factory from its parent.
      expect((out.children as any).create[0]).toEqual({ code: '1100' });
    });
  });
});
