import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, NotificationType, NotificationSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway, NotificationRealtimePayload } from '../realtime/realtime.gateway';
import {
  toFactoryDateKey,
  factoryDateKeyDayOfWeek,
  getFactoryLocalDate,
  parseDateKeyToUtcMidnight,
} from '../common/utils/timezone.util';
import { runUnscoped, runWithTenant } from '../common/tenant/tenant-context';
import { tenantKey } from '../common/tenant/tenant-key';

type CreateNotificationInput = {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  employeeId?: string | null;
  employeeName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  /** مفتاح إلغاء التكرار — يمنع إنشاء إشعار مكرر بنفس القيمة (مثلاً لكل موظف/يوم). */
  dedupeKey?: string | null;
};

/** Friday is the factory's weekly rest day (0=Sunday). */
const WEEKEND_DAY_OF_WEEK = 5;

/** "HH:mm" to minutes since local midnight, or null when unparseable. */
function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** What one factory's absence sweep did — returned so tests need no log parsing. */
export type AbsenceScanResult = {
  scanned: number;
  flagged: number;
  onLeave: number;
  present: number;
  /** Why the sweep did nothing, or null when it ran. */
  skipped: string | null;
};

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  /** وقت بداية الدوام الرسمي بتوقيت المصنع — قابل للضبط عبر المتغير. */
  private readonly workStartHour = Number(process.env.WORK_START_HOUR ?? 8);
  private readonly workStartMinute = Number(process.env.WORK_START_MINUTE ?? 0);

  /**
   * The factory-local window the sweep is allowed to run in, and how late
   * someone must be before it counts.
   *
   * The window is separate from WORK_START_HOUR so a factory with an early
   * shift can be scanned from 06:00 without moving everyone's official start.
   */
  private readonly scanStartHour = Number(process.env.ABSENCE_SCAN_START_HOUR ?? 6);
  private readonly scanEndHour = Number(process.env.ABSENCE_SCAN_END_HOUR ?? 17);
  private readonly graceMinutes = Number(process.env.ABSENCE_GRACE_MINUTES ?? 30);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  onModuleInit() {
    this.logger.log(
      `Notification cron active — work day starts at ${this.workStartHour}:${String(
        this.workStartMinute,
      ).padStart(2, '0')}`,
    );
  }

  /**
   * ينشئ إشعاراً في قاعدة البيانات ويبثّه لحظياً عبر WebSocket.
   * الفشل هنا لا يجب أن يوقف العملية الأصلية (مثلاً تسجيل حضور).
   */
  async create(input: CreateNotificationInput): Promise<void> {
    try {
      // إلغاء التكرار: إن وُجد dedupeKey مسبقاً نتخطى الإنشاء.
      if (input.dedupeKey) {
        const existing = await this.prisma.notification.findFirst({
          where: { dedupeKey: input.dedupeKey },
          select: { id: true },
        });
        if (existing) return;
      }

      const notification = await this.prisma.notification.create({
        data: {
          type: input.type,
          severity: input.severity ?? NotificationSeverity.INFO,
          title: input.title,
          message: input.message,
          employeeId: input.employeeId ?? null,
          employeeName: input.employeeName ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          metadata: input.metadata ?? Prisma.JsonNull,
          dedupeKey: input.dedupeKey ?? null,
        },
      });

      const payload: NotificationRealtimePayload = {
        id: notification.id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        message: notification.message,
        employeeId: notification.employeeId,
        employeeName: notification.employeeName,
        entityType: notification.entityType,
        entityId: notification.entityId,
        createdAt: notification.createdAt.toISOString(),
      };

      this.realtimeGateway.emitNotification(payload);
    } catch (error) {
      // عدم كسر السير الرئيسي في حال فشل الإشعار
      this.logger.error('Failed to create notification', error as Error);
    }
  }

  /** جلب قائمة الإشعارات (الأحدث أولاً) مع فلترة اختيارية. */
  async list(opts: { unreadOnly?: boolean; type?: string; limit?: number; cursor?: string }) {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const where: Prisma.NotificationWhereInput = {};
    if (opts.unreadOnly) where.isRead = false;
    if (opts.type) where.type = opts.type as NotificationType;

    const items = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;

    return {
      items: data,
      nextCursor: hasMore ? data[data.length - 1].id : null,
      hasMore,
    };
  }

  async getUnreadCount(): Promise<number> {
    return this.prisma.notification.count({ where: { isRead: false } });
  }

  async markAllRead(): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { count: result.count };
  }

  async markRead(id: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async dismiss(id?: string, dedupeKey?: string, dismissedBy?: string): Promise<void> {
    const data: Prisma.NotificationUpdateInput = {
      isDismissed: true,
      dismissedAt: new Date(),
      dismissedBy: dismissedBy ?? null,
    };

    if (id) {
      await this.prisma.notification.update({ where: { id }, data });
      return;
    }
    if (dedupeKey) {
      await this.prisma.notification.updateMany({
        where: { dedupeKey, isDismissed: false },
        data,
      });
    }
  }

  /**
   * Hourly sweep for staff who have not clocked in, run once per factory.
   *
   * Every Prisma model this touches is tenant-scoped, so the scan must
   * establish a tenant itself: a `@Cron` runs outside any request and
   * `requireScope()` fails closed without one. It previously did not, so every
   * run threw, the catch swallowed it, and no absence notification was ever
   * created. Same shape as ExpiryService.scanAllTenants for that reason.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scanAbsentEmployees(): Promise<void> {
    let tenants: Array<{ id: string; name: string }>;
    try {
      tenants = await runUnscoped('absence-scan-tenants', () =>
        this.prisma.tenant.findMany({
          where: { status: 'active' },
          select: { id: true, name: true },
        }),
      );
    } catch (error) {
      this.logger.error('Absent-employee scan could not list tenants', error as Error);
      return;
    }

    for (const tenant of tenants) {
      try {
        await runWithTenant(
          { tenantId: tenant.id, bypass: false, actor: 'system:absence-scan' },
          () => this.scanTenantAbsences(),
        );
      } catch (error) {
        this.logger.error(
          `Absent-employee scan failed for tenant ${tenant.name}`,
          error as Error,
        );
      }
    }
  }

  /**
   * One factory's sweep. Safe to call by hand.
   *
   * Returns what it did so the behaviour is testable without reading the log.
   */
  async scanTenantAbsences(now = new Date()): Promise<AbsenceScanResult> {
    const skipped = (reason: string): AbsenceScanResult => ({
      scanned: 0,
      flagged: 0,
      onLeave: 0,
      present: 0,
      skipped: reason,
    });

    // Clock arithmetic is done entirely in factory-local minutes. The old code
    // mixed `now.getHours()` (whatever timezone the server happens to run in)
    // with `toFactoryDateKey()` (UTC+3), so on a UTC host the whole working
    // window was three hours out and lateness was computed against the wrong
    // midnight.
    const todayKey = toFactoryDateKey(now);
    const localNow = getFactoryLocalDate(now);
    const nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();

    if (factoryDateKeyDayOfWeek(todayKey) === WEEKEND_DAY_OF_WEEK) {
      return skipped('weekend');
    }
    if (nowMinutes < this.scanStartHour * 60 || nowMinutes >= this.scanEndHour * 60) {
      return skipped('outside scan window');
    }

    const defaultStartMinutes = this.workStartHour * 60 + this.workStartMinute;
    const todayStart = parseDateKeyToUtcMidnight(todayKey);
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'active',
        OR: [{ employmentStartDate: null }, { employmentStartDate: { lte: todayEnd } }],
      },
      select: { employeeId: true, name: true, scheduledStart: true },
    });

    if (employees.length === 0) return skipped('no active employees');

    const employeeIds = employees.map((e) => e.employeeId);

    // Both lookups are one query for the whole factory rather than one per
    // employee: the old loop issued an attendance query per person per hour.
    const [checkIns, approvedLeaves] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, date: todayKey, type: 'IN' },
        select: { employeeId: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: 'APPROVED',
          startDate: { lte: todayEnd },
          endDate: { gte: todayStart },
        },
        select: { employeeId: true },
      }),
    ]);

    const presentIds = new Set(checkIns.map((r) => r.employeeId));
    const onLeaveIds = new Set(approvedLeaves.map((l) => l.employeeId));

    let flagged = 0;

    for (const employee of employees) {
      // Someone who punched in is here. Someone on an approved leave is
      // accounted for. Neither is an absence, and telling the office otherwise
      // is exactly the false alarm this scan is meant to avoid.
      if (presentIds.has(employee.employeeId)) continue;
      if (onLeaveIds.has(employee.employeeId)) continue;

      const startMinutes = parseHhMm(employee.scheduledStart) ?? defaultStartMinutes;
      const lateMinutes = nowMinutes - startMinutes;

      // Grace period: a shift that started twenty minutes ago is not yet an
      // absence, and flagging it trains people to ignore the bell.
      if (lateMinutes < this.graceMinutes) continue;

      const dedupeKey = `ABSENT:${employee.employeeId}:${todayKey}`;

      // A dismissed alert stays dismissed. Upserting unconditionally would
      // rewrite the row every hour and push it back at whoever cleared it.
      const existing = await this.prisma.notification.findFirst({
        where: { dedupeKey },
        select: { id: true, isDismissed: true },
      });
      if (existing?.isDismissed) continue;

      const message =
        `السيد/ة ${employee.name} لم يسجّل الدخول حتى الآن ` +
        `(متأخر ${lateMinutes} دقيقة عن موعد الدوام).`;

      const notification = await this.prisma.notification.upsert({
        where: tenantKey<Prisma.NotificationWhereUniqueInput>({ dedupeKey }),
        create: {
          type: NotificationType.ABSENT,
          severity: NotificationSeverity.WARNING,
          title: 'موظف لم يسجّل دخوله بعد',
          message,
          employeeId: employee.employeeId,
          employeeName: employee.name,
          entityType: 'attendance',
          dedupeKey,
          metadata: { lateMinutes, date: todayKey },
        },
        update: {
          message,
          severity: NotificationSeverity.WARNING,
          metadata: { lateMinutes, date: todayKey },
        },
      });

      flagged += 1;

      this.realtimeGateway.emitNotification({
        id: notification.id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        message: notification.message,
        employeeId: notification.employeeId,
        employeeName: notification.employeeName,
        entityType: notification.entityType,
        entityId: notification.entityId,
        createdAt: notification.updatedAt.toISOString(),
      });
    }

    return {
      scanned: employees.length,
      flagged,
      onLeave: onLeaveIds.size,
      present: presentIds.size,
      skipped: null,
    };
  }
}
