import { Reflector } from '@nestjs/core';
import { PurchasingController } from '../../../src/purchasing/purchasing.controller';
import { PERMISSIONS_KEY } from '../../../src/common/decorators/permissions.decorator';

/**
 * The "add a new material from the purchasing screen" flow must not depend on an
 * inventory entitlement. A purchasing-only operator has `edit_purchasing` but
 * may not have `edit_inventory`, so the new endpoint is deliberately guarded by
 * `edit_purchasing` (the controller class still carries
 * `@RequiresPage('purchasing.orders')`).
 */
describe('PurchasingController permissions', () => {
  const reflector = new Reflector();
  const permsOf = (handler: (...args: never[]) => unknown) =>
    reflector.get<string[]>(PERMISSIONS_KEY, handler);

  it('createProduct requires edit_purchasing', () => {
    expect(permsOf(PurchasingController.prototype.createProduct)).toEqual(['edit_purchasing']);
  });

  it('createProduct does not require an inventory permission', () => {
    const required = permsOf(PurchasingController.prototype.createProduct) ?? [];
    expect(required).not.toContain('edit_inventory');
    expect(required).not.toContain('view_inventory');
  });

  it('receiveGoods still requires edit_purchasing', () => {
    expect(permsOf(PurchasingController.prototype.receiveGoods)).toEqual(['edit_purchasing']);
  });
});
