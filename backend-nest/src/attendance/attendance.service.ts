import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { checkLeaveConflictForAttendance } from '../common/utils/leave-attendance-conflict.util';
import { parse as parseCsv } from 'csv-parse/sync';
import { extname } from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { CreateAttendanceDto } from './dto/create-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { AttendanceListQueryDto } from './dto/attendance-list-query.dto';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AttendanceAggregationService } from './attendance-aggregation.service';
import { toFactoryDateKey } from '../common/utils/timezone.util';
import { resolveSalary } from '../common/utils/salary-resolution.util';

type ShiftPair = {
  inRecordId?: string;
  outRecordId?: string;
  hoursWorked?: number;
  minutesLate?: number;
  gracePeriodApplied?: number;
};

type AttendanceAlertStatus = 'absent' | 'late';

type AttendanceAlertItem = {
  status: AttendanceAlertStatus;
  employeeId: string;
  name: string;
  department: string;
  scheduledStart: string;
  checkIn: string | null;
  minutesLate: number;
};

type EmployeeDailyAttendance = {
  firstIn: Date | null;
  maxMinutesLateFromShiftPair: number | null;
};

type AttendanceImportRow = {
  employeeId: string;
  timestamp: string;
  type: string;
  deviceId?: string;
  location?: string;
  source?: string;
  notes?: string;
};

const ATTENDANCE_DELETION_ENTITY = 'attendance';
const DEFAULT_ALERT_SCHEDULE_START = '08:00';
const DEFAULT_LATE_THRESHOLD_MINUTES = 5;
const TIME_HH_MM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ATTENDANCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const ATTENDANCE_IMPORT_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.ods',
]);

/** تحويل timestamp (UTC مخزّن) إلى دقائق بالتوقيت المحلي السعودي (+3) */
function toLocalMinutes(timestamp: Date | string): number {
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const utc = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (((utc + 180) % 1440) + 1440) % 1440;
}

/**
 * حساب دقائق العمل الفعلية من سجلات البصمة الخام (IN/OUT) ليوم واحد أو أكثر.
 * نزوّج كل IN مع أقرب OUT تليه: IN→OUT→IN→OUT تعطي (OUT₁−IN₁)+(OUT₂−IN₂).
 * الفجوة بين OUT وIN التالية (وقت غياب داخل الدوام) لا تُحتسب — بلا أجر.
 */
function computeWorkedMinutes(
  records: Array<{ type: string; timestamp: Date | string }>,
): number {
  const dayMap = new Map<string, Array<{ type: string; min: number }>>();
  for (const r of records) {
    const type = (r.type || '').toUpperCase();
    if (type !== 'IN' && type !== 'OUT') continue;
    const d = typeof r.timestamp === 'string' ? new Date(r.timestamp) : r.timestamp;
    const date = d.toISOString().slice(0, 10);
    const arr = dayMap.get(date) ?? [];
    arr.push({ type, min: toLocalMinutes(d) });
    dayMap.set(date, arr);
  }

  let total = 0;
  for (const arr of dayMap.values()) {
    arr.sort((a, b) => a.min - b.min);
    let pendingIn: number | null = null;
    for (const p of arr) {
      if (p.type === 'IN') {
        if (pendingIn === null) pendingIn = p.min;
      } else {
        if (pendingIn !== null) {
          total += Math.max(0, p.min - pendingIn);
          pendingIn = null;
        }
      }
    }
  }
  return total;
}

/**
 * دقائق الإجازة المرضية الجزئية (منتصف اليوم) المدفوعة بنصف الأجر.
 * يخص فقط إجازة SICK بساعات (isHourly) تبدأ بعد بداية الدوام،
 * حيث تُحتسب الساعات من وقت بدء الإجازة حتى نهاية الدوام بنصف التكلفة.
 */
