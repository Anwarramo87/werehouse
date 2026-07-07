import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// أنواع الإجازات التي تعني غياباً فعلياً — يُرفض تسجيلها مع حضور بنفس اليوم
const HARD_BLOCK_LEAVE_TYPES = ['SICK', 'ADMIN', 'DEATH', 'UNPAID'];

export type ConflictWarning = {
  hasConflict: true;
  message: string;
  conflictType: 'leave_on_attendance_day' | 'attendance_on_leave_day';
  employeeId: string;
  date: string;
};

/**
 * إجازة يومية من نوع SICK/ADMIN/DEATH/UNPAID مع حضور فعلي → رفض قاطع.
 * إجازة PAID/OTHER مع حضور → تحذير فقط.
 * إجازة ساعية → تجاهل تام.
 */
export async function checkAttendanceConflictForLeave(
  prisma: PrismaService,
  employeeId: string,
  startDate: Date,
  endDate: Date,
  isHourly: boolean,
  leaveType: string,
): Promise<ConflictWarning | null> {
  if (isHourly) return null;

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const existing = await prisma.attendanceRecord.findFirst({
    where: { employeeId, date: { gte: startStr, lte: endStr } },
    select: { date: true, type: true, timestamp: true },
  });

  if (!existing) return null;

  const time = existing.timestamp.toISOString().slice(11, 16);

  if (HARD_BLOCK_LEAVE_TYPES.includes(leaveType)) {
    throw new BadRequestException(
      `لا يمكن تسجيل إجازة (${leaveType}) للموظف (${employeeId}) بتاريخ ${existing.date} ` +
      `لأنه يوجد سجل حضور فعلي في نفس اليوم (${existing.type} الساعة ${time}). ` +
      `يجب حذف سجل الحضور أولاً إذا كان خطأ.`,
    );
  }

  return {
    hasConflict: true,
    conflictType: 'leave_on_attendance_day',
    employeeId,
    date: existing.date,
    message:
      `⚠️ تنبيه: الموظف (${employeeId}) لديه سجل حضور فعلي بتاريخ ${existing.date} ` +
      `(${existing.type} الساعة ${time}) وتم تسجيل الإجازة في نفس الفترة. ` +
      `يرجى مراجعة الأدمن لاتخاذ الإجراء المناسب.`,
  };
}

/**
 * حضور بيوم فيه إجازة SICK/ADMIN/DEATH/UNPAID معتمدة → رفض قاطع.
 * حضور بيوم فيه إجازة PAID/OTHER → تحذير فقط.
 * إجازة ساعية → تجاهل تام.
 */
export async function checkLeaveConflictForAttendance(
  prisma: PrismaService,
  employeeId: string,
  date: string,
): Promise<ConflictWarning | null> {
  const existing = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: 'APPROVED',
      isHourly: false,
      AND: [
        { startDate: { lte: new Date(`${date}T23:59:59Z`) } },
        { endDate: { gte: new Date(`${date}T00:00:00Z`) } },
      ],
    },
    select: { leaveType: true, startDate: true, endDate: true },
  });

  if (!existing) return null;

  const start = existing.startDate.toISOString().slice(0, 10);
  const end = existing.endDate.toISOString().slice(0, 10);

  if (HARD_BLOCK_LEAVE_TYPES.includes(existing.leaveType)) {
    throw new BadRequestException(
      `لا يمكن تسجيل حضور للموظف (${employeeId}) بتاريخ ${date} ` +
      `لأنه يوجد إجازة معتمدة (${existing.leaveType}) من ${start} إلى ${end}. ` +
      `يجب إلغاء الإجازة أولاً إذا كان الموظف حاضراً فعلاً.`,
    );
  }

  return {
    hasConflict: true,
    conflictType: 'attendance_on_leave_day',
    employeeId,
    date,
    message:
      `⚠️ تنبيه: الموظف (${employeeId}) لديه إجازة معتمدة (${existing.leaveType}) ` +
      `من ${start} إلى ${end} وتم تسجيل حضور في نفس الفترة. ` +
      `يرجى مراجعة الأدمن لاتخاذ الإجراء المناسب.`,
  };
}
