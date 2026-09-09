import { TENANT_SCOPED_MODELS } from '../../../src/common/tenant/tenant-models';
import {
  DELETE_ORDER,
  GLOBAL_MODELS,
  MODEL_DEPENDENCIES,
  RESTORE_ORDER,
  topologicalOrder,
} from '../../../src/backup/snapshot.model-graph';

describe('snapshot model graph', () => {
  it('covers every tenant-scoped model', () => {
    const scoped = Object.keys(TENANT_SCOPED_MODELS).sort();
    const graphed = Object.keys(MODEL_DEPENDENCIES).sort();

    // If this fails someone added a model to the schema and to tenant-models.ts
    // but not here -- its rows would be exported and then silently dropped on
    // restore, which is the exact failure this whole step exists to prevent.
    expect(graphed).toEqual(scoped);
  });

  it('never includes a global model in the restore order', () => {
    for (const model of RESTORE_ORDER) {
      expect(GLOBAL_MODELS.has(model)).toBe(false);
    }
  });

  it('orders every parent before its children', () => {
    const position = new Map(RESTORE_ORDER.map((model, index) => [model, index]));

    for (const [model, deps] of Object.entries(MODEL_DEPENDENCIES)) {
      for (const dep of deps) {
        if (GLOBAL_MODELS.has(dep) || dep === model) continue;
        expect(position.get(dep)).toBeLessThan(position.get(model) as number);
      }
    }
  });

  it('places children before parents in the delete order', () => {
    expect(DELETE_ORDER).toEqual([...RESTORE_ORDER].reverse());

    const position = new Map(DELETE_ORDER.map((model, index) => [model, index]));
    for (const [model, deps] of Object.entries(MODEL_DEPENDENCIES)) {
      for (const dep of deps) {
        if (GLOBAL_MODELS.has(dep) || dep === model) continue;
        // The child must be deleted first, so it comes earlier in DELETE_ORDER.
        expect(position.get(model)).toBeLessThan(position.get(dep) as number);
      }
    }
  });

  it('puts known parents ahead of known children', () => {
    const at = (model: string) => RESTORE_ORDER.indexOf(model);

    expect(at('product')).toBeLessThan(at('stockLevel'));
    expect(at('user')).toBeLessThan(at('employee'));
    expect(at('employee')).toBeLessThan(at('payrollInput'));
    expect(at('purchaseOrder')).toBeLessThan(at('goodsReceipt'));
    expect(at('goodsReceipt')).toBeLessThan(at('goodsReceiptItem'));
    expect(at('terminationRecord')).toBeLessThan(at('rehireRecord'));
    expect(at('journalEntry')).toBeLessThan(at('journalEntryLine'));
    expect(at('account')).toBeLessThan(at('journalEntryLine'));
  });

  it('is deterministic', () => {
    expect(topologicalOrder()).toEqual(topologicalOrder());
  });

  it('detects a cycle rather than emitting a broken order', () => {
    const original = { ...MODEL_DEPENDENCIES };
    try {
      (MODEL_DEPENDENCIES as Record<string, readonly string[]>).product = ['stockLevel'];
      expect(() => topologicalOrder()).toThrow(/Cyclic foreign-key dependency/);
    } finally {
      for (const key of Object.keys(MODEL_DEPENDENCIES)) {
        delete (MODEL_DEPENDENCIES as Record<string, readonly string[]>)[key];
      }
      Object.assign(MODEL_DEPENDENCIES, original);
    }
  });
});
