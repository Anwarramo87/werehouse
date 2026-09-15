import { Controller, Get, INestApplication, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

/**
 * `GET /employees/me` must not be swallowed by `GET /employees/:employeeId`.
 *
 * Both patterns match the path "me", so which one answers is decided purely by
 * registration order — and registration order comes from the order of the
 * `controllers` array in EmployeesModule. That is a load-bearing detail with
 * nothing in the type system to protect it: reorder the array and every
 * employee's "my profile" request silently starts looking up an employee whose
 * number is literally "me", returning 404 instead of their record.
 *
 * These controllers mirror the real route shapes rather than importing them, so
 * the test needs no database, but the precedence being asserted is the framework
 * behaviour the real module depends on.
 */
@Controller('employees/me')
class SelfStubController {
  @Get()
  me() {
    return { handler: 'self' };
  }

  @Get('profile')
  profile() {
    return { handler: 'self-profile' };
  }
}

@Controller('employees')
class ParameterisedStubController {
  @Get(':employeeId')
  one(@Param('employeeId') employeeId: string) {
    return { handler: 'by-id', employeeId };
  }

  @Get(':employeeId/profile')
  profile(@Param('employeeId') employeeId: string) {
    return { handler: 'by-id-profile', employeeId };
  }
}

describe('employees/me route precedence', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Same order as EmployeesModule: the self controller first.
      controllers: [SelfStubController, ParameterisedStubController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('routes /employees/me to the self handler', async () => {
    const response = await request(app.getHttpServer()).get('/employees/me');

    expect(response.status).toBe(200);
    expect(response.body.handler).toBe('self');
  });

  it('routes /employees/me/profile to the self handler', async () => {
    const response = await request(app.getHttpServer()).get('/employees/me/profile');

    expect(response.status).toBe(200);
    expect(response.body.handler).toBe('self-profile');
  });

  it('still routes a real employee number to the parameterised handler', async () => {
    const response = await request(app.getHttpServer()).get('/employees/EMP001');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handler: 'by-id', employeeId: 'EMP001' });
  });

  it('still routes a real employee profile to the parameterised handler', async () => {
    const response = await request(app.getHttpServer()).get('/employees/EMP001/profile');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handler: 'by-id-profile', employeeId: 'EMP001' });
  });
});

describe('employees/me route precedence — the wrong order', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Deliberately reversed, to demonstrate that the order is what matters and
      // that getting it wrong is silent rather than loud.
      controllers: [ParameterisedStubController, SelfStubController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('swallows "me" as an employee number when registered last', async () => {
    const response = await request(app.getHttpServer()).get('/employees/me');

    // No error, no warning — just the wrong handler, answering about an employee
    // called "me". This is why EmployeesModule lists the self controller first.
    expect(response.body).toEqual({ handler: 'by-id', employeeId: 'me' });
  });
});
