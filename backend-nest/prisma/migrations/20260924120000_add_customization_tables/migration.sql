-- Per-tenant customization + custom fields.
--
-- These four models exist in schema.prisma (TenantCustomization,
-- TenantCustomizationAudit, CustomFieldDefinition, CustomFieldValue) but no
-- migration ever created their tables, so every call to
-- /customization/tenant* died with a 500 (P2021: table does not exist).

CREATE TABLE "tenant_customizations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastEditedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "branding" JSONB NOT NULL DEFAULT '{}',
    "theme" JSONB NOT NULL DEFAULT '{}',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "navigation" JSONB NOT NULL DEFAULT '{}',
    "dashboard" JSONB NOT NULL DEFAULT '{}',
    "customFields" JSONB NOT NULL DEFAULT '[]',
    "terminology" JSONB NOT NULL DEFAULT '{}',
    "documents" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_customizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_customizations_tenantId_key" ON "tenant_customizations"("tenantId");

ALTER TABLE "tenant_customizations"
    ADD CONSTRAINT "tenant_customizations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tenant_customization_audit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" TEXT,
    "actorUsername" TEXT,
    "action" TEXT NOT NULL,
    "section" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_customization_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_customization_audit_tenantId_createdAt_idx" ON "tenant_customization_audit"("tenantId", "createdAt");

ALTER TABLE "tenant_customization_audit"
    ADD CONSTRAINT "tenant_customization_audit_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL DEFAULT 'text',
    "description" TEXT,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" JSONB,
    "validation" JSONB,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "exportable" BOOLEAN NOT NULL DEFAULT false,
    "visibleToRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibleToModules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_definitions_tenantId_entity_key_key" ON "custom_field_definitions"("tenantId", "entity", "key");
CREATE INDEX "custom_field_definitions_tenantId_entity_ordering_idx" ON "custom_field_definitions"("tenantId", "entity", "ordering");

ALTER TABLE "custom_field_definitions"
    ADD CONSTRAINT "custom_field_definitions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "custom_field_values" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldId" UUID,
    "fieldKey" TEXT NOT NULL,
    "value" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_values_tenantId_entity_recordId_fieldKey_key" ON "custom_field_values"("tenantId", "entity", "recordId", "fieldKey");
CREATE INDEX "custom_field_values_tenantId_entity_recordId_idx" ON "custom_field_values"("tenantId", "entity", "recordId");

ALTER TABLE "custom_field_values"
    ADD CONSTRAINT "custom_field_values_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
