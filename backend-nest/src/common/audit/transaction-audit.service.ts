import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * سجل تدقيق المعاملات — the trail every consequential write leaves behind.
 *
 * ── What is recorded ───────────────────────────────────────────────────────
 * Every entry carries WHAT changed (entity type + id), WHICH operation ran
 * (create / update / delete / post / cancel / lock / transfer), the values
 * BEFORE and AFTER, WHO did it, and WHEN.
 *
 * ── Why it is a separate table and not AuditLog ─────────────────────────────
 * `AuditLog` is the operator-facing activity log (logins, record edits) and
 * it stores free-form JSON metadata. This table is different in two ways that
 * matter:
 *
 *   1. it is QUERYABLE by (entityType, entityId) — "show me everything that
 *      ever happened to this invoice" is a single indexed lookup;
 *   2. it holds the before/after values, so a correction can be explained
 *      rather than merely detected.
 *
 * That second property is what the brief asks for in several places: an
 * exchange rate cannot be re-priced under live documents, a batch cannot be
 * silently rolled back, an invoice cannot be posted twice. In each case the
 * evidence of the change is the point.
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 * A failing audit write must not roll back the business operation it was
 * describing: losing the trail is bad, but refusing the user's legitimate
 * work because the trail could not be written is worse. Failures are logged
 * loudly instead.
 */
@Injectable()
export class TransactionAuditService {
  private readonly logger = new Logger(TransactionAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes one audit entry. Never throws. */
  async record(input: {
    entityType: string;
    entityId: string;
    action: string;
    oldValues?: unknown;
    newValues?: unknown;
    actorId?: string | null;
    actorName?: string | null;
    note?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.transactionAudit.create({
        data: {
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          oldValues:
            input.oldValues === undefined
              ? undefined
              : (JSON.parse(JSON.stringify(input.oldValues)) as object),
          newValues:
            input.newValues === undefined
              ? undefined
              : (JSON.parse(JSON.stringify(input.newValues)) as object),
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not write the audit entry for ${input.entityType}:${input.entityId} ` +
          `(${input.action}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The whole history of one record, newest first.
   *
   * This is the "سجل تدقيق لكل تعديل" the brief asks for on the bus page, the
   * invoice page and the batch page.
   */
  async historyFor(entityType: string, entityId: string) {
    const rows = await this.prisma.transactionAudit.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        oldValues: r.oldValues,
        newValues: r.newValues,
        actorId: r.actorId,
        actorName: r.actorName,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * A filtered list for the audit screen.
   *
   * Bounded to 200 rows a page — this is a browsing view, and an unbounded
   * audit table is exactly the kind of query that takes the API down.
   */
  async list(query: {
    entityType?: string;
    entityId?: string;
    action?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 200);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.action) where.action = query.action;

    const [rows, total] = await Promise.all([
      this.prisma.transactionAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transactionAudit.count({ where }),
    ]);

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
}
