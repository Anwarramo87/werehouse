import { ToolRegistry } from '../../../../src/assistant/tools/registry';
import { HrTools } from '../../../../src/assistant/tools/hr.tools';
import { InventoryTools } from '../../../../src/assistant/tools/inventory.tools';
import { SalesTools } from '../../../../src/assistant/tools/sales.tools';
import { NavigationTools } from '../../../../src/assistant/tools/navigation.tools';
import { PrismaService } from '../../../../src/prisma/prisma.service';

/**
 * Two things here are worth pinning.
 *
 * The schema conversion, because a declaration Gemini's parser rejects fails at
 * request time with an opaque 400 rather than anywhere near this code. And the
 * permission filter, because it is what stops a warehouse user's assistant from
 * even knowing payroll exists.
 */

const prisma = {} as PrismaService;

function makeRegistry(): ToolRegistry {
  return new ToolRegistry(
    prisma,
    new HrTools(prisma),
    new InventoryTools(prisma),
    new SalesTools(prisma),
    new NavigationTools(),
  );
}

describe('ToolRegistry', () => {
  const superadmin = { roles: ['superadmin'], permissions: [] };

  it('emits provider-neutral declarations', () => {
    const declarations = makeRegistry().declarationsFor(superadmin);

    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(declaration.description.length).toBeGreaterThan(20);
      expect(declaration.parameters).toMatchObject({ type: 'object' });

      // zod emits a $schema key that no provider wants. Anything narrower --
      // Gemini rejecting additionalProperties, say -- is the client's job.
      expect(JSON.stringify(declaration.parameters)).not.toContain('$schema');
    }
  });

  it('gives the super admin every tool', () => {
    const names = makeRegistry()
      .declarationsFor(superadmin)
      .map((d) => d.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'search_employees',
        'get_stock_levels',
        'search_sales_orders',
        'navigate',
      ]),
    );
  });

  it('hides tools a user lacks the permission for', () => {
    const warehouseUser = { roles: ['user'], permissions: ['view_inventory'] };
    const names = makeRegistry()
      .declarationsFor(warehouseUser)
      .map((d) => d.name);

    expect(names).toContain('get_stock_levels');
    expect(names).toContain('search_products');
    expect(names).not.toContain('search_employees');
    expect(names).not.toContain('search_sales_orders');
  });

  it('always offers navigation, which needs no permission', () => {
    const names = makeRegistry()
      .declarationsFor({ roles: [], permissions: [] })
      .map((d) => d.name);

    expect(names).toEqual(['navigate']);
  });

  it('refuses a tool the caller may not use, without running it', async () => {
    const outcome = await makeRegistry().execute(
      'search_employees',
      {},
      {
        user: { userId: 'u1', roles: ['user'], permissions: ['view_inventory'] },
        tenantId: 't1',
      },
    );

    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/permission/i);
  });

  it('rejects arguments that fail validation before touching the database', async () => {
    const outcome = await makeRegistry().execute(
      'search_employees',
      { limit: 99_999 },
      { user: { userId: 'u1', roles: ['superadmin'] }, tenantId: 't1' },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.result).toHaveProperty('issues');
  });

  it('reports an unknown tool rather than throwing', async () => {
    const outcome = await makeRegistry().execute(
      'drop_everything',
      {},
      { user: { userId: 'u1', roles: ['superadmin'] }, tenantId: 't1' },
    );

    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/unknown tool/i);
  });
});
