import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeeAccessService } from './employee-access.service';
import { AuthenticatedUser } from '../types/authenticated-user.types';

const ATTENDANCE_PERMISSIONS = ['view_attendance', 'edit_attendance', 'view_payroll'];

describe('EmployeeAccessService', () => {
  let service: EmployeeAccessService;

  const prismaMock = {
    employee: { findFirst: jest.fn() },
  };

  const superadmin: AuthenticatedUser = {
    userId: 'u-root',
    username: 'root',
    role: 'superadmin',
    roles: ['superadmin'],
    permissions: [],
    tenantId: null,
  };

  const adminWithPermissions: AuthenticatedUser = {
    userId: 'u-admin',
    username: 'manager',
    role: 'admin',
    roles: ['admin'],
    permissions: ['view_attendance', 'view_payroll', 'view_employees'],
    tenantId: 'tenant-a',
  };

  /** A role literally named `admin` but carrying a narrow permission set. */
  const adminWithoutPermissions: AuthenticatedUser = {
    userId: 'u-admin2',
    username: 'weak-admin',
    role: 'admin',
    roles: ['admin'],
    permissions: ['view_employees'],
    tenantId: 'tenant-a',
  };

  const staff: AuthenticatedUser = {
    userId: 'u-staff',
    username: 'worker',
    role: 'staff',
    roles: ['staff'],
    permissions: [],
    tenantId: 'tenant-a',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.employee.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [EmployeeAccessService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get(EmployeeAccessService);
  });

  describe('isSuperAdmin', () => {
    it('recognises the super admin by role and by roles[]', () => {
      expect(service.isSuperAdmin(superadmin)).toBe(true);
      expect(service.isSuperAdmin({ ...superadmin, roles: [], role: 'superadmin' })).toBe(true);
      expect(service.isSuperAdmin({ ...superadmin, role: undefined, roles: ['superadmin'] })).toBe(true);
    });

    it('does not treat a factory admin as super admin', () => {
      expect(service.isSuperAdmin(adminWithPermissions)).toBe(false);
    });

    it('handles a missing user', () => {
      expect(service.isSuperAdmin(undefined)).toBe(false);
    });
  });

  describe('hasAnyPermission', () => {
    it('allows the super admin regardless of their permission list', () => {
      expect(service.hasAnyPermission(superadmin, ATTENDANCE_PERMISSIONS)).toBe(true);
      expect(service.hasAnyPermission(superadmin, ['manage_salary'])).toBe(true);
    });

    it('allows anyone holding one of the requested permissions', () => {
      expect(service.hasAnyPermission(adminWithPermissions, ATTENDANCE_PERMISSIONS)).toBe(true);
      expect(service.hasAnyPermission(staff, ['view_employees'])).toBe(false);
    });

    it('no longer grants access on the strength of the role name "admin"', () => {
      // The regression this change exists to close. `isAdmin()` used to return
      // true here and satisfy any permission list at all.
      expect(service.hasAnyPermission(adminWithoutPermissions, ['manage_salary'])).toBe(false);
      expect(service.hasAnyPermission(adminWithoutPermissions, ATTENDANCE_PERMISSIONS)).toBe(false);
    });

    it('rejects a missing user', () => {
      expect(service.hasAnyPermission(undefined, ATTENDANCE_PERMISSIONS)).toBe(false);
    });
  });

  describe('assertCanAccessEmployee', () => {
    it('requires authentication', async () => {
      await expect(
        service.assertCanAccessEmployee(undefined, 'EMP001', ATTENDANCE_PERMISSIONS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the super admin without touching the database', async () => {
      await expect(
        service.assertCanAccessEmployee(superadmin, 'EMP001', ATTENDANCE_PERMISSIONS),
      ).resolves.toBeUndefined();
      expect(prismaMock.employee.findFirst).not.toHaveBeenCalled();
    });

    it('allows an admin who holds the permission, for any employee', async () => {
      await expect(
        service.assertCanAccessEmployee(adminWithPermissions, 'EMP001', ATTENDANCE_PERMISSIONS),
      ).resolves.toBeUndefined();
      expect(prismaMock.employee.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the self-service link when the permission is absent', async () => {
      prismaMock.employee.findFirst.mockResolvedValue({ employeeId: 'EMP001' });

      await expect(
        service.assertCanAccessEmployee(staff, 'EMP001', ATTENDANCE_PERMISSIONS),
      ).resolves.toBeUndefined();

      // Matched on the caller's own user id — the record has to be theirs.
      expect(prismaMock.employee.findFirst).toHaveBeenCalledWith({
        where: { employeeId: 'EMP001', userId: 'u-staff' },
        select: { employeeId: true },
      });
    });

    it("refuses a staff member asking about somebody else's record", async () => {
      prismaMock.employee.findFirst.mockResolvedValue(null);

      await expect(
        service.assertCanAccessEmployee(staff, 'EMP999', ATTENDANCE_PERMISSIONS),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('makes a permissionless "admin" go through the same self-link check as anyone else', async () => {
      prismaMock.employee.findFirst.mockResolvedValue(null);

      await expect(
        service.assertCanAccessEmployee(adminWithoutPermissions, 'EMP001', ATTENDANCE_PERMISSIONS),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prismaMock.employee.findFirst).toHaveBeenCalled();
    });

    it('never widens the lookup beyond the caller — tenant scoping is the extension\'s job', async () => {
      prismaMock.employee.findFirst.mockResolvedValue(null);

      await expect(
        service.assertCanAccessEmployee(staff, 'EMP-OTHER-TENANT', ATTENDANCE_PERMISSIONS),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // No tenantId is passed by hand: the Prisma extension narrows this query,
      // and a hand-rolled filter here would be a second source of truth.
      const call = prismaMock.employee.findFirst.mock.calls[0][0];
      expect(call.where).toEqual({ employeeId: 'EMP-OTHER-TENANT', userId: 'u-staff' });
    });
  });
});
