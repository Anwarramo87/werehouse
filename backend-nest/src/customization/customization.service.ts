import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  baseCustomizationState,
  deepMerge,
  normalizeCustomFieldDefinition,
  normalizeCustomFieldValueForStorage,
  normalizeEntityKey,
  sanitizeCustomizationCss,
} from './customization.utils';

export type CustomizationPatchInput = {
  status?: string;
  branding?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  navigation?: Record<string, unknown>;
  dashboard?: Record<string, unknown>;
  customFields?: Record<string, unknown>[];
  terminology?: Record<string, unknown>;
  documents?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

@Injectable()
export class CustomizationService {
  private readonly cache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

  constructor(private readonly prisma: PrismaService) {}

  private getCacheKey(tenantId: string) {
    return `customization:${tenantId}`;
  }

  private readCached(tenantId: string) {
    const cached = this.cache.get(this.getCacheKey(tenantId));
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.cache.delete(this.getCacheKey(tenantId));
      return null;
    }
    return cached.value;
  }

  private writeCache(tenantId: string, value: Record<string, unknown>) {
    this.cache.set(this.getCacheKey(tenantId), {
      value,
      expiresAt: Date.now() + 60_000,
    });
  }

  private invalidateCache(tenantId: string) {
    this.cache.delete(this.getCacheKey(tenantId));
  }

  private normalizeRecord(row: Record<string, any> | null | undefined) {
    const defaultState = baseCustomizationState();
    const merged = deepMerge(defaultState, row ?? {});

    if (merged.theme?.customCss && typeof merged.theme.customCss === 'string') {
      merged.theme.customCss = sanitizeCustomizationCss(merged.theme.customCss);
    }

    if (merged.settings?.customCss && typeof merged.settings.customCss === 'string') {
      merged.settings.customCss = sanitizeCustomizationCss(merged.settings.customCss);
    }

    return merged;
  }

  private sanitizePatch(patch: Record<string, unknown> = {}) {
    const next = { ...patch } as Record<string, unknown>;
    if (next.theme && typeof next.theme === 'object') {
      const theme = { ...(next.theme as Record<string, unknown>) };
      if (typeof theme.customCss === 'string') {
        theme.customCss = sanitizeCustomizationCss(theme.customCss);
      }
      next.theme = theme;
    }

    if (next.settings && typeof next.settings === 'object') {
      const settings = { ...(next.settings as Record<string, unknown>) };
      if (typeof settings.customCss === 'string') {
        settings.customCss = sanitizeCustomizationCss(settings.customCss);
      }
      next.settings = settings;
    }

    return next;
  }

  private prismaJsonInput(
    value: unknown,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    return value as Prisma.InputJsonValue;
  }

  private async findOrCreate(tenantId: string) {
    const existing = await this.prisma.tenantCustomization.findUnique({
      where: { tenantId },
    });

    if (existing) {
      return existing;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} does not exist`);
    }

    const seed = baseCustomizationState();
    try {
      return await this.prisma.tenantCustomization.create({
        data: {
          tenantId,
          status: seed.status,
          version: seed.version,
          branding: seed.branding as Prisma.InputJsonValue,
          theme: seed.theme as Prisma.InputJsonValue,
          layout: seed.layout as Prisma.InputJsonValue,
          navigation: seed.navigation as Prisma.InputJsonValue,
          dashboard: seed.dashboard as Prisma.InputJsonValue,
          customFields: seed.customFields as Prisma.InputJsonValue,
          terminology: seed.terminology as Prisma.InputJsonValue,
          documents: seed.documents as Prisma.InputJsonValue,
          settings: seed.settings as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2003' || err.code === 'P2002')
      ) {
        throw new NotFoundException(`Tenant ${tenantId} does not exist or is invalid`);
      }
      throw err;
    }
  }

  async getCustomization(tenantId: string) {
    const cached = this.readCached(tenantId);
    if (cached) {
      return cached;
    }

    const record = await this.findOrCreate(tenantId);
    const normalized = this.normalizeRecord(record as Record<string, any>);
    this.writeCache(tenantId, normalized);
    return normalized;
  }

  async updateCustomization(
    tenantId: string,
    patch: CustomizationPatchInput,
    actor?: Partial<AuthenticatedUser> | null,
  ) {
    const existing = await this.findOrCreate(tenantId);
    const sanitized = this.sanitizePatch(patch as Record<string, unknown>);
    const merged = deepMerge(existing as Record<string, unknown>, sanitized);

    const updated = await this.prisma.tenantCustomization.update({
      where: { tenantId },
      data: {
        status: (sanitized.status as string) ?? existing.status,
        branding: merged.branding as Prisma.InputJsonValue,
        theme: merged.theme as Prisma.InputJsonValue,
        layout: merged.layout as Prisma.InputJsonValue,
        navigation: merged.navigation as Prisma.InputJsonValue,
        dashboard: merged.dashboard as Prisma.InputJsonValue,
        customFields: merged.customFields as Prisma.InputJsonValue,
        terminology: merged.terminology as Prisma.InputJsonValue,
        documents: merged.documents as Prisma.InputJsonValue,
        settings: merged.settings as Prisma.InputJsonValue,
        lastEditedBy: actor?.userId ?? existing.lastEditedBy,
        version: (existing.version ?? 1) + 1,
      },
    });

    await this.prisma.tenantCustomizationAudit.create({
      data: {
        tenantId,
        actorId: actor?.userId ?? null,
        actorUsername: actor?.username ?? null,
        action: 'customization.update',
        section: 'multi',
        oldValue: existing as Prisma.InputJsonValue,
        newValue: updated as Prisma.InputJsonValue,
      },
    });

    this.invalidateCache(tenantId);
    return this.normalizeRecord(updated as Record<string, any>);
  }

  async publishCustomization(tenantId: string, actor?: Partial<AuthenticatedUser> | null) {
    const existing = await this.findOrCreate(tenantId);
    const updated = await this.prisma.tenantCustomization.update({
      where: { tenantId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        lastEditedBy: actor?.userId ?? existing.lastEditedBy,
        version: (existing.version ?? 1) + 1,
      },
    });

    await this.prisma.tenantCustomizationAudit.create({
      data: {
        tenantId,
        actorId: actor?.userId ?? null,
        actorUsername: actor?.username ?? null,
        action: 'customization.publish',
        section: 'publishing',
        oldValue: existing as Prisma.InputJsonValue,
        newValue: updated as Prisma.InputJsonValue,
      },
    });

    this.invalidateCache(tenantId);
    return this.normalizeRecord(updated as Record<string, any>);
  }

  async resetCustomization(tenantId: string, actor?: Partial<AuthenticatedUser> | null) {
    const seed = baseCustomizationState();
    const updated = await this.prisma.tenantCustomization.upsert({
      where: { tenantId },
      create: {
        tenantId,
        status: 'draft',
        version: 1,
        branding: seed.branding as Prisma.InputJsonValue,
        theme: seed.theme as Prisma.InputJsonValue,
        layout: seed.layout as Prisma.InputJsonValue,
        navigation: seed.navigation as Prisma.InputJsonValue,
        dashboard: seed.dashboard as Prisma.InputJsonValue,
        customFields: seed.customFields as Prisma.InputJsonValue,
        terminology: seed.terminology as Prisma.InputJsonValue,
        documents: seed.documents as Prisma.InputJsonValue,
        settings: seed.settings as Prisma.InputJsonValue,
        lastEditedBy: actor?.userId ?? null,
      },
      update: {
        status: 'draft',
        branding: seed.branding as Prisma.InputJsonValue,
        theme: seed.theme as Prisma.InputJsonValue,
        layout: seed.layout as Prisma.InputJsonValue,
        navigation: seed.navigation as Prisma.InputJsonValue,
        dashboard: seed.dashboard as Prisma.InputJsonValue,
        customFields: seed.customFields as Prisma.InputJsonValue,
        terminology: seed.terminology as Prisma.InputJsonValue,
        documents: seed.documents as Prisma.InputJsonValue,
        settings: seed.settings as Prisma.InputJsonValue,
        lastEditedBy: actor?.userId ?? null,
        version: 1,
      },
    });

    await this.prisma.tenantCustomizationAudit.create({
      data: {
        tenantId,
        actorId: actor?.userId ?? null,
        actorUsername: actor?.username ?? null,
        action: 'customization.reset',
        section: 'reset',
        oldValue: { status: 'published' },
        newValue: updated as Prisma.InputJsonValue,
      },
    });

    this.invalidateCache(tenantId);
    return this.normalizeRecord(updated as Record<string, any>);
  }

  async listCustomFields(tenantId: string, entity?: string) {
    const normalizedEntity = entity ? normalizeEntityKey(entity) : undefined;
    const rows = await this.prisma.customFieldDefinition.findMany({
      where: {
        tenantId,
        ...(normalizedEntity ? { entity: normalizedEntity } : {}),
        status: 'active',
      },
      orderBy: [{ ordering: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => normalizeCustomFieldDefinition(row as Record<string, unknown>));
  }

  async upsertCustomField(
    tenantId: string,
    input: Record<string, unknown>,
    actor?: Partial<AuthenticatedUser> | null,
  ) {
    const normalized = normalizeCustomFieldDefinition({
      ...input,
      tenantId,
      entity: normalizeEntityKey(input.entity),
    });
    const row = await this.prisma.customFieldDefinition.upsert({
      where: {
        tenantId_entity_key: {
          tenantId,
          entity: normalized.entity,
          key: normalized.key,
        },
      },
      update: {
        entity: normalized.entity,
        key: normalized.key,
        label: normalized.label,
        fieldType: normalized.fieldType,
        description: normalized.description,
        placeholder: normalized.placeholder,
        required: normalized.required,
        defaultValue: this.prismaJsonInput(normalized.defaultValue),
        validation: this.prismaJsonInput(normalized.validation),
        ordering: normalized.ordering,
        searchable: normalized.searchable,
        filterable: normalized.filterable,
        exportable: normalized.exportable,
        visibleToRoles: normalized.visibleToRoles,
        visibleToModules: normalized.visibleToModules,
        status: normalized.status,
      },
      create: {
        tenantId,
        entity: normalized.entity,
        key: normalized.key,
        label: normalized.label,
        fieldType: normalized.fieldType,
        description: normalized.description,
        placeholder: normalized.placeholder,
        required: normalized.required,
        defaultValue: this.prismaJsonInput(normalized.defaultValue),
        validation: this.prismaJsonInput(normalized.validation),
        ordering: normalized.ordering,
        searchable: normalized.searchable,
        filterable: normalized.filterable,
        exportable: normalized.exportable,
        visibleToRoles: normalized.visibleToRoles,
        visibleToModules: normalized.visibleToModules,
        status: normalized.status,
      },
    });

    await this.prisma.tenantCustomizationAudit.create({
      data: {
        tenantId,
        actorId: actor?.userId ?? null,
        actorUsername: actor?.username ?? null,
        action: 'custom_field.upsert',
        section: 'customFields',
        oldValue: { tenantId, entity: normalized.entity, key: normalized.key },
        newValue: row as Prisma.InputJsonValue,
      },
    });

    return normalizeCustomFieldDefinition(row as Record<string, unknown>);
  }

  async deleteCustomField(
    tenantId: string,
    fieldId: string,
    actor?: Partial<AuthenticatedUser> | null,
  ) {
    const existing = await this.prisma.customFieldDefinition.findFirst({
      where: { tenantId, id: fieldId },
    });

    if (!existing) {
      return null;
    }

    await this.prisma.customFieldDefinition.delete({
      where: { id: fieldId, tenantId },
    });

    await this.prisma.tenantCustomizationAudit.create({
      data: {
        tenantId,
        actorId: actor?.userId ?? null,
        actorUsername: actor?.username ?? null,
        action: 'custom_field.delete',
        section: 'customFields',
        oldValue: existing as Prisma.InputJsonValue,
        newValue: { deleted: true },
      },
    });

    return existing;
  }

  async upsertCustomFieldValues(
    tenantId: string,
    entity: string,
    recordId: string,
    values: Record<string, unknown>,
  ) {
    const normalizedEntity = normalizeEntityKey(entity);
    const entries = Object.entries(values ?? {});
    const saved: Record<string, unknown> = {};

    for (const [fieldKey, value] of entries) {
      const field = await this.prisma.customFieldDefinition.findUnique({
        where: { tenantId_entity_key: { tenantId, entity: normalizedEntity, key: fieldKey } },
      });

      if (!field) continue;

      const normalizedValue = normalizeCustomFieldValueForStorage(value, field.fieldType || 'text');
      const row = await this.prisma.customFieldValue.upsert({
        where: {
          tenantId_entity_recordId_fieldKey: {
            tenantId,
            entity: normalizedEntity,
            recordId,
            fieldKey,
          },
        },
        update: { value: normalizedValue as Prisma.InputJsonValue },
        create: {
          tenantId,
          entity: normalizedEntity,
          recordId,
          fieldId: field.id,
          fieldKey,
          value: normalizedValue as Prisma.InputJsonValue,
        },
      });

      saved[fieldKey] = row.value ?? null;
    }

    return saved;
  }

  async getCustomFieldValues(tenantId: string, entity: string, recordId: string) {
    const normalizedEntity = normalizeEntityKey(entity);
    const rows = await this.prisma.customFieldValue.findMany({
      where: { tenantId, entity: normalizedEntity, recordId },
      orderBy: { createdAt: 'asc' },
    });

    return Object.fromEntries(rows.map((row) => [row.fieldKey, row.value ?? null]));
  }
}
