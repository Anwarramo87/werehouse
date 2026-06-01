import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Employees Termination (e2e)', () => {
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
        password: 'admin123',
      });

    authToken = loginResponse.body.accessToken;

    // Create a test employee
    const createResponse = await request(app.getHttpServer())
      .post('/api/employees')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employeeId: 'TEST-TERM-001',
        name: 'Test Employee for Termination',
        username: 'test-terminate-user',
        password: 'test123',
        roleId: '00000000-0000-0000-0000-000000000001',
        department: 'Test Department',
        baseSalary: 5000,
        hourlyRate: 25,
      });

    testEmployeeId = createResponse.body.employee.employeeId;
  });

  afterAll(async () => {
    // Clean up test employee
    if (testEmployeeId) {
      await prisma.employee.deleteMany({
        where: { employeeId: testEmployeeId },
      });
    }

    await app.close();
  });

  describe('POST /api/employees/terminate', () => {
    it('should terminate an employee with resignation type', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          terminationDate: new Date().toISOString(),
          terminationType: 'resignation',
          reason: 'Employee decided to pursue other opportunities',
          notes: 'Good employee, left on good terms',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('resigned successfully');
      expect(response.body.employee.status).toBe('resigned');
      expect(response.body.employee.terminationType).toBe('resignation');
      expect(response.body.employee.financialSettlementStatus).toBe('pending');
      expect(response.body.terminationRecord).toBeDefined();
      expect(response.body.terminationRecord.terminationType).toBe('resignation');
    });

    it('should fail to terminate non-existent employee', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: 'NON-EXISTENT',
          terminationDate: new Date().toISOString(),
          terminationType: 'termination',
          reason: 'Performance issues',
        })
        .expect(404);
    });

    it('should fail with invalid termination type', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          terminationDate: new Date().toISOString(),
          terminationType: 'invalid-type',
          reason: 'Some reason',
        })
        .expect(400);
    });

    it('should fail with short reason', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          terminationDate: new Date().toISOString(),
          terminationType: 'resignation',
          reason: 'Short',
        })
        .expect(400);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .send({
          employeeId: testEmployeeId,
          terminationDate: new Date().toISOString(),
          terminationType: 'resignation',
          reason: 'Employee decided to pursue other opportunities',
        })
        .expect(401);
    });
  });
});
