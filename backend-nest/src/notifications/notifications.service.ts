import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, NotificationType, NotificationSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway, NotificationRealtimePayload } from '../realtime/realtime.gateway';

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

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  /** وقت بداية الدوام الرسمي (بالتوقيت المحلي للخادم) — قابل للضبط عبر المتغير. */
  private readonly workStartHour = Number(process.env.WORK_START_HOUR ?? 8);
  private readonly workStartMinute = Number(process.env.WORK_START_MINUTE ?? 0);

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
        const existing = await this.prisma.notification.findUnique({
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
   * المؤقّت كل ساعة:
   * يفحص الموظفين النشطين الذين لم يسجّلوا دخولاً بعد وقت الدوام الرسمي،
   * وينشئ/يحدّث إشعاراً لكل واحد منهم. الإشعار يبقى يتكرر كل ساعة حتى
   * يسجّل الموظف دخوله أو يضغط الأدمن "تجاهل" (isDismissed).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scanAbsentEmployees(): Promise<void> {
    try {
      const now = new Date();
      const currentHour = now.getHours();

      // لا نُنبّه بعد انتهاء الدوام (بعد 17:00) لتجنّب الإزعاج ليلاً
      if (currentHour < this.workStartHour || currentHour >= 17) return;

      const todayKey = now.toISOString().slice(0, 10);

      // وقت بداية الدوام اليوم بصيغة Date
      const workStart = new Date(now);
      workStart.setHours(this.workStartHour, this.workStartMinute, 0, 0);

      const activeEmployees = await this.prisma.employee.findMany({
        where: { status: 'active' },
        select: {
          employeeId: true,
          name: true,
          scheduledStart: true,
        },
      });

      for (const employee of activeEmployees) {
        const employeeWorkStart = new Date(workStart);
        if (employee.scheduledStart) {
          const [h, m] = employee.scheduledStart.split(':').map(Number);
          if (!Number.isNaN(h)) employeeWorkStart.setHours(h, m ?? 0, 0, 0);
        }

        // إن كان الموظف لا يزال ضمن فترة السماح قبل الدوام لا نُنبّه
        if (now < employeeWorkStart) continue;

        // هل سجّل دخولاً اليوم؟
        const checkIn = await this.prisma.attendanceRecord.findFirst({
          where: {
            employeeId: employee.employeeId,
            date: todayKey,
            type: 'IN',
          },
          select: { id: true },
        });

        if (checkIn) continue;

        const dedupeKey = `ABSENT:${employee.employeeId}:${todayKey}`;

        // هل هناك إشعار سابق لم يُتجاهل؟ نحدّث وقت التكرار فقط عبر upsert.
        const lateMinutes = Math.floor((now.getTime() - employeeWorkStart.getTime()) / 60000);

        await this.prisma.notification.upsert({
          where: { dedupeKey },
          create: {
            type: NotificationType.ABSENT,
            severity: NotificationSeverity.WARNING,
            title: 'موظف لم يسجّل دخوله بعد',
            message: `السيد/ة ${employee.name} لم يسجّل الدخول حتى الآن (متأخر ${lateMinutes} دقيقة عن موعد الدوام).`,
            employeeId: employee.employeeId,
            employeeName: employee.name,
            entityType: 'attendance',
            dedupeKey,
            metadata: { lateMinutes },
          },
          update: {
            message: `السيد/ة ${employee.name} لم يسجّل الدخول حتى الآن (متأخر ${lateMinutes} دقيقة عن موعد الدوام).`,
            severity: NotificationSeverity.WARNING,
            metadata: { lateMinutes },
          },
        });

        // البثّ اللحظي حتى لو كان موجوداً مسبقاً (للتنبيه المتكرر)
        const existing = await this.prisma.notification.findUnique({
          where: { dedupeKey },
        });
        if (existing && !existing.isDismissed) {
          this.realtimeGateway.emitNotification({
            id: existing.id,
            type: existing.type,
            severity: existing.severity,
            title: existing.title,
            message: existing.message,
            employeeId: existing.employeeId,
            employeeName: existing.employeeName,
            entityType: existing.entityType,
            entityId: existing.entityId,
            createdAt: existing.updatedAt.toISOString(),
          });
        }
      }
    } catch (error) {
      this.logger.error('Absent-employee scan failed', error as Error);
    }
  }
}
