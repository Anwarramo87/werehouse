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
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { TerminateEmployeeBodyDto } from './dto/terminate-employee-body.dto';
import { RehireEmployeeDto } from './dto/rehire-employee.dto';
import { FinancialSettlementDto } from './dto/financial-settlement.dto';
import { ResignedEmployeesQueryDto } from './dto/resigned-employees-query.dto';
import { BulkTerminateDepartmentDto } from './dto/bulk-terminate-department.dto';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { BCRYPT_DEFAULT_ROUNDS } from '../common/constants/auth.constants';
import {
  DEFAULT_DEPARTMENT,
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_WORK_DAYS_IN_PERIOD,
  MAX_BASE_SALARY,
  MAX_HOURLY_RATE,
} from './employees.constants';
import { buildEmployeeSalaryMirror, resolveSalary } from '../common/utils/salary-resolution.util';

const DEFAULT_PROFILE_RANGE_DAYS = 30;
const DEFAULT_PROFILE_LIMIT = 200;

const EMPLOYEE_DELETION_ENTITY = 'employee';

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortCache: ShortCacheService,
  ) {}

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

    return parsed;
  }

  private async resolveDepartment(departmentName: string) {
    const normalizedName = this.normalizeDepartmentName(departmentName);

    const existing = await this.prisma.department.findFirst({
      where: { name: { equals: normalizedName, mode: 'insensitive' } },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.department.create({
      data: { name: normalizedName },
    });
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

  async list(query: EmployeesListQueryDto) {
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
      this.prisma.employee.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
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
          hourlyRate: true,
          baseSalary: true,
          livingAllowance: true,
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
        },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginatedResponse(employees, page, limit, total);
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

  async byDepartment(department: string, query: Record<string, any> = {}) {
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(200, Math.max(1, query?.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeWhereInput = { department };
    this.applyEmployeeStatusFilter(where, query?.status ?? undefined);

    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        include: this.employeeSelect(),
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      data: employees,
      ...paginationMeta(page, limit, total),
      department,
    };
  }

  async create(dto: CreateEmployeeDto) {
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
    const department = await this.resolveDepartment(departmentName);
    const profession = this.normalizeOptionalString(dto.profession ?? dto.jobTitle);
    const baseSalary = dto.baseSalary ?? null;
    const resolvedWorkDaysInPeriod = dto.workDaysInPeriod ?? DEFAULT_WORK_DAYS_IN_PERIOD;
    const resolvedHoursPerDay = dto.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
    const resolvedHourlyRate =
      dto.hourlyRate ??
      (baseSalary != null
        ? Number((baseSalary / (resolvedWorkDaysInPeriod * resolvedHoursPerDay)).toFixed(2))
        : null);

    if (resolvedHourlyRate === null || resolvedHourlyRate === undefined) {
      throw new BadRequestException('baseSalary is required when hourlyRate is not provided');
    }

    if (baseSalary != null && baseSalary > MAX_BASE_SALARY) {
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
      const user = await transaction.user.create({
        data: {
          username: loginName,
          email: loginName,
          passwordHash,
          roleId: dto.roleId || null,
          status: 'active',
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
          hourlyRate: new Prisma.Decimal(resolvedHourlyRate),
          baseSalary: baseSalary != null ? new Prisma.Decimal(baseSalary) : null,
          livingAllowance:
            dto.livingAllowance != null ? new Prisma.Decimal(dto.livingAllowance) : null,
          roleId: dto.roleId || null,
          department: department.name,
          departmentId: department.id,
          scheduledStart: dto.scheduledStart || null,
          scheduledEnd: dto.scheduledEnd || null,
          employmentStartDate,
          terminationDate: null,
          status: 'active',
          workDaysInPeriod: dto.workDaysInPeriod ?? DEFAULT_WORK_DAYS_IN_PERIOD,
          hoursPerDay: dto.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
          gracePeriodMinutes: dto.gracePeriodMinutes ?? 5,
        },
        include: this.employeeSelect(),
      });

      await transaction.employeeSalary.create({
        data: {
          employeeId: dto.employeeId,
          profession,
          baseSalary: baseSalary != null ? new Prisma.Decimal(baseSalary) : new Prisma.Decimal(0),
          lumpSumSalary: new Prisma.Decimal(dto.lumpSumSalary ?? 0),
          livingAllowance:
            dto.livingAllowance != null
              ? new Prisma.Decimal(dto.livingAllowance)
              : new Prisma.Decimal(0),
        },
      });

      return { user, employee };
    });

    await this.shortCache.invalidatePrefix('employees:stats');

    return { message: 'Employee created successfully', employee: created.employee };
  }

  async getByEmployeeId(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { employeeId },
      include: this.employeeSelect(),
    });

    if (!employee) throw new NotFoundException('Employee not found');

    return employee;
  }

  async update(employeeId: string, dto: UpdateEmployeeDto) {
    const [employee, existingSalary] = await Promise.all([
      this.prisma.employee.findUnique({
        where: { employeeId },
      }),
      this.prisma.employeeSalary.findUnique({ where: { employeeId } }),
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
      if (loginName !== undefined || passwordHash !== undefined || dto.roleId !== undefined) {
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
              ...(dto.roleId !== undefined && { roleId: dto.roleId }),
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
        ...(profession !== undefined && { jobTitle: profession, profession }),
        ...(dto.roleId !== undefined && { roleId: dto.roleId }),
        ...(departmentName !== undefined && { department: departmentName }),
        ...(dto.scheduledStart !== undefined && { scheduledStart: dto.scheduledStart }),
        ...(dto.scheduledEnd !== undefined && { scheduledEnd: dto.scheduledEnd }),
        ...(employmentStartDate !== undefined && { employmentStartDate }),
        ...(terminationDate !== undefined && { terminationDate }),
        ...(dto.workDaysInPeriod !== undefined && { workDaysInPeriod: dto.workDaysInPeriod }),
        ...(dto.hoursPerDay !== undefined && { hoursPerDay: dto.hoursPerDay }),
        ...(dto.gracePeriodMinutes !== undefined && {
          gracePeriodMinutes: dto.gracePeriodMinutes,
        }),
      };

      if (departmentName !== undefined) {
        const department = await this.resolveDepartment(departmentName);
        payload.department = department.name;
        payload.departmentId = department.id;
      }

      const updatedEmployee = await transaction.employee.update({
        where: { employeeId },
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
        lumpSumSalary:
          dto.lumpSumSalary !== undefined
            ? new Prisma.Decimal(dto.lumpSumSalary ?? 0)
            : (existingSalary?.lumpSumSalary ?? new Prisma.Decimal(0)),
      };

      await transaction.employeeSalary.upsert({
        where: { employeeId },
        update: salaryPayload,
        create: salaryPayload,
      });

      const salaryRecord = await transaction.employeeSalary.findUnique({ where: { employeeId } });
      if (salaryRecord) {
        const mirror = buildEmployeeSalaryMirror(resolveSalary(updatedEmployee, salaryRecord));
        await transaction.employee.update({
          where: { employeeId },
          data: mirror,
        });
      }

      return transaction.employee.findUnique({
        where: { employeeId },
        include: this.employeeSelect(),
      });
    });

    await this.shortCache.invalidatePrefix('employees:stats');

    return { message: 'Employee updated successfully', employee: updated };
  }

  async getProfile(employeeId: string, query: EmployeeProfileQueryDto, user?: AuthenticatedUser) {
    const employee = await this.getByEmployeeId(employeeId);

    const canViewSalary = this.hasPermission(user, 'manage_salary');
    const canViewAttendance = this.hasPermission(user, 'view_attendance');
    const canViewAdvances = this.hasPermission(user, 'manage_advances');
    const canViewBonuses = this.hasPermission(user, 'manage_bonuses');

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
      ? this.prisma.employeeSalary.findUnique({ where: { employeeId } })
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
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });

    if (!employee) throw new NotFoundException('Employee not found');

    const terminationDate =
      this.parseOptionalDate(dto.terminationDate, 'terminationDate') || new Date();

    const updated = await this.prisma.employee.update({
      where: { employeeId },
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

    await this.shortCache.invalidatePrefix('employees:stats');

    return { message: successMessage, employee: updated };
  }

  async terminateEmployee(dto: TerminateEmployeeBodyDto, user: AuthenticatedUser) {
    const employee = await this.prisma.employee.findUnique({
      where: { employeeId: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (employee.status !== 'active') {
      throw new BadRequestException('Employee is not active');
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
        where: { employeeId: dto.employeeId },
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

      return { employee: updated, terminationRecord };
    });

    await this.shortCache.invalidatePrefix('employees:stats');

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

  async bulkTerminateDepartment(dto: BulkTerminateDepartmentDto, user: AuthenticatedUser) {
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

    const results = await this.prisma.$transaction(
      employees.map((emp) =>
        this.prisma.employee.update({
          where: { employeeId: emp.employeeId },
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

    await this.shortCache.invalidatePrefix('employees:stats');

    const actionLabel = dto.terminationType === 'resignation' ? 'استقالة' : 'إقالة';
    return {
      success: true,
      message: `تم ${actionLabel} جماعي لـ ${results.length} موظف في قسم "${dto.department}"`,
      terminatedCount: results.length,
      employees: results,
    };
  }

  async settle(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });

    if (!employee) throw new NotFoundException('Employee not found');

    const updated = await this.prisma.employee.update({
      where: { employeeId },
      data: {
        isSettled: true,
      },
      include: this.employeeSelect(),
    });

    return { message: 'Employee settled successfully', employee: updated };
  }

  async rehireEmployee(dto: RehireEmployeeDto, user: AuthenticatedUser) {
    // 1. Validate employee exists and is resigned/terminated
    const employee = await this.prisma.employee.findUnique({
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

      // If restorePreviousSettings is true, keep all previous data (salary, department, etc.)
      // Otherwise, the data is already preserved in the employee record

      const updatedEmployee = await tx.employee.update({
        where: { employeeId: dto.employeeId },
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

    await this.shortCache.invalidatePrefix('employees:stats');

    return {
      success: true,
      message: 'Employee rehired successfully',
      employee: result.employee,
      rehireRecord: result.rehireRecord,
    };
  }

  async processFinancialSettlement(dto: FinancialSettlementDto, user: AuthenticatedUser) {
    // 1. Validate employee exists and is resigned/terminated
    const employee = await this.prisma.employee.findUnique({
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
        where: { employeeId: dto.employeeId },
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

    await this.shortCache.invalidatePrefix('employees:stats');

    return {
      success: true,
      message: 'Financial settlement processed successfully',
      settlement: result.settlement,
      employee: result.employee,
    };
  }

  async getResignedEmployees(query: ResignedEmployeesQueryDto) {
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

    // Filter by month (current or previous)
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
      }
    }

    // Execute queries
    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        orderBy: { terminationDate: 'desc' },
        skip,
        take: limit,
        include: this.employeeSelect(),
      }),
      this.prisma.employee.count({ where }),
    ]);

    // Calculate statistics
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      currentMonthCount,
      previousMonthsCount,
      resignationsCount,
      terminationsCount,
      pendingSettlementCount,
      byDepartment,
    ] = await Promise.all([
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
    const employee = await this.prisma.employee.findUnique({ where: { employeeId } });

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
        where: { employeeId },
        data: {
          status: 'terminated',
          terminationDate: employee.terminationDate || new Date(),
        },
      });
    });

    await this.shortCache.invalidatePrefix('employees:stats');

    return { message: 'Employee terminated and archived successfully' };
  }

  async restoreEmployee(historyId: string, restoredBy?: string) {
    const history = await this.prisma.deletedRecordHistory.findFirst({
      where: { id: historyId, entityType: EMPLOYEE_DELETION_ENTITY, restoredAt: null },
    });

    if (!history) throw new NotFoundException('History record not found or already restored');

    const payload = history.payload as any;

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { employeeId: payload.employeeId },
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

    await this.shortCache.invalidatePrefix('employees:stats');

    return this.getByEmployeeId(payload.employeeId);
  }

  async listDeletedEmployees() {
    return this.prisma.deletedRecordHistory.findMany({
      where: { entityType: EMPLOYEE_DELETION_ENTITY, restoredAt: null },
      orderBy: { deletedAt: 'desc' },
    });
  }
}
