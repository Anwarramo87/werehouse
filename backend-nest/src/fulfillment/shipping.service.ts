import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  NotificationSeverity,
  NotificationType,
  Prisma,
  ShipmentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BarcodeService } from '../common/wms/barcode.service';
import { DocumentNumberService } from '../common/wms/document-number.service';
import { WebhookDispatchService } from '../common/wms/webhook-dispatch.service';
import { currentTenant } from '../common/tenant/tenant-context';
import { paginatedResponse, resolvePagination } from '../common/utils/pagination.util';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { CreateCarrierDto } from './dto/create-carrier.dto';
import { CreatePackageDto } from './dto/create-package.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';

type Actor = Pick<AuthenticatedUser, 'userId' | 'username'> | undefined;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly barcode: BarcodeService,
    private readonly documentNumbers: DocumentNumberService,
    private readonly webhooks: WebhookDispatchService,
  ) {}

  // ----------------------------------------------------------------- carriers

  listCarriers() {
    return this.prisma.carrier.findMany({ orderBy: { name: 'asc' } });
  }

  async createCarrier(dto: CreateCarrierDto) {
    const existing = await this.prisma.carrier.findFirst({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Carrier "${dto.code}" already exists`);
    return this.prisma.carrier.create({ data: { ...dto } });
  }

  async updateCarrier(carrierId: string, dto: Partial<CreateCarrierDto>) {
    const carrier = await this.prisma.carrier.findFirst({ where: { id: carrierId } });
    if (!carrier) throw new NotFoundException('Carrier not found');
    return this.prisma.carrier.update({
      where: { id: carrierId },
      data: { name: dto.name, contactPhone: dto.contactPhone, trackingUrlTemplate: dto.trackingUrlTemplate, isActive: dto.isActive },
    });
  }

  // ----------------------------------------------------------------- packages

  /**
   * Records a physical parcel and what went into it.
   *
   * Weight is taken from the scale when the packer supplies it, and otherwise
   * computed from the products' unit weights — a shipping label needs a
   * number, and an estimate beats blocking the dock.
   */
  async createPackage(dto: CreatePackageDto, actor: Actor) {
    const tenantId = currentTenant()?.tenantId ?? null;

    const skus = [...new Set(dto.items.map((i) => i.sku))];
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, weightKg: true },
    });
    const weightBySku = new Map(products.map((p) => [p.sku, D(p.weightKg ?? 0)]));

    const computedWeight = dto.items.reduce(
      (sum, item) => sum.plus((weightBySku.get(item.sku) ?? ZERO).mul(item.quantity)),
      ZERO,
    );

    return this.prisma.$transaction(async (tx) => {
      const packageNumber = await this.documentNumbers.next(tx, 'package', tenantId);

      return tx.package.create({
        data: {
          packageNumber,
          shipmentId: dto.shipmentId ?? null,
          salesOrderId: dto.salesOrderId ?? null,
          weightKg: dto.weightKg === undefined ? computedWeight : D(dto.weightKg),
          lengthCm: D(dto.lengthCm ?? 0),
          widthCm: D(dto.widthCm ?? 0),
          heightCm: D(dto.heightCm ?? 0),
          packagingType: dto.packagingType ?? 'box',
          barcode: this.barcode.normalize(packageNumber),
          packedBy: actor?.userId ?? null,
          packedAt: new Date(),
          items: {
            create: dto.items.map((item) => ({
              sku: item.sku,
              batchId: item.batchId ?? null,
              batchNumber: item.batchNumber ?? null,
              quantity: item.quantity,
            })),
          },
        },
        include: { items: true },
      });
    });
  }

  async listPackages(shipmentId?: string, salesOrderId?: string) {
    return this.prisma.package.findMany({
      where: {
        ...(shipmentId ? { shipmentId } : {}),
        ...(salesOrderId ? { salesOrderId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  // ---------------------------------------------------------------- shipments

  async listShipments(query: {
    page?: string | number;
    limit?: string | number;
    status?: ShipmentStatus;
    carrierId?: string;
  }) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 25 });

    const where: Prisma.ShipmentWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.carrierId) where.carrierId = query.carrierId;

    const [shipments, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          carrier: { select: { code: true, name: true, trackingUrlTemplate: true } },
          salesInvoice: { select: { invoiceNumber: true } },
          _count: { select: { packages: true } },
        },
      }),
      this.prisma.shipment.count({ where }),
    ]);

    return paginatedResponse(
      shipments.map((s) => ({ ...s, trackingUrl: this.trackingUrl(s.carrier?.trackingUrlTemplate, s.trackingNumber) })),
      page,
      limit,
      total,
    );
  }

  async getShipment(shipmentId: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId },
      include: {
        carrier: true,
        salesInvoice: { select: { invoiceNumber: true, customerId: true } },
        packages: { include: { items: true } },
      },
    });
    if (!shipment) throw new NotFoundException('Shipment not found');

    return {
      ...shipment,
      trackingUrl: this.trackingUrl(shipment.carrier?.trackingUrlTemplate, shipment.trackingNumber),
    };
  }

  async createShipment(dto: CreateShipmentDto, actor: Actor) {
    const tenantId = currentTenant()?.tenantId ?? null;

    if (dto.carrierId) {
      const carrier = await this.prisma.carrier.findFirst({ where: { id: dto.carrierId } });
      if (!carrier) throw new NotFoundException('Carrier not found');
    }

    const shipment = await this.prisma.$transaction(async (tx) => {
      const shipmentNumber = await this.documentNumbers.next(tx, 'shipment', tenantId);

      const created = await tx.shipment.create({
        data: {
          shipmentNumber,
          salesOrderId: dto.salesOrderId ?? null,
          salesInvoiceId: dto.salesInvoiceId ?? null,
          carrierId: dto.carrierId ?? null,
          trackingNumber: dto.trackingNumber ?? null,
          shippingCost: D(dto.shippingCost ?? 0),
          recipientName: dto.recipientName ?? null,
          recipientPhone: dto.recipientPhone ?? null,
          address: dto.address ?? null,
          notes: dto.notes ?? null,
          createdBy: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
        },
      });

      // Attaching existing packages here keeps the pack-then-ship flow working
      // for warehouses that box goods before deciding on a carrier.
      if (dto.packageIds?.length) {
        await tx.package.updateMany({
          where: { id: { in: dto.packageIds } },
          data: { shipmentId: created.id },
        });
      }

      return created;
    });

    return this.recalculateShipment(shipment.id);
  }

  /**
   * Generates the shipping label.
   *
   * The payload is self-contained — shipment number, tracking number, weight
   * and parcel count — so a scan at the depot identifies the consignment even
   * when the carrier's own system is unreachable.
   */
  async generateLabel(shipmentId: string, format: 'code128' | 'qr' = 'code128') {
    const shipment = await this.getShipment(shipmentId);

    const payload = [
      shipment.shipmentNumber,
      shipment.trackingNumber ?? '',
      `${shipment.packageCount}PK`,
      `${D(shipment.totalWeightKg).toFixed(2)}KG`,
    ]
      .filter(Boolean)
      .join('|');

    const encoded = this.barcode.normalize(shipment.trackingNumber ?? shipment.shipmentNumber);

    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { labelPayload: payload, labelFormat: format, status: ShipmentStatus.LABELED },
    });

    return {
      shipmentNumber: shipment.shipmentNumber,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier?.name ?? null,
      recipient: {
        name: shipment.recipientName,
        phone: shipment.recipientPhone,
        address: shipment.address,
      },
      packageCount: shipment.packageCount,
      totalWeightKg: shipment.totalWeightKg,
      payload,
      format,
      svg: this.barcode.svg(encoded, { height: 80 }),
      packages: shipment.packages.map((pkg) => ({
        packageNumber: pkg.packageNumber,
        weightKg: pkg.weightKg,
        barcode: pkg.barcode,
        svg: pkg.barcode ? this.barcode.svg(pkg.barcode, { height: 50, moduleWidth: 1.5 }) : null,
      })),
    };
  }

  /**
   * Advances the shipment through its lifecycle.
   *
   * Transitions are checked rather than trusted: a shipment cannot go from
   * PENDING straight to DELIVERED, because that is how a consignment ends up
   * marked delivered while its parcels are still on the dock.
   */
  async updateStatus(shipmentId: string, dto: UpdateShipmentStatusDto, actor: Actor) {
    const shipment = await this.prisma.shipment.findFirst({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Shipment not found');

    const allowed: Record<ShipmentStatus, ShipmentStatus[]> = {
      [ShipmentStatus.PENDING]: [ShipmentStatus.LABELED, ShipmentStatus.CANCELLED],
      [ShipmentStatus.LABELED]: [ShipmentStatus.DISPATCHED, ShipmentStatus.CANCELLED],
      [ShipmentStatus.DISPATCHED]: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED],
      [ShipmentStatus.IN_TRANSIT]: [ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED],
      [ShipmentStatus.DELIVERED]: [ShipmentStatus.RETURNED],
      [ShipmentStatus.RETURNED]: [],
      [ShipmentStatus.CANCELLED]: [],
    };

    if (!allowed[shipment.status].includes(dto.status)) {
      throw new ConflictException(
        `Cannot move a shipment from ${shipment.status} to ${dto.status}. Allowed: ${allowed[shipment.status].join(', ') || 'none'}`,
      );
    }

    const updated = await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: dto.status,
        trackingNumber: dto.trackingNumber ?? shipment.trackingNumber,
        shippedAt: dto.status === ShipmentStatus.DISPATCHED ? new Date() : shipment.shippedAt,
        deliveredAt: dto.status === ShipmentStatus.DELIVERED ? new Date() : shipment.deliveredAt,
        notes: dto.notes ?? shipment.notes,
      },
    });

    if (dto.status === ShipmentStatus.DISPATCHED) {
      await this.notifications.create({
        type: NotificationType.SHIPMENT_DISPATCHED,
        severity: NotificationSeverity.SUCCESS,
        title: `شحنة خرجت: ${shipment.shipmentNumber}`,
        message: `الشحنة ${shipment.shipmentNumber} غادرت المخزن${
          updated.trackingNumber ? ` — رقم التتبع ${updated.trackingNumber}` : ''
        }.`,
        entityType: 'shipment',
        entityId: shipmentId,
        metadata: { shipmentNumber: shipment.shipmentNumber, trackingNumber: updated.trackingNumber },
        dedupeKey: `shipment-dispatched:${shipmentId}`,
      });

      this.webhooks.emit('shipment.dispatched', {
        shipmentId,
        shipmentNumber: shipment.shipmentNumber,
        trackingNumber: updated.trackingNumber,
        carrierId: shipment.carrierId,
        packageCount: shipment.packageCount,
        weightKg: shipment.totalWeightKg.toString(),
      });
    }

    return updated;
  }

  /** Recomputes parcel count and total weight from the attached packages. */
  async recalculateShipment(shipmentId: string) {
    const packages = await this.prisma.package.findMany({ where: { shipmentId } });

    return this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        packageCount: packages.length,
        totalWeightKg: packages.reduce((s, p) => s.plus(D(p.weightKg)), ZERO),
      },
      include: { packages: { include: { items: true } }, carrier: true },
    });
  }

  private trackingUrl(template: string | null | undefined, tracking: string | null): string | null {
    if (!template || !tracking) return null;
    return template.replace('{tracking}', encodeURIComponent(tracking));
  }
}
