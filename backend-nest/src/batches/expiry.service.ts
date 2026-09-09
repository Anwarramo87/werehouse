import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BatchStatus,
  NotificationSeverity,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhookDispatchService } from '../common/wms/webhook-dispatch.service';
import { runUnscoped, runWithTenant } from '../common/tenant/tenant-context';
import { CreateExpiryRuleDto } from './dto/create-expiry-rule.dto';
import { UpdateExpiryRuleDto } from './dto/update-expiry-rule.dto';

/** Escalation bands a batch can fall into, worst first. */
export type ExpiryLevel = 'expired' | 'critical' | 'warning' | 'ok';

interface EffectiveRule {
  warnDays: number;
  criticalDays: number;
  blockDays: number;
  notifySales: boolean;
  notifyEmails: string[];
  source: string;
}

const DEFAULT_RULE: EffectiveRule = {
  warnDays: 60,
  criticalDays: 30,
  blockDays: 0,
  notifySales: true,
  notifyEmails: [],
  source: 'default',
};

@Injectable()
export class ExpiryService {
  private readonly logger = new Logger(ExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhookDispatchService,
  ) {}

  // ------------------------------------------------------------------- rules

  listRules() {
    return this.prisma.expiryAlertRule.findMany({
      orderBy: [{ sku: { sort: 'asc', nulls: 'last' } }, { category: { sort: 'asc', nulls: 'last' } }],
    });
  }

