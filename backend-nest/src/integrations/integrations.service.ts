import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'crypto';
import {
  IntegrationProvider,
  NotificationSeverity,
  NotificationType,
  Prisma,
  SyncDirection,
  SyncStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { runUnscoped, runWithTenant } from '../common/tenant/tenant-context';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { CreateWebhookDto } from './dto/create-webhook.dto';

const ALGORITHM = 'aes-256-gcm';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    // Derived from the app secret rather than stored separately: one secret to
    // rotate, and a credential encrypted under it cannot be read from a stolen
    // database dump alone.
    const secret =
      this.config.get<string>('INTEGRATION_ENCRYPTION_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      'insecure-development-key-change-me';
    this.encryptionKey = scryptSync(secret, 'wms-integration-salt', 32);
  }

  // -------------------------------------------------------------- credentials

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
  }

  private decrypt(payload: string): string | null {
    try {
      const [ivB64, tagB64, dataB64] = payload.split('.');
      if (!ivB64 || !tagB64 || !dataB64) return null;
      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // A key rotation invalidates old ciphertexts; the connection then needs
      // its credentials re-entered rather than the whole request failing.
      this.logger.warn('Failed to decrypt an integration credential — re-enter it');
      return null;
    }
  }

  /** Credentials never leave the service. Callers get a masked marker only. */
  private redact<T extends { apiKeyEncrypted: string | null; apiSecretEncrypted: string | null }>(
    connection: T,
  ) {
    const { apiKeyEncrypted, apiSecretEncrypted, ...rest } = connection;
    return {
      ...rest,
      hasApiKey: Boolean(apiKeyEncrypted),
      hasApiSecret: Boolean(apiSecretEncrypted),
    };
  }

  // ------------------------------------------------------------- connections

  async list() {
    const connections = await this.prisma.integrationConnection.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        syncLogs: { orderBy: { startedAt: 'desc' }, take: 5 },
      },
    });
    return connections.map((c) => this.redact(c));
  }

  async get(connectionId: string) {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId },
      include: { syncLogs: { orderBy: { startedAt: 'desc' }, take: 20 } },
    });
    if (!connection) throw new NotFoundException('Integration connection not found');
    return this.redact(connection);
  }

  async create(dto: CreateConnectionDto) {
    const existing = await this.prisma.integrationConnection.findFirst({
      where: { provider: dto.provider, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`A ${dto.provider} connection named "${dto.name}" already exists`);
    }

    const connection = await this.prisma.integrationConnection.create({
      data: {
        provider: dto.provider,
        name: dto.name,
        baseUrl: dto.baseUrl ?? null,
        apiKeyEncrypted: dto.apiKey ? this.encrypt(dto.apiKey) : null,
        apiSecretEncrypted: dto.apiSecret ? this.encrypt(dto.apiSecret) : null,
        config: (dto.config ?? null) as Prisma.InputJsonValue,
        syncEntities: dto.syncEntities ?? ['products', 'stock'],
        syncInterval: dto.syncInterval ?? 15,
        isActive: dto.isActive ?? false,
      },
    });

    return this.redact(connection);
  }

  async update(connectionId: string, dto: UpdateConnectionDto) {
    const connection = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId } });
    if (!connection) throw new NotFoundException('Integration connection not found');

    const updated = await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: {
        name: dto.name,
        baseUrl: dto.baseUrl,
        // Absent means "leave it alone"; empty string means "clear it".
        apiKeyEncrypted:
          dto.apiKey === undefined ? undefined : dto.apiKey ? this.encrypt(dto.apiKey) : null,
        apiSecretEncrypted:
          dto.apiSecret === undefined ? undefined : dto.apiSecret ? this.encrypt(dto.apiSecret) : null,
        config: dto.config === undefined ? undefined : (dto.config as Prisma.InputJsonValue),
        syncEntities: dto.syncEntities,
        syncInterval: dto.syncInterval,
        isActive: dto.isActive,
      },
    });

    return this.redact(updated);
  }

  async remove(connectionId: string) {
    const connection = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId } });
    if (!connection) throw new NotFoundException('Integration connection not found');
    await this.prisma.integrationConnection.delete({ where: { id: connectionId } });
    return { message: 'Integration connection deleted' };
  }

  /** Verifies the endpoint answers and the credential is accepted. */
  async testConnection(connectionId: string) {
    const connection = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId } });
    if (!connection) throw new NotFoundException('Integration connection not found');
    if (!connection.baseUrl) throw new BadRequestException('Connection has no base URL configured');

    const apiKey = connection.apiKeyEncrypted ? this.decrypt(connection.apiKeyEncrypted) : null;
    const started = Date.now();

    try {
      const response = await fetch(this.healthUrl(connection.provider, connection.baseUrl), {
        method: 'GET',
        headers: this.authHeaders(connection.provider, apiKey),
        signal: AbortSignal.timeout(10_000),
      });

      const ok = response.ok;
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: ok ? 'connected' : 'error',
          lastError: ok ? null : `HTTP ${response.status} ${response.statusText}`,
        },
      });

      return {
        ok,
        status: response.status,
        latencyMs: Date.now() - started,
        message: ok ? 'Connection verified' : `Endpoint returned ${response.status}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: 'error', lastError: message },
      });
      return { ok: false, status: null, latencyMs: Date.now() - started, message };
    }
  }

  private healthUrl(provider: IntegrationProvider, baseUrl: string): string {
    const root = baseUrl.replace(/\/+$/, '');
    switch (provider) {
      case IntegrationProvider.SHOPIFY:
        return `${root}/admin/api/2024-10/shop.json`;
      case IntegrationProvider.WOOCOMMERCE:
        return `${root}/wp-json/wc/v3/system_status`;
      case IntegrationProvider.ODOO:
        return `${root}/web/webclient/version_info`;
      case IntegrationProvider.SAP:
      case IntegrationProvider.ORACLE:
      case IntegrationProvider.CUSTOM:
      default:
        return `${root}/health`;
    }
  }

  private authHeaders(provider: IntegrationProvider, apiKey: string | null): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!apiKey) return headers;

    switch (provider) {
      case IntegrationProvider.SHOPIFY:
        headers['X-Shopify-Access-Token'] = apiKey;
        break;
      case IntegrationProvider.WOOCOMMERCE:
      default:
        headers.Authorization = `Bearer ${apiKey}`;
        break;
    }
    return headers;
  }

  // -------------------------------------------------------------------- sync

  /**
   * Pushes current stock to a connected storefront.
   *
   * Outbound only, and deliberately so: this system is the source of truth for
   * quantities. Letting a storefront write stock back is how two systems end up
   * overselling the same unit.
   */
  async pushStock(connectionId: string, skus?: string[]) {
    const connection = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId } });
    if (!connection) throw new NotFoundException('Integration connection not found');
    if (!connection.isActive) throw new BadRequestException('Connection is not active');
    if (!connection.baseUrl) throw new BadRequestException('Connection has no base URL configured');

    const log = await this.prisma.integrationSyncLog.create({
      data: {
        connectionId,
        direction: SyncDirection.OUTBOUND,
        entity: 'stock',
        status: SyncStatus.RUNNING,
      },
    });

    try {
      const levels = await this.prisma.stockLevel.groupBy({
        by: ['sku'],
        where: skus?.length ? { sku: { in: skus } } : {},
        _sum: { available: true },
      });

      const products = await this.prisma.product.findMany({
        where: { status: 'active', ...(skus?.length ? { sku: { in: skus } } : {}) },
        select: { sku: true, name: true, unitPrice: true, barcode: true },
      });

      const availableBySku = new Map(levels.map((l) => [l.sku, l._sum.available ?? 0]));

      const payload = products.map((p) => ({
        sku: p.sku,
        name: p.name,
        price: p.unitPrice,
        barcode: p.barcode,
        available: availableBySku.get(p.sku) ?? 0,
      }));

      const apiKey = connection.apiKeyEncrypted ? this.decrypt(connection.apiKeyEncrypted) : null;
      const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/inventory/bulk`, {
        method: 'POST',
        headers: { ...this.authHeaders(connection.provider, apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payload }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Remote rejected the push: HTTP ${response.status} ${response.statusText}`);
      }

      await this.prisma.$transaction([
        this.prisma.integrationSyncLog.update({
          where: { id: log.id },
          data: {
            status: SyncStatus.SUCCESS,
            recordsProcessed: payload.length,
            finishedAt: new Date(),
          },
        }),
        this.prisma.integrationConnection.update({
          where: { id: connectionId },
          data: { lastSyncAt: new Date(), status: 'connected', lastError: null },
        }),
      ]);

      return { ok: true, pushed: payload.length, syncLogId: log.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.$transaction([
        this.prisma.integrationSyncLog.update({
          where: { id: log.id },
          data: { status: SyncStatus.FAILED, error: message, finishedAt: new Date() },
        }),
        this.prisma.integrationConnection.update({
          where: { id: connectionId },
          data: { status: 'error', lastError: message },
        }),
      ]);

      await this.notifications.create({
        type: NotificationType.INTEGRATION_ERROR,
        severity: NotificationSeverity.DANGER,
        title: `فشل مزامنة: ${connection.name}`,
        message: `تعذّرت مزامنة المخزون مع ${connection.provider} (${connection.name}): ${message}`,
        entityType: 'integration_connection',
        entityId: connectionId,
        metadata: { provider: connection.provider, error: message },
        dedupeKey: `integration-error:${connectionId}:${new Date().toISOString().slice(0, 10)}`,
      });

      return { ok: false, pushed: 0, error: message, syncLogId: log.id };
    }
  }

  async syncLogs(connectionId: string, limit = 50) {
    return this.prisma.integrationSyncLog.findMany({
      where: { connectionId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(200, limit),
    });
  }

  // ---------------------------------------------------------------- webhooks

  listWebhooks() {
    return this.prisma.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } });
  }

  createWebhook(dto: CreateWebhookDto) {
    return this.prisma.webhookEndpoint.create({
      data: {
        name: dto.name,
        url: dto.url,
        events: dto.events ?? ['stock.changed'],
        secret: dto.secret ?? randomBytes(24).toString('hex'),
        isActive: dto.isActive ?? true,
      },
    });
  }

  async deleteWebhook(webhookId: string) {
    const hook = await this.prisma.webhookEndpoint.findFirst({ where: { id: webhookId } });
    if (!hook) throw new NotFoundException('Webhook endpoint not found');
    await this.prisma.webhookEndpoint.delete({ where: { id: webhookId } });
    return { message: 'Webhook endpoint deleted' };
  }

  /**
   * Fires an event at every subscribed endpoint.
   *
   * Each delivery carries an HMAC over the exact body sent, so a receiver can
   * verify the call came from this system and was not replayed with altered
   * quantities. Failures are counted, not retried here — a webhook that is
   * down should not hold up the stock movement that triggered it.
   */
  async dispatch(event: string, payload: Record<string, unknown>) {
    const hooks = await this.prisma.webhookEndpoint.findMany({
      where: { isActive: true, events: { has: event } },
    });
    if (hooks.length === 0) return { delivered: 0, failed: 0 };

    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
    let delivered = 0;
    let failed = 0;

    await Promise.all(
      hooks.map(async (hook) => {
        try {
          const signature = hook.secret
            ? createHmac('sha256', hook.secret).update(body).digest('hex')
            : undefined;

          const response = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(signature ? { 'X-WMS-Signature': `sha256=${signature}` } : {}),
              'X-WMS-Event': event,
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });

          if (response.ok) {
            delivered++;
            await this.prisma.webhookEndpoint.update({
              where: { id: hook.id },
              data: { lastFiredAt: new Date(), failureCount: 0 },
            });
          } else {
            failed++;
            await this.bumpFailure(hook.id, hook.failureCount);
          }
        } catch {
          failed++;
          await this.bumpFailure(hook.id, hook.failureCount);
        }
      }),
    );

    return { delivered, failed };
  }

  /** Ten consecutive failures disables the hook rather than retrying forever. */
  private async bumpFailure(webhookId: string, current: number) {
    await this.prisma.webhookEndpoint.update({
      where: { id: webhookId },
      data: { failureCount: current + 1, isActive: current + 1 < 10 },
    });
  }

  // ------------------------------------------------------------------- cron

  /** Pushes stock for every active connection whose interval has elapsed. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledSync() {
    const tenants = await runUnscoped('integration-sync-tenants', () =>
      this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true, name: true } }),
    );

    for (const tenant of tenants) {
      await runWithTenant(
        { tenantId: tenant.id, bypass: false, actor: 'system:integration-sync' },
        async () => {
          const connections = await this.prisma.integrationConnection.findMany({
            where: { isActive: true, syncEntities: { has: 'stock' } },
          });

          for (const connection of connections) {
            const dueAt = connection.lastSyncAt
              ? connection.lastSyncAt.getTime() + connection.syncInterval * 60_000
              : 0;
            if (Date.now() < dueAt) continue;

            try {
              await this.pushStock(connection.id);
            } catch (error) {
              this.logger.error(
                `Scheduled sync failed for ${connection.name} (${tenant.name})`,
                error as Error,
              );
            }
          }
        },
      );
    }
  }
}
