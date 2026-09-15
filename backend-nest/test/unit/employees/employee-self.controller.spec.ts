import { ForbiddenException } from '@nestjs/common';
import { EmployeeSelfController } from '../../../src/employees/employee-self.controller';
import { AuthenticatedUser } from '../../../src/common/types/authenticated-user.types';
import { EmployeeProfileQueryDto } from '../../../src/employees/dto/employee-profile-query.dto';

const query = {} as EmployeeProfileQueryDto;

const serviceStub = () => {
  const getProfile = jest.fn(async () => ({ profile: true }));
  const getByEmployeeId = jest.fn(async () => ({ employeeId: 'EMP001' }));
  return { getProfile, getByEmployeeId } as never;
};

/*
 * The gap this closes: the only profile endpoint took the employee number from
 * the URL and was gated on `view_employees` — a see-everyone permission with no
 * ownership check. Letting staff read their own record therefore also let them
 * read every colleague's, by editing one number in the address bar.
 *
 * The identity here comes from the verified token and nowhere else, so there is
 * no parameter left to tamper with.
 */
describe('EmployeeSelfController', () => {
  const staff: AuthenticatedUser = {
    userId: 'u1',
    username: 'worker',
    employeeId: 'EMP001',
    tenantId: 'aaaaaaa1-0000-4000-8000-00000000000a',
    permissions: [],
    roles: ['staff'],
  };

  it('reads the employee number from the token, not from any input', async () => {
    const service = serviceStub();
    const controller = new EmployeeSelfController(service);

    await controller.profile(staff, query);

    const [employeeId] = (service as unknown as { getProfile: jest.Mock }).getProfile.mock.calls[0];
    expect(employeeId).toBe('EMP001');
  });

  it('grants every section without requiring manage_salary', async () => {
    // The whole point: your own pay needs no permission. Requiring one is how
    // staff would end up holding manage_salary and seeing everyone's.
    const service = serviceStub();
    const controller = new EmployeeSelfController(service);

    await controller.profile(staff, query);

    const call = (service as unknown as { getProfile: jest.Mock }).getProfile.mock.calls[0];
    expect(call[3]).toEqual({ asSelf: true });
    expect(staff.permissions).toEqual([]); // no permissions were needed
  });

  it('refuses an account with no staff record, and says why', async () => {
    // The super admin and operator logins legitimately have no Employee row. A
    // clear refusal beats a 404 that reads like the employee was deleted.
    const controller = new EmployeeSelfController(serviceStub());
    const operator: AuthenticatedUser = { ...staff, employeeId: null };

    await expect(controller.profile(operator, query)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.me(operator)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the token carries no employee identity at all', async () => {
    const controller = new EmployeeSelfController(serviceStub());
    const noIdentity = { userId: 'u2', username: 'x' } as AuthenticatedUser;

    await expect(controller.profile(noIdentity, query)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns the caller’s own record from /employees/me', async () => {
    const service = serviceStub();
    const controller = new EmployeeSelfController(service);

    await controller.me(staff);

    const mock = service as unknown as { getByEmployeeId: jest.Mock };
    const [employeeId, user, options] = mock.getByEmployeeId.mock.calls[0];
    // Identity comes from the token, and salary stays visible through the
    // asSelf carve-out — the record belongs to the caller, so no permission
    // is required (requiring one would push staff toward holding
    // manage_salary and seeing everyone's).
    expect(employeeId).toBe('EMP001');
    expect(user).toEqual(staff);
    expect(options).toEqual({ asSelf: true });
  });
});
