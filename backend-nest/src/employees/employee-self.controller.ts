import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user.types';
import { EmployeeProfileQueryDto } from './dto/employee-profile-query.dto';

/**
 * What a member of staff may see about themselves.
 *
 * ── Why this controller exists ───────────────────────────────────────────────
 * Before it, there was no way for an employee to view their own record. The only
 * profile endpoint took the employee number from the URL and was gated on
 * `view_employees` — a see-everyone permission with no ownership check — so the
 * access an employee needed was also the access to read every colleague's file,
 * and changing one number in the address bar was enough to do it.
 *
 * ── Why the identity comes from the token ────────────────────────────────────
 * `employeeId` is resolved by JwtStrategy from the User→Employee relation on
 * every cache miss. It is never read from a path, a query string or a body, so
 * there is no parameter to tamper with: a request can only ever be about the
 * person who signed it.
 *
 * ── Why no PermissionsGuard ──────────────────────────────────────────────────
 * Deliberately absent. PermissionsGuard requires every endpoint to name a
 * permission, and no permission should be required to read your own payslip —
 * requiring one is exactly how staff would end up holding `manage_salary` and
 * seeing everyone's. PageAccessGuard is absent for the same reason: a person's
 * own record is not a module their factory buys.
 *
 * Authentication is still mandatory, and the Prisma tenant extension still
 * narrows every query to the caller's factory.
 */
@ApiTags('employees')
@ApiCookieAuth()
@Controller('employees/me')
@UseGuards(JwtAuthGuard)
export class EmployeeSelfController {
  constructor(private readonly employeesService: EmployeesService) {}

  /**
   * The staff identity behind this login, or a clear refusal.
   *
   * Operator accounts — the super admin, an IT login with no Employee row —
   * legitimately have no staff record. Saying so plainly beats a 404 that reads
   * like the employee was deleted.
   */
  private requireEmployeeId(user: AuthenticatedUser): string {
    if (!user?.employeeId) {
      throw new ForbiddenException(
        'This account is not linked to an employee record, so it has no personal profile.',
      );
    }
    return user.employeeId;
  }

  @Get()
  @ApiOperation({ summary: 'بيانات حسابي الوظيفي' })
  @ApiResponse({ status: 200, description: 'سجل الموظف الخاص بالمستخدم الحالي' })
  @ApiResponse({ status: 403, description: 'الحساب غير مرتبط بسجل موظف' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    // asSelf keeps the caller's own salary fields visible: the record belongs
    // to them, and the identity came from the verified token, not the URL.
    return this.employeesService.getByEmployeeId(
      this.requireEmployeeId(user),
      user,
      { asSelf: true },
    );
  }

  @Get('profile')
  @ApiOperation({
    summary: 'ملفي الكامل (حضور، راتب، سلف، مكافآت)',
    description:
      'Self-scoped. Returns every section without requiring manage_salary, because the data belongs to the caller.',
  })
  async profile(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EmployeeProfileQueryDto,
  ) {
    return this.employeesService.getProfile(
      this.requireEmployeeId(user),
      query,
      user,
      // The id came from the verified token, never from the request, which is
      // the precondition for treating this as self-access.
      { asSelf: true },
    );
  }
}
