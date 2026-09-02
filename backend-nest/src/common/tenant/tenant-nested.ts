import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { isTenantScoped } from './tenant-models';

/**
 * Tenant enforcement for *nested* writes.
 *
 * The extension in tenant-extension.ts narrows `where` and stamps `data` at the
 * top level. It does not walk into nested writes, so a payload like
 *
 *     salesOrder.create({ data: { …, items: { create: [ … ] } } })
 *
 * produced item rows with no tenantId at all -- rejected by the NOT NULL column
 * in the best case, and an isolation gap in the worst. Three call sites were
 * rewritten by hand to avoid nested writes; there are 72 relation paths, so hand
 * discipline was never going to hold. This module closes the class centrally.
 *
 * Two mechanisms, chosen per operation:
 *
 *   Rows being CREATED get `tenantId` stamped from the caller's scope, always
 *   overwriting whatever the payload claimed. A caller cannot donate a row to
 *   another factory by naming one.
 *
 *   Rows being CONNECTED, UPDATED or DELETED are already in the database and
 *   must be *verified*, not stamped. Their `where` gains `tenantId`, so Prisma
 *   simply does not find a row belonging to anyone else and fails with P2025
 *   ("record required but not found"). That is the correct disclosure boundary:
 *   it does not reveal whether the other factory's record exists, and it costs
 *   no extra query -- the predicate rides along on the statement Prisma was
 *   already going to run.
 *
 * The relation map comes from `Prisma.dmmf`, so adding a model or a relation
 * needs no change here.
 */

/** Guards against a pathological payload; real ones nest two or three deep. */
const MAX_DEPTH = 12;

type AnyRecord = Record<string, unknown>;

/**
 * `Model -> relation field name -> target model`.
 *
 * Prisma 7 ships a slimmed DMMF: fields carry `{ name, kind, type, relationName }`
 * and nothing else -- no `isList`, no `isId`, no unique metadata. That is enough
 * for the only question asked here ("this key points at which model?"); the
 * to-one / to-many distinction is read from the payload's own shape instead,
 * which is where it actually matters.
 */
const RELATION_TARGETS: Map<string, Map<string, string>> = (() => {
  const map = new Map<string, Map<string, string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const fields = new Map<string, string>();
    for (const field of model.fields) {
      if (field.kind === 'object') fields.set(field.name, field.type);
    }
    map.set(model.name, fields);
  }
  return map;
})();

/**
 * Relations whose child *inherits* `tenantId` from its parent, because the
 * foreign key linking them is the tenant-composite `(tenantId, parentId)`.
 *
 * Prisma omits `tenantId` from the nested create input for those relations --
 * `SalesOrderItemUncheckedCreateWithoutSalesOrderInput` has no tenantId field at
 * all, since the value is implied by the parent row. Stamping it there is not
 * merely redundant, it is rejected as an unknown argument.
 *
 * Where the link is a plain single-column FK (the four `onDelete: SetNull`
 * relations, which cannot carry a composite key without nulling tenantId on
 * delete) the child does NOT inherit, and the stamp is still required.
 *
 * Keyed `ParentModel.relationField`. Derived from the schema, never hand-written.
 */
const INHERITS_TENANT: Set<string> = (() => {
  const set = new Set<string>();

  // Locate schema.prisma from the compiled output as well as from source.
  const candidates = [
    path.resolve(process.cwd(), 'prisma/schema.prisma'),
    path.resolve(__dirname, '../../../prisma/schema.prisma'),
    path.resolve(__dirname, '../../../../prisma/schema.prisma'),
  ];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    // Fail loud at boot rather than silently mis-stamping every nested write.
    throw new Error(
      'tenant-nested: could not locate prisma/schema.prisma to determine which ' +
        'relations inherit tenantId. Looked in: ' + candidates.join(', '),
    );
  }

  const schema = fs.readFileSync(schemaPath, 'utf8').replace(/\r/g, '');
  // model -> relationName -> whether that side's FK includes tenantId
  const fkIncludesTenant = new Map<string, boolean>();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(schema))) {
    const model = m[1];
    const relRe = /(\w+)\s+(\w+)(\?|\[\])?\s+@relation\(([^)]*)\)/g;
    let r: RegExpExecArray | null;
    while ((r = relRe.exec(m[2]))) {
      const args = r[4];
      const fields = args.match(/fields:\s*\[([^\]]*)\]/);
      if (!fields) continue;
      const named = args.match(/^\s*"([^"]+)"/);
      const relationName = named ? named[1] : `${[model, r[2]].sort().join('To')}`;
      const carriesTenant = fields[1].split(',').some((f) => f.trim() === 'tenantId');
      fkIncludesTenant.set(`${model}::${relationName}`, carriesTenant);
    }
  }

  // For each parent relation, look up the child's back-relation by relationName.
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const field of model.fields) {
      if (field.kind !== 'object' || !field.relationName) continue;
      const childCarriesTenant = fkIncludesTenant.get(`${field.type}::${field.relationName}`);
      if (childCarriesTenant) set.add(`${model.name}.${field.name}`);
    }
  }

  return set;
})();

