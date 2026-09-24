import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Sequential, human-readable document numbers: PINV-2026-000173.
 *
 * The number is derived inside the caller's transaction from a row-locked
 * count of the year's existing documents. Two concurrent posts therefore
 * serialise on the same lock instead of both reading `172` and both writing
 * `...173` -- which the `@@unique([tenantId, <number>])` constraint would turn
 * into a 500 for whichever lost.
 *
 * `table` and `column` are never caller-supplied: every call site passes one of
 * the constants below, so the identifiers interpolated into the raw statement
 * are fixed at compile time.
 */
export const DOCUMENT_SEQUENCES = {
  purchaseInvoice: { table: 'purchase_invoices', column: 'invoiceNumber', prefix: 'PINV' },
  salesInvoice: { table: 'sales_invoices', column: 'invoiceNumber', prefix: 'SINV' },
  deliveryNote: { table: 'delivery_notes', column: 'noteNumber', prefix: 'DN' },
  cycleCount: { table: 'cycle_counts', column: 'countNumber', prefix: 'CC' },
  qualityInspection: { table: 'quality_inspections', column: 'inspectionNumber', prefix: 'QC' },
  pickList: { table: 'pick_lists', column: 'pickNumber', prefix: 'PICK' },
  putawayTask: { table: 'putaway_tasks', column: 'taskNumber', prefix: 'PUT' },
  shipment: { table: 'shipments', column: 'shipmentNumber', prefix: 'SHP' },
  package: { table: 'packages', column: 'packageNumber', prefix: 'PKG' },
  // Manufacturing
  productionOrder: { table: 'production_orders', column: 'orderNumber', prefix: 'PO' },
  productBatch: { table: 'product_batches', column: 'batchNumber', prefix: 'BAT' },
  // Representatives
  repSale: { table: 'rep_sales', column: 'saleNumber', prefix: 'RS' },
} as const;

export type DocumentSequenceName = keyof typeof DOCUMENT_SEQUENCES;

@Injectable()
export class DocumentNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Next number for `sequence`, allocated within `tx`.
   *
   * Runs raw because the tenant extension only rewrites the typed client, and
   * this counts rows across a tenant it is handed explicitly -- there is no
   * ambient request scope inside a cron-driven post.
   */
  async next(
    tx: Prisma.TransactionClient,
    sequence: DocumentSequenceName,
    tenantId: string | null,
    year = new Date().getFullYear(),
  ): Promise<string> {
    const { table, column, prefix } = DOCUMENT_SEQUENCES[sequence];
    const like = `${prefix}-${year}-%`;

    // Advisory lock keyed on (tenant, sequence, year): held until the
    // transaction ends, so the read-then-insert below is atomic against any
    // other allocator of the same sequence.
    const lockKey = `${tenantId ?? 'global'}:${sequence}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const rows = await tx.$queryRawUnsafe<Array<{ last: string | null }>>(
      `SELECT MAX("${column}") AS last FROM "${table}"
       WHERE "${column}" LIKE $1 AND ("tenantId" = $2::uuid OR ($2::uuid IS NULL AND "tenantId" IS NULL))`,
      like,
      tenantId,
    );

    const last = rows[0]?.last ?? null;
    const lastSeq = last ? Number(last.slice(last.lastIndexOf('-') + 1)) : 0;
    const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;

    return `${prefix}-${year}-${String(nextSeq).padStart(6, '0')}`;
  }
}
