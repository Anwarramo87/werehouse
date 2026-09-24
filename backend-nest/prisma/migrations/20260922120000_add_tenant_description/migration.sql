-- Optional free-text description for a factory, shown on the super-admin
-- factories list. Purely informational: nothing in the product branches on it,
-- so existing rows stay NULL and no backfill is needed.

ALTER TABLE "tenants" ADD COLUMN "description" TEXT;