function computeSickRemainderMinutes(
  sickLeaves: Array<{ startTime?: string | null; isHourly?: boolean | null }>,
  scheduledStartMin: number,
  scheduledEndMin: number,
): number {
  let total = 0;
  for (const l of sickLeaves) {
    if (!l.isHourly) continue;
    const [sh, sm] = (l.startTime || '').split(':').map(Number);
    const startMin = (sh || 0) * 60 + (sm || 0);
    if (!(startMin > scheduledStartMin)) continue; // إجازة يوم كامل تُعالَج عبر sickLeaveDays
    total += Math.max(0, scheduledEndMin - startMin);
  }
  return total;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly aggregationService: AttendanceAggregationService,
  ) {}

  private async invalidateAttendanceDashboardCaches() {
    await Promise.all([
      this.shortCache.invalidatePrefix('attendance:stats:'),
      this.shortCache.invalidatePrefix('attendance:anomalies:'),
      this.shortCache.invalidatePrefix('attendance:alerts:'),
    ]);
  }

  private toTimeHHmm(value: Date) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  }

  private async safeGetEmployeeName(employeeId: string): Promise<string> {
    try {
      const employee = await this.prisma.employee.findUnique({
        where: { employeeId },
        select: { name: true },
      });
      return employee?.name || employeeId;
    } catch {
      return employeeId;
    }
  }

  private async emitAttendanceRealtime(
    record: {
      id: string;
      employeeId: string;
      type: string;
      timestamp: Date;
      date: string;
      source?: string | null;
    },
    action: 'created' | 'updated',
  ) {
    try {
      const employeeName = await this.safeGetEmployeeName(record.employeeId);
      const type = record.type.toUpperCase() === 'OUT' ? 'OUT' : 'IN';
      const arabicAction = action === 'updated' ? 'تحديث' : 'تسجيل';
      const arabicMovement = type === 'IN' ? 'دخول' : 'خروج';

      this.realtimeGateway.emitAttendanceUpdate({
        employeeId: record.employeeId,
        employeeName,
        type,
        timestamp: record.timestamp.toISOString(),
        date: record.date,
        time: this.toTimeHHmm(record.timestamp),
        source: 'biometric',
        status: 'success',
        action,
        message: `تم ${arabicAction} ${arabicMovement} ${employeeName}`,
      });
    } catch {
      // Realtime emission failures must never block attendance writes
    }
  }

  private deriveDateKey(timestampInput: string, parsed: Date) {
    const fromInput = /^(\d{4}-\d{2}-\d{2})/.exec(timestampInput)?.[1];
    if (fromInput) {
      return fromInput;
    }

    return parsed.toISOString().slice(0, 10);
  }

  private async assertEmployeeExists(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });
    if (!employee) {
      throw new BadRequestException(`Employee not found: ${employeeId}`);
    }
  }

  private toHistoryPayload(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private parseRequiredString(payload: Prisma.JsonObject, key: string) {
    const value = payload[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`Corrupted history payload: missing ${key}`);
    }
    return value;
  }

  private resolveRange(startDate?: string, endDate?: string) {
    if (startDate && endDate) {
      return { startDate, endDate };
    }

    if (startDate || endDate) {
      throw new BadRequestException('Start and end dates must be provided together');
    }

    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);

    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }

  private toDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private parseClockMinutes(value?: string) {
    const source = (value || DEFAULT_ALERT_SCHEDULE_START).slice(0, 5);
    const match = TIME_HH_MM_REGEX.exec(source);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  private minutesFromCheckIn(checkIn: Date) {
    return checkIn.getHours() * 60 + checkIn.getMinutes();
  }

  private resolveMinutesLate(
    firstIn: Date,
    scheduledStart?: string,
    minutesLateFromShiftPair?: number | null,
  ) {
    if (typeof minutesLateFromShiftPair === 'number' && Number.isFinite(minutesLateFromShiftPair)) {
      return Math.max(0, Math.floor(minutesLateFromShiftPair));
    }

    const scheduledMinutes = this.parseClockMinutes(scheduledStart);
    if (scheduledMinutes === null) return 0;

    return Math.max(0, this.minutesFromCheckIn(firstIn) - scheduledMinutes);
  }

  private extractMinutesLate(shiftPair: Prisma.JsonValue | null): number {
    if (!shiftPair || typeof shiftPair !== 'object' || Array.isArray(shiftPair)) {
      return 0;
    }

    const raw = (shiftPair as Record<string, unknown>).minutesLate;
    const parsed = Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }

  private normalizeImportHeader(value: string) {
    return value.toLowerCase().replace(/[\s_-]+/g, '');
  }

  private normalizeImportRow(row: Record<string, unknown>) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[this.normalizeImportHeader(key)] = String(value ?? '').trim();
    }
    return normalized;
  }

  private detectDelimiter(content: string) {
    const firstLine = content.split(/\r?\n/, 1)[0] || '';
    const commaCount = (firstLine.match(/,/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    return tabCount > commaCount ? '\t' : ',';
  }

  private parseDelimitedRows(content: string, delimiter: string) {
    let parsed: Array<Record<string, unknown>>;
    try {
      parsed = parseCsv(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        delimiter,
      }) as Array<Record<string, unknown>>;
    } catch {
      throw new BadRequestException('Unable to parse attendance file');
    }

    return parsed
      .map((row) => this.normalizeImportRow(row))
      .filter((row) => Object.values(row).some((value) => value !== ''));
  }

  private parseJsonRows(content: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BadRequestException('Invalid JSON attendance file');
    }

    if (!Array.isArray(parsed)) {
      throw new BadRequestException('Attendance JSON file must contain an array of rows');
    }

    return parsed
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
      )
      .map((entry) => this.normalizeImportRow(entry))
      .filter((row) => Object.values(row).some((value) => value !== ''));
  }

  private async parseSpreadsheetRows(buffer: Buffer) {
    try {
      const workbook = new ExcelJS.Workbook();
      const wb = await workbook.xlsx.load(buffer as any);

      const worksheet = wb.worksheets[0];
      if (!worksheet) {
        throw new BadRequestException('Attendance spreadsheet must contain at least one sheet');
      }

      const rows: Record<string, string>[] = [];
      let headers: string[] = [];
      worksheet.eachRow((row, rowNumber) => {
        const values = (row.values as ExcelJS.CellValue[]).slice(1);
        if (rowNumber === 1) {
          headers = values.map((value) => String(value ?? '').trim());
        } else {
          const obj: Record<string, string> = {};
          headers.forEach((header, index) => {
            obj[header] = String(values[index] ?? '').trim();
          });
          if (Object.values(obj).some((value) => value !== '')) {
            rows.push(obj);
          }
        }
      });

      return rows.map((row) => this.normalizeImportRow(row));
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Unable to parse attendance spreadsheet file');
    }
  }

  private pickRowValue(row: Record<string, string>, keys: string[]) {
    for (const key of keys) {
      const value = row[this.normalizeImportHeader(key)];
      if (value) {
        return value;
      }
    }
    return '';
  }

  private normalizeAttendanceType(value: string) {
    const normalized = value.trim().toLowerCase();

    if (['in', 'checkin', 'entry', 'arrival', 'حضور', 'دخول'].includes(normalized)) {
      return 'IN';
    }

    if (['out', 'checkout', 'exit', 'departure', 'انصراف', 'خروج'].includes(normalized)) {
      return 'OUT';
    }

    return null;
  }

  private normalizeAttendanceSource(value?: string) {
    return value?.trim().toLowerCase() === 'device' ? 'device' : 'manual';
  }

  private async extractAttendanceRows(file: Express.Multer.File): Promise<AttendanceImportRow[]> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Attendance file is required');
    }

    const extension = extname(String(file.originalname || '')).toLowerCase();
    if (!ATTENDANCE_IMPORT_EXTENSIONS.has(extension)) {
      throw new BadRequestException('Unsupported attendance file extension');
    }

    let rows: Record<string, string>[] = [];

    if (extension === '.json') {
      rows = this.parseJsonRows(file.buffer.toString('utf8'));
    } else if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(extension)) {
      rows = await this.parseSpreadsheetRows(file.buffer);
    } else {
      const content = file.buffer.toString('utf8');
      const delimiter = extension === '.tsv' ? '\t' : this.detectDelimiter(content);
      rows = this.parseDelimitedRows(content, delimiter);
    }

    return rows
      .map((row) => ({
        employeeId: this.pickRowValue(row, [
          'employeeId',
          'employee_id',
          'empId',
          'id',
          'رقم الموظف',
          'كود الموظف',
        ]),
        timestamp: this.pickRowValue(row, [
          'timestamp',
          'datetime',
          'eventTime',
          'time',
          'التاريخ',
          'الوقت',
        ]),
        type: this.pickRowValue(row, ['type', 'eventType', 'direction', 'status', 'النوع']),
        deviceId:
          this.pickRowValue(row, ['deviceId', 'device_id', 'device', 'الجهاز']) || undefined,
        location: this.pickRowValue(row, ['location', 'site', 'الموقع']) || undefined,
        source: this.pickRowValue(row, ['source', 'المصدر']) || undefined,
        notes: this.pickRowValue(row, ['notes', 'note', 'ملاحظات']) || undefined,
      }))
      .filter((row) => row.employeeId || row.timestamp || row.type);
  }

  private resolveMonthRange(month: string) {
    if (!ATTENDANCE_MONTH_REGEX.test(month)) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }

    const [year, monthNumber] = month.split('-').map(Number);
    const monthEndDate = new Date(Date.UTC(year, monthNumber, 0));
    const endDay = String(monthEndDate.getUTCDate()).padStart(2, '0');

    return {
      startDate: `${month}-01`,
      endDate: `${month}-${endDay}`,
    };
  }

  async list(query: AttendanceListQueryDto) {
    const { page, limit, skip } = resolvePagination(query, { defaultLimit: 100 });

    const where: Prisma.AttendanceRecordWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;

    if (query.date) {
      where.date = query.date;
    } else if (query.startDate || query.endDate) {
      if (query.startDate && query.endDate && query.startDate > query.endDate) {
        throw new BadRequestException('startDate must be less than or equal to endDate');
      }

      where.date = {
        ...(query.startDate ? { gte: query.startDate } : {}),
        ...(query.endDate ? { lte: query.endDate } : {}),
      };
    }

    const [records, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        include: { employee: { select: { name: true, employeeId: true } } },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return {
      records,
      ...paginationMeta(page, limit, total),
    };
  }

  async create(dto: CreateAttendanceDto) {
    const eventDate = new Date(dto.timestamp);
    if (Number.isNaN(eventDate.getTime())) {
      throw new BadRequestException('Invalid timestamp');
    }

    await this.assertEmployeeExists(dto.employeeId);

    const date = this.deriveDateKey(dto.timestamp, eventDate);

    // ── منع تسجيل نفس النوع مرتين متتاليين في نفس اليوم ──
    const normalizedType = dto.type.toUpperCase();
    const lastRecord = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId: dto.employeeId, date },
      orderBy: { timestamp: 'desc' },
      select: { type: true },
    });
    if (lastRecord && lastRecord.type.toUpperCase() === normalizedType) {
      const typeLabel = normalizedType === 'IN' ? 'دخول' : 'خروج';
      throw new BadRequestException(
        `تحذير: آخر بصمة مسجلة هي ${typeLabel} أيضاً — لا يمكن تسجيل ${typeLabel} مرتين متتاليتين`,
      );
    }

    const record = await this.prisma.attendanceRecord.create({
      data: {
        ...dto,
        timestamp: eventDate,
        type: dto.type.toUpperCase(),
        source: dto.source || 'manual',
        verified: dto.verified ?? true,
        date,
      },
    });

    await this.invalidateAttendanceDashboardCaches();
    await this.emitAttendanceRealtime(record, 'created');

    // ── Real-time aggregation: recalculate missing minutes immediately ──
    this.aggregationService
      .aggregateEmployeeDay(dto.employeeId, date)
      .catch((err) =>
        this.logger.error(
          `⚠️ Real-time aggregation failed (manual create) for ${dto.employeeId}: ${err.message}`,
        ),
      );

    const warning = await checkLeaveConflictForAttendance(this.prisma, dto.employeeId, date);
    return { message: 'Attendance record created successfully', record, warning: warning ?? undefined };
  }

  async upload(file: Express.Multer.File, userId?: string) {
    const rows = await this.extractAttendanceRows(file);
    if (rows.length === 0) {
      throw new BadRequestException('No attendance rows found in uploaded file');
    }

    const employeeIds = Array.from(new Set(rows.map((row) => row.employeeId).filter(Boolean)));
    const employees = await this.prisma.employee.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true },
    });
    const employeeSet = new Set(employees.map((employee) => employee.employeeId));

    const errors: Array<{ row: number; error: string }> = [];
    let importedRows = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;

      if (!row.employeeId || !employeeSet.has(row.employeeId)) {
        errors.push({
          row: rowNumber,
          error: `Employee not found: ${row.employeeId || 'unknown'}`,
        });
        continue;
      }

      if (!row.timestamp) {
        errors.push({ row: rowNumber, error: 'Missing timestamp' });
        continue;
      }

      const parsedTimestamp = new Date(row.timestamp);
      if (Number.isNaN(parsedTimestamp.getTime())) {
        errors.push({ row: rowNumber, error: 'Invalid timestamp format' });
        continue;
      }

      const normalizedType = this.normalizeAttendanceType(row.type || '');
      if (!normalizedType) {
        errors.push({ row: rowNumber, error: 'Attendance type must be IN or OUT' });
        continue;
      }

      try {
        const created = await this.prisma.attendanceRecord.create({
          data: {
            employeeId: row.employeeId,
            timestamp: parsedTimestamp,
            type: normalizedType,
            deviceId: row.deviceId || null,
            location: row.location || null,
            source: this.normalizeAttendanceSource(row.source),
            verified: true,
            notes: row.notes || null,
            date: this.deriveDateKey(row.timestamp, parsedTimestamp),
          },
        });

        importedRows += 1;
        await this.emitAttendanceRealtime(created, 'created');
      } catch (error) {
        errors.push({
          row: rowNumber,
          error: error instanceof Error ? error.message : 'Failed to save attendance row',
        });
      }
    }

    await this.invalidateAttendanceDashboardCaches();

    return {
      message:
        errors.length > 0
          ? 'Attendance upload completed with partial failures'
          : 'Attendance upload completed successfully',
      uploadedBy: userId || null,
      totalRows: rows.length,
      importedRows,
      failedRows: errors.length,
      errors: errors.slice(0, 100),
    };
  }

  async month(month: string, page = 1, limit = 100) {
    const range = this.resolveMonthRange(month);
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { date: { gte: range.startDate, lte: range.endDate } },
        orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.attendanceRecord.count({
        where: { date: { gte: range.startDate, lte: range.endDate } },
      }),
    ]);

    const employeeCount = new Set(records.map((record) => record.employeeId)).size;
    const lateCount = records.filter(
      (record) => ((record.shiftPair as ShiftPair | null)?.minutesLate || 0) > 0,
    ).length;

    return {
      records,
      ...paginationMeta(page, limit, total),
      month,
      period: range,
      statistics: {
        totalRecords: total,
        totalEmployees: employeeCount,
        totalLateRecords: lateCount,
      },
    };
  }

  async getById(recordId: string) {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!record) throw new NotFoundException('Attendance record not found');
    return record;
  }

  async update(recordId: string, dto: UpdateAttendanceDto) {
    const existing = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });

    if (!existing) throw new NotFoundException('Attendance record not found');

    if (dto.employeeId !== undefined) {
      await this.assertEmployeeExists(dto.employeeId);
    }

    // ── Capture original state for edge-case: admin changes date or employeeId ──
    const originalEmployeeId = existing.employeeId;
    const originalDate = existing.date;

    const payload: Prisma.AttendanceRecordUncheckedUpdateInput = {};

    if (dto.employeeId !== undefined) payload.employeeId = dto.employeeId;
    if (dto.type !== undefined) payload.type = dto.type.toUpperCase();
    if (dto.deviceId !== undefined) payload.deviceId = dto.deviceId;
    if (dto.location !== undefined) payload.location = dto.location;
    if (dto.source !== undefined) payload.source = dto.source;
    if (dto.verified !== undefined) payload.verified = dto.verified;
    if (dto.notes !== undefined) payload.notes = dto.notes;

    if (dto.timestamp) {
      const parsed = new Date(dto.timestamp);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid timestamp');
      }
      payload.timestamp = parsed;
      payload.date = this.deriveDateKey(dto.timestamp, parsed);
    }

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: recordId },
      data: payload,
    });

    await this.invalidateAttendanceDashboardCaches();
    await this.emitAttendanceRealtime(updated, 'updated');

    // ── Real-time aggregation: recalculate missing minutes for the NEW state ──
    // Fire-and-forget so the update response is not blocked.
    this.aggregationService
      .aggregateEmployeeDay(updated.employeeId, updated.date)
      .catch((err) =>
        this.logger.error(
          `⚠️ Real-time aggregation failed (update/new) for ${updated.employeeId} on ${updated.date}: ${err.message}`,
        ),
      );

    // ── Edge case: if admin changed date or employeeId, also recalculate the OLD day ──
    // This cleans up stale penalty calculations from the original employee/date combination.
    if (updated.employeeId !== originalEmployeeId || updated.date !== originalDate) {
      this.aggregationService
        .aggregateEmployeeDay(originalEmployeeId, originalDate)
        .catch((err) =>
          this.logger.error(
            `⚠️ Real-time aggregation failed (update/old) for ${originalEmployeeId} on ${originalDate}: ${err.message}`,
          ),
        );
    }

    const warning = await checkLeaveConflictForAttendance(this.prisma, updated.employeeId, updated.date);
    return { message: 'Attendance record updated successfully', record: updated, warning: warning ?? undefined };
  }

  async listDeletedHistory(query: { page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = { entityType: ATTENDANCE_DELETION_ENTITY, restoredAt: null };

    const [records, total] = await Promise.all([
      this.prisma.deletedRecordHistory.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.deletedRecordHistory.count({ where }),
    ]);

    return {
      records,
      ...paginationMeta(page, limit, total),
    };
  }

  async remove(recordId: string, deletedBy?: string) {
    const record = await this.getById(recordId);

    const history = await this.prisma.$transaction(async (tx) => {
      const createdHistory = await tx.deletedRecordHistory.create({
        data: {
          entityType: ATTENDANCE_DELETION_ENTITY,
          recordId: record.id,
          payload: this.toHistoryPayload(record),
          deletedBy: deletedBy || null,
        },
      });

      await tx.attendanceRecord.delete({ where: { id: record.id } });
      return createdHistory;
    });

    await this.invalidateAttendanceDashboardCaches();

    return {
      message: 'Attendance record deleted successfully',
      recordId: record.id,
      historyId: history.id,
    };
  }

  async restore(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: ATTENDANCE_DELETION_ENTITY },
    });

    if (!history) {
      throw new NotFoundException('Deleted attendance history not found');
    }

    if (history.restoredAt) {
      throw new BadRequestException('Attendance record has already been restored');
    }

    const payload = history.payload as Prisma.JsonObject;
    const id = this.parseRequiredString(payload, 'id');
    const employeeId = this.parseRequiredString(payload, 'employeeId');
    const timestampValue = this.parseRequiredString(payload, 'timestamp');
    const date = this.parseRequiredString(payload, 'date');
    const type = this.parseRequiredString(payload, 'type').toUpperCase();
    const timestamp = new Date(timestampValue);

    if (Number.isNaN(timestamp.getTime())) {
      throw new BadRequestException('Corrupted history payload: invalid timestamp');
    }

    await this.assertEmployeeExists(employeeId);

    const existing = await this.prisma.attendanceRecord.findUnique({ where: { id } });
    if (existing) {
      throw new BadRequestException('Attendance record already exists');
    }

    const source = typeof payload.source === 'string' ? payload.source : 'manual';
    const verified = typeof payload.verified === 'boolean' ? payload.verified : true;
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : null;
    const location = typeof payload.location === 'string' ? payload.location : null;
    const notes = typeof payload.notes === 'string' ? payload.notes : null;
    const shiftPair = payload.shiftPair;

    const restoredRecord = await this.prisma.$transaction(async (tx) => {
      const created = await tx.attendanceRecord.create({
        data: {
          id,
          employeeId,
          timestamp,
          type,
          deviceId,
          location,
          source,
          verified,
          notes,
          date,
          ...(shiftPair !== undefined && shiftPair !== null
            ? { shiftPair: shiftPair as Prisma.InputJsonValue }
            : {}),
        },
      });

      await tx.deletedRecordHistory.update({
        where: { id: history.id },
        data: {
          restoredAt: new Date(),
          restoredBy: restoredBy || null,
        },
      });

      return created;
    });

    await this.invalidateAttendanceDashboardCaches();

    return {
      message: 'Attendance record restored successfully',
      record: restoredRecord,
    };
  }

  async stats(startDate?: string, endDate?: string) {
    const range = this.resolveRange(startDate, endDate);

    return this.shortCache.getOrSetJson(
      `attendance:stats:${range.startDate}:${range.endDate}`,
      20,
      async () => {
        const records = await this.prisma.attendanceRecord.findMany({
          where: {
            date: { gte: range.startDate, lte: range.endDate },
          },
          include: { employee: { select: { employeeId: true, name: true } } },
        });

        const totalEmployees = await this.prisma.employee.count({
          where: { status: 'active' },
        });

        const employeeMap = new Map<
          string,
          { employeeId: string; name: string; minutesLate: number; records: number }
        >();
        let totalLateMinutes = 0;
        let totalLateArrivals = 0;

        for (const record of records) {
          const empId = record.employeeId;
          const shiftPair = record.shiftPair as ShiftPair | null;
          const minutesLate = shiftPair?.minutesLate || 0;

          if (!employeeMap.has(empId)) {
            employeeMap.set(empId, {
              employeeId: empId,
              name: record.employee?.name || empId,
              minutesLate: 0,
              records: 0,
            });
          }
          const empData = employeeMap.get(empId)!;
          empData.minutesLate += minutesLate;
          empData.records += 1;
          totalLateMinutes += minutesLate;
          if (minutesLate > 5) totalLateArrivals++;
        }

        const topLateEmployees = Array.from(employeeMap.values())
          .filter((e) => e.minutesLate > 0)
          .sort((a, b) => b.minutesLate - a.minutesLate)
          .slice(0, 10)
          .map((e) => ({
            employeeId: e.employeeId,
            name: e.name,
            totalLateMinutes: e.minutesLate,
          }));

        return {
          summary: {
            activeEmployees: employeeMap.size,
            absentCount: totalEmployees - employeeMap.size,
            totalLateMinutes,
          },
          statistics: {
            totalLateArrivals,
          },
          topLateEmployees,
        };
      },
    );
  }

  async anomalies(startDate?: string, endDate?: string) {
    const range = this.resolveRange(startDate, endDate);

    return this.shortCache.getOrSetJson(
      `attendance:anomalies:${range.startDate}:${range.endDate}`,
      20,
      async () => {
        const candidates = await this.prisma.attendanceRecord.findMany({
          where: {
            date: { gte: range.startDate, lte: range.endDate },
          },
        });

        const anomalies = candidates.filter((record: (typeof candidates)[number]) => {
          if (!record.verified) return true;
          const shiftPair = record.shiftPair as ShiftPair | null;
          return (shiftPair?.minutesLate || 0) > 60;
        });

        return {
          period: range,
          anomalies,
          anomalyCount: anomalies.length,
        };
      },
    );
  }

  async alerts(date?: string, lateThresholdMinutes = DEFAULT_LATE_THRESHOLD_MINUTES) {
    const targetDate = date || this.toDateKey();
    const threshold = Number.isFinite(lateThresholdMinutes)
      ? Math.max(0, Math.floor(lateThresholdMinutes))
      : DEFAULT_LATE_THRESHOLD_MINUTES;

    return this.shortCache.getOrSetJson(
      `attendance:alerts:${targetDate}:${threshold}`,
      15,
      async () => {
        const [activeEmployees, records] = await Promise.all([
          this.prisma.employee.findMany({
            where: { status: 'active' },
            select: {
              employeeId: true,
              name: true,
              department: true,
              scheduledStart: true,
            },
          }),
          this.prisma.attendanceRecord.findMany({
            where: { date: targetDate },
            orderBy: { timestamp: 'asc' },
            select: {
              employeeId: true,
              type: true,
              timestamp: true,
              shiftPair: true,
            },
          }),
        ]);

        const attendanceByEmployee = new Map<string, EmployeeDailyAttendance>();

        for (const record of records) {
          const snapshot = attendanceByEmployee.get(record.employeeId) || {
            firstIn: null,
            maxMinutesLateFromShiftPair: null,
          };

          const shiftPair = record.shiftPair as ShiftPair | null;
          if (
            typeof shiftPair?.minutesLate === 'number' &&
            Number.isFinite(shiftPair.minutesLate)
          ) {
            const existingMinutes = snapshot.maxMinutesLateFromShiftPair ?? 0;
            snapshot.maxMinutesLateFromShiftPair = Math.max(
              existingMinutes,
              Math.max(0, Math.floor(shiftPair.minutesLate)),
            );
          }

          if (record.type.toUpperCase() === 'IN' && !snapshot.firstIn) {
            snapshot.firstIn = record.timestamp;
          }

          attendanceByEmployee.set(record.employeeId, snapshot);
        }

        const absentAlerts: AttendanceAlertItem[] = [];
        const lateAlerts: AttendanceAlertItem[] = [];

        for (const employee of activeEmployees) {
          const snapshot = attendanceByEmployee.get(employee.employeeId);
          const scheduledStart = employee.scheduledStart || DEFAULT_ALERT_SCHEDULE_START;
          if (!snapshot?.firstIn) {
            absentAlerts.push({
              status: 'absent',
              employeeId: employee.employeeId,
              name: employee.name,
              department: employee.department,
              scheduledStart,
              checkIn: null,
              minutesLate: 0,
            });
            continue;
          }

          const minutesLate = this.resolveMinutesLate(
            snapshot.firstIn,
            scheduledStart,
            snapshot.maxMinutesLateFromShiftPair,
          );

          if (minutesLate >= threshold) {
            lateAlerts.push({
              status: 'late',
              employeeId: employee.employeeId,
              name: employee.name,
              department: employee.department,
              scheduledStart,
              checkIn: snapshot.firstIn.toISOString(),
              minutesLate,
            });
          }
        }

        const alerts = [...absentAlerts, ...lateAlerts].sort((a, b) => {
          if (a.status !== b.status) {
            return a.status === 'absent' ? -1 : 1;
          }

          return a.name.localeCompare(b.name);
        });

        return {
          date: targetDate,
          lateThresholdMinutes: threshold,
          summary: {
            activeEmployees: activeEmployees.length,
            checkedInCount: activeEmployees.length - absentAlerts.length,
            absentCount: absentAlerts.length,
            lateCount: lateAlerts.length,
            totalAlerts: alerts.length,
          },
          alerts,
        };
      },
    );
  }

  async employeeOnDate(employeeId: string, date: string) {
    const records = await this.prisma.attendanceRecord.findMany({
      where: { employeeId, date },
      orderBy: { timestamp: 'asc' },
    });

    return { employeeId, date, records, recordCount: records.length };
  }

  async dailyView(date?: string) {
    const targetDate = date || this.toDateKey();
    const TIMEZONE_OFFSET_MINUTES = 180;

    const [activeEmployees, records] = await Promise.all([
      this.prisma.employee.findMany({
        where: { status: 'active' },
        select: {
          employeeId: true,
          name: true,
          department: true,
          scheduledStart: true,
          scheduledEnd: true,
          gracePeriodMinutes: true,
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { date: targetDate },
        orderBy: { timestamp: 'asc' },
        select: {
          employeeId: true,
          type: true,
          timestamp: true,
          shiftPair: true,
        },
      }),
    ]);

    const byEmployee = new Map<
      string,
      {
        firstIn: Date | null;
        lastOut: Date | null;
        maxMinutesLate: number | null;
      }
    >();

    for (const record of records) {
      const entry = byEmployee.get(record.employeeId) || {
        firstIn: null,
        lastOut: null,
        maxMinutesLate: null,
      };

      const sp = record.shiftPair as ShiftPair | null;
      if (typeof sp?.minutesLate === 'number' && Number.isFinite(sp.minutesLate)) {
        entry.maxMinutesLate = Math.max(
          entry.maxMinutesLate ?? 0,
          Math.max(0, Math.floor(sp.minutesLate)),
        );
      }

      const recType = record.type.toUpperCase();
      if (recType === 'IN' && !entry.firstIn) {
        entry.firstIn = record.timestamp;
      }
      if (recType === 'OUT') {
        entry.lastOut = record.timestamp;
      }

      byEmployee.set(record.employeeId, entry);
    }

    const toLocalHHMM = (ts: Date | null): string | null => {
      if (!ts) return null;
      const utcMin = ts.getUTCHours() * 60 + ts.getUTCMinutes();
      const localMin = (((utcMin + TIMEZONE_OFFSET_MINUTES) % 1440) + 1440) % 1440;
      const h = Math.floor(localMin / 60);
      const m = localMin % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const result = activeEmployees.map((emp) => {
      const entry = byEmployee.get(emp.employeeId);
      const scheduledStart = emp.scheduledStart || '08:00';
      const scheduledEnd = emp.scheduledEnd || '16:00';
      const grace = emp.gracePeriodMinutes ?? 15;

      const checkInTime = toLocalHHMM(entry?.firstIn ?? null);
      const checkOutTime = toLocalHHMM(entry?.lastOut ?? null);

      let status: string;
      let notes: string | null = null;

      if (!entry?.firstIn) {
        status = 'absent';
      } else {
        const [schH, schM] = scheduledStart.split(':').map(Number);
        const scheduledMinutes = (schH || 8) * 60 + (schM || 0);
        const utcMin = entry.firstIn.getUTCHours() * 60 + entry.firstIn.getUTCMinutes();
        const localMin = ((utcMin + TIMEZONE_OFFSET_MINUTES) % 1440) % 1440;
        const rawLate = Math.max(0, localMin - scheduledMinutes);

        if (
          entry.maxMinutesLate !== null &&
          entry.maxMinutesLate !== undefined &&
          entry.maxMinutesLate > 0
        ) {
          status = 'late';
          notes = `متأخر ${entry.maxMinutesLate} دقيقة`;
        } else if (rawLate > grace) {
          status = 'late';
          notes = `متأخر ${rawLate - grace} دقيقة`;
        } else {
          status = 'present';
        }

        if (entry.lastOut) {
          const [seH, seM] = scheduledEnd.split(':').map(Number);
          const scheduledEndMin = (seH || 16) * 60 + (seM || 0);
          const outUtcMin = entry.lastOut.getUTCHours() * 60 + entry.lastOut.getUTCMinutes();
          const outLocalMin = ((outUtcMin + TIMEZONE_OFFSET_MINUTES) % 1440) % 1440;
          const overtime = Math.max(0, outLocalMin - scheduledEndMin);
          if (overtime > 0) {
            notes = notes ? `${notes} + إضافي ${overtime} دقيقة` : `إضافي ${overtime} دقيقة`;
          }
        }
      }

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        department: emp.department,
        date: targetDate,
        scheduledStart,
        scheduledEnd,
        checkIn: checkInTime,
        checkOut: checkOutTime,
        status,
        notes,
        source: entry?.firstIn ? 'biometric' : null,
      };
    });

    return {
      date: targetDate,
      employees: result,
      summary: {
        total: result.length,
        present: result.filter((e) => e.status === 'present').length,
        late: result.filter((e) => e.status === 'late').length,
        absent: result.filter((e) => e.status === 'absent').length,
      },
    };
  }

  async employeePeriod(employeeId: string, startDate: string, endDate: string) {
    if (!startDate || !endDate) {
      throw new BadRequestException('Start and end dates are required');
    }

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
    });

    return {
      employeeId,
      period: { startDate, endDate },
      records,
      statistics: {
        totalDays: new Set(records.map((r: (typeof records)[number]) => r.date)).size,
        totalRecords: records.length,
      },
    };
  }

  async calculateDeductions(input: {
    periodStart: string;
    periodEnd: string;
    gracePeriodMinutes?: number;
    workDaysInPeriod?: number;
    hoursPerDay?: number;
    employeeId?: string;
  }) {
    const {
      periodStart,
      periodEnd,
      // القيم الافتراضية من الـ input — تُستخدم فقط إذا لم يوجد إعداد على الموظف نفسه
      gracePeriodMinutes: inputGracePeriod = 5,
      workDaysInPeriod: inputWorkDays = 26,
      hoursPerDay: inputHoursPerDay = 8,
      employeeId,
    } = input;

    if (!periodStart || !periodEnd) {
      throw new BadRequestException('periodStart and periodEnd are required');
    }

    if (periodStart > periodEnd) {
      throw new BadRequestException('periodStart must be before or equal to periodEnd');
    }

    // حساب عدد أيام العمل في الفترة (استثناء الجمعة فقط — السبت يوم عمل)
    const calcWorkingDays = (start: string, end: string): number => {
      const startDate = new Date(`${start}T00:00:00Z`);
      const endDate = new Date(`${end}T00:00:00Z`);
      let count = 0;
      const cur = new Date(startDate);
      while (cur <= endDate) {
        const day = cur.getUTCDay(); // 0=Sunday, 5=Friday, 6=Saturday
        if (day !== 5) count++; // استثناء الجمعة فقط — السبت يوم عمل
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return count;
    };

    // عدد أيام العمل في الفترة الكاملة (للحسابات المالية)
    const totalWorkDaysInPeriod = calcWorkingDays(periodStart, periodEnd);

    // عدد أيام العمل المنقضية فقط (لحساب الغياب — لا نخصم مستقبلاً)
    const today = toFactoryDateKey();
    const effectivePeriodEnd = periodEnd < today ? periodEnd : today;
    const elapsedWorkDays = calcWorkingDays(periodStart, effectivePeriodEnd);

    // الحصول على جميع الموظفين النشطين أو موظف محدد
    // نجلب إعدادات كل موظف من الـ DB مباشرة
    const employeeSelect = {
      employeeId: true,
      name: true,
      hourlyRate: true,
      baseSalary: true,
      livingAllowance: true,
      scheduledStart: true,
      scheduledEnd: true,
      workDaysInPeriod: true,
      hoursPerDay: true,
      gracePeriodMinutes: true,
    } as const;

    const employees = employeeId
      ? [
          await this.prisma.employee.findUnique({
            where: { employeeId },
            select: employeeSelect,
          }),
        ]
      : await this.prisma.employee.findMany({
          where: { status: 'active' },
          select: employeeSelect,
        });

    if (!employees.length) {
      throw new BadRequestException('No active employees found');
    }

    // جلب الإجازات المعتمدة للفترة لاستبعاد أيام الإجازة من أيام الحضور.
    // يوم إجازة معتمدة (مرضية/إدارية/وفاة/بدون أجر) له بصمة دخول (IN) يُحتسب
    // حضوراً خطأً فيضاعف عدد الأيام (مثال: عمل يومين + يوم مرضي ببصمة → 3 أيام).
    const leaveWhere: Prisma.LeaveRequestWhereInput = {
      status: 'APPROVED',
      startDate: { lte: new Date(`${periodEnd}T23:59:59Z`) },
      endDate: { gte: new Date(`${periodStart}T00:00:00Z`) },
    };
    if (employeeId) leaveWhere.employeeId = employeeId;
    const approvedLeaves = await this.prisma.leaveRequest.findMany({
      where: leaveWhere,
      select: { employeeId: true, startDate: true, endDate: true },
    });
    const periodStartUtc = new Date(`${periodStart}T00:00:00Z`);
    const periodEndUtc = new Date(`${periodEnd}T23:59:59Z`);
    const leaveDatesByEmployee = new Map<string, Set<string>>();
    for (const leave of approvedLeaves) {
      const start = leave.startDate < periodStartUtc ? periodStartUtc : new Date(leave.startDate);
      const end = leave.endDate > periodEndUtc ? periodEndUtc : new Date(leave.endDate);
      const cur = new Date(start);
      while (cur <= end) {
        const d = cur.toISOString().slice(0, 10);
        if (!leaveDatesByEmployee.has(leave.employeeId)) {
          leaveDatesByEmployee.set(leave.employeeId, new Set<string>());
        }
        leaveDatesByEmployee.get(leave.employeeId)!.add(d);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // جلب الإجازات المرضية بساعات (isHourly) لحساب باقي اليوم بنصف الأجر
    const sickLeaves = await this.prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        leaveType: 'SICK',
        isHourly: true,
        startDate: { lte: new Date(`${periodEnd}T23:59:59Z`) },
        endDate: { gte: new Date(`${periodStart}T00:00:00Z`) },
      },
      select: { employeeId: true, startDate: true, endDate: true, startTime: true, isHourly: true },
    });
    const sickLeavesByEmployee = new Map<string, typeof sickLeaves>();
    for (const l of sickLeaves) {
      const arr = sickLeavesByEmployee.get(l.employeeId) ?? [];
      arr.push(l);
      sickLeavesByEmployee.set(l.employeeId, arr);
    }

    // جلب جميع سجلات الحضور للفترة دفعة واحدة لتحسين الأداء
    const allRecords = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        date: { gte: periodStart, lte: periodEnd },
      },
      orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
      select: {
        employeeId: true,
        date: true,
        type: true,
        timestamp: true,
        shiftPair: true,
        // used for IN/OUT pairing to compute overtime
      },
    });

    // ── Aggregate EARLY_LEAVE_MINUTES from DailyAttendanceLog for the period ──
    // This picks up real-time calculated penalties written by the aggregation engine.
    const earlyLeaveLogs = await this.prisma.dailyAttendanceLog.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        date: {
          gte: new Date(`${periodStart}T00:00:00.000Z`),
          lte: new Date(`${periodEnd}T23:59:59.999Z`),
        },
        recordType: 'EARLY_LEAVE_MINUTES',
      },
      select: { employeeId: true, value: true },
    });
    const earlyLeaveMinutesByEmployee = new Map<string, number>();
    for (const log of earlyLeaveLogs) {
      const minutes = Number(log.value ?? 0);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      earlyLeaveMinutesByEmployee.set(
        log.employeeId,
        (earlyLeaveMinutesByEmployee.get(log.employeeId) || 0) + minutes,
      );
    }

    // تجميع السجلات حسب الموظف
    const recordsByEmployee = new Map<string, typeof allRecords>();
    for (const record of allRecords) {
      const existing = recordsByEmployee.get(record.employeeId) || [];
      existing.push(record);
      recordsByEmployee.set(record.employeeId, existing);
    }

    const breakdowns: Array<{
      employeeId: string;
      employeeName: string;
      presentDays: number;
      absentDays: number;
      absenceDeduction: number;
      delayMinutes: number;
      delayDeduction: number;
      earlyLeaveMinutes: number;
      overtimeMinutes: number;
      overtimeWeekendDays: number;
      overtimePay: number;
      totalAttendanceDeduction: number;
      totalOvertimePay: number;
      elapsedWorkDays: number;
      periodStart: string;
      periodEnd: string;
    }> = [];

    let totalAbsenceDeduction = 0;
    let totalDelayDeduction = 0;

    for (const employee of employees) {
      if (!employee) continue;

      const records = recordsByEmployee.get(employee.employeeId) || [];

      // إعدادات الموظف الخاصة — تُقدَّم على القيم الافتراضية
      const empWorkDays: number = employee.workDaysInPeriod ?? inputWorkDays;
      const empHoursPerDay: number = employee.hoursPerDay ?? inputHoursPerDay;
      const empGracePeriod: number = employee.gracePeriodMinutes ?? inputGracePeriod;

      // ── حساب أيام الحضور الفعلية ─────────────────────────────────────────
      // نحسب الأيام الفريدة التي وُجد فيها سجل IN (استثناء الجمعة فقط — السبت يوم عمل)
      // مع استبعاد أيام الإجازة المعتمدة حتى لو وُجدت فيها بصمة دخول (راجع الأعلى)
      const employeeLeaveDates = leaveDatesByEmployee.get(employee.employeeId);
      const datesWithCheckIn = new Set(
        records
          .filter((r) => r.type.toUpperCase() === 'IN')
          .map((r) => r.date)
          .filter((dateStr) => {
            const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
            if (day === 5) return false; // استثناء الجمعة فقط — السبت يوم عمل
            if (employeeLeaveDates && employeeLeaveDates.has(dateStr)) return false; // استبعاد يوم إجازة
            return true;
          }),
      );
      // أيام الحضور الفعلية = عدد الأيام الفريدة التي تم فيها تسجيل حضور
      const presentDays = datesWithCheckIn.size;

      // أيام الغياب = أيام العمل المنقضية - أيام الحضور الفعلية
      // نستخدم elapsedWorkDays (حتى اليوم) حتى لا نخصم مستقبلاً
      const absentDays = Math.max(
        0,
        elapsedWorkDays - Math.min(datesWithCheckIn.size, elapsedWorkDays),
      );

      // ── حساب دقائق التأخير الشهرية ───────────────────────────────────────
      // نأخذ أول IN لكل يوم ونقارنه بـ scheduledStart الخاص بالموظف
      const scheduledStart = employee.scheduledStart || '08:00';
      const [schH, schM] = scheduledStart.split(':').map(Number);
      const scheduledMinutes = (schH || 8) * 60 + (schM || 0);

      // أول IN وآخر OUT لكل يوم
      const firstInByDate = new Map<
        string,
        { timestamp: Date; shiftPairMinutesLate: number | null; date: string }
      >();
      const lastOutByDate = new Map<string, Date>();
      for (const record of records) {
        const recType = record.type.toUpperCase();
        if (recType === 'IN') {
          if (firstInByDate.has(record.date)) continue;
          const sp = record.shiftPair as Record<string, unknown> | null;
          const spLate =
            sp?.minutesLate !== null && sp?.minutesLate !== undefined
              ? Number(sp.minutesLate)
              : null;
          firstInByDate.set(record.date, {
            timestamp: record.timestamp,
            date: record.date,
            shiftPairMinutesLate: Number.isFinite(spLate) ? (spLate as number) : null,
          });
        } else if (recType === 'OUT') {
          // نحتفظ بآخر OUT في اليوم
          const existing = lastOutByDate.get(record.date);
          if (!existing || record.timestamp > existing) {
            lastOutByDate.set(record.date, record.timestamp);
          }
        }
      }

      // timezone offset: Saudi Arabia UTC+3 = 180 minutes
      const TIMEZONE_OFFSET_MINUTES = 180;

      // جلب الإجازات الساعية المعتمدة للموظف في الفترة
      const hourlyLeavesInPeriod = await this.prisma.leaveRequest.findMany({
        where: {
          employeeId: employee.employeeId,
          status: 'APPROVED',
          isHourly: true,
          startDate: { lte: new Date(`${periodEnd}T23:59:59Z`) },
          endDate: { gte: new Date(`${periodStart}T00:00:00Z`) },
        },
        select: { startDate: true, startTime: true, endTime: true },
      });

      // بناء map: date → دقائق الإجازة الساعية في بداية اليوم
      const morningLeaveOffsetByDate = new Map<string, number>();
      for (const leave of hourlyLeavesInPeriod) {
        const dateStr = leave.startDate.toISOString().slice(0, 10);
        const [lsh, lsm] = (leave.startTime || '').split(':').map(Number);
        const [leh, lem] = (leave.endTime || '').split(':').map(Number);
        const leaveStartMin = (lsh || 0) * 60 + (lsm || 0);
        const leaveEndMin = (leh || 0) * 60 + (lem || 0);
        // تُحسب فقط إذا الإجازة بدأت عند أو قبل وقت الدوام
        if (leaveStartMin <= scheduledMinutes && leaveEndMin > scheduledMinutes) {
          const existing = morningLeaveOffsetByDate.get(dateStr) || 0;
          morningLeaveOffsetByDate.set(dateStr, Math.max(existing, leaveEndMin - scheduledMinutes));
        }
      }

      let totalDelayMinutes = 0;
      for (const { timestamp, shiftPairMinutesLate, date } of firstInByDate.values()) {
        let rawLate: number;
        if (shiftPairMinutesLate !== null && shiftPairMinutesLate > 0) {
          rawLate = shiftPairMinutesLate;
        } else {
          // timestamp stored in DB as UTC — add +3h to get local Saudi time
          const utcMinutes = timestamp.getUTCHours() * 60 + timestamp.getUTCMinutes();
          const localMinutes = (((utcMinutes + TIMEZONE_OFFSET_MINUTES) % 1440) + 1440) % 1440;
          rawLate = Math.max(0, localMinutes - scheduledMinutes);
        }
        // طرح دقائق الإجازة الساعية الصباحية من التأخير
        const morningOffset = morningLeaveOffsetByDate.get(date) || 0;
        rawLate = Math.max(0, rawLate - morningOffset);
        const effectiveLate = rawLate > empGracePeriod ? rawLate - empGracePeriod : 0;
        totalDelayMinutes += effectiveLate;
      }

      // ── حساب الإضافي من checkOut vs scheduledEnd ──────────────────────────
      const scheduledEnd = employee.scheduledEnd || '16:00';
      const [seH, seM] = scheduledEnd.split(':').map(Number);
      const scheduledEndMinutes = (seH || 16) * 60 + (seM || 0);

      // آخر خروج (OUT) لكل يوم — لحساب باقي يوم الإجازة المرضية منتصف اليوم
      const lastOutMinutesByDate = new Map<string, number>();
      for (const r of records) {
        if ((r.type || '').toUpperCase() !== 'OUT') continue;
        const ts = typeof r.timestamp === 'string' ? new Date(r.timestamp) : r.timestamp;
        const date = ts.toISOString().slice(0, 10);
        const min = toLocalMinutes(ts);
        const prev = lastOutMinutesByDate.get(date);
        if (prev === undefined || min > prev) lastOutMinutesByDate.set(date, min);
      }

      // دقائق العمل الفعلية (من أزواج IN/OUT)
      const workedMinutes = computeWorkedMinutes(records);

      // الإجازة المرضية:
      //  - يوم فيه حضور (بصمة خروج) ← إجازة منتصف اليوم: باقي الوقت حتى نهاية
      //    الدوام يُحتسب بنصف الأجر (الساعات قبل الخروج بأجر كامل عبر workedMinutes).
      //  - يوم بلا حضور ← إجازة مرضية كاملة (يوم كامل بنصف الأجر).
      const employeeSickLeaves = sickLeavesByEmployee.get(employee.employeeId) || [];
      let sickRemainderMinutes = 0;
      let fullSickDays = 0;
      for (const l of employeeSickLeaves) {
        const start = l.startDate < periodStartUtc ? periodStartUtc : new Date(l.startDate);
        const end = l.endDate > periodEndUtc ? periodEndUtc : new Date(l.endDate);
        const cur = new Date(start);
        while (cur <= end) {
          const d = cur.toISOString().slice(0, 10);
          const lastOut = lastOutMinutesByDate.get(d);
          if (lastOut !== undefined) {
            // إجازة منتصف اليوم: باقي اليوم بعد آخر بصمة خروج بنصف الأجر
            sickRemainderMinutes += Math.max(0, scheduledEndMinutes - lastOut);
          } else {
            // إجازة مرضية كاملة (بلا حضور) — يوم كامل بنصف الأجر
            fullSickDays += 1;
          }
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }

      let totalOvertimeMinutes = 0;
      let overtimeWeekendDays = 0;
      for (const [date, outTimestamp] of lastOutByDate.entries()) {
        const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
        const isFriday = dayOfWeek === 5;

        // timestamp stored as UTC — add +3h to get local Saudi time
        const utcOutMinutes = outTimestamp.getUTCHours() * 60 + outTimestamp.getUTCMinutes();
        const localOutMinutes = (((utcOutMinutes + TIMEZONE_OFFSET_MINUTES) % 1440) + 1440) % 1440;

        if (isFriday) {
          if (localOutMinutes > scheduledEndMinutes) {
            overtimeWeekendDays += 1;
          }
        } else {
          const overtime = Math.max(0, localOutMinutes - scheduledEndMinutes);
          totalOvertimeMinutes += overtime;
        }
      }

      // ── حساب الخصومات المالية ─────────────────────────────────────────────
      const resolved = resolveSalary(employee);
      const effectiveHourlyRate = resolved.hourlyRate;
      const dailyRate = effectiveHourlyRate * empHoursPerDay;
      const minuteRate = dailyRate / (empHoursPerDay * 60);
      const OVERTIME_MULTIPLIER = 1.5; // معدل 1.5× للإضافي والتأخير

      const absenceDeduction = absentDays * dailyRate;
      const delayDeduction = totalDelayMinutes * minuteRate * OVERTIME_MULTIPLIER;

      // الإضافي المالي: عادي + جمعة (كلهم 1.5×)
      const overtimePay = totalOvertimeMinutes * minuteRate * OVERTIME_MULTIPLIER;
      const weekendOvertimePay = overtimeWeekendDays * dailyRate * OVERTIME_MULTIPLIER;

      const totalOvertimePayValue = overtimePay + weekendOvertimePay;

      const breakdown = {
        employeeId: employee.employeeId,
        employeeName: employee.name,
        presentDays,
        workedMinutes,
        sickRemainderMinutes,
        sickLeaveDays: fullSickDays,
        absentDays,
        absenceDeduction: Math.round(absenceDeduction * 100) / 100,
        delayMinutes: totalDelayMinutes,
        delayDeduction: Math.round(delayDeduction * 100) / 100,
        earlyLeaveMinutes: earlyLeaveMinutesByEmployee.get(employee.employeeId) || 0,
        totalAttendanceDeduction: Math.round((absenceDeduction + delayDeduction) * 100) / 100,
        overtimeMinutes: totalOvertimeMinutes,
        overtimeWeekendDays,
        overtimePay: Math.round(overtimePay * 100) / 100,
        weekendOvertimePay: Math.round(weekendOvertimePay * 100) / 100,
        totalOvertimePay: Math.round(totalOvertimePayValue * 100) / 100,
        elapsedWorkDays,
        periodStart,
        periodEnd,
      };

      breakdowns.push(breakdown);
      totalAbsenceDeduction += absenceDeduction;
      totalDelayDeduction += delayDeduction;
    }

    return {
      data: breakdowns,
      summary: {
        totalEmployeesAffected: breakdowns.filter((b) => b.totalAttendanceDeduction > 0).length,
        totalAbsenceDeduction: Math.round(totalAbsenceDeduction * 100) / 100,
        totalDelayDeduction: Math.round(totalDelayDeduction * 100) / 100,
        totalAttendanceDeduction:
          Math.round((totalAbsenceDeduction + totalDelayDeduction) * 100) / 100,
        totalOvertimePay:
          Math.round(breakdowns.reduce((sum, b) => sum + b.totalOvertimePay, 0) * 100) / 100,
        elapsedWorkDays,
        effectivePeriodEnd,
      },
    };
  }
}
