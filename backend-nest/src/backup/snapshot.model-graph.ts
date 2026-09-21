/**
 * Foreign-key dependency graph for every tenant-scoped model, transcribed from
 * `prisma/schema.prisma`.
 *
 * A restore inserts rows with Postgres' default *immediate* constraint checking,
 * so parents must land before children or the transaction aborts. Rather than
 * hand-maintain an ordered list -- which silently rots the moment someone adds a
 * relation -- this file declares the edges and derives the order from them.
 *
 * `tenant` and `role` are deliberately absent: they are global rows shared by
 * every factory (see tenant-models.ts) and a tenant snapshot must never create
 * or delete them. They appear here only as edge targets so the graph reads the
 * same way the schema does.
 *
 * WHEN YOU ADD A MODEL: add it to TENANT_SCOPED_MODELS *and* here. The spec in
 * snapshot.model-graph.spec.ts fails if the two ever disagree.
 */

/** Models that exist outside any factory and are never part of a tenant snapshot. */
export const GLOBAL_MODELS = new Set(['tenant', 'role']);

/**
 * `model -> models it points at`. Transcribed from every
 * `@relation(fields: [...])` in the schema; self-references are omitted because
 * a table can always be filled in one pass (see the note on `account` below).
 */
export const MODEL_DEPENDENCIES: Record<string, readonly string[]> = {
  user: ['tenant', 'role'],
  biometricCredential: ['tenant', 'user'],
  employee: ['tenant', 'user', 'department', 'role'],
  department: ['tenant'],
  leaveRequest: ['tenant', 'employee'],
  device: ['tenant'],
  attendanceRecord: ['tenant', 'employee'],
  dailyAttendanceLog: ['tenant', 'employee'],
  product: ['tenant', 'taxRate'],
  stockLevel: ['tenant', 'product'],
  warehouse: ['tenant'],
  stockMovement: ['tenant'],
  supplier: ['tenant'],
  purchaseOrder: ['tenant', 'supplier'],
  purchaseOrderItem: ['tenant', 'purchaseOrder', 'product'],
  goodsReceipt: ['tenant', 'purchaseOrder'],
  goodsReceiptItem: ['tenant', 'goodsReceipt', 'purchaseOrderItem', 'product'],
  customer: ['tenant', 'priceTier'],
  salesOrder: ['tenant', 'customer'],
  salesOrderItem: ['tenant', 'salesOrder', 'product'],
  salesPayment: ['tenant', 'salesOrder'],
  // `account` is a self-referencing tree (parentId -> Account). The self-edge is
  // dropped: parents and children live in the same table, so a single insert
  // pass fills it as long as rows are written in one statement per model.
  account: ['tenant'],
  journalEntry: ['tenant'],
  journalEntryLine: ['tenant', 'journalEntry', 'account'],
  importJob: ['tenant'],
  payrollRun: ['tenant'],
  payrollItem: ['tenant', 'payrollRun'],
  payrollReceipt: ['tenant', 'employee', 'payrollRun'],
  payrollInput: ['tenant', 'employee'],
  employeeSalary: ['tenant', 'employee'],
  employeeAdvance: ['tenant', 'employee'],
  deletedRecordHistory: ['tenant'],
  employeeInsurance: ['tenant', 'employee'],
  employeeBonus: ['tenant', 'employee'],
  employeePenalty: ['tenant', 'employee'],
  terminationRecord: ['tenant', 'employee'],
  financialSettlement: ['tenant', 'employee'],
  rehireRecord: ['tenant', 'employee', 'terminationRecord'],
  bus: ['tenant'],
  busPassenger: ['tenant', 'bus', 'employee'],
  auditLog: ['tenant'],
  notification: ['tenant'],

  // --- WMS extension ---------------------------------------------------
  // Reference data first: prices and taxes are pointed at by products,
  // customers and invoices, so they have to exist before any of them.
  taxRate: ['tenant'],
  priceTier: ['tenant'],
  productPrice: ['tenant', 'priceTier'],

  // Batches. `sku` is a plain column on the sub-ledger, not a foreign key --
  // only the batch itself is, which is what the edge records.
  productBatch: ['tenant'],
  batchStockLevel: ['tenant', 'productBatch'],
  expiryAlertRule: ['tenant'],

  // Location hierarchy.
  warehouseZone: ['tenant', 'warehouse'],
  storageBin: ['tenant', 'warehouseZone'],
  putawayTask: ['tenant', 'productBatch'],

  // Purchase invoicing and costing.
  purchaseInvoice: ['tenant', 'supplier', 'purchaseOrder'],
  purchaseInvoiceItem: ['tenant', 'purchaseInvoice'],
  landedCost: ['tenant', 'purchaseInvoice'],
  purchasePayment: ['tenant', 'purchaseInvoice'],
  costHistory: ['tenant'],

  // Sales invoicing and delivery.
  salesInvoice: ['tenant', 'customer', 'salesOrder', 'priceTier'],
  salesInvoiceItem: ['tenant', 'salesInvoice', 'productBatch'],
  deliveryNote: ['tenant', 'salesInvoice'],
  deliveryNoteItem: ['tenant', 'deliveryNote'],

  // Counting and quality.
  cycleCount: ['tenant'],
  cycleCountItem: ['tenant', 'cycleCount', 'productBatch'],
  qualityInspection: ['tenant'],

  // Fulfilment.
  pickList: ['tenant'],
  pickListItem: ['tenant', 'pickList', 'productBatch'],
  carrier: ['tenant'],
  shipment: ['tenant', 'salesInvoice', 'carrier'],
  package: ['tenant', 'shipment'],
  packageItem: ['tenant', 'package'],

  // Integrations.
  integrationConnection: ['tenant'],
  integrationSyncLog: ['tenant', 'integrationConnection'],
  webhookEndpoint: ['tenant'],

  // خريطة الحسابات: تُرمَّم بعد شجرة الحسابات نفسها.
  accountMapping: ['tenant', 'account'],

  // Which modules and pages the factory was sold. Depends on nothing but the
  // factory itself, and belongs in a snapshot: restoring a factory without its
  // entitlements would hand it either everything or nothing.
  tenantEntitlement: ['tenant'],
  // Per-admin page grants. Points at the admin account as well as the factory,
  // so it restores after both exist; without this edge a snapshot would export
  // the rows and then silently drop them on restore.
  userEntitlement: ['tenant', 'user'],
  // The factory's time-boxed subscription. Restores with the factory itself.
  tenantSubscription: ['tenant'],
};

