import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, DailyRecordType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveTimezoneOffsetMinutes } from '../common/utils/timezone.util';

const HH_MM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_IN_DAY = 1440;

// ─── Types ────────────────────────────────────────────────────────────────────

type ShiftPairJson = {
  inRecordId?: string;
  outRecordId?: string;
  hoursWorked?: number;
  minutesLate?: number;
  gracePeriodApplied?: number;
};

type DailyPunchRecord = {
  id: string;
  type: string;
  timestamp: Date;
  shiftPair: Prisma.JsonValue | null;
};

type HourlyLeaveRecord = {
  id: string;
  startTime: string | null;
  endTime: string | null;
  isPaid: boolean;
};

type AggregationResult = {
  employeeId: string;
  date: string;
  requiredMinutes: number;
  actualWorkedMinutes: number;
  overtimeMinutes: number;
  calculatedDelayMinutes: number;
  delayMinutesSubtracted: number;
  grossMissingMinutes: number;
  approvedLeaveMinutes: number;
  finalMissingMinutes: number;
  logsCreated: string[];
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AttendanceAggregationService {
  private readonly logger = new Logger(AttendanceAggregationService.name);
  private readonly timezoneOffsetMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.timezoneOffsetMinutes = resolveTimezoneOffsetMinutes(
      this.config.get<string>('APP_TIMEZONE_OFFSET_MINUTES'),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Parse "HH:mm" → total minutes since midnight.
   * Returns null if the string is malformed.
   */
  private parseHHmmToMinutes(value: string | null | undefined): number | null {
    if (!value) return null;
    const match = HH_MM_REGEX.exec(value.slice(0, 5));
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  /**
   * Convert a UTC timestamp to local minutes-since-midnight,
   * applying the configured timezone offset.
   */
  private utcTimestampToLocalMinutes(utc: Date): number {
    const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes();
    return (
      (((utcMinutes + this.timezoneOffsetMinutes) % MINUTES_IN_DAY) + MINUTES_IN_DAY) %
      MINUTES_IN_DAY
    );
  }

  /**
   * Convert a local timestamp to minutes since midnight.
   * Use this when the biometric device sends local timestamps.
   */
  private localTimestampToMinutes(local: Date): number {
    return local.getHours() * 60 + local.getMinutes();
  }

  /**
   * Build the date-key (YYYY-MM-DD) from a Date, using UTC to stay
   * consistent with how `AttendanceRecord.date` is stored.
   */
  private toDateKey(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Parse a date string (YYYY-MM-DD) into a UTC midnight Date (for Prisma @db.Date).
   */
  private toDateOnly(value: string): Date {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  }

  /**
   * Extract `minutesLate` from a shiftPair JSON blob.
   * Returns 0 when absent or invalid.
   */
  private extractMinutesLate(shiftPair: Prisma.JsonValue | null): number {
    if (!shiftPair || typeof shiftPair !== 'object' || Array.isArray(shiftPair)) return 0;
    const raw = (shiftPair as Record<string, unknown>).minutesLate;
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * Extract `hoursWorked` from a shiftPair JSON blob.
   * Returns 0 when absent or invalid.
   */
  private extractHoursWorked(shiftPair: Prisma.JsonValue | null): number {
    if (!shiftPair || typeof shiftPair !== 'object' || Array.isArray(shiftPair)) return 0;
    const raw = (shiftPair as Record<string, unknown>).hoursWorked;
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Calculate worked minutes split into two buckets:
   *   - scheduledWorkedMinutes: time physically present WITHIN the scheduled window
   *   - overtimeMinutes: time physically present AFTER scheduledEnd
   *
   * This separation prevents overtime from masking mid-day absences.
   *
   * Example: schedule 08:00–16:00, punches IN 8:00 OUT 10:00, IN 12:00 OUT 18:00
   *   Pair 1: 8:00–10:00 → 120 min scheduled, 0 overtime
   *   Pair 2: 12:00–16:00 → 240 min scheduled, 16:00–18:00 → 120 min overtime
   *   Result: scheduledWorked=360, overtime=120
   *   grossMissing = 480 - 360 = 120 min (the 10:00–12:00 gap) ✅
   */
  private calculateWorkedMinutesSplit(
    punches: DailyPunchRecord[],
    scheduledStartMin: number,
    scheduledEndMin: number,
    scheduledEndEffMin: number,
    isNightShift = false,
  ): { scheduledWorkedMinutes: number; overtimeMinutes: number } {
    if (punches.length === 0) return { scheduledWorkedMinutes: 0, overtimeMinutes: 0 };

    const sorted = [...punches].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let scheduledWorkedMs = 0;
    let overtimeMs = 0;
    let pendingIn: Date | null = null;

    for (const punch of sorted) {
      const type = punch.type.toUpperCase();
      if (type === 'IN') {
        pendingIn = punch.timestamp;
      } else if (type === 'OUT' && pendingIn) {
        const inMin = this.utcTimestampToLocalMinutes(pendingIn);
        let outMin = this.utcTimestampToLocalMinutes(punch.timestamp);

        // For night shifts, an OUT that occurs before the scheduled start
        // (e.g. 06:00 OUT for a 22:00→06:00 shift) actually happens on the
        // following day — shift it forward so the pair duration is positive.
        if (isNightShift && outMin < scheduledStartMin) {
          outMin += 1440;
        }

        const schedEnd = isNightShift ? scheduledEndEffMin : scheduledEndMin;

        // Clamp the pair to the scheduled window for "scheduled" bucket
        const clampedIn = Math.max(inMin, scheduledStartMin);
        const clampedOut = Math.min(outMin, schedEnd);
        if (clampedOut > clampedIn) {
          scheduledWorkedMs += (clampedOut - clampedIn) * 60_000;
        }

        // Overtime = time worked strictly after scheduledEnd
        if (outMin > schedEnd) {
          const overtimeStart = Math.max(inMin, schedEnd);
          overtimeMs += (outMin - overtimeStart) * 60_000;
        }

        pendingIn = null;
      }
    }

    let scheduledWorkedMinutes = Math.round(scheduledWorkedMs / 60_000);
    let overtimeMinutes = Math.round(overtimeMs / 60_000);

    // Fallback: if pairing yields 0 but shiftPair has hoursWorked, use that
    if (scheduledWorkedMinutes <= 0) {
      let totalFromShiftPair = 0;
      for (const punch of sorted) {
        const hw = this.extractHoursWorked(punch.shiftPair);
        if (hw > totalFromShiftPair) totalFromShiftPair = hw;
      }
      if (totalFromShiftPair > 0) {
        scheduledWorkedMinutes = Math.min(
          Math.round(totalFromShiftPair * 60),
          scheduledEndEffMin - scheduledStartMin,
        );
      }
    }

    return {
      scheduledWorkedMinutes: Math.max(0, scheduledWorkedMinutes),
      overtimeMinutes: Math.max(0, overtimeMinutes),
    };
  }

  /**
   * Calculate the total DELAY_MINUTES already logged for this employee+date,
   * to avoid double-penalizing the morning late arrival as "missing minutes".
   */
  private async getLoggedDelayMinutes(
    employeeId: string,
    date: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const logs = await tx.dailyAttendanceLog.findMany({
      where: {
        employeeId,
        date,
        recordType: DailyRecordType.DELAY_MINUTES,
      },
      select: { value: true },
    });

    return logs.reduce((sum, log) => sum + Number(log.value || 0), 0);
  }

  /**
   * Fetch approved hourly leave requests that overlap with the given date.
   */
  private async getApprovedHourlyLeaves(
    employeeId: string,
    date: Date,
  ): Promise<HourlyLeaveRecord[]> {
    return this.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        isHourly: true,
        startDate: { lte: date },
        endDate: { gte: date },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        isPaid: true,
      },
    });
  }

  /**
   * Calculate total approved leave minutes from hourly leave records.
   */
  private calculateApprovedLeaveMinutes(leaves: HourlyLeaveRecord[]): number {
    let total = 0;
    for (const leave of leaves) {
      const startMin = this.parseHHmmToMinutes(leave.startTime);
      const endMin = this.parseHHmmToMinutes(leave.endTime);
      if (startMin === null || endMin === null) continue;
      const duration = endMin - startMin;
      if (duration > 0) total += duration;
    }
    return total;
  }

  /**
   * Calculate morning delay minutes from the first IN punch of the day.
   *
   * Strategy:
   *  1. Use shiftPair.minutesLate if available on the first IN punch.
   *  2. Otherwise compute from UTC timestamp → local time − scheduledStart.
   *  3. Apply grace period: if delay ≤ grace, effective delay = 0.
   */
  private calculateDelayFromPunches(
    punches: DailyPunchRecord[],
    scheduledStartMin: number,
    gracePeriodMinutes: number,
    isNightShift = false,
  ): number {
    const sorted = [...punches].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const firstIn = sorted.find((p) => p.type.toUpperCase() === 'IN');
    if (!firstIn) return 0;

    // Prefer pre-calculated minutesLate from biometric shiftPair
    const shiftPairMinutes = this.extractMinutesLate(firstIn.shiftPair);
    if (shiftPairMinutes > 0) {
      return Math.max(0, shiftPairMinutes - gracePeriodMinutes);
    }

    // Compute from UTC timestamp → local time
    const localArrivalMin = this.utcTimestampToLocalMinutes(firstIn.timestamp);

    // Pick the scheduled-start instance (same day or next day) closest to the
    // arrival. This correctly handles: (a) night shifts whose start is near
    // midnight, and (b) the edge where an employee clocks in just BEFORE the
    // scheduled start (e.g. 23:50 for a 00:00 start → early, not 23h50m late).
    // Candidates: scheduledStart on the arrival day and on the following day.
    const candidates = [scheduledStartMin, scheduledStartMin + 1440];
    let startInstance = scheduledStartMin;
    let best = Infinity;
    for (const c of candidates) {
      const d = Math.abs(localArrivalMin - c);
      if (d < best) {
        best = d;
        startInstance = c;
      }
    }

    const rawDelay = Math.max(0, localArrivalMin - startInstance);
    return rawDelay > gracePeriodMinutes ? rawDelay - gracePeriodMinutes : 0;
  }

  /**
   * Calculate early leave minutes from the last OUT punch of the day.
   *
   * This is computed INDEPENDENTLY from the delay calculation to avoid
   * misattributing grace-period delay as early leave.
   *
   * Example: schedule 08:00–16:00, IN at 08:10, OUT at 15:55
   *   → delay = (08:10 − 08:00) − grace = 5 min
   *   → earlyLeave = 16:00 − 15:55 = 5 min  (NOT 10 min!)
   */
  private calculateEarlyLeaveFromPunches(
    punches: DailyPunchRecord[],
    scheduledEndMin: number,
    scheduledEndEffMin: number,
  ): number {
    const sorted = [...punches].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Find the last OUT that is NOT followed by another IN
    // (an OUT followed by IN means the employee came back — not a final departure)
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].type.toUpperCase() !== 'OUT') continue;

      // Check if any IN punch comes after this OUT
      const hasInAfter = sorted.slice(i + 1).some((p) => p.type.toUpperCase() === 'IN');
      if (hasInAfter) continue; // not the final departure

      const localDepartureMin = this.utcTimestampToLocalMinutes(sorted[i].timestamp);

      // Pick the scheduled-end instance (same day or next day) closest to the
      // departure. For night shifts the effective end is the next-day occurrence.
      const candidates = [scheduledEndMin, scheduledEndEffMin];
      let endInstance = scheduledEndMin;
      let best = Infinity;
      for (const c of candidates) {
        const d = Math.abs(localDepartureMin - c);
        if (d < best) {
          best = d;
          endInstance = c;
        }
      }

      return Math.max(0, endInstance - localDepartureMin);
    }

    // No valid final OUT punch — handled as absence
    return 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core: Single Employee + Single Date Aggregation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate and persist the "missing minutes" breakdown for ONE employee
   * on ONE specific date.
   *
   * Mathematical Flow:
   *   Required Minutes     = scheduledEnd − scheduledStart
   *   Actual Worked Minutes = sum of IN→OUT paired durations
   *   Gross Missing Minutes = Required − Actual Worked
   *   Net Unexcused Gap     = max(0, Gross Missing − Delay Already Penalized)
   *   Final Missing Minutes = max(0, Net Unexcused Gap − Approved Leave Minutes)
   */
  async aggregateEmployeeDay(
    employeeId: string,
    dateStr: string,
  ): Promise<AggregationResult | null> {
    const dateOnly = this.toDateOnly(dateStr);

    // ── Step 1: Fetch employee schedule ──────────────────────────────────────
    const employee = await this.prisma.employee.findUnique({
      where: { employeeId },
      select: {
        employeeId: true,
        scheduledStart: true,
        scheduledEnd: true,
        gracePeriodMinutes: true,
        status: true,
      },
    });

    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }

    const scheduledStartMin = this.parseHHmmToMinutes(employee.scheduledStart);
    const scheduledEndMin = this.parseHHmmToMinutes(employee.scheduledEnd);

    // Guard: skip if schedule is misconfigured
    if (scheduledStartMin === null || scheduledEndMin === null) {
      this.logger.debug(
        `Skipping ${employeeId} on ${dateStr}: missing scheduledStart or scheduledEnd`,
      );
      return null;
    }

    // Detect night shifts (schedule crosses midnight) e.g. 22:00→06:00.
    // For these, extend the scheduled end into the next day so the required
    // work duration stays positive and the calculations below are correct.
    const isNightShift = scheduledEndMin <= scheduledStartMin;
    const scheduledEndEffMin = isNightShift ? scheduledEndMin + 1440 : scheduledEndMin;

    // Required work duration for the day (always positive once night handled)
    const requiredMinutes = Math.max(0, scheduledEndEffMin - scheduledStartMin);

    // ── Step 1b: Skip deduction calculation on rest days (Friday) or public holidays (OTHER leave) ──
    // Employees are not obligated to attend on Fridays or public holidays — any partial attendance
    // should be rewarded (overtime), never penalized for delay or early departure.
    // Other leave types (SICK, ADMIN, DEATH, PAID, UNPAID) still apply normal deductions
    // if the employee punched in and did not complete their scheduled hours.
    const dateUTC = new Date(`${dateStr}T00:00:00.000Z`);
    const dayOfWeek = dateUTC.getUTCDay(); // 5 = Friday
    if (dayOfWeek === 5) {
      this.logger.debug(
        `Skipping penalty calc for ${employeeId} on ${dateStr}: Friday (rest day)`,
      );
      return null;
    }

    // Check for OTHER leave (ساعية أو كاملة — عطلة / عيد / سبب آخر) — لا خصومات دائماً
    // المعامل (×1 أو ×2) يُطبَّق في مرحلة الراتب عبر payroll.service — هنا فقط نلغي الخصومات
    const otherLeave = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: 'APPROVED',
        leaveType: 'OTHER',
        startDate: { lte: dateUTC },
        endDate: { gte: dateUTC },
      },
      select: { id: true, notes: true },
    });
    if (otherLeave) {
      this.logger.debug(
        `Skipping penalty calc for ${employeeId} on ${dateStr}: OTHER leave (notes=${otherLeave.notes ?? 'none'})`,
      );
      return null;
    }

    // ── Step 2: Fetch raw attendance punches for the day ─────────────────────
    const punches = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, date: dateStr },
      orderBy: { timestamp: 'asc' },
      select: {
        id: true,
        type: true,
        timestamp: true,
        shiftPair: true,
      },
    });

    // If no punches at all, the employee is absent — skip missing-minutes calc.
    // (Absence is handled by separate absence logic in payroll.)
    if (punches.length === 0) {
      return null;
    }

    // ── Step 3: Calculate worked minutes split into scheduled vs overtime ──────
    const empGracePeriod = Number(employee.gracePeriodMinutes ?? 0);
    const { scheduledWorkedMinutes, overtimeMinutes } = this.calculateWorkedMinutesSplit(
      punches,
      scheduledStartMin,
      scheduledEndMin,
      scheduledEndEffMin,
      isNightShift,
    );
    const actualWorkedMinutes = scheduledWorkedMinutes;

    // ── Step 4: Fetch approved hourly leaves (needed before delay calc) ──────
    const hourlyLeaves = await this.getApprovedHourlyLeaves(employeeId, dateOnly);
    const approvedLeaveMinutes = this.calculateApprovedLeaveMinutes(hourlyLeaves);

    // ── Step 4a: Effective scheduled start = scheduledStart + any hourly leave cover ─
    // If employee has approved hourly leave at the start of the day (e.g. 08:00→10:00),
    // their effective start shifts forward so they are NOT penalized for delay.
    const leaveAtStart = hourlyLeaves.reduce((maxEnd, l) => {
      const s = this.parseHHmmToMinutes(l.startTime);
      const e = this.parseHHmmToMinutes(l.endTime);
      if (s === null || e === null) return maxEnd;
      // Shift start if leave begins at or before scheduledStart (covers morning)
      if (s <= scheduledStartMin) return Math.max(maxEnd, e);
      return maxEnd;
    }, scheduledStartMin);
    const effectiveScheduledStartMin = leaveAtStart;

    // ── Step 4b: Calculate morning delay using effective start ───────────────
    // Also subtract any leave minutes that cover the arrival window to handle
    // cases where shiftPair.minutesLate was pre-calculated without leave context.
    const rawDelayMinutes = this.calculateDelayFromPunches(
      punches,
      effectiveScheduledStartMin,
      empGracePeriod,
      isNightShift,
    );

    // If shiftPair.minutesLate was used (biometric pre-calc), it doesn't know
    // about hourly leaves — subtract the leave window that covers the morning.
    const morningLeaveOffset = Math.max(0, effectiveScheduledStartMin - scheduledStartMin);
    const calculatedDelayMinutes = Math.max(0, rawDelayMinutes - morningLeaveOffset);

    // ── Step 4c: (unused — missing minutes computed via grossMissingMinutes below) ──

    // ── Step 6: Write to DailyAttendanceLog inside a $transaction ─────────────
    const result = await this.prisma.$transaction(async (tx) => {
      // ── Step A: Gross missing minutes ────────────────────────────────────
      const grossMissingMinutes = Math.max(0, requiredMinutes - actualWorkedMinutes);

      // ── Step B: Delay already penalized separately ───────────────────────
      // DELAY_MINUTES = تأخير الصباح → يُعاقب عليه بـ 1.5× في الـ payroll
      // grossMissingMinutes = كل الوقت الناقص (فجوات داخلية + خروج مبكر + تأخير)
      // finalMissingMinutes = الناقص بعد استثناء التأخير (لأنه مُعاقب عليه منفصلاً)
      const delayMinutesSubtracted = calculatedDelayMinutes;

      // ── Step C: finalMissing = grossMissing − delay − approvedLeave ──────
      // لا نعتمد على rawEarlyLeaveMinutes لأنه يشوف آخر OUT فقط
      // ويفوّت الفجوات الداخلية (مثل خروج 10 ورجوع 12)
      const netMissingAfterDelay = Math.max(0, grossMissingMinutes - calculatedDelayMinutes);
      const finalMissingMinutes = Math.max(0, netMissingAfterDelay - approvedLeaveMinutes);

      // ── Step D: Clean existing calculated logs for this date ─────────────
      // Delete previously calculated logs (idempotent re-run support).
      // Only delete 'calculated' source logs to preserve manual entries.
      await tx.dailyAttendanceLog.deleteMany({
        where: {
          employeeId,
          date: dateOnly,
          source: 'calculated',
          recordType: {
            in: [
              DailyRecordType.DELAY_MINUTES,
              DailyRecordType.EARLY_LEAVE_MINUTES,
              DailyRecordType.PAID_LEAVE,
              DailyRecordType.UNPAID_LEAVE,
            ],
          },
        },
      });

      const logsCreated: string[] = [];

      // ── Step E: Log DELAY_MINUTES (morning late arrival penalty) ─────────
      if (calculatedDelayMinutes > 0) {
        await tx.dailyAttendanceLog.create({
          data: {
            employeeId,
            date: dateOnly,
            recordType: DailyRecordType.DELAY_MINUTES,
            value: new Prisma.Decimal(calculatedDelayMinutes),
            source: 'calculated',
            notes: `Auto-calculated delay: first IN local=${this.utcTimestampToLocalMinutes(punches.find((p) => p.type.toUpperCase() === 'IN')!.timestamp)}min, scheduled=${scheduledStartMin}min, grace=${empGracePeriod}min → delay=${calculatedDelayMinutes}min`,
          },
        });
        logsCreated.push(`DELAY_MINUTES=${calculatedDelayMinutes}`);
      }

      // ── Step F: Log EARLY_LEAVE_MINUTES (all unexcused missing time) ──────
      if (finalMissingMinutes > 0) {
        await tx.dailyAttendanceLog.create({
          data: {
            employeeId,
            date: dateOnly,
            recordType: DailyRecordType.EARLY_LEAVE_MINUTES,
            value: new Prisma.Decimal(finalMissingMinutes),
            source: 'calculated',
            notes: `Auto-calculated: required=${requiredMinutes}min, worked=${actualWorkedMinutes}min, gross_missing=${grossMissingMinutes}min, delay=${calculatedDelayMinutes}min, leave_offset=${approvedLeaveMinutes}min → missing_penalty=${finalMissingMinutes}min`,
          },
        });
        logsCreated.push(`EARLY_LEAVE_MINUTES=${finalMissingMinutes}`);
      }

      // ── Step G: Log approved hourly leave breakdown ──────────────────────
      if (approvedLeaveMinutes > 0) {
        // Group leaves by paid/unpaid to log correctly
        const paidLeaveMinutes = hourlyLeaves
          .filter((l) => l.isPaid)
          .reduce((sum, l) => {
            const s = this.parseHHmmToMinutes(l.startTime);
            const e = this.parseHHmmToMinutes(l.endTime);
            return sum + (s !== null && e !== null ? Math.max(0, e - s) : 0);
          }, 0);

        const unpaidLeaveMinutes = hourlyLeaves
          .filter((l) => !l.isPaid)
          .reduce((sum, l) => {
            const s = this.parseHHmmToMinutes(l.startTime);
            const e = this.parseHHmmToMinutes(l.endTime);
            return sum + (s !== null && e !== null ? Math.max(0, e - s) : 0);
          }, 0);

        if (paidLeaveMinutes > 0) {
          await tx.dailyAttendanceLog.create({
            data: {
              employeeId,
              date: dateOnly,
              recordType: DailyRecordType.PAID_LEAVE,
              value: new Prisma.Decimal(paidLeaveMinutes),
              source: 'calculated',
              notes: `Approved paid hourly leave: ${paidLeaveMinutes} minutes`,
            },
          });
          logsCreated.push(`PAID_LEAVE=${paidLeaveMinutes}`);
        }

        if (unpaidLeaveMinutes > 0) {
          await tx.dailyAttendanceLog.create({
            data: {
              employeeId,
              date: dateOnly,
              recordType: DailyRecordType.UNPAID_LEAVE,
              value: new Prisma.Decimal(unpaidLeaveMinutes),
              source: 'calculated',
              notes: `Approved unpaid hourly leave: ${unpaidLeaveMinutes} minutes`,
            },
          });
          logsCreated.push(`UNPAID_LEAVE=${unpaidLeaveMinutes}`);
        }
      }

      // ── Step H: Log OVERTIME_MINUTES ────────────────────────────────────
      if (overtimeMinutes > 0) {
        await tx.dailyAttendanceLog.deleteMany({
          where: {
            employeeId,
            date: dateOnly,
            source: 'calculated',
            recordType: DailyRecordType.OVERTIME_MINUTES,
          },
        });
        await tx.dailyAttendanceLog.create({
          data: {
            employeeId,
            date: dateOnly,
            recordType: DailyRecordType.OVERTIME_MINUTES,
            value: new Prisma.Decimal(overtimeMinutes),
            source: 'calculated',
            notes: `Auto-calculated overtime: worked after scheduledEnd=${scheduledEndMin}min → overtime=${overtimeMinutes}min`,
          },
        });
        logsCreated.push(`OVERTIME_MINUTES=${overtimeMinutes}`);
      }

      return {
        employeeId,
        date: dateStr,
        requiredMinutes,
        actualWorkedMinutes,
        overtimeMinutes,
        calculatedDelayMinutes,
        delayMinutesSubtracted,
        grossMissingMinutes,
        approvedLeaveMinutes,
        finalMissingMinutes,
        logsCreated,
      } satisfies AggregationResult;
    });

    this.logger.log(
      `[${employeeId}] ${dateStr}: delay=${result.calculatedDelayMinutes}min, ` +
        `missing=${result.finalMissingMinutes}min, overtime=${result.overtimeMinutes}min ` +
        `(required=${requiredMinutes}, scheduledWorked=${actualWorkedMinutes}, ` +
        `gross_missing=${result.grossMissingMinutes}, leave=${approvedLeaveMinutes})`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk: All employees for a single date
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run the missing-minutes aggregation for ALL active employees on a given date.
   * Called by the End-of-Day cron or manually triggered.
   */
  async aggregateAllForDate(dateStr: string): Promise<{
    date: string;
    processedCount: number;
    skippedCount: number;
    results: AggregationResult[];
  }> {
    const employees = await this.prisma.employee.findMany({
      where: { status: { in: ['active', 'resigned', 'terminated'] } },
      select: { employeeId: true },
    });

    const results: AggregationResult[] = [];
    let skippedCount = 0;

    for (const emp of employees) {
      try {
        const result = await this.aggregateEmployeeDay(emp.employeeId, dateStr);
        if (result) {
          results.push(result);
        } else {
          skippedCount++;
        }
      } catch (err) {
        this.logger.error(
          `Failed to aggregate ${emp.employeeId} for ${dateStr}: ${(err as Error).message}`,
        );
        skippedCount++;
      }
    }

    this.logger.log(
      `Daily aggregation complete for ${dateStr}: ` +
        `${results.length} processed, ${skippedCount} skipped`,
    );

    return {
      date: dateStr,
      processedCount: results.length,
      skippedCount,
      results,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk: Date range
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run the aggregation for all active employees across a date range.
   * Iterates day-by-day to ensure clean per-day processing.
   */
  async aggregateRange(
    startDateStr: string,
    endDateStr: string,
  ): Promise<{
    startDate: string;
    endDate: string;
    totalProcessed: number;
    totalSkipped: number;
    dailySummaries: Array<{
      date: string;
      processedCount: number;
      skippedCount: number;
    }>;
  }> {
    if (startDateStr > endDateStr) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    const dailySummaries: Array<{
      date: string;
      processedCount: number;
      skippedCount: number;
    }> = [];
    let totalProcessed = 0;
    let totalSkipped = 0;

    // Iterate day-by-day
    const cursor = new Date(`${startDateStr}T00:00:00.000Z`);
    const end = new Date(`${endDateStr}T00:00:00.000Z`);

    while (cursor <= end) {
      const dayStr = this.toDateKey(cursor);
      const dayResult = await this.aggregateAllForDate(dayStr);
      totalProcessed += dayResult.processedCount;
      totalSkipped += dayResult.skippedCount;
      dailySummaries.push({
        date: dayStr,
        processedCount: dayResult.processedCount,
        skippedCount: dayResult.skippedCount,
      });

      // Advance to next day
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      startDate: startDateStr,
      endDate: endDateStr,
      totalProcessed,
      totalSkipped,
      dailySummaries,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Read: Sum EARLY_LEAVE_MINUTES from DailyAttendanceLog for payroll
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sum all EARLY_LEAVE_MINUTES logs for a set of employees within a date period.
   * Used by PayrollRunService to compute financial deductions.
   *
   * Returns a Map<employeeId, totalEarlyLeaveMinutes>.
   */
  async sumEarlyLeaveMinutesForPeriod(
    employeeIds: string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<string, number>> {
    const logs = await this.prisma.dailyAttendanceLog.findMany({
      where: {
        employeeId: { in: employeeIds },
        recordType: DailyRecordType.EARLY_LEAVE_MINUTES,
        date: {
          gte: this.toDateOnly(periodStart),
          lte: this.toDateOnly(periodEnd),
        },
      },
      select: {
        employeeId: true,
        value: true,
      },
    });

    const result = new Map<string, number>();
    for (const log of logs) {
      const minutes = Number(log.value || 0);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      result.set(log.employeeId, (result.get(log.employeeId) || 0) + minutes);
    }

    return result;
  }
}
