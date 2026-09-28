# Scale Backlog

Hardening and capacity work that is intentionally deferred, not forgotten. Each
item here is safe to ship without, and each is the kind of thing that only
matters once the system is actually under load or being audited.

## Composite tenant foreign keys for the WMS extension blocks

`test/e2e/scalar-fk-isolation.e2e-spec.ts` is the guard for this. Fourteen
core tenant-to-tenant relations (sales invoices -> customer, packages ->
shipment, ...) predate the composite-FK hardening migration and still use a
scalar FK. They are isolated at the application layer by the tenant extension
(every query and write carries `tenantId`) and are listed exactly in
`TRACKED_NON_COMPOSITE` so the guard still fails on any *new* scalar
tenant-to-tenant relation.

The manufacturing and representatives blocks added later are the same posture
and are tracked in the same list:

- `BOMItem.bom`, `ProductionOrder.bom`, `MaterialConsumption.productionOrder`
- `Representative.user` and every `Rep*.representative` / `RepSaleItem.sale`

Retrofitting a block means one migration that adds `@@unique([tenantId, id])`
to the parent, switches the child relation to `fields: [tenantId, xId]`, and
shrinks `TRACKED_NON_COMPOSITE` by exactly the relations it converted. The
guard enforces that the list and the schema stay in sync, so a partial
conversion cannot silently leave a relation untracked.

Two relations (`RepCollection.sale`, `RepReturn.sale`) use `onDelete: SetNull`
and cannot express a composite key at all; they live in
`SET_NULL_EXCEPTIONS` and are covered by the tenant extension's nested-write
verification instead.

`UserEntitlement.user` is scalar because `userId` is `@unique` (one grant per
account) and a user belongs to exactly one factory, so the composite form is
not expressible either. It is tracked rather than excepted because its
`onDelete` is `Cascade`, not `SetNull`.

## Representative settlements: scalar `repId` on admin reads

`GET /representatives/:repId/settlements` accepts a `repId` path parameter and
relies on `RepIsolationGuard` to reject a representative asking for another
representative's settlements. The underlying query is scoped to `repId`, so
the guard is load-bearing. A stronger form would resolve the caller's own
representative from the JWT and ignore the path parameter for non-admins.