/**
 * Kahn's algorithm over MODEL_DEPENDENCIES, with ties broken alphabetically so
 * the order is deterministic across runs. A stable order matters: it is written
 * into the snapshot manifest and compared on restore.
 *
 * @throws if the graph contains a cycle -- which would mean the schema cannot be
 *   restored in any order and needs deferred constraints instead.
 */
export function topologicalOrder(): string[] {
  const nodes = Object.keys(MODEL_DEPENDENCIES);
  const remaining = new Map<string, Set<string>>();

  for (const node of nodes) {
    const edges = (MODEL_DEPENDENCIES[node] ?? []).filter(
      (dep) => !GLOBAL_MODELS.has(dep) && dep !== node,
    );
    remaining.set(node, new Set(edges));
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  while (ordered.length < nodes.length) {
    const ready = [...remaining.entries()]
      .filter(([node, deps]) => !placed.has(node) && [...deps].every((d) => placed.has(d)))
      .map(([node]) => node)
      .sort();

    if (ready.length === 0) {
      const stuck = nodes.filter((n) => !placed.has(n));
      throw new Error(
        `Cyclic foreign-key dependency in MODEL_DEPENDENCIES among: ${stuck.join(', ')}. ` +
          'A snapshot cannot be restored in any single-pass order.',
      );
    }

    for (const node of ready) {
      ordered.push(node);
      placed.add(node);
    }
  }

  return ordered;
}

/** Parents first. Use for inserts. */
export const RESTORE_ORDER: readonly string[] = topologicalOrder();

/** Children first. Use for deletes, so nothing is orphaned mid-transaction. */
export const DELETE_ORDER: readonly string[] = [...RESTORE_ORDER].reverse();
