import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Employees Financial Settlement (e2e)', () => {
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
        employeeId: 'TEST-SETTLE-001',
        name: 'Test Employee for Settlement',
        username: 'test-settle-user',
        password: 'test123',
        roleId: '00000000-0000-0000-0000-000000000001',
        department: 'Test Department',
        baseSalary: 5000,
        hourlyRate: 25,
      });

    testEmployeeId = createResponse.body.employee.employeeId;

    // Terminate the employee first (required for settlement)
    await request(app.getHttpServer())
      .post('/api/employees/terminate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        employeeId: testEmployeeId,
        terminationDate: new Date().toISOString(),
        terminationType: 'resignation',
        reason: 'Employee decided to pursue other opportunities',
      });
  });

  afterAll(async () => {
    // Clean up test data
    if (testEmployeeId) {
      await prisma.financialSettlement.deleteMany({
        where: { employeeId: testEmployeeId },
      });
      await prisma.terminationRecord.deleteMany({
        where: { employeeId: testEmployeeId },
      });
      await prisma.employee.deleteMany({
        where: { employeeId: testEmployeeId },
      });
    }

    await app.close();
  });

  describe('POST /api/employees/financial-settlement', () => {
    it('should process financial settlement for resigned employee', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          settlementDate: new Date().toISOString(),
          finalSalaryAmount: 5000,
          deductions: 500,
          bonuses: 1000,
          notes: 'Final settlement processed',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('settlement processed successfully');
      expect(response.body.employee.financialSettlementStatus).toBe('completed');
      expect(response.body.employee.isFinanciallySettled).toBe(true);
      expect(response.body.settlement).toBeDefined();
      expect(response.body.settlement.finalSalaryAmount).toBe('5000');
      expect(response.body.settlement.deductions).toBe('500');
      expect(response.body.settlement.bonuses).toBe('1000');
      expect(response.body.settlement.totalSettlement).toBe('5500'); // 5000 + 1000 - 500
    });

    it('should fail to settle non-existent employee', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: 'NON-EXISTENT',
          settlementDate: new Date().toISOString(),
          finalSalaryAmount: 5000,
        })
        .expect(404);
    });

    it('should fail to settle already settled employee', async () => {
      // Try to settle the same employee again
      await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          settlementDate: new Date().toISOString(),
          finalSalaryAmount: 5000,
        })
        .expect(400);
    });

    it('should fail with negative amounts', async () => {
      // Create another test employee for this test
      const createResponse = await request(app.getHttpServer())
        .post('/api/employees')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: 'TEST-SETTLE-002',
          name: 'Test Employee 2',
          username: 'test-settle-user-2',
          password: 'test123',
          roleId: '00000000-0000-0000-0000-000000000001',
          department: 'Test Department',
          baseSalary: 5000,
          hourlyRate: 25,
        });

      const employeeId2 = createResponse.body.employee.employeeId;

      // Terminate the employee
      await request(app.getHttpServer())
        .post('/api/employees/terminate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: employeeId2,
          terminationDate: new Date().toISOString(),
          terminationType: 'resignation',
          reason: 'Test reason',
        });

      // Try to settle with negative amount
      await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: employeeId2,
          settlementDate: new Date().toISOString(),
          finalSalaryAmount: -1000,
        })
        .expect(400);

      // Clean up
      await prisma.terminationRecord.deleteMany({
        where: { employeeId: employeeId2 },
      });
      await prisma.employee.deleteMany({
        where: { employeeId: employeeId2 },
      });
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .send({
          employeeId: testEmployeeId,
          settlementDate: new Date().toISOString(),
          finalSalaryAmount: 5000,
        })
        .expect(401);
    });

    it('should fail with missing required fields', async () => {
      await request(app.getHttpServer())
        .post('/api/employees/financial-settlement')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          employeeId: testEmployeeId,
          // Missing settlementDate and finalSalaryAmount
        })
        .expect(400);
    });
  });
});
