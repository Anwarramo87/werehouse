import { tenantKey } from '../common/tenant/tenant-key';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import {
  paginatedResponse,
  paginationMeta,
  resolvePagination,
} from '../common/utils/pagination.util';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesListQueryDto } from './dto/employees-list-query.dto';
import { ShortCacheService } from '../common/cache/short-cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { TerminateEmployeeBodyDto } from './dto/terminate-employee-body.dto';
import { RehireEmployeeDto } from './dto/rehire-employee.dto';
import { FinancialSettlementDto } from './dto/financial-settlement.dto';
import { ResignedEmployeesQueryDto } from './dto/resigned-employees-query.dto';
import { BulkTerminateDepartmentDto } from './dto/bulk-terminate-department.dto';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { BCRYPT_DEFAULT_ROUNDS } from '../common/constants/auth.constants';
import { assertCanAssignRole } from '../common/auth/role-assignment';
import {
  DEFAULT_DEPARTMENT,
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_WORK_DAYS_IN_PERIOD,
  MAX_BASE_SALARY,
  MAX_HOURLY_RATE,
} from './employees.constants';
import { buildEmployeeSalaryMirror, resolveSalary } from '../common/utils/salary-resolution.util';
import {
  deriveHoursPerDayFromSchedule,
  validateScheduleTimes,
} from '../common/utils/work-hours.util';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PROFILE_RANGE_DAYS = 30;
const DEFAULT_PROFILE_LIMIT = 200;

