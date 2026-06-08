import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parse as parseCsv } from 'csv-parse/sync';
import { extname } from 'path';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { paginationMeta, resolvePagination } from '../common/utils/pagination.util';
import { CreateAttendanceDto } from './dto/create-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { AttendanceListQueryDto } from './dto/attendance-list-query.dto';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

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
const DEFAULT_LATE_THRESHOLD_MINUTES = 15;
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

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly realtimeGateway: RealtimeGateway,
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
    record: { id: string; employeeId: string; type: string; timestamp: Date; date: string; source?: string | null },
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
    return (checkIn.getHours() * 60) + checkIn.getMinutes();
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
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => this.normalizeImportRow(entry))
      .filter((row) => Object.values(row).some((value) => value !== ''));
  }

  private parseSpreadsheetRows(buffer: Buffer) {
    try {
      const workbook = XLSX.read(buffer, {
        type: 'buffer',
        raw: false,
        cellDates: false,
        dense: true,
      });

      const firstSheetName = workbook.SheetNames?.[0];
      if (!firstSheetName) {
        throw new BadRequestException('Attendance spreadsheet must contain at least one sheet');
      }

      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        defval: '',
        raw: false,
      });

      return rows
        .map((row) => this.normalizeImportRow(row))
        .filter((row) => Object.values(row).some((value) => value !== ''));
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

  private extractAttendanceRows(file: Express.Multer.File): AttendanceImportRow[] {
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
      rows = this.parseSpreadsheetRows(file.buffer);
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
        deviceId: this.pickRowValue(row, ['deviceId', 'device_id', 'device', 'الجهاز']) || undefined,
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
      data: records,
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

    return { message: 'Attendance record created successfully', record };
  }

  async upload(file: Express.Multer.File, userId?: string) {
    const rows = this.extractAttendanceRows(file);
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
        errors.push({ row: rowNumber, error: `Employee not found: ${row.employeeId || 'unknown'}` });
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
      data: records,
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

    return { message: 'Attendance record updated successfully', record: updated };
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
      data: records,
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

        const employeeMap = new Map<string, { employeeId: string; name: string; minutesLate: number; records: number }>();
        let totalLateMinutes = 0;
        let totalLateArrivals = 0;

        for (const record of records) {
          const empId = record.employeeId;
          const shiftPair = record.shiftPair as ShiftPair | null;
          const minutesLate = (shiftPair?.minutesLate || 0);

          if (!employeeMap.has(empId)) {
            employeeMap.set(empId, { employeeId: empId, name: record.employee?.name || empId, minutesLate: 0, records: 0 });
          }
          const empData = employeeMap.get(empId)!;
          empData.minutesLate += minutesLate;
          empData.records += 1;
          totalLateMinutes += minutesLate;
          if (minutesLate > 5) totalLateArrivals++;
        }

        const topLateEmployees = Array.from(employeeMap.values())
          .filter(e => e.minutesLate > 0)
          .sort((a, b) => b.minutesLate - a.minutesLate)
          .slice(0, 10)
          .map(e => ({ employeeId: e.employeeId, name: e.name, totalLateMinutes: e.minutesLate }));

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
          if (typeof shiftPair?.minutesLate === 'number' && Number.isFinite(shiftPair.minutesLate)) {
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
      gracePeriodMinutes: inputGracePeriod = 15,
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

    // نحسب عدد أيام العمل الفعلية في الفترة المطلوبة
    // (الأيام من periodStart حتى اليوم الحالي أو periodEnd أيهما أقل)
    // هذا يحل مشكلة "الشهر لم ينته بعد" حيث لا يمكن محاسبة الموظف على أيام لم تحدث بعد
    const today = new Date().toISOString().slice(0, 10);
    const effectivePeriodEnd = periodEnd < today ? periodEnd : today;

    // حساب عدد أيام العمل الفعلية في الفترة (استثناء الجمعة/السبت حسب الإعداد)
    // مبدئياً نحسب الأيام التقويمية ونفترض 5 أيام عمل أسبوعياً
    const calcWorkingDays = (start: string, end: string): number => {
      const startDate = new Date(`${start}T00:00:00Z`);
      const endDate = new Date(`${end}T00:00:00Z`);
      let count = 0;
      const cur = new Date(startDate);
      while (cur <= endDate) {
        const day = cur.getUTCDay(); // 0=Sunday, 5=Friday, 6=Saturday
        if (day !== 5 && day !== 6) count++; // استثناء الجمعة والسبت
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return count;
    };

    // عدد أيام العمل المتاحة فعلاً حتى اليوم في الفترة المطلوبة
    const elapsedWorkDays = calcWorkingDays(periodStart, effectivePeriodEnd);

    // الحصول على جميع الموظفين النشطين أو موظف محدد
    // نجلب إعدادات كل موظف من الـ DB مباشرة
    const employeeSelect = {
      employeeId: true,
      name: true,
      hourlyRate: true,
      baseSalary: true,
      scheduledStart: true,
      workDaysInPeriod: true,
      hoursPerDay: true,
      gracePeriodMinutes: true,
    } as const;

    const employees = employeeId
      ? [await this.prisma.employee.findUnique({
          where: { employeeId },
          select: employeeSelect,
        })]
      : await this.prisma.employee.findMany({
          where: { status: 'active' },
          select: employeeSelect,
        });

    if (!employees.length) {
      throw new BadRequestException('No active employees found');
    }

    // جلب جميع سجلات الحضور للفترة دفعة واحدة لتحسين الأداء
    const allRecords = await this.prisma.attendanceRecord.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        date: { gte: periodStart, lte: effectivePeriodEnd },
      },
      orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
      select: {
        employeeId: true,
        date: true,
        type: true,
        timestamp: true,
        shiftPair: true,
      },
    });

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
      totalAttendanceDeduction: number;
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
      // نحسب الأيام الفريدة التي وُجد فيها سجل IN
      const datesWithCheckIn = new Set(
        records.filter((r) => r.type.toUpperCase() === 'IN').map((r) => r.date)
      );
      const presentDays = datesWithCheckIn.size;

      // أيام الغياب = أيام العمل المنقضية - أيام الحضور الفعلية
      // نستخدم elapsedWorkDays بدلاً من workDaysInPeriod لأن الشهر قد لا يكون منتهياً
      const absentDays = Math.max(0, elapsedWorkDays - presentDays);

      // ── حساب دقائق التأخير الشهرية ───────────────────────────────────────
      // نأخذ أول IN لكل يوم ونقارنه بـ scheduledStart الخاص بالموظف
      const scheduledStart = employee.scheduledStart || '08:00';
      const [schH, schM] = scheduledStart.split(':').map(Number);
      const scheduledMinutes = (schH || 8) * 60 + (schM || 0);

      // أول IN لكل يوم
      const firstInByDate = new Map<string, { timestamp: Date; shiftPairMinutesLate: number | null; date: string }>();
      for (const record of records) {
        if (record.type.toUpperCase() !== 'IN') continue;
        if (firstInByDate.has(record.date)) continue;
        const sp = record.shiftPair as Record<string, unknown> | null;
        const spLate = sp?.minutesLate != null ? Number(sp.minutesLate) : null;
        firstInByDate.set(record.date, {
          timestamp: record.timestamp,
          date: record.date,
          shiftPairMinutesLate: Number.isFinite(spLate) ? (spLate as number) : null,
        });
      }

      let totalDelayMinutes = 0;
      for (const { timestamp, shiftPairMinutesLate, date } of firstInByDate.values()) {
        let rawLate: number;
        if (shiftPairMinutesLate !== null && shiftPairMinutesLate > 0) {
          // إذا حسب جهاز البصمة التأخير وخزّنه في shiftPair نستخدمه مباشرة
          rawLate = shiftPairMinutesLate;
        } else {
          // الفرونت يُرسل: "2026-06-02T08:30:00+03:00"
          // Prisma يخزّن: timestamp = 2026-06-02T05:30:00.000Z (UTC)
          //              date = "2026-06-02" (التاريخ المحلي)
          //
          // لاستخراج الوقت المحلي الفعلي:
          // بداية اليوم المحلي = date + "T00:00:00Z" = 2026-06-02T00:00:00Z
          // فرق الـ timestamp عن بداية اليوم بالدقائق = دقائق منذ منتصف الليل المحلي
          // مثال: 2026-06-02T05:30:00Z - 2026-06-02T00:00:00Z = 330 دقيقة
          // لكن الوقت الفعلي 08:30 = 510 دقيقة
          //
          // المشكلة: date هو التاريخ المحلي لكن الـ timestamp UTC يحتوي الوقت المنقوص منه الـ offset
          // إذن: دقائق الوقت المحلي = (timestamp_ms - date_start_UTC_ms) / 60000
          // هذا يعطي الوقت المحلي فقط إذا كان date = localDate وليس UTC date
          //
          // الفرونت يُرسل timezone offset → الـ date المخزّن هو التاريخ المحلي
          // مثال: 08:30+03:00 → UTC=05:30 → date="2026-06-02" (صحيح محلياً)
          // date_start_UTC = "2026-06-02T00:00:00Z" = منتصف ليل UTC = 03:00 صباح محلي
          // timestamp_UTC = 05:30 UTC
          // الفرق = 5*60+30 - 0 = 330 دقيقة ≠ 510 (الوقت المحلي الفعلي)
          //
          // الحل الصحيح: نستخدم ISO string الأصلي للـ timestamp الذي يُمثّل UTC
          // ونُضيف الـ offset المتوقع من خلال مقارنة date مع UTC date
          // إذا date > utcDate → offset موجب
          // minutesSinceMidnight_LOCAL = minutesSinceMidnight_UTC + offsetMinutes
          const timestampMs = timestamp.getTime();
          const utcDate = timestamp.toISOString().slice(0, 10); // YYYY-MM-DD بتوقيت UTC
          // حساب الـ offset من فرق التاريخ المحلي (date) عن UTC date
          // إذا date == utcDate → offset بين -12h و +12h في نفس اليوم
          // إذا date > utcDate → timezone موجب (مثل +3، المستخدم في يوم تالٍ عن UTC)
          // إذا date < utcDate → timezone سالب
          const localDateMs = new Date(`${date}T00:00:00Z`).getTime();
          const utcDateMs = new Date(`${utcDate}T00:00:00Z`).getTime();
          const dateDiffMinutes = (localDateMs - utcDateMs) / 60000; // فرق الأيام بالدقائق (0 أو ±1440)
          const utcMinutes = timestamp.getUTCHours() * 60 + timestamp.getUTCMinutes();
          const localMinutes = utcMinutes + dateDiffMinutes;
          // نُضيف تعديل: إذا كان localMinutes خارج نطاق 0-1440 نُصحّح
          const actualMinutes = ((localMinutes % 1440) + 1440) % 1440;
          rawLate = Math.max(0, actualMinutes - scheduledMinutes);
        }
        // طرح فترة السماح الخاصة بالموظف
        const effectiveLate = rawLate > empGracePeriod ? rawLate - empGracePeriod : 0;
        totalDelayMinutes += effectiveLate;
      }

      // ── حساب الخصومات المالية ─────────────────────────────────────────────
      const hourlyRate = employee.hourlyRate ? Number(employee.hourlyRate) : 0;
      const baseSalary = employee.baseSalary ? Number(employee.baseSalary) : 0;
      // معدل الساعة الفعلي — يُحسب من hourlyRate أو من baseSalary
      const effectiveHourlyRate =
        hourlyRate || (baseSalary > 0 ? baseSalary / (empWorkDays * empHoursPerDay) : 0);
      const dailyRate = effectiveHourlyRate * empHoursPerDay;
      const minuteRate = dailyRate / (empHoursPerDay * 60);

      const absenceDeduction = absentDays * dailyRate;
      const delayDeduction = totalDelayMinutes * minuteRate;

      const breakdown = {
        employeeId: employee.employeeId,
        employeeName: employee.name,
        presentDays,
        absentDays,
        absenceDeduction: Math.round(absenceDeduction * 100) / 100,
        delayMinutes: totalDelayMinutes,
        delayDeduction: Math.round(delayDeduction * 100) / 100,
        totalAttendanceDeduction: Math.round((absenceDeduction + delayDeduction) * 100) / 100,
        elapsedWorkDays, // عدد أيام العمل التي مضت فعلاً في الفترة
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
        totalAttendanceDeduction: Math.round((totalAbsenceDeduction + totalDelayDeduction) * 100) / 100,
        elapsedWorkDays,
        effectivePeriodEnd,
      },
    };
  }

}
