import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssistantTool,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from '../assistant.types';

/**
 * The record types DailyAttendanceLog uses for time away from work.
 *
 * These are the same rows payroll reads, which is the whole point of querying
 * this table instead of reconstructing absence from raw punches: the number the
 * assistant reports is the number the attendance and salaries pages show.
 */
const LEAVE_TYPES = [
  'PAID_LEAVE',
  'UNPAID_LEAVE',
  'SICK_LEAVE',
  'ADMIN_LEAVE',
  'DEATH_LEAVE',
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const searchEmployeesInput = z.object({
  nameContains: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Part of the name, Arabic or English.'),
  employeeId: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('Exact staff number, e.g. EMP014.'),
  department: z.string().min(1).max(120).optional(),
  jobTitle: z.string().min(1).max(120).optional(),
  status: z.enum(['active', 'inactive', 'terminated', 'resigned']).optional(),
  salaryMin: z
    .number()
    .nonnegative()
    .optional()
    .describe('Base salary at least this.'),
  salaryMax: z
    .number()
    .nonnegative()
    .optional()
    .describe('Base salary at most this.'),
  hiredAfter: isoDate.optional(),
  hiredBefore: isoDate.optional(),
  absentDaysMin: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Absence days at least this, within the period.'),
  absentDaysMax: z.number().int().nonnegative().optional(),
  leaveDaysMin: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Leave days of any kind at least this, within the period.'),
  leaveDaysMax: z.number().int().nonnegative().optional(),
  periodFrom: isoDate
    .optional()
.describe('Period start for absence and leave. Default: 30 days ago.'),
  periodTo: isoDate
    .optional()
    .describe('Period end. Default: today.'),
  sortBy: z
    .enum(['name', 'employeeId', 'salary', 'absentDays', 'leaveDays', 'hiredAt'])
    .optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
});

type SearchEmployeesInput = z.infer<typeof searchEmployeesInput>;

@Injectable()
export class HrTools {
  constructor(private readonly prisma: PrismaService) {}

  tools(): AssistantTool[] {
    return [
      this.searchEmployees(),
      this.getEmployeeProfile(),
      this.getAttendanceSummary(),
      this.listLeaveRequests(),
    ];
  }

  private searchEmployees(): AssistantTool {
    return {
      name: 'search_employees',
      description: [
        'Find employees by profile, salary, absence or leave filters, combined freely.',
        'Absence and leave days come from the daily attendance log, the source payroll uses.',
        'leaveDays covers paid, unpaid, sick, admin and bereavement leave together.',
        'Period defaults to the last 30 days; say which period you used.',
        'Answer "how many" from totalMatching, never by counting rows.',
      ].join(' '),
      input: searchEmployeesInput,
      permissions: ['view_employees'],
      run: async (input) => this.runSearchEmployees(input as SearchEmployeesInput),
    };
  }

  private async runSearchEmployees(input: SearchEmployeesInput) {
    const limit = input.limit ?? DEFAULT_ROW_LIMIT;
    const wantsDayFilters =
      input.absentDaysMin !== undefined ||
      input.absentDaysMax !== undefined ||
      input.leaveDaysMin !== undefined ||
      input.leaveDaysMax !== undefined ||
      input.sortBy === 'absentDays' ||
      input.sortBy === 'leaveDays';

    const periodTo = input.periodTo ? new Date(input.periodTo) : new Date();
    const periodFrom = input.periodFrom
      ? new Date(input.periodFrom)
      : new Date(periodTo.getTime() - 30 * 24 * 60 * 60 * 1000);

    const where: Prisma.EmployeeWhereInput = {};
    if (input.nameContains) {
      where.name = { contains: input.nameContains, mode: 'insensitive' };
    }
    if (input.employeeId) where.employeeId = input.employeeId;
    if (input.department) {
      where.department = { contains: input.department, mode: 'insensitive' };
    }
    if (input.jobTitle) {
      where.jobTitle = { contains: input.jobTitle, mode: 'insensitive' };
    }
    if (input.status) where.status = input.status;

    if (input.hiredAfter || input.hiredBefore) {
      where.employmentStartDate = {
        ...(input.hiredAfter ? { gte: new Date(input.hiredAfter) } : {}),
        ...(input.hiredBefore ? { lte: new Date(input.hiredBefore) } : {}),
      };
    }

    // Salary lives in two places: the EmployeeSalary record when one exists,
    // and Employee.baseSalary otherwise. Filter both so a range never silently
    // drops the employees who only have the fallback.
    if (input.salaryMin !== undefined || input.salaryMax !== undefined) {
      const range = {
        ...(input.salaryMin !== undefined ? { gte: input.salaryMin } : {}),
        ...(input.salaryMax !== undefined ? { lte: input.salaryMax } : {}),
      };
      where.OR = [
        { employeeSalary: { baseSalary: range } },
        { employeeSalary: null, baseSalary: range },
      ];
    }

    // Day counts have to be resolved before paging, or "the 50 most absent"
    // would really mean "the most absent of an arbitrary 50".
    let dayCounts: Map<
      string,
      { absentDays: number; leaveDays: number }
    > | null = null;

    if (wantsDayFilters) {
      const grouped = await this.prisma.dailyAttendanceLog.groupBy({
        by: ['employeeId', 'recordType'],
        where: {
          date: { gte: periodFrom, lte: periodTo },
          recordType: { in: ['ABSENCE', ...LEAVE_TYPES] },
        },
        _sum: { value: true },
      });

      dayCounts = new Map();
      for (const row of grouped) {
        const entry = dayCounts.get(row.employeeId) ?? {
          absentDays: 0,
          leaveDays: 0,
        };
        const days = Number(row._sum.value ?? 0);
        if (row.recordType === 'ABSENCE') entry.absentDays += days;
        else entry.leaveDays += days;
        dayCounts.set(row.employeeId, entry);
      }

      const matching = [...dayCounts.entries()]
        .filter(([, v]) => {
          if (
            input.absentDaysMin !== undefined &&
            v.absentDays < input.absentDaysMin
          )
            return false;
          if (
            input.absentDaysMax !== undefined &&
            v.absentDays > input.absentDaysMax
          )
            return false;
          if (
            input.leaveDaysMin !== undefined &&
            v.leaveDays < input.leaveDaysMin
          )
            return false;
          if (
            input.leaveDaysMax !== undefined &&
            v.leaveDays > input.leaveDaysMax
          )
            return false;
          return true;
        })
        .map(([employeeId]) => employeeId);

      // An employee with no log rows has zero of both, so a "max" filter must
      // keep them. Narrowing to `matching` would drop them, and skipping the
      // filter entirely would let violators through -- so exclude only the
      // employees whose counts actually break the limit.
      const hasMinimum =
        input.absentDaysMin !== undefined || input.leaveDaysMin !== undefined;

      if (hasMinimum) {
        where.employeeId = { in: matching };
      } else {
        const violating = [...dayCounts.keys()].filter(
          (id) => !matching.includes(id),
        );
        if (violating.length) where.employeeId = { notIn: violating };
      }
    }

    // The model answers "how many" from this, not from the row count -- a
    // capped page of 50 was being reported as the total.
    const total = await this.prisma.employee.count({ where });

    const employees = await this.prisma.employee.findMany({
      where,
      select: {
        employeeId: true,
        name: true,
        department: true,
        jobTitle: true,
        status: true,
        baseSalary: true,
        currency: true,
        employmentStartDate: true,
        employeeSalary: { select: { baseSalary: true } },
      },
      // Over-fetch only when a JS sort follows, so paging stays in SQL otherwise.
      take: wantsDayFilters ? MAX_ROW_LIMIT : limit,
      orderBy: this.employeeOrderBy(input),
    });

    const rows = employees.map((e) => {
      const counts = dayCounts?.get(e.employeeId);
      return {
        employeeId: e.employeeId,
        name: e.name,
        department: e.department,
        jobTitle: e.jobTitle,
        status: e.status,
        salary: Number(e.employeeSalary?.baseSalary ?? e.baseSalary ?? 0),
        currency: e.currency,
        hiredAt: e.employmentStartDate?.toISOString().slice(0, 10) ?? null,
        absentDays: dayCounts ? (counts?.absentDays ?? 0) : undefined,
        leaveDays: dayCounts ? (counts?.leaveDays ?? 0) : undefined,
      };
    });

    if (input.sortBy === 'absentDays' || input.sortBy === 'leaveDays') {
      const key = input.sortBy;
      const dir = input.sortDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => dir * ((a[key] ?? 0) - (b[key] ?? 0)));
    }

    const returned = Math.min(rows.length, limit);
    return {
      period: {
        from: periodFrom.toISOString().slice(0, 10),
        to: periodTo.toISOString().slice(0, 10),
        applied: wantsDayFilters,
      },
      /** Every employee matching the filters -- use this to answer "how many". */
      totalMatching: total,
      /** How many are listed below; fewer than totalMatching when capped. */
      rowCount: returned,
      truncated: total > returned,
      rows: rows.slice(0, limit),
    };
  }

  private employeeOrderBy(
    input: SearchEmployeesInput,
  ): Prisma.EmployeeOrderByWithRelationInput {
    const dir = input.sortDir ?? 'asc';
    switch (input.sortBy) {
      case 'employeeId':
        return { employeeId: dir };
      case 'salary':
        return { baseSalary: dir };
      case 'hiredAt':
        return { employmentStartDate: dir };
      case 'name':
        return { name: dir };
      default:
        return { name: 'asc' };
    }
  }

  private getEmployeeProfile(): AssistantTool {
    const input = z.object({
      employeeId: z
        .string()
        .min(1)
        .max(40)
        .describe('Exact staff number, e.g. EMP014.'),
    });

    return {
      name: 'get_employee_profile',
      description:
        'Full detail for one employee: contact, job, salary components, department and employment dates. Use search_employees first if you only have a name.',
      input,
      permissions: ['view_employees'],
      run: async (args) => {
        const { employeeId } = args as z.infer<typeof input>;
        const employee = await this.prisma.employee.findFirst({
          where: { employeeId },
          select: {
            employeeId: true,
            name: true,
            mobile: true,
            jobTitle: true,
            profession: true,
            department: true,
            status: true,
            gender: true,
            baseSalary: true,
            livingAllowance: true,
            currency: true,
            hourlyRate: true,
            dailyRate: true,
            workDaysInPeriod: true,
            hoursPerDay: true,
            scheduledStart: true,
            scheduledEnd: true,
            employmentStartDate: true,
            terminationDate: true,
            terminationType: true,
            employeeSalary: true,
          },
        });

        if (!employee) {
          return { error: `No employee with staff number "${employeeId}".` };
        }
        return {
          ...employee,
        };
      },
    };
  }

  private getAttendanceSummary(): AssistantTool {
    const input = z.object({
      employeeId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('Limit to one employee. Omit for a whole-factory summary.'),
      department: z.string().min(1).max(120).optional(),
      from: isoDate.describe('Start of the period.'),
      to: isoDate.describe('End of the period.'),
    });

    return {
      name: 'get_attendance_summary',
      description:
        'Totals per record type (absence, delay minutes, overtime minutes, and each kind of leave) over a period, for one employee, one department, or the whole factory. Use this for "how many days was X absent" rather than counting rows yourself.',
      input,
      permissions: ['view_attendance'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.DailyAttendanceLogWhereInput = {
          date: { gte: new Date(args.from), lte: new Date(args.to) },
        };
        if (args.employeeId) where.employeeId = args.employeeId;
        if (args.department) {
          where.employee = {
            department: { contains: args.department, mode: 'insensitive' },
          };
        }

        const grouped = await this.prisma.dailyAttendanceLog.groupBy({
          by: ['recordType'],
          where,
          _sum: { value: true },
          _count: { _all: true },
        });

        return {
          period: { from: args.from, to: args.to },
          scope: args.employeeId ?? args.department ?? 'all employees',
          totals: grouped.map((g) => ({
            recordType: g.recordType,
            total: Number(g._sum.value ?? 0),
            entries: g._count._all,
          })),
        };
      },
    };
  }

  private listLeaveRequests(): AssistantTool {
    const input = z.object({
      employeeId: z.string().min(1).max(40).optional(),
      status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
        .optional(),
      from: isoDate
        .optional()
        .describe('Only requests overlapping on or after this date.'),
      to: isoDate
        .optional()
        .describe('Only requests overlapping on or before this date.'),
      limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
    });

    return {
      name: 'list_leave_requests',
      description:
        'Individual leave requests with their type, status and dates. Use this when the user asks about specific requests or approvals; use search_employees or get_attendance_summary when they ask how many days someone took.',
      input,
      permissions: ['view_attendance'],
      run: async (raw) => {
        const args = raw as z.infer<typeof input>;
        const where: Prisma.LeaveRequestWhereInput = {};
        if (args.employeeId) where.employeeId = args.employeeId;
        if (args.status) {
          where.status = args.status as Prisma.LeaveRequestWhereInput['status'];
        }
        // Overlap, not containment: a request straddling the window edge still
        // falls inside the period the user asked about.
        if (args.to) where.startDate = { lte: new Date(args.to) };
        if (args.from) where.endDate = { gte: new Date(args.from) };

        const rows = await this.prisma.leaveRequest.findMany({
          where,
          take: args.limit ?? DEFAULT_ROW_LIMIT,
          orderBy: { startDate: 'desc' },
          select: {
            employeeId: true,
            leaveType: true,
            status: true,
            isPaid: true,
            isHourly: true,
            startDate: true,
            endDate: true,
            reason: true,
          },
        });

        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
            ...r,
            startDate: r.startDate.toISOString().slice(0, 10),
            endDate: r.endDate.toISOString().slice(0, 10),
          })),
        };
      },
    };
  }
}
