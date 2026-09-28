/**
 * CI guard: keeps src/common/tenant/tenant-models.ts in sync with
 * prisma/schema.prisma.
 *
 * Fails when:
 *  - a model with a `tenantId` column is missing from TENANT_SCOPED_MODELS
 *    (rows would be visible to every factory => tenant isolation breach), or
 *  - TENANT_SCOPED_MODELS references a model that no longer exists or no
 *    longer has a tenantId column (stale entry => dead code / false safety).
 *
 * Usage: node scripts/check-model-coverage.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const listPath = path.join(root, "src", "common", "tenant", "tenant-models.ts");

function exit(msg, code) {
  console.log(msg);
  process.exit(code);
}

if (!fs.existsSync(schemaPath)) return exit(`MISSING schema.prisma at ${schemaPath}`, 1);
if (!fs.existsSync(listPath)) return exit(`MISSING tenant-models.ts at ${listPath}`, 1);

const schema = fs.readFileSync(schemaPath, "utf8");
const listSrc = fs.readFileSync(listPath, "utf8");

const models = new Map();
const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
let m;
while ((m = re.exec(schema)) !== null) {
  const name = m[1];
  const body = m[2];
  const hasTenantId = /\btenantId\s+/.test(body);
  // isTenantScoped() looks up TENANT_SCOPED_MODELS with the camelCased name
  // (User -> user, BOM -> bOM), so compare in that same canonical form.
  const key = name[0].toLowerCase() + name.slice(1);
  models.set(key, { hasTenantId, schemaName: name });
}

const declared = new Set();
const listRe = /^\s*(\w+):\s*true/mg;
let l;
while ((l = listRe.exec(listSrc)) !== null) declared.add(l[1]);

const missingFromList = [];
const staleInList = [];
for (const [key, { hasTenantId, schemaName }] of models) {
  if (hasTenantId && !declared.has(key)) missingFromList.push(schemaName);
}
for (const name of declared) {
  if (!models.has(name)) {
    staleInList.push(`${name} (not in schema)`);
  } else if (!models.get(name).hasTenantId) {
    staleInList.push(`${name} (no tenantId in schema)`);
  }
}

let globalCount = 0;
for (const [, { hasTenantId }] of models) if (!hasTenantId) globalCount++;

if (missingFromList.length || staleInList.length) {
  const out = ["MODEL COVERAGE MISMATCH:"];
  if (missingFromList.length) {
    out.push(`  Missing from TENANT_SCOPED_MODELS (have tenantId): ${missingFromList.join(", ")}`);
  }
  if (staleInList.length) {
    out.push(`  Stale entries in TENANT_SCOPED_MODELS: ${staleInList.join(", ")}`);
  }
  out.push(`  ${models.size} models total: ${models.size - globalCount} scoped, ${globalCount} global.`);
  return exit(out.join("\n"), 1);
}

console.log(
  `OK: ${models.size} models, ${models.size - globalCount} tenant-scoped, ${globalCount} global; ` +
    `TENANT_SCOPED_MODELS (${declared.size}) is in sync with schema.prisma.`,
);
process.exit(0);