/** Nested keys whose payload describes rows to create. */
const CREATE_KEYS = ['create', 'createMany', 'connectOrCreate', 'upsert'] as const;

/** Nested keys whose payload locates rows that already exist. */
const LOCATE_KEYS = [
  'connect',
  'disconnect',
  'set',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const;

const NESTED_KEYS = new Set<string>([...CREATE_KEYS, ...LOCATE_KEYS]);

function isPlainObject(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Applies `fn` to a value that Prisma accepts as either one item or a list. */
function mapOneOrMany(value: unknown, fn: (item: AnyRecord) => AnyRecord): unknown {
  if (Array.isArray(value)) return value.map((item) => (isPlainObject(item) ? fn(item) : item));
  if (isPlainObject(value)) return fn(value);
  return value;
}

/** Adds the tenant predicate to a `where`, overwriting any supplied value. */
function narrowWhere(where: unknown, tenantId: string): unknown {
  if (!isPlainObject(where)) return where;
  return { ...where, tenantId };
}

/**
 * Stamps `tenantId` onto a row being created and recurses into its own nested
 * writes. The stamp always wins: `{ ...row, tenantId }`, never the other way
 * round.
 */
function stampCreate(
  model: string,
  row: AnyRecord,
  tenantId: string,
  depth: number,
  inherits: boolean,
): AnyRecord {
  const walked = walkWriteData(model, row, tenantId, depth + 1);
  // `inherits` means the composite foreign key to the parent already carries the
  // tenant, and Prisma's nested input has no tenantId field to set.
  if (inherits || !isTenantScoped(model)) return walked;
  return { ...walked, tenantId };
}

/**
 * Rewrites one relation's nested-write block.
 *
 * `target` is the model on the other end of the relation. When it is a global
 * model -- Tenant and Role are the only two -- nothing is stamped or narrowed:
 * those rows belong to every factory and filtering them would hide legitimate
 * data.
 */
function walkRelationBlock(
  target: string,
  block: AnyRecord,
  tenantId: string,
  depth: number,
  inherits: boolean,
): AnyRecord {
  if (!isTenantScoped(target)) return block;

  const out: AnyRecord = { ...block };

  for (const key of Object.keys(block)) {
    const value = block[key];
    if (!NESTED_KEYS.has(key)) continue;

    switch (key) {
      // ---- rows being created -------------------------------------------
      case 'create':
        out.create = mapOneOrMany(value, (row) =>
          stampCreate(target, row, tenantId, depth, inherits),
        );
        break;

      case 'createMany': {
        // `{ data: row | row[], skipDuplicates? }`. createMany cannot itself
        // nest further, so the rows are stamped but not walked.
        if (!isPlainObject(value)) break;
        out.createMany = {
          ...value,
          data: mapOneOrMany(value.data, (row) => (inherits ? row : { ...row, tenantId })),
        };
        break;
      }

      // ---- rows that may exist or be created -----------------------------
      case 'connectOrCreate':
        out.connectOrCreate = mapOneOrMany(value, (entry) => ({
          ...entry,
          where: narrowWhere(entry.where, tenantId),
          create: isPlainObject(entry.create)
            ? stampCreate(target, entry.create, tenantId, depth, inherits)
            : entry.create,
        }));
        break;

      case 'upsert':
        out.upsert = mapOneOrMany(value, (entry) => ({
          ...entry,
          // A to-one upsert has no `where`; the parent already scopes it.
          ...(entry.where === undefined ? {} : { where: narrowWhere(entry.where, tenantId) }),
          create: isPlainObject(entry.create)
            ? stampCreate(target, entry.create, tenantId, depth, inherits)
            : entry.create,
          update: isPlainObject(entry.update)
            ? walkWriteData(target, entry.update, tenantId, depth + 1)
            : entry.update,
        }));
        break;

      // ---- rows that must already belong to this factory ------------------
      case 'connect':
      case 'set':
        out[key] = mapOneOrMany(value, (where) => narrowWhere(where, tenantId) as AnyRecord);
        break;

      case 'disconnect':
      case 'delete':
        // `true` on a to-one relation: the row is reachable only through a
        // parent this caller already owns, so there is nothing to verify.
        if (typeof value === 'boolean') break;
        out[key] = mapOneOrMany(value, (where) => narrowWhere(where, tenantId) as AnyRecord);
        break;

      case 'deleteMany':
        out.deleteMany = mapOneOrMany(value, (where) => narrowWhere(where, tenantId) as AnyRecord);
        break;

      case 'update':
      case 'updateMany':
        out[key] = mapOneOrMany(value, (entry) => {
          // To-many form is `{ where, data }`. The to-one form is the update
          // payload itself, with no `where` -- scoped by its parent.
          if ('data' in entry || 'where' in entry) {
            return {
              ...entry,
              ...(entry.where === undefined
                ? {}
                : { where: narrowWhere(entry.where, tenantId) }),
              ...(isPlainObject(entry.data)
                ? { data: walkWriteData(target, entry.data, tenantId, depth + 1) }
                : {}),
            };
          }
          return walkWriteData(target, entry, tenantId, depth + 1);
        });
        break;

      default:
        break;
    }
  }

  return out;
}

/**
 * Walks a `data` payload for `model`, rewriting every nested relation block it
 * finds. Scalar fields are returned untouched.
 */
export function walkWriteData(
  model: string,
  data: unknown,
  tenantId: string,
  depth = 0,
): AnyRecord {
  if (!isPlainObject(data) || depth > MAX_DEPTH) return data as AnyRecord;

  const relations = RELATION_TARGETS.get(model);
  if (!relations || relations.size === 0) return data;

  let out: AnyRecord | null = null;

  for (const key of Object.keys(data)) {
    const target = relations.get(key);
    if (!target) continue;

    const value = data[key];
    if (!isPlainObject(value)) continue;

    const rewritten = walkRelationBlock(
      target,
      value,
      tenantId,
      depth,
      INHERITS_TENANT.has(`${model}.${key}`),
    );
    if (rewritten !== value) {
      if (!out) out = { ...data };
      out[key] = rewritten;
    }
  }

  return out ?? data;
}

/** Exposed for the test matrix, which enumerates relation paths from it. */
export function relationTargets(): Map<string, Map<string, string>> {
  return RELATION_TARGETS;
}

/**
 * `Model -> set of scalar field names`, used to tell a belongs-to relation from
 * a to-many one: `SalesOrder.customer` is belongs-to because the model also
 * carries a `customerId` scalar, whereas `SalesOrder.items` has no `itemsId`.
 * Prisma 7's slim DMMF drops `isList`, so this is how the distinction is
 * recovered -- from Prisma's own naming rule for foreign keys.
 */
const SCALAR_FIELDS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    map.set(model.name, new Set(model.fields.filter((f) => f.kind === 'scalar').map((f) => f.name)));
  }
  return map;
})();