const EMPLOYEE_DELETION_ENTITY = 'employee';

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
    private readonly notifications: NotificationsService,
  ) {}

  private async invalidateEmployeeCaches() {
    await Promise.all([
      this.shortCache.invalidatePrefix('employees:stats'),
      this.shortCache.invalidatePrefix('dashboard:home-stats:'),
    ]);
  }


  private normalizeOptionalString(value?: string | null) {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeDepartmentName(value?: string | null) {
    return this.normalizeOptionalString(value) ?? DEFAULT_DEPARTMENT;
  }

  private parseOptionalDate(value: string | null | undefined, fieldName: string) {
    if (value === null || value === undefined) return null;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${fieldName} must be a valid ISO date`);
    }

    // Prevent dates in the far future (> 100 years from now)
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 100);
    if (parsed > maxDate) {
      throw new BadRequestException(`${fieldName} cannot be more than 100 years in the future`);
    }

    return parsed;
  }

  private async resolveDepartment(departmentName: string, tx?: Pick<typeof this.prisma, "department">) {
    const normalizedName = this.normalizeDepartmentName(departmentName);
    const client = tx ?? this.prisma;

    const existing = await client.department.findFirst({
      where: { name: { equals: normalizedName, mode: "insensitive" } },
    });

    if (existing) {
      return existing;
    }

    return client.department.create({
      data: { name: normalizedName },
    });
  }

  /**
   * Turns a client-supplied roleId into a real Role uuid.
   *
   * Callers may legitimately send a role *name* ("admin") instead of an id --
   * the roles dropdown falls back to a free-text field whenever GET /auth/roles
   * is not permitted for the current user. Passing that straight to Prisma made
   * Postgres fail the uuid cast and surfaced as a 500, so resolve by id first,
   * then by name, and reject anything unknown with a 400.
   */
  private async resolveRoleId(
    roleId: string | null | undefined,
    tx?: Pick<typeof this.prisma, 'role'>,
  ): Promise<string | null | undefined> {
    if (roleId === undefined) {
      return undefined;
    }

    const trimmed = typeof roleId === 'string' ? roleId.trim() : '';
    if (!trimmed) {
      return null;
    }

    const client = tx ?? this.prisma;

    if (UUID_PATTERN.test(trimmed)) {
      const byId = await client.role.findUnique({ where: { id: trimmed } });
      if (!byId) {
        throw new BadRequestException('Role not found');
      }
      return byId.id;
    }

    const byName = await client.role.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' } },
    });

    if (!byName) {
      throw new BadRequestException(`Role not found: ${trimmed}`);
    }

    return byName.id;
  }

  private validateEmploymentDates(
    employmentStartDate: Date | null | undefined,
    terminationDate: Date | null | undefined,
  ) {
    if (employmentStartDate && terminationDate && employmentStartDate > terminationDate) {
      throw new BadRequestException('employmentStartDate cannot be later than terminationDate');
    }
  }

  private resolveProfileRange(startDate?: string, endDate?: string) {
    if (startDate && endDate) {
      if (startDate > endDate) {
        throw new BadRequestException('startDate must be less than or equal to endDate');
      }

      return { startDate, endDate };
    }

    if (startDate || endDate) {
      throw new BadRequestException('startDate and endDate must be provided together');
    }

    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - DEFAULT_PROFILE_RANGE_DAYS);

    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }

  private hasPermission(user: AuthenticatedUser | undefined, permission: string) {
    if (!user) return false;
    if (user.role === 'admin' || user.roles?.includes('admin')) {
      return true;
    }

    return user.permissions?.includes(permission) ?? false;
  }

  private normalizeLoginName(value: string) {
    return value.trim().toLowerCase();
  }

  private employeeSelect() {
    return {
      // Only select relations that do not touch Department.manager in the current DB.
      // Department.manager may be missing depending on migration state.
      departmentEntity: {
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      role: true,
    } as const;
  }

  /**
   * The projection for list-shaped rows, used by every endpoint that returns
   * many employees (list, byDepartment, resigned). `photo` is deliberately
   * absent: a single avatar is ~41 KB of base64, and N of them cost N × 41 KB
   * per page for avatars the browser then has to re-download. Callers get
   * `photoUrl` instead (added by withPhotoUrls) and fetch the one avatar they
   * actually render.
   */
  private employeeListSelect() {
    return {
      id: true,
      employeeId: true,
      name: true,
      mobile: true,
      nationalId: true,
      residence: true,
      dateOfBirth: true,
      gender: true,
      department: true,
      jobTitle: true,
      profession: true,
      status: true,
      biometricNumber: true,
      scheduledStart: true,
      scheduledEnd: true,
      gracePeriodMinutes: true,
      workDaysInPeriod: true,
      hoursPerDay: true,
      // Pay fields are selected here and stripped below for callers without
      // `manage_salary`. Selecting them conditionally would fork the Prisma
      // types for no benefit -- the row is already being read, and nothing
      // leaves this method unfiltered.
      hourlyRate: true,
      baseSalary: true,
      livingAllowance: true,
      transportAllowanceOverride: true,
      insuranceAmount: true,
      currency: true,
      employmentStartDate: true,
      terminationDate: true,
      terminationType: true,
      terminationReason: true,
      terminationNotes: true,
      financialSettlementStatus: true,
      isSettled: true,
      createdAt: true,
      updatedAt: true,
      roleId: true,
      departmentId: true,
      departmentEntity: true,
      role: true,
    } as const;
  }

  /** Fetches a page of list-shaped rows, then salary-strips and photoUrl-annotates them. */
  private async fetchListRows(
    where: Prisma.EmployeeWhereInput,
    orderBy: Prisma.EmployeeOrderByWithRelationInput,
    skip: number,
    take: number,
    user?: AuthenticatedUser,
  ) {
    const employees = await this.prisma.employee.findMany({
      where,
      orderBy,
      skip,
      take,
      select: this.employeeListSelect(),
    });

    return this.withPhotoUrls(this.stripSalaryFields(employees, user));
  }

  private async findAuthUserByLogin(loginName: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ username: loginName }, { email: loginName }],
      },
    });
  }

  private applyEmployeeStatusFilter(where: Prisma.EmployeeWhereInput, queryStatus?: string | null) {
    // Policy:
    // - default: exclude terminated/resigned only
    // - allow overriding with queryStatus
    const excluded = ['terminated', 'resigned'];

    if (queryStatus) {
      where.status = queryStatus;
      return;
    }

    where.status = { notIn: excluded };
  }

  /** Pay fields. Returned only to a caller holding `manage_salary`. */
  private static readonly SALARY_FIELDS = [
    'baseSalary',
    'hourlyRate',
    'livingAllowance',
    'transportAllowanceOverride',
    'insuranceAmount',
  ] as const;

  async list(query: EmployeesListQueryDto, user?: AuthenticatedUser) {
    const { page, limit, skip } = resolvePagination(query);
    const where: Prisma.EmployeeWhereInput = {};

    if (query.department) where.department = query.department;
    this.applyEmployeeStatusFilter(where, query.status ?? undefined);

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { employeeId: { contains: query.search, mode: 'insensitive' } },
        { mobile: { contains: query.search, mode: 'insensitive' } },
        { nationalId: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [employees, total] = await Promise.all([
      this.fetchListRows(where, { createdAt: 'desc' }, skip, limit, user),
      this.prisma.employee.count({ where }),
    ]);

    const visible = await this.withPhotoUrls(
      this.stripSalaryFields(employees, user),
    );

    return paginatedResponse(visible, page, limit, total);
  }

  /**
   * Removes pay from rows the caller is not entitled to see.
   *
   * Deleting the keys rather than blanking them keeps the shape honest: a
   * consumer can tell "not permitted" from "genuinely zero", which matters when
   * an unpaid intern and a hidden salary would otherwise both read as 0.
   */
  private stripSalaryFields<T extends Record<string, unknown>>(
    rows: T[],
    user?: AuthenticatedUser,
  ): T[] {
    if (this.hasPermission(user, 'manage_salary')) {
      return rows;
    }

    return rows.map((row) => {
      const copy = { ...row };
      for (const field of EmployeesService.SALARY_FIELDS) {
        delete copy[field];
      }
      return copy;
    });
  }

  /**
   * Adds a `photoUrl` to the rows that actually have a photo.
   *
   * One extra indexed query returning nothing but ids, which is far cheaper
   * than carrying the base64 payloads: it lets the browser fetch each avatar
   * once and cache it across every page that shows the same person, instead of
   * re-downloading all of them inside every list response.
   */
  private async withPhotoUrls<T extends { employeeId: string }>(rows: T[]) {
    if (rows.length === 0) return rows as Array<T & { photoUrl: string | null }>;

    const withPhoto = await this.prisma.employee.findMany({
      where: {
        employeeId: { in: rows.map((row) => row.employeeId) },
        photo: { not: null },
      },
      select: { employeeId: true },
    });

    const hasPhoto = new Set(withPhoto.map((row) => row.employeeId));

    return rows.map((row) => ({
      ...row,
      photoUrl: hasPhoto.has(row.employeeId)
        ? `/employees/${encodeURIComponent(row.employeeId)}/photo`
        : null,
    }));
  }

  /**
   * One employee's photo, as the stored data URL.
   *
   * Separate from the list so the payload is fetched only when it is going to
   * be displayed, and can be cached per employee.
   */
  async getPhoto(employeeId: string): Promise<string | null> {
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId },
      select: { photo: true },
    });

    if (!employee) throw new NotFoundException('Employee not found');
    return employee.photo ?? null;
  }

  async stats() {
    // Stats is a pure aggregation; keep all statuses visible.
    return this.shortCache.getOrSetJson('employees:stats', 30, async () => {
      const [total, active, inactive, terminated, resigned, groupedByDepartment] =
        await Promise.all([
          this.prisma.employee.count(),
          this.prisma.employee.count({ where: { status: 'active' } }),
          this.prisma.employee.count({ where: { status: 'inactive' } }),
          this.prisma.employee.count({ where: { status: 'terminated' } }),
          this.prisma.employee.count({ where: { status: 'resigned' } }),
          this.prisma.employee.groupBy({
            by: ['department'],
            _count: { _all: true },
          }),
        ]);

      const byDepartment = groupedByDepartment.reduce<Record<string, number>>(
        (accumulator, entry) => {
          const key = entry.department || 'Unassigned';
          accumulator[key] = entry._count._all;
          return accumulator;
        },
        {},
      );

      return {
        total,
        active,
        inactive,
        terminated,
        resigned,
        byDepartment,
      };
    });
  }

  async byDepartment(department: string, query: Record<string, any> = {}, user?: AuthenticatedUser) {
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(200, Math.max(1, query?.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeWhereInput = { department };
    this.applyEmployeeStatusFilter(where, query?.status ?? undefined);

    const [employees, total] = await Promise.all([
      this.fetchListRows(where, { createdAt: 'desc' }, skip, limit, user),
      this.prisma.employee.count({ where }),
    ]);

    return {
      data: employees,
      ...paginationMeta(page, limit, total),
      department,
    };
  }

  async create(dto: CreateEmployeeDto, actor?: AuthenticatedUser) {
    const loginName = this.normalizeLoginName(dto.username || dto.employeeId);
    const mobile = this.normalizeOptionalString(dto.mobile);
    const residence = this.normalizeOptionalString(dto.residence);
    const nationalId = this.normalizeOptionalString(dto.nationalId);
    const biometricNumber = dto.biometricNumber ?? null;
    const birthDate = this.parseOptionalDate(dto.birthDate ?? dto.dateOfBirth, 'birthDate');
    const employmentStartDate = this.parseOptionalDate(
      dto.employmentStartDate,
      'employmentStartDate',
    );
    const terminationDate = this.parseOptionalDate(dto.terminationDate, 'terminationDate');
    const departmentName = this.normalizeDepartmentName(dto.department);
    const profession = this.normalizeOptionalString(dto.profession ?? dto.jobTitle);
    const baseSalary = dto.baseSalary ?? null;
    const transportAllowanceOverride =
      dto.transportAllowance !== null && dto.transportAllowance !== undefined
        ? new Prisma.Decimal(dto.transportAllowance)
        : null;
    const insuranceAmount =
      dto.insuranceAmount !== null && dto.insuranceAmount !== undefined
        ? new Prisma.Decimal(dto.insuranceAmount)
        : null;
    const resolvedWorkDaysInPeriod = dto.workDaysInPeriod ?? DEFAULT_WORK_DAYS_IN_PERIOD;

    // hoursPerDay is ALWAYS derived from the schedule (scheduledStart/scheduledEnd).
    // Any client-supplied hoursPerDay is ignored and overwritten so the two can
    // never diverge. When no schedule is provided we fall back to the default.
    const scheduleError = validateScheduleTimes(dto.scheduledStart, dto.scheduledEnd);
    if (scheduleError) {
      throw new BadRequestException(scheduleError);
    }
    const resolvedHoursPerDay =
      deriveHoursPerDayFromSchedule(dto.scheduledStart, dto.scheduledEnd) ??
      (dto.hoursPerDay ?? DEFAULT_HOURS_PER_DAY);

    const resolvedHourlyRate =
      dto.hourlyRate ??
      (baseSalary !== null && baseSalary !== undefined
        ? Number((baseSalary / (resolvedWorkDaysInPeriod * resolvedHoursPerDay)).toFixed(2))
        : null);

    if (resolvedHourlyRate === null || resolvedHourlyRate === undefined) {
      throw new BadRequestException('baseSalary is required when hourlyRate is not provided');
    }

    if (baseSalary !== null && baseSalary !== undefined && baseSalary > MAX_BASE_SALARY) {
      throw new BadRequestException('baseSalary is too large');
    }

    if (resolvedHourlyRate > MAX_HOURLY_RATE) {
      throw new BadRequestException('baseSalary is too large for hourlyRate');
    }

    if (terminationDate) {
      throw new BadRequestException(
        'terminationDate cannot be set during creation. Use update/remove when terminating an employee',
      );
    }

    this.validateEmploymentDates(employmentStartDate, terminationDate);

    const [existingEmployee, existingUser] = await Promise.all([
      this.prisma.employee.findFirst({
        where: {
          OR: [
            { employeeId: dto.employeeId },
            ...(nationalId ? [{ nationalId }] : []),
            ...(biometricNumber !== null ? [{ biometricNumber }] : []),
          ],
        },
      }),
      this.findAuthUserByLogin(loginName),
    ]);

    if (existingEmployee) {
      if (existingEmployee.employeeId === dto.employeeId) {
        throw new BadRequestException('Employee ID already exists');
      }

      if (nationalId && existingEmployee.nationalId === nationalId) {
        throw new BadRequestException('Employee national ID already exists');
      }

      if (biometricNumber !== null && existingEmployee.biometricNumber === biometricNumber) {
        throw new BadRequestException('Employee biometric number already exists');
      }
    }

    if (existingUser) {
      throw new BadRequestException('Username already exists');
    }

    const passwordToHash = dto.password || dto.employeeId;
    const passwordHash = await bcrypt.hash(passwordToHash, BCRYPT_DEFAULT_ROUNDS);

    const created = await this.prisma.$transaction(async (transaction) => {
      const department = await this.resolveDepartment(departmentName, transaction);
      const roleId = (await this.resolveRoleId(dto.roleId, transaction)) ?? null;
      // Privilege guard: a factory admin may not mint admins/superadmins
      // through employee creation. Checked on the resolved id, not raw input.
      if (roleId) {
        const targetRole = await transaction.role.findUnique({
          where: { id: roleId },
          select: { name: true },
        });
        assertCanAssignRole(targetRole?.name ?? null, actor);
      }

      const user = await transaction.user.create({
        data: {
          username: loginName,
          email: loginName,
          passwordHash,
          roleId,
          status: 'active',
          photo: dto.photo,
        },
      });

      const employee = await transaction.employee.create({
        data: {
          employeeId: dto.employeeId,
          biometricNumber,
          name: dto.name,
          mobile,
          residence,
          nationalId,
          dateOfBirth: birthDate,
          gender: dto.gender ?? null,
          jobTitle: profession,
          profession,
          photo: dto.photo,
          hourlyRate: new Prisma.Decimal(resolvedHourlyRate),
          baseSalary:
            baseSalary !== null && baseSalary !== undefined ? new Prisma.Decimal(baseSalary) : null,
          livingAllowance:
            dto.livingAllowance !== null && dto.livingAllowance !== undefined
              ? new Prisma.Decimal(dto.livingAllowance)
              : null,
          transportAllowanceOverride,
          insuranceAmount,
          roleId,
          department: department.name,
          departmentId: department.id,
          scheduledStart: dto.scheduledStart || null,
          scheduledEnd: dto.scheduledEnd || null,
          employmentStartDate,
          terminationDate: null,
          status: 'active',
          workDaysInPeriod: dto.workDaysInPeriod ?? DEFAULT_WORK_DAYS_IN_PERIOD,
          hoursPerDay: resolvedHoursPerDay,
          gracePeriodMinutes: dto.gracePeriodMinutes ?? 5,
        },
        include: this.employeeSelect(),
      });

      await transaction.employeeSalary.create({
        data: {
          employeeId: dto.employeeId,
          profession,
          baseSalary:
            baseSalary !== null && baseSalary !== undefined
              ? new Prisma.Decimal(baseSalary)
              : new Prisma.Decimal(0),
          lumpSumSalary: new Prisma.Decimal(dto.lumpSumSalary ?? 0),
          livingAllowance:
            dto.livingAllowance !== null && dto.livingAllowance !== undefined
              ? new Prisma.Decimal(dto.livingAllowance)
              : new Prisma.Decimal(0),
          transportAllowance:
            transportAllowanceOverride ?? new Prisma.Decimal(0),
          insuranceAmount:
            insuranceAmount ?? new Prisma.Decimal(0),
        },
      });

      return { user, employee };
    });

    await this.invalidateEmployeeCaches();

    return { message: 'Employee created successfully', employee: created.employee };
  }

  /**
   * One employee's record.
   *
   * Salary fields leave this method only for callers holding `manage_salary`.
   * `asSelf` is the one carve-out: a person reading their OWN record (identity
   * resolved from the token, never from a URL — see EmployeeSelfController)
   * needs no permission, because the data is already theirs.
   */
  async getByEmployeeId(
    employeeId: string,
    user?: AuthenticatedUser,
    options?: { asSelf?: boolean },
  ) {
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId },
      include: this.employeeSelect(),
    });

    if (!employee) throw new NotFoundException('Employee not found');

    const canViewSalary = options?.asSelf === true || this.hasPermission(user, 'manage_salary');
    return canViewSalary
      ? employee
      : EmployeesService.stripSalaryRow(employee);
  }

  private static stripSalaryRow<T extends Record<string, unknown>>(row: T): T {
    const copy: Record<string, unknown> = { ...row };
    for (const field of EmployeesService.SALARY_FIELDS) {
      delete copy[field];
    }
    return copy as T;
  }

  async update(employeeId: string, dto: UpdateEmployeeDto, actor?: AuthenticatedUser) {
    const [employee, existingSalary] = await Promise.all([
      this.prisma.employee.findFirst({
        where: { employeeId },
      }),
      this.prisma.employeeSalary.findFirst({ where: { employeeId } }),
    ]);

    if (!employee) throw new NotFoundException('Employee not found');

    const nationalId =
      dto.nationalId !== undefined ? this.normalizeOptionalString(dto.nationalId) : undefined;
    const employmentStartDate =
      dto.employmentStartDate !== undefined
        ? this.parseOptionalDate(dto.employmentStartDate, 'employmentStartDate')
        : undefined;
    const terminationDate =
      dto.terminationDate !== undefined
        ? this.parseOptionalDate(dto.terminationDate, 'terminationDate')
        : undefined;
    const birthDateInput = dto.birthDate ?? dto.dateOfBirth;
    const birthDate =
      birthDateInput !== undefined
        ? this.parseOptionalDate(birthDateInput, 'birthDate')
        : undefined;
    const departmentName =
      dto.department !== undefined ? this.normalizeDepartmentName(dto.department) : undefined;
    const profession =
      dto.profession !== undefined || dto.jobTitle !== undefined
        ? this.normalizeOptionalString(dto.profession ?? dto.jobTitle)
        : undefined;
    const mobile = dto.mobile !== undefined ? this.normalizeOptionalString(dto.mobile) : undefined;

    // hoursPerDay is ALWAYS derived from the schedule (scheduledStart/scheduledEnd).
    // Any client-supplied hoursPerDay is ignored and overwritten. Derivation runs
    // only when the schedule itself is being edited — unrelated updates to legacy
    // records are never rejected for schedule reasons.
    const isScheduleBeingUpdated =
      dto.scheduledStart !== undefined || dto.scheduledEnd !== undefined;
    let effectiveHoursPerDay: number | undefined;
    if (isScheduleBeingUpdated) {
      const effectiveScheduledStart = dto.scheduledStart ?? employee.scheduledStart ?? null;
      const effectiveScheduledEnd = dto.scheduledEnd ?? employee.scheduledEnd ?? null;
      const scheduleError = validateScheduleTimes(
        effectiveScheduledStart,
        effectiveScheduledEnd,
      );
      if (scheduleError) {
        throw new BadRequestException(scheduleError);
      }
      effectiveHoursPerDay =
        deriveHoursPerDayFromSchedule(effectiveScheduledStart, effectiveScheduledEnd) ??
        employee.hoursPerDay ??
        DEFAULT_HOURS_PER_DAY;
    }

    const nextEmploymentStartDate =
      employmentStartDate === undefined ? employee.employmentStartDate : employmentStartDate;
    const nextTerminationDate =
      terminationDate === undefined ? employee.terminationDate : terminationDate;

    this.validateEmploymentDates(nextEmploymentStartDate, nextTerminationDate);

    if (nationalId !== undefined) {
      const conflict = await this.prisma.employee.findFirst({
        where: {
          AND: [{ employeeId: { not: employeeId } }, { nationalId }],
        },
      });

      if (conflict) {
        throw new BadRequestException('Employee national ID already exists');
      }
    }

    if (dto.biometricNumber !== undefined) {
      const conflict = await this.prisma.employee.findFirst({
        where: {
          AND: [{ employeeId: { not: employeeId } }, { biometricNumber: dto.biometricNumber }],
        },
      });

      if (conflict) {
        throw new BadRequestException('Employee biometric number already exists');
      }
    }

    const loginName =
      dto.username !== undefined ? this.normalizeLoginName(dto.username) : undefined;
    const passwordHash =
      dto.password !== undefined
        ? await bcrypt.hash(dto.password, BCRYPT_DEFAULT_ROUNDS)
        : undefined;

    if (loginName !== undefined) {
      const userConflict = await this.findAuthUserByLogin(loginName);

      if (userConflict && userConflict.username.toLowerCase() !== loginName.toLowerCase()) {
        throw new BadRequestException('Username already exists');
      }
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const resolvedRoleId = await this.resolveRoleId(dto.roleId, transaction);
      // Same privilege guard on role changes via employee update.
      if (dto.roleId !== undefined && resolvedRoleId) {
        const targetRole = await transaction.role.findUnique({
          where: { id: resolvedRoleId },
          select: { name: true },
        });
        assertCanAssignRole(targetRole?.name ?? null, actor);
      }

      if (
        loginName !== undefined ||
        passwordHash !== undefined ||
        dto.roleId !== undefined ||
        dto.photo !== undefined
      ) {
        const existingUser = await transaction.user.findFirst({
          where: {
            id: employee.userId || undefined,
          },
        });

        if (existingUser) {
          await transaction.user.update({
            where: { id: existingUser.id },
            data: {
              ...(loginName !== undefined && { username: loginName, email: loginName }),
              ...(passwordHash !== undefined && { passwordHash }),
              ...(resolvedRoleId !== undefined && { roleId: resolvedRoleId }),
              ...(dto.photo !== undefined && { photo: dto.photo }),
            },
          });
        }
      }

      const payload: Prisma.EmployeeUncheckedUpdateInput = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.biometricNumber !== undefined && { biometricNumber: dto.biometricNumber }),
        ...(mobile !== undefined && { mobile }),
        ...(dto.residence !== undefined && {
          residence: this.normalizeOptionalString(dto.residence),
        }),
        ...(nationalId !== undefined && { nationalId }),
        ...(birthDate !== undefined && { dateOfBirth: birthDate }),
        ...(dto.hourlyRate !== undefined && {
          hourlyRate: new Prisma.Decimal(dto.hourlyRate),
        }),
        ...(dto.baseSalary !== undefined && {
          baseSalary: dto.baseSalary === null ? null : new Prisma.Decimal(dto.baseSalary),
        }),
        ...(dto.livingAllowance !== undefined && {
          livingAllowance:
            dto.livingAllowance === null ? null : new Prisma.Decimal(dto.livingAllowance),
        }),
        ...(dto.transportAllowance !== undefined && {
          transportAllowanceOverride:
            dto.transportAllowance === null ? null : new Prisma.Decimal(dto.transportAllowance),
        }),
        ...(dto.insuranceAmount !== undefined && {
          insuranceAmount:
            dto.insuranceAmount === null ? null : new Prisma.Decimal(dto.insuranceAmount),
        }),
        ...(profession !== undefined && { jobTitle: profession, profession }),
        ...(resolvedRoleId !== undefined && { roleId: resolvedRoleId }),
        ...(dto.photo !== undefined && { photo: dto.photo }),
        ...(departmentName !== undefined && { department: departmentName }),
        ...(dto.scheduledStart !== undefined && { scheduledStart: dto.scheduledStart }),
        ...(dto.scheduledEnd !== undefined && { scheduledEnd: dto.scheduledEnd }),
        ...(employmentStartDate !== undefined && { employmentStartDate }),
        ...(terminationDate !== undefined && { terminationDate }),
        ...(dto.workDaysInPeriod !== undefined && { workDaysInPeriod: dto.workDaysInPeriod }),
        ...(effectiveHoursPerDay !== undefined && { hoursPerDay: effectiveHoursPerDay }),
        ...(dto.gracePeriodMinutes !== undefined && {
          gracePeriodMinutes: dto.gracePeriodMinutes,
        }),
      };

      if (departmentName !== undefined) {
        const department = await this.resolveDepartment(departmentName, transaction);
        payload.department = department.name;
        payload.departmentId = department.id;
      }

      const updatedEmployee = await transaction.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId }),
        data: payload,
        include: this.employeeSelect(),
      });

      const salaryPayload: Prisma.EmployeeSalaryUpsertArgs['create'] = {
        employeeId,
        profession: profession ?? employee.profession,
        baseSalary:
          dto.baseSalary !== undefined
            ? dto.baseSalary === null
              ? new Prisma.Decimal(0)
              : new Prisma.Decimal(dto.baseSalary)
            : (existingSalary?.baseSalary ?? employee.baseSalary ?? new Prisma.Decimal(0)),
        livingAllowance:
          dto.livingAllowance !== undefined
            ? dto.livingAllowance === null
              ? new Prisma.Decimal(0)
              : new Prisma.Decimal(dto.livingAllowance)
            : (existingSalary?.livingAllowance ??
              employee.livingAllowance ??
              new Prisma.Decimal(0)),
        transportAllowance:
          dto.transportAllowance !== undefined
            ? dto.transportAllowance === null
              ? new Prisma.Decimal(0)
              : new Prisma.Decimal(dto.transportAllowance)
            : (existingSalary?.transportAllowance ??
              employee.transportAllowanceOverride ??
              new Prisma.Decimal(0)),
        insuranceAmount:
          dto.insuranceAmount !== undefined
            ? dto.insuranceAmount === null
              ? new Prisma.Decimal(0)
              : new Prisma.Decimal(dto.insuranceAmount)
            : (existingSalary?.insuranceAmount ??
              employee.insuranceAmount ??
              new Prisma.Decimal(0)),
        lumpSumSalary:
          dto.lumpSumSalary !== undefined
            ? new Prisma.Decimal(dto.lumpSumSalary ?? 0)
            : (existingSalary?.lumpSumSalary ?? new Prisma.Decimal(0)),
      };

      const salaryRecord = await transaction.employeeSalary.upsert({
        where: tenantKey<Prisma.EmployeeSalaryWhereUniqueInput>({ employeeId }),
        update: salaryPayload,
        create: salaryPayload,
      });

      if (salaryRecord) {
        const mirror = buildEmployeeSalaryMirror(resolveSalary(updatedEmployee, salaryRecord));
        await transaction.employee.update({
          where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId }),
          data: mirror,
        });
      }

      return transaction.employee.findFirst({
        where: { employeeId },
        include: this.employeeSelect(),
      });
    }, { timeout: 15000, maxWait: 10000 });

    await this.invalidateEmployeeCaches();

    return { message: 'Employee updated successfully', employee: updated };
  }

  /**
   * One employee's full profile.
   *
   * `asSelf` is what makes per-employee accounts possible. An administrator
   * needs `manage_salary` to see someone else's pay; a person looking at their
   * OWN record needs no permission at all, because the data is already theirs.
   * Without this distinction the only way to let staff see their own payslip was
   * to grant them `manage_salary`, which would have shown them everyone's.
   *
   * Callers must never pass `asSelf` on an employeeId taken from a URL — see
   * EmployeeSelfController, which takes it from the verified token instead.
   */
  async getProfile(
    employeeId: string,
    query: EmployeeProfileQueryDto,
    user?: AuthenticatedUser,
    options?: { asSelf?: boolean },
  ) {
    const employee = await this.getByEmployeeId(employeeId, user, options);

    const asSelf = options?.asSelf === true;
    const canViewSalary = asSelf || this.hasPermission(user, 'manage_salary');
    const canViewAttendance = asSelf || this.hasPermission(user, 'view_attendance');
    const canViewAdvances = asSelf || this.hasPermission(user, 'manage_advances');
    const canViewBonuses = asSelf || this.hasPermission(user, 'manage_bonuses');

    const attendanceRange = this.resolveProfileRange(query.startDate, query.endDate);
    const attendanceLimit = query.attendanceLimit ?? DEFAULT_PROFILE_LIMIT;
    const advancesLimit = query.advancesLimit ?? DEFAULT_PROFILE_LIMIT;
    const bonusesLimit = query.bonusesLimit ?? DEFAULT_PROFILE_LIMIT;

    const attendanceWhere: Prisma.AttendanceRecordWhereInput = {
      employeeId,
      date: {
        gte: attendanceRange.startDate,
        lte: attendanceRange.endDate,
      },
    };

    const bonusesWhere: Prisma.EmployeeBonusWhereInput = {
      employeeId,
      ...(query.period ? { period: query.period } : {}),
    };

    const salaryPromise = canViewSalary
      ? this.prisma.employeeSalary.findFirst({ where: { employeeId } })
      : Promise.resolve(null);

    const attendancePromise = canViewAttendance
      ? Promise.all([
          this.prisma.attendanceRecord.findMany({
            where: attendanceWhere,
            orderBy: [{ date: 'asc' }, { timestamp: 'asc' }],
            take: attendanceLimit,
          }),
          this.prisma.attendanceRecord.count({ where: attendanceWhere }),
          this.prisma.attendanceRecord.groupBy({ by: ['date'], where: attendanceWhere }),
        ]).then(([records, totalRecords, groupedDays]) => ({
          period: attendanceRange,
          statistics: {
            totalDays: groupedDays.length,
            totalRecords,
          },
          records,
        }))
      : Promise.resolve(null);

    const advancesPromise = canViewAdvances
      ? Promise.all([
          this.prisma.employeeAdvance.findMany({
            where: { employeeId },
            orderBy: { issueDate: 'desc' },
            take: advancesLimit,
          }),
          this.prisma.employeeAdvance.count({ where: { employeeId } }),
          this.prisma.employeeAdvance.aggregate({
            where: { employeeId },
            _sum: {
              totalAmount: true,
              remainingAmount: true,
            },
          }),
        ]).then(([advances, totalAdvances, aggregate]) => ({
          summary: {
            totalAdvances,
            totalAmount: Number(aggregate._sum.totalAmount || 0),
            remainingAmount: Number(aggregate._sum.remainingAmount || 0),
          },
          advances,
        }))
      : Promise.resolve(null);

    const bonusesPromise = canViewBonuses
      ? Promise.all([
          this.prisma.employeeBonus.findMany({
            where: bonusesWhere,
            orderBy: { createdAt: 'desc' },
            take: bonusesLimit,
          }),
          this.prisma.employeeBonus.count({ where: bonusesWhere }),
          this.prisma.employeeBonus.aggregate({
            where: bonusesWhere,
            _sum: {
              bonusAmount: true,
              assistanceAmount: true,
            },
          }),
        ]).then(([bonuses, totalRecords, aggregate]) => ({
          period: query.period || null,
          summary: {
            totalRecords,
            totalBonus: Number(aggregate._sum.bonusAmount || 0),
            totalAssistance: Number(aggregate._sum.assistanceAmount || 0),
          },
          bonuses,
        }))
      : Promise.resolve(null);

    const [salary, attendance, advances, bonuses] = await Promise.all([
      salaryPromise,
      attendancePromise,
      advancesPromise,
      bonusesPromise,
    ]);

    return {
      employee,
      access: {
        salary: canViewSalary,
        attendance: canViewAttendance,
        advances: canViewAdvances,
        bonuses: canViewBonuses,
      },
      filters: {
        attendance: attendanceRange,
        bonuses: {
          period: query.period || null,
        },
        limits: {
          attendance: attendanceLimit,
          advances: advancesLimit,
          bonuses: bonusesLimit,
        },
      },
      salary,
      attendance,
      advances,
      bonuses,
    };
  }

  async terminate(employeeId: string, dto: TerminateEmployeeDto) {
    return this._applySimpleTermination(
      employeeId,
      dto,
      'terminated',
      'termination',
      'Employee terminated successfully',
    );
  }

  async resign(employeeId: string, dto: TerminateEmployeeDto) {
    return this._applySimpleTermination(
      employeeId,
      dto,
      'resigned',
      'resignation',
      'Employee resigned successfully',
    );
  }

  /**
   * Shared helper for terminate() and resign() — both differ only in status/type/message.
   */
  private async _applySimpleTermination(
    employeeId: string,
    dto: TerminateEmployeeDto,
    status: string,
    terminationType: string,
    successMessage: string,
  ) {
    const employee = await this.prisma.employee.findFirst({ where: { employeeId } });

    if (!employee) throw new NotFoundException('Employee not found');

    // Check if employee is a manager of any department
    const managedDepartment = await this.prisma.department.findFirst({
      where: { manager: employeeId },
    });

    if (managedDepartment) {
      throw new BadRequestException(
        `لا يمكن إنهاء خدمة الموظف لأنهم المشرف على قسم "${managedDepartment.name}". يرجى تغيير المشرف للقسم قبل إنهاء الخدمة.`,
      );
    }

    const terminationDate =
      this.parseOptionalDate(dto.terminationDate, 'terminationDate') || new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedEmployee = await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId }),
        data: {
          status,
          terminationDate,
          terminationType,
          terminationReason: dto.terminationReason || null,
          terminationNotes: null,
          financialSettlementStatus: 'pending',
          isSettled: false,
          isFinanciallySettled: false,
        },
        include: this.employeeSelect(),
      });

      // إزالة الموظف من أي باص وحذف خصم المواصلات الخاص به
      try {
        const busPassenger = await tx.busPassenger.findFirst({
          where: { employeeId, status: 'active' },
          include: { bus: { select: { plateNumber: true } } },
        });
        if (busPassenger) {
          await tx.busPassenger.delete({ where: { id: busPassenger.id } });
          await tx.employeeBonus.deleteMany({
            where: {
              employeeId,
              // `bus` is typed optional only because the composite key
              // (tenantId, busId) carries a nullable tenantId; busId is NOT NULL.
              bonusReason: { contains: busPassenger.bus!.plateNumber },
            },
          });
        }
      } catch {
        // bus_passengers table may not exist yet — safe to skip
      }

      return updatedEmployee;
    });

    await this.invalidateEmployeeCaches();

    const isResignation = terminationType === 'resignation';
    void this.notifications.create({
      type: isResignation ? 'RESIGNATION' : 'TERMINATION',
      severity: 'WARNING',
      title: isResignation ? 'استقالة موظف' : 'إنهاء خدمة موظف',
      message: `تم ${isResignation ? 'قبول استقالة' : 'إنهاء خدمة'} الموظف ${employee.name} (${employeeId}).${dto.terminationReason ? ` السبب: ${dto.terminationReason}` : ''}`,
      employeeId,
      employeeName: employee.name,
      entityType: 'employee',
      metadata: { terminationType, terminationReason: dto.terminationReason },
    });

    return { message: successMessage, employee: updated };
  }

  async terminateEmployee(dto: TerminateEmployeeBodyDto, user: AuthenticatedUser) {
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (employee.status !== 'active') {
      throw new BadRequestException('Employee is not active');
    }

    // Check if employee is a manager of any department
    const managedDepartment = await this.prisma.department.findFirst({
      where: { manager: dto.employeeId },
    });

    if (managedDepartment) {
      throw new BadRequestException(
        `لا يمكن إنهاء خدمة الموظف لأنهم المشرف على قسم "${managedDepartment.name}". يرجى تغيير المشرف للقسم قبل إنهاء الخدمة.`,
      );
    }

    const terminationDate = this.parseOptionalDate(dto.terminationDate, 'terminationDate');

    if (!terminationDate) {
      throw new BadRequestException('Invalid termination date');
    }

    // Determine the status based on termination type
    const status = dto.terminationType === 'resignation' ? 'resigned' : 'terminated';

    // Use transaction to update employee and create termination record
    const result = await this.prisma.$transaction(async (tx) => {
      // Update employee status
      const updated = await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId: dto.employeeId }),
        data: {
          status,
          terminationDate,
          terminationType: dto.terminationType,
          terminationReason: dto.reason,
          terminationNotes: dto.notes || null,
          financialSettlementStatus: 'pending',
          isSettled: false,
          isFinanciallySettled: false,
        },
        include: this.employeeSelect(),
      });

      // Create termination record for audit trail
      const terminationRecord = await tx.terminationRecord.create({
        data: {
          employeeId: dto.employeeId,
          terminationDate,
          terminationType: dto.terminationType,
          reason: dto.reason,
          notes: dto.notes || null,
          processedBy: user.userId || user.username || 'system',
        },
      });

      // إزالة الموظف من أي باص وحذف خصم المواصلات الخاص به
      try {
        const busPassenger = await tx.busPassenger.findFirst({
          where: { employeeId: dto.employeeId, status: 'active' },
          include: { bus: { select: { plateNumber: true } } },
        });
        if (busPassenger) {
          await tx.busPassenger.delete({ where: { id: busPassenger.id } });
          await tx.employeeBonus.deleteMany({
            where: {
              employeeId: dto.employeeId,
              // `bus` is typed optional only because the composite key
              // (tenantId, busId) carries a nullable tenantId; busId is NOT NULL.
              bonusReason: { contains: busPassenger.bus!.plateNumber },
            },
          });
        }
      } catch {
        // bus_passengers table may not exist yet — safe to skip
      }

      return { employee: updated, terminationRecord };
    });

    await this.invalidateEmployeeCaches();

    const actionMessage =
      dto.terminationType === 'resignation'
        ? 'Employee resigned successfully'
        : 'Employee terminated successfully';

    return {
      success: true,
      message: actionMessage,
      employee: result.employee,
      terminationRecord: result.terminationRecord,
    };
  }

  async bulkTerminateDepartment(dto: BulkTerminateDepartmentDto, _user: AuthenticatedUser) {
    const status = dto.terminationType === 'resignation' ? 'resigned' : 'terminated';
    const terminationDate =
      this.parseOptionalDate(dto.terminationDate, 'terminationDate') || new Date();

    const employees = await this.prisma.employee.findMany({
      where: {
        department: dto.department,
        status: 'active',
      },
      select: { employeeId: true, name: true },
    });

    if (employees.length === 0) {
      return { success: true, message: 'لا يوجد موظفين نشطين في هذا القسم', terminatedCount: 0 };
    }

    // Check if any of the employees is a manager of any department
    const employeeIds = employees.map(emp => emp.employeeId);
    const managedDepartment = await this.prisma.department.findFirst({
      where: { manager: { in: employeeIds } },
    });

    if (managedDepartment) {
      const managerEmployee = employees.find(emp => emp.employeeId === managedDepartment.manager);
      throw new BadRequestException(
        `لا يمكن إنهاء خدمة الموظفين لأن الموظف ${managerEmployee?.name} (${managedDepartment.manager}) هو المشرف على قسم ${managedDepartment.name}. يرجى تغيير المشرف للقسم أولاً.`,
      );
    }

    const results = await this.prisma.$transaction(
      employees.map((emp) =>
        this.prisma.employee.update({
          where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId: emp.employeeId }),
          data: {
            status,
            terminationDate,
            terminationType: dto.terminationType,
            terminationReason: dto.terminationReason || null,
            terminationNotes: dto.terminationNotes || null,
            financialSettlementStatus: 'pending',
            isSettled: false,
            isFinanciallySettled: false,
          },
          include: this.employeeSelect(),
        }),
      ),
    );

    await this.invalidateEmployeeCaches();

    const actionLabel = dto.terminationType === 'resignation' ? 'استقالة' : 'إقالة';
    return {
      success: true,
      message: `تم ${actionLabel} جماعي لـ ${results.length} موظف في قسم "${dto.department}"`,
      terminatedCount: results.length,
      employees: results,
    };
  }

  async settle(employeeId: string) {
    const employee = await this.prisma.employee.findFirst({ where: { employeeId } });

    if (!employee) throw new NotFoundException('Employee not found');

    const updated = await this.prisma.employee.update({
      where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId }),
      data: {
        isSettled: true,
      },
      include: this.employeeSelect(),
    });

    return { message: 'Employee settled successfully', employee: updated };
  }

  async rehireEmployee(dto: RehireEmployeeDto, user: AuthenticatedUser) {
    // 1. Validate employee exists and is resigned/terminated
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (!['resigned', 'terminated'].includes(employee.status)) {
      throw new BadRequestException(
        'Employee is not eligible for rehire. Only resigned or terminated employees can be rehired.',
      );
    }

    const rehireDate = this.parseOptionalDate(dto.rehireDate, 'rehireDate');

    if (!rehireDate) {
      throw new BadRequestException('Invalid rehire date');
    }

    // Store previous settings if needed for restoration
    const restorePreviousSettings = dto.restorePreviousSettings ?? true;

    // Use transaction to update employee and create rehire record
    const result = await this.prisma.$transaction(async (tx) => {
      // 2. Restore employee to active status
      const updateData: Prisma.EmployeeUpdateInput = {
        status: 'active',
        rehireDate,
        // Clear termination-related fields
        terminationDate: null,
        terminationType: null,
        terminationReason: null,
        terminationNotes: null,
        financialSettlementStatus: 'pending',
        isSettled: false,
        isFinanciallySettled: false,
      };

      // When restorePreviousSettings is false, the employee starts FRESH:
      // previous salary config and financial history (bonuses, advances,
      // penalties) are cleared inside the same transaction so nothing old
      // silently carries over into the new employment.
      if (!restorePreviousSettings) {
        await tx.employeeSalary.deleteMany({ where: { employeeId: dto.employeeId } });
        await tx.employeeBonus.deleteMany({ where: { employeeId: dto.employeeId } });
        await tx.employeeAdvance.deleteMany({ where: { employeeId: dto.employeeId } });
        await tx.employeePenalty.deleteMany({ where: { employeeId: dto.employeeId } });
      }

      const updatedEmployee = await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId: dto.employeeId }),
        data: updateData,
        include: this.employeeSelect(),
      });

      // 3. Find the most recent termination record for this employee
      const previousTermination = await tx.terminationRecord.findFirst({
        where: { employeeId: dto.employeeId },
        orderBy: { terminationDate: 'desc' },
      });

      // 4. Create rehire record for audit trail
      const rehireRecord = await tx.rehireRecord.create({
        data: {
          employeeId: dto.employeeId,
          rehireDate,
          processedBy: user.userId || user.username || 'system',
          previousTerminationId: previousTermination?.id || null,
          notes: dto.notes || null,
        },
      });

      return { employee: updatedEmployee, rehireRecord };
    });

    await this.invalidateEmployeeCaches();

    return {
      success: true,
      message: 'Employee rehired successfully',
      employee: result.employee,
      rehireRecord: result.rehireRecord,
    };
  }

  async processFinancialSettlement(dto: FinancialSettlementDto, user: AuthenticatedUser) {
    // 1. Validate employee exists and is resigned/terminated
    const employee = await this.prisma.employee.findFirst({
      where: { employeeId: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (!['resigned', 'terminated'].includes(employee.status)) {
      throw new BadRequestException(
        'Employee is not eligible for financial settlement. Only resigned or terminated employees can be settled.',
      );
    }

    if (employee.financialSettlementStatus === 'completed' || employee.isFinanciallySettled) {
      throw new BadRequestException('Employee has already been financially settled');
    }

    const settlementDate = this.parseOptionalDate(dto.settlementDate, 'settlementDate');

    if (!settlementDate) {
      throw new BadRequestException('Invalid settlement date');
    }

    // 2. Calculate total settlement amount
    const finalSalaryAmount = dto.finalSalaryAmount;
    const deductions = dto.deductions ?? 0;
    const bonuses = dto.bonuses ?? 0;
    const totalSettlement = finalSalaryAmount + bonuses - deductions;

    // Use transaction to update employee and create settlement record
    const result = await this.prisma.$transaction(async (tx) => {
      // 3. Create financial settlement record
      const settlement = await tx.financialSettlement.create({
        data: {
          employeeId: dto.employeeId,
          settlementDate,
          processedBy: user.userId || user.username || 'system',
          finalSalaryAmount: new Prisma.Decimal(finalSalaryAmount),
          deductions: new Prisma.Decimal(deductions),
          bonuses: new Prisma.Decimal(bonuses),
          totalSettlement: new Prisma.Decimal(totalSettlement),
          status: 'completed',
          notes: dto.notes || null,
        },
      });

      // 4. Update employee financial status
      const updatedEmployee = await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId: dto.employeeId }),
        data: {
          financialSettlementStatus: 'completed',
          financialSettlementDate: settlementDate,
          isFinanciallySettled: true,
          isSettled: true,
        },
        include: this.employeeSelect(),
      });

      return { settlement, employee: updatedEmployee };
    });

    await this.invalidateEmployeeCaches();

    return {
      success: true,
      message: 'Financial settlement processed successfully',
      settlement: result.settlement,
      employee: result.employee,
    };
  }

  async getResignedEmployees(query: ResignedEmployeesQueryDto, user?: AuthenticatedUser) {
    const { page, limit, skip } = resolvePagination(query);

    // Build where clause for resigned/terminated employees
    const where: Prisma.EmployeeWhereInput = {
      status: {
        in: ['resigned', 'terminated'],
      },
    };

    // Filter by department
    if (query.department) {
      where.department = query.department;
    }

    // Filter by termination type
    if (query.type) {
      where.terminationType = query.type;
    }

    // Filter by financial settlement status
    if (query.financialStatus) {
      where.financialSettlementStatus = query.financialStatus;
    }

    // Filter by search term
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { employeeId: { contains: query.search, mode: 'insensitive' } },
        { mobile: { contains: query.search, mode: 'insensitive' } },
        { nationalId: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    // Filter by month: current / previous / all, or an explicit YYYY-MM.
    if (query.month && query.month !== 'all') {
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      if (query.month === 'current') {
        where.terminationDate = {
          gte: currentMonthStart,
          lte: currentMonthEnd,
        };
      } else if (query.month === 'previous') {
        where.terminationDate = {
          lt: currentMonthStart,
        };
      } else {
        // Explicit calendar month. The DTO has already validated the shape.
        const [year, month] = query.month.split('-').map(Number);
        where.terminationDate = {
          gte: new Date(year, month - 1, 1),
          lte: new Date(year, month, 0, 23, 59, 59, 999),
        };
      }
    }

    // The list and statistics are independent. Start all database work together
    // so the endpoint has one query phase instead of two serial phases.
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      employees,
      total,
      currentMonthCount,
      previousMonthsCount,
      resignationsCount,
      terminationsCount,
      pendingSettlementCount,
      byDepartment,
    ] = await Promise.all([
      this.fetchListRows(where, { terminationDate: 'desc' }, skip, limit, user),
      this.prisma.employee.count({ where }),
      this.prisma.employee.count({
        where: {
          status: { in: ['resigned', 'terminated'] },
          terminationDate: {
            gte: currentMonthStart,
          },
        },
      }),
      this.prisma.employee.count({
        where: {
          status: { in: ['resigned', 'terminated'] },
          terminationDate: {
            lt: currentMonthStart,
          },
        },
      }),
      this.prisma.employee.count({
        where: {
          status: 'resigned',
        },
      }),
      this.prisma.employee.count({
        where: {
          status: 'terminated',
        },
      }),
      this.prisma.employee.count({
        where: {
          status: { in: ['resigned', 'terminated'] },
          financialSettlementStatus: 'pending',
        },
      }),
      this.prisma.employee.groupBy({
        by: ['department'],
        where: {
          status: { in: ['resigned', 'terminated'] },
        },
        _count: { _all: true },
      }),
    ]);

    const departmentStats = byDepartment.reduce<Record<string, number>>((acc, entry) => {
      const key = entry.department || 'Unassigned';
      acc[key] = entry._count._all;
      return acc;
    }, {});

    return {
      data: employees,
      ...paginationMeta(page, limit, total),
      statistics: {
        currentMonth: currentMonthCount,
        previousMonths: previousMonthsCount,
        resignations: resignationsCount,
        terminations: terminationsCount,
        pendingSettlement: pendingSettlementCount,
        byDepartment: departmentStats,
      },
    };
  }

  async remove(employeeId: string, deletedBy?: string) {
    const employee = await this.prisma.employee.findFirst({ where: { employeeId } });

    if (!employee) throw new NotFoundException('Employee not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.deletedRecordHistory.create({
        data: {
          entityType: EMPLOYEE_DELETION_ENTITY,
          recordId: employee.id,
          payload: JSON.parse(JSON.stringify(employee)) as Prisma.InputJsonValue,
          deletedBy: deletedBy || null,
        },
      });

      await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId }),
        data: {
          status: 'terminated',
          terminationDate: employee.terminationDate || new Date(),
        },
      });
    });

    await this.invalidateEmployeeCaches();

    return { message: 'Employee terminated and archived successfully' };
  }

  async restoreEmployee(historyId: string, restoredBy?: string, user?: AuthenticatedUser) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: EMPLOYEE_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: tenantKey<Prisma.EmployeeWhereUniqueInput>({ employeeId: payload.employeeId }),
        data: {
          status: 'active',
          terminationDate: null,
          terminationType: null,
          terminationReason: null,
          terminationNotes: null,
        },
      });

      await tx.deletedRecordHistory.update({
        where: { id: historyId },
        data: { restoredAt: new Date(), restoredBy: restoredBy || null },
      });
    });

    await this.invalidateEmployeeCaches();

    return this.getByEmployeeId(payload.employeeId, user);
  }

  async listDeletedEmployees() {
    return this.prisma.deletedRecordHistory.findMany({
      where: { entityType: EMPLOYEE_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }
}