  createRule(dto: CreateExpiryRuleDto) {
    return this.prisma.expiryAlertRule.create({
      data: {
        name: dto.name,
        category: dto.category ?? null,
        sku: dto.sku ?? null,
        warnDays: dto.warnDays ?? 60,
        criticalDays: dto.criticalDays ?? 30,
        blockDays: dto.blockDays ?? 0,
        notifyEmails: dto.notifyEmails ?? [],
        notifySales: dto.notifySales ?? true,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateRule(ruleId: string, dto: UpdateExpiryRuleDto) {
    const rule = await this.prisma.expiryAlertRule.findFirst({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException('Expiry rule not found');
    return this.prisma.expiryAlertRule.update({ where: { id: ruleId }, data: { ...dto } });
  }

  async deleteRule(ruleId: string) {
    const rule = await this.prisma.expiryAlertRule.findFirst({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException('Expiry rule not found');
    await this.prisma.expiryAlertRule.delete({ where: { id: ruleId } });
    return { message: 'Expiry rule deleted' };
  }

  /**
   * Resolves which rule governs a product. Most specific wins: an explicit SKU
   * rule beats its category's, which beats the tenant-wide default. Without
   * that precedence a single medical rule would drag every food item to a
   * 90-day warning and drown the dashboard.
   */
  private pickRule(rules: Array<Prisma.ExpiryAlertRuleGetPayload<object>>, sku: string, category: string): EffectiveRule {
    const bySku = rules.find((r) => r.isActive && r.sku === sku);
    const byCategory = rules.find((r) => r.isActive && !r.sku && r.category === category);
    const global = rules.find((r) => r.isActive && !r.sku && !r.category);
    const rule = bySku ?? byCategory ?? global;
    if (!rule) return DEFAULT_RULE;
    return {
      warnDays: rule.warnDays,
      criticalDays: rule.criticalDays,
      blockDays: rule.blockDays,
      notifySales: rule.notifySales,
      notifyEmails: rule.notifyEmails,
      source: rule.sku ? `sku:${rule.sku}` : rule.category ? `category:${rule.category}` : 'global',
    };
  }

  private levelFor(daysLeft: number, rule: EffectiveRule): ExpiryLevel {
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= rule.criticalDays) return 'critical';
    if (daysLeft <= rule.warnDays) return 'warning';
    return 'ok';
  }

  // --------------------------------------------------------------- dashboard

  /**
   * The expiry board: every in-stock batch that any rule considers at risk,
   * bucketed by severity and valued at cost so the number has a currency
   * figure attached — "37 batches" does not get a manager's attention, "37
   * batches worth 4.2M" does.
   */
  async dashboard(options?: { horizonDays?: number }) {
    const horizon = options?.horizonDays ?? 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + horizon);

    const [batches, rules, products] = await Promise.all([
      this.prisma.productBatch.findMany({
        where: {
          quantity: { gt: 0 },
          expiryDate: { not: null, lte: cutoff },
          status: { notIn: [BatchStatus.CONSUMED, BatchStatus.REJECTED] },
        },
        orderBy: { expiryDate: 'asc' },
        include: { stockLevels: true },
      }),
      this.prisma.expiryAlertRule.findMany({ where: { isActive: true } }),
      this.prisma.product.findMany({ select: { sku: true, name: true, category: true, unit: true } }),
    ]);

    const productBySku = new Map(products.map((p) => [p.sku, p]));

    const buckets: Record<ExpiryLevel, Array<Record<string, unknown>>> = {
      expired: [],
      critical: [],
      warning: [],
      ok: [],
    };
    const value: Record<ExpiryLevel, Prisma.Decimal> = {
      expired: new Prisma.Decimal(0),
      critical: new Prisma.Decimal(0),
      warning: new Prisma.Decimal(0),
      ok: new Prisma.Decimal(0),
    };

    for (const batch of batches) {
      const product = productBySku.get(batch.sku);
      const rule = this.pickRule(rules, batch.sku, product?.category ?? '');
      const daysLeft = Math.floor((batch.expiryDate!.getTime() - Date.now()) / 86_400_000);
      const level = this.levelFor(daysLeft, rule);
      if (level === 'ok') continue;

      const batchValue = new Prisma.Decimal(batch.unitCost).mul(batch.quantity);
      value[level] = value[level].plus(batchValue);

      buckets[level].push({
        batchId: batch.id,
        sku: batch.sku,
        productName: product?.name ?? batch.sku,
        category: product?.category ?? null,
        unit: product?.unit ?? 'قطعة',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        daysLeft,
        quantity: batch.quantity,
        reserved: batch.reserved,
        status: batch.status,
        unitCost: batch.unitCost,
        value: batchValue,
        locations: batch.stockLevels.map((s) => ({ location: s.location, quantity: s.quantity })),
        rule: rule.source,
        willBlockInDays: rule.blockDays > 0 ? daysLeft - rule.blockDays : null,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      horizonDays: horizon,
      summary: {
        expired: { count: buckets.expired.length, value: value.expired },
        critical: { count: buckets.critical.length, value: value.critical },
        warning: { count: buckets.warning.length, value: value.warning },
        totalAtRisk: buckets.expired.length + buckets.critical.length + buckets.warning.length,
        totalValueAtRisk: value.expired.plus(value.critical).plus(value.warning),
      },
      expired: buckets.expired,
      critical: buckets.critical,
      warning: buckets.warning,
    };
  }

  // ----------------------------------------------------------------- scanner

  /**
   * Nightly sweep, per factory.
   *
   * Three things happen, in this order: batches past their date are marked
   * EXPIRED, batches inside their rule's block window are quarantined (which
   * is what actually stops them being sold), and the survivors raise
   * notifications. Ordering matters — quarantining first means the notification
   * reports the state the warehouse is now in, not the one it was in.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scanAllTenants(): Promise<void> {
    const tenants = await runUnscoped('expiry-scan-tenants', () =>
      this.prisma.tenant.findMany({ where: { status: 'active' }, select: { id: true, name: true } }),
    );

    for (const tenant of tenants) {
      try {
        await runWithTenant(
          { tenantId: tenant.id, bypass: false, actor: 'system:expiry-scan' },
          () => this.scan(),
        );
      } catch (error) {
        this.logger.error(`Expiry scan failed for tenant ${tenant.name}`, error as Error);
      }
    }
  }

  /** One factory's sweep. Safe to call by hand from the dashboard's refresh. */
  async scan(): Promise<{
    expired: number;
    quarantined: number;
    notified: number;
    scanned: number;
  }> {
    const [batches, rules, products] = await Promise.all([
      this.prisma.productBatch.findMany({
        where: {
          quantity: { gt: 0 },
          expiryDate: { not: null },
          status: { in: [BatchStatus.AVAILABLE, BatchStatus.NEAR_EXPIRY] },
        },
      }),
      this.prisma.expiryAlertRule.findMany({ where: { isActive: true } }),
      this.prisma.product.findMany({ select: { sku: true, name: true, category: true } }),
    ]);

    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const today = new Date().toISOString().slice(0, 10);

    let expired = 0;
    let quarantined = 0;
    let notified = 0;

    for (const batch of batches) {
      const product = productBySku.get(batch.sku);
      const rule = this.pickRule(rules, batch.sku, product?.category ?? '');
      const daysLeft = Math.floor((batch.expiryDate!.getTime() - Date.now()) / 86_400_000);
      const level = this.levelFor(daysLeft, rule);
      const name = product?.name ?? batch.sku;

      if (level === 'expired') {
        await this.prisma.productBatch.update({
          where: { id: batch.id },
          data: {
            status: BatchStatus.EXPIRED,
            quarantineReason: `انتهت الصلاحية بتاريخ ${batch.expiryDate!.toISOString().slice(0, 10)}`,
          },
        });
        expired++;
        await this.notify(
          NotificationType.EXPIRED,
          NotificationSeverity.DANGER,
          `انتهت صلاحية دفعة: ${name}`,
          `الدفعة ${batch.batchNumber} من "${name}" منتهية الصلاحية منذ ${Math.abs(daysLeft)} يوم — ${batch.quantity} وحدة سُحبت من البيع تلقائياً.`,
          batch.id,
          { sku: batch.sku, batchNumber: batch.batchNumber, quantity: batch.quantity, daysLeft },
          `expired:${batch.id}`,
        );
        notified++;
        continue;
      }

      // Automatic quarantine: the batch stops being sellable `blockDays`
      // before it expires, which is the compliance requirement — not a
      // warning, an actual block.
      if (rule.blockDays > 0 && daysLeft <= rule.blockDays) {
        await this.prisma.productBatch.update({
          where: { id: batch.id },
          data: {
            status: BatchStatus.QUARANTINE,
            quarantineReason: `حجر تلقائي: تبقّى ${daysLeft} يوم على الانتهاء (حد القاعدة ${rule.blockDays} يوم)`,
          },
        });
        quarantined++;
        await this.notify(
          NotificationType.BATCH_QUARANTINED,
          NotificationSeverity.DANGER,
          `حجر تلقائي: ${name}`,
          `الدفعة ${batch.batchNumber} من "${name}" حُجرت تلقائياً — تبقّى ${daysLeft} يوم على انتهاء الصلاحية. ${batch.quantity} وحدة أصبحت غير قابلة للبيع.`,
          batch.id,
          { sku: batch.sku, batchNumber: batch.batchNumber, daysLeft, blockDays: rule.blockDays },
          `quarantine:${batch.id}`,
        );
        notified++;
        continue;
      }

      if (level === 'critical' || level === 'warning') {
        if (batch.status !== BatchStatus.NEAR_EXPIRY) {
          await this.prisma.productBatch.update({
            where: { id: batch.id },
            data: { status: BatchStatus.NEAR_EXPIRY },
          });
        }

        // Deduped per batch per day: the sweep runs nightly and a 45-day
        // warning should not produce 45 identical notifications.
        await this.notify(
          level === 'critical' ? NotificationType.EXPIRY_CRITICAL : NotificationType.EXPIRY_WARNING,
          level === 'critical' ? NotificationSeverity.DANGER : NotificationSeverity.WARNING,
          level === 'critical' ? `صلاحية حرجة: ${name}` : `اقتراب انتهاء صلاحية: ${name}`,
          `الدفعة ${batch.batchNumber} من "${name}" تنتهي خلال ${daysLeft} يوم (${batch.quantity} وحدة).${
            rule.notifySales ? ' يُنصح بتصريفها عبر عرض أو خصم.' : ''
          }`,
          batch.id,
          {
            sku: batch.sku,
            batchNumber: batch.batchNumber,
            daysLeft,
            quantity: batch.quantity,
            level,
            notifyEmails: rule.notifyEmails,
          },
          `expiry:${level}:${batch.id}:${today}`,
        );
        notified++;
      }
    }

    this.logger.log(
      `Expiry scan: ${batches.length} batches, ${expired} expired, ${quarantined} quarantined, ${notified} notifications`,
    );

    // One summary event per sweep rather than one per batch: a subscriber
    // wants to know the shelf changed, not to receive 300 near-identical
    // calls at one in the morning.
    if (expired > 0 || quarantined > 0) {
      this.webhooks.emit('batch.expiring', {
        scanned: batches.length,
        expired,
        quarantined,
        scannedAt: new Date().toISOString(),
      });
    }

    return { expired, quarantined, notified, scanned: batches.length };
  }

  private notify(
    type: NotificationType,
    severity: NotificationSeverity,
    title: string,
    message: string,
    batchId: string,
    metadata: Record<string, unknown>,
    dedupeKey: string,
  ) {
    return this.notifications.create({
      type,
      severity,
      title,
      message,
      entityType: 'product_batch',
      entityId: batchId,
      metadata: metadata as Prisma.InputJsonValue,
      dedupeKey,
    });
  }
}