function isBelongsTo(model: string, relationField: string): boolean {
  return SCALAR_FIELDS.get(model)?.has(`${relationField}Id`) ?? false;
}

/**
 * Applies the tenant to a create payload in whichever input style the caller
 * used.
 *
 * Prisma exposes two mutually exclusive shapes for a create: the *checked* one,
 * where a belongs-to relation is written as `customer: { connect: … }`, and the
 * *unchecked* one, where it is the scalar `customerId`. The tenant follows the
 * same split -- `tenant: { connect: … }` versus `tenantId` -- and mixing the two
 * is rejected outright with "Unknown argument `tenantId`".
 *
 * The extension used to stamp the scalar unconditionally. That is right for the
 * unchecked payloads this codebase writes everywhere, and it made any
 * checked-style payload fail with a confusing validation error -- which is
 * exactly the style someone reaches for when they want a nested `connect`. The
 * style is now read from the payload instead of assumed.
 */
export function stampTenantOnData(model: string, data: unknown, tenantId: string): AnyRecord {
  const walked = walkWriteData(model, data, tenantId);
  if (!isPlainObject(walked)) return walked;

  const relations = RELATION_TARGETS.get(model);
  const scalars = SCALAR_FIELDS.get(model);
  if (!relations || !scalars) return { ...walked, tenantId };

  // A scalar foreign key anywhere in the payload pins it to the unchecked shape.
  for (const key of Object.keys(walked)) {
    if (key === 'tenantId') continue;
    if (scalars.has(key) && relations.has(key.replace(/Id$/, '')) && key.endsWith('Id')) {
      return { ...walked, tenantId };
    }
  }

  // A belongs-to relation written in relation form pins it to the checked shape.
  for (const key of Object.keys(walked)) {
    if (key === 'tenant') continue;
    if (relations.has(key) && isBelongsTo(model, key) && isPlainObject(walked[key])) {
      const { tenantId: _dropped, ...rest } = walked;
      return { ...rest, tenant: { connect: { id: tenantId } } };
    }
  }

  return { ...walked, tenantId };
}
