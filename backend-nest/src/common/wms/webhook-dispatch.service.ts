import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/** Events a subscriber can register for. */
export type WmsEvent =
  | 'stock.changed'
  | 'batch.expiring'
  | 'batch.quarantined'
  | 'invoice.posted'
  | 'invoice.cancelled'
  | 'shipment.dispatched'
  | 'count.completed';

/**
 * Outbound webhook delivery.
 *
 * This lives in the global WMS module rather than in `IntegrationsService`
 * for one structural reason: the services that need to fire an event
 * (inventory, invoicing, shipping) are the same ones `IntegrationsModule`
 * would have to import to read stock — so putting the dispatcher there makes
 * the import graph circular. A global, dependency-free service breaks the
 * cycle, and every caller injects it without importing anything.
 *
 * Delivery never blocks or fails the business operation that triggered it: a
 * warehouse must be able to ship goods while a customer's storefront is down.
 * Callers therefore fire and forget, and the failure lands in the log and the
 * endpoint's failure counter instead of in the user's transaction.
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Delivers `event` to every active endpoint subscribed to it.
   *
   * Safe to call without awaiting. Call it *after* the transaction commits —
   * a webhook announcing a stock change that then rolls back is worse than a
   * late one.
   */
  emit(event: WmsEvent, payload: Record<string, unknown>): void {
    void this.deliver(event, payload).catch((error) => {
      this.logger.error(`Webhook dispatch failed for ${event}`, error as Error);
    });
  }

  /** Awaitable form, for the rare caller that needs the delivery counts. */
  async deliver(
    event: WmsEvent,
    payload: Record<string, unknown>,
  ): Promise<{ delivered: number; failed: number }> {
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
          // Signed over the exact bytes sent, so a receiver can prove the call
          // came from us and was not replayed with altered quantities.
          const signature = hook.secret
            ? createHmac('sha256', hook.secret).update(body).digest('hex')
            : undefined;

          const response = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-WMS-Event': event,
              ...(signature ? { 'X-WMS-Signature': `sha256=${signature}` } : {}),
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
            await this.recordFailure(hook.id, hook.failureCount, `HTTP ${response.status}`);
          }
        } catch (error) {
          failed++;
          await this.recordFailure(
            hook.id,
            hook.failureCount,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );

    return { delivered, failed };
  }

  /** Ten consecutive failures disable the endpoint instead of retrying forever. */
  private async recordFailure(webhookId: string, current: number, reason: string) {
    const next = current + 1;
    if (next >= 10) {
      this.logger.warn(`Disabling webhook ${webhookId} after 10 failures — last: ${reason}`);
    }
    await this.prisma.webhookEndpoint.update({
      where: { id: webhookId },
      data: { failureCount: next, isActive: next < 10 },
    });
  }
}
