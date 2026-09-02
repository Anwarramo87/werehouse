import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { runUnscoped } from '../src/common/tenant/tenant-context';

describe('Employees Rehire (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authToken: string;
  let testEmployeeId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get<PrismaService>(PrismaService);

    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ZodValidationPipe(),
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    await app.init();

    // Login to get auth token
    const loginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: 'password123',
      });

    authToken = loginResponse.body.token;

    // Remove anything a previous failed run left behind: these suites create
    // fixed employee ids, so a leftover row makes the next run fail on a
    // conflict rather than on anything real.
    await runUnscoped('e2e-pre-clean', async () => {
      await prisma.rehireRecord.deleteMany({ where: { employeeId: { startsWith: 'EMP9' } } });
      await prisma.financialSettlement.deleteMany({ where: { employeeId: { startsWith: 'EMP9' } } });
      await prisma.terminationRecord.deleteMany({ where: { employeeId: { startsWith: 'EMP9' } } });
      await prisma.employee.deleteMany({ where: { employeeId: { startsWith: 'EMP9' } } });
      // The linked user survives the employee: username is globally unique,
      // so a leftover one blocks recreating the fixture.
      await prisma.user.deleteMany({ where: { username: { startsWith: 'test-' } } });
    });

    // Create a test employee
    const createResponse = await request(app.getHttpServer())
      .post('/api/employees')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employeeId: 'EMP9201',
        name: 'Test Employee for Rehire',
        username: 'test-rehire-user',
        password: 'test123',
        department: 'Test Department',
        baseSalary: 5000,
        hourlyRate: 25,
      });

    testEmployeeId = createResponse.body.employee.employeeId;

    // Terminate the employee first so we can test rehire
    await request(app.getHttpServer())
      .post('/api/employees/terminate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employeeId: testEmployeeId,
        terminationDate: new Date().toISOString(),
        terminationType: 'resignation',
        reason: 'Employee decided to pursue other opportunities',
        notes: 'Good employee, left on good terms',
      });
  });

  afterAll(async () => {
    // Clean up test employee and related records
    if (testEmployeeId) {
      await runUnscoped('e2e-cleanup', async () => await prisma.rehireRecord.deleteMany({
        where: { employeeId: testEmployeeId },
      }));
      await runUnscoped('e2e-cleanup', async () => await prisma.terminationRecord.deleteMany({
        where: { employeeId: testEmployeeId },
      }));
      await runUnscoped('e2e-cleanup', async () => await prisma.employee.deleteMany({
        where: { employeeId: testEmployeeId },
      }));
    }

    await app.close();
  });

  describe('POST /api/employees/rehire', () => {
    it('should rehire a resigned employee successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          rehireDate: new Date().toISOString(),
          notes: 'Employee requested to return, good performance history',
          restorePreviousSettings: true,
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('rehired successfully');
      expect(response.body.employee.status).toBe('active');
      expect(response.body.employee.rehireDate).toBeDefined();
      expect(response.body.employee.terminationDate).toBeNull();
      expect(response.body.employee.terminationType).toBeNull();
      expect(response.body.employee.terminationReason).toBeNull();
      expect(response.body.employee.financialSettlementStatus).toBe('pending');
      expect(response.body.rehireRecord).toBeDefined();
      expect(response.body.rehireRecord.employeeId).toBe(testEmployeeId);
    });

    it('should fail to rehire non-existent employee', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: 'EMP9999',
          rehireDate: new Date().toISOString(),
          notes: 'Test notes',
        })
        .expect(404);
    });

    it('should fail to rehire an active employee', async () => {
      // The employee is now active after the first rehire test
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          rehireDate: new Date().toISOString(),
          notes: 'Trying to rehire active employee',
        })
        .expect(400);
    });

    it('should fail with invalid rehire date', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          rehireDate: 'invalid-date',
          notes: 'Test notes',
        })
        .expect(400);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .send({
          employeeId: testEmployeeId,
          rehireDate: new Date().toISOString(),
          notes: 'Test notes',
        })
        .expect(401);
    });

    it('should fail without required employeeId', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          rehireDate: new Date().toISOString(),
          notes: 'Test notes',
        })
        .expect(400);
    });

    it('should fail without required rehireDate', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/rehire')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          notes: 'Test notes',
        })
        .expect(400);
    });
  });
});
