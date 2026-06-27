import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../types/authenticated-user.types';

@Injectable()
export class EmployeeAccessService {
  constructor(private readonly prisma: PrismaService) {}

  isAdmin(user: AuthenticatedUser | undefined): boolean {
    if (!user) return false;
    return user.role === 'admin' || (user.roles?.includes('admin') ?? false);
  }

  hasAnyPermission(user: AuthenticatedUser | undefined, permissions: string[]): boolean {
    if (!user) return false;
    if (this.isAdmin(user)) return true;
    return permissions.some((permission) => user.permissions?.includes(permission));
  }

  async assertCanAccessEmployee(
    user: AuthenticatedUser | undefined,
    employeeId: string,
    permissions: string[],
  ): Promise<void> {
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    if (this.hasAnyPermission(user, permissions)) {
      return;
    }

    const linked = await this.prisma.employee.findFirst({
      where: {
        employeeId,
        userId: user.userId,
      },
      select: { employeeId: true },
    });

    if (linked) {
      return;
    }

    throw new ForbiddenException('You cannot access this employee record');
  }
}
