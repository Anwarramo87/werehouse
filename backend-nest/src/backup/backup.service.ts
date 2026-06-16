import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';

const BATCH_SIZE = 1000;

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async exportFull(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HRM Warehouse Backup';
    workbook.created = new Date();

    const models = [
      { name: 'employees', model: this.prisma.employee },
      { name: 'employee_salaries', model: this.prisma.employeeSalary },
      { name: 'employee_insurance', model: this.prisma.employeeInsurance },
      { name: 'attendance_records', model: this.prisma.attendanceRecord },
      { name: 'daily_attendance_logs', model: this.prisma.dailyAttendanceLog },
      { name: 'employee_advances', model: this.prisma.employeeAdvance },
      { name: 'employee_bonuses', model: this.prisma.employeeBonus },
      { name: 'employee_penalties', model: this.prisma.employeePenalty },
      { name: 'leave_requests', model: this.prisma.leaveRequest },
      { name: 'payroll_runs', model: this.prisma.payrollRun },
      { name: 'payroll_items', model: this.prisma.payrollItem },
      { name: 'payroll_inputs', model: this.prisma.payrollInput },
      { name: 'buses', model: this.prisma.bus },
      { name: 'bus_passengers', model: this.prisma.busPassenger },
      { name: 'devices', model: this.prisma.device },
      { name: 'departments', model: this.prisma.department },
      { name: 'roles', model: this.prisma.role },
      { name: 'users', model: this.prisma.user },
      { name: 'deleted_record_history', model: this.prisma.deletedRecordHistory },
      { name: 'audit_logs', model: this.prisma.auditLog },
    ];

    for (const { name, model } of models) {
      this.logger.log(`Exporting ${name}...`);
      const sheet = workbook.addWorksheet(name);

      let offset = 0;
      let isFirstBatch = true;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const records = await (model as any).findMany({
          skip: offset,
          take: BATCH_SIZE,
        });

        if (records.length === 0) break;

        if (isFirstBatch && records.length > 0) {
          // Add headers from first record keys
          const headers = Object.keys(records[0]);
          sheet.addRow(headers);
          isFirstBatch = false;
        }

        for (const record of records) {
          const values = Object.values(record).map((v) =>
            v instanceof Date ? v.toISOString() :
            typeof v === 'object' && v !== null ? JSON.stringify(v) :
            v,
          );
          sheet.addRow(values);
        }

        offset += BATCH_SIZE;

        if (records.length < BATCH_SIZE) break;
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async exportMonth(period: string): Promise<Buffer> {
    const [year, month] = period.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HRM Warehouse Backup';
    workbook.created = new Date();

    // Static data (always included in full)
    const staticModels = [
      { name: 'employees', model: this.prisma.employee },
      { name: 'employee_salaries', model: this.prisma.employeeSalary },
      { name: 'employee_insurance', model: this.prisma.employeeInsurance },
      { name: 'departments', model: this.prisma.department },
      { name: 'roles', model: this.prisma.role },
    ];

    for (const { name, model } of staticModels) {
      this.logger.log(`Exporting ${name} (full snapshot)...`);
      const sheet = workbook.addWorksheet(name);
      const records = await (model as any).findMany({});

      if (records.length > 0) {
        sheet.addRow(Object.keys(records[0]));
        for (const record of records) {
          const values = Object.values(record).map((v) =>
            v instanceof Date ? v.toISOString() :
            typeof v === 'object' && v !== null ? JSON.stringify(v) :
            v,
          );
          sheet.addRow(values);
        }
      }
    }

    // Monthly data (filtered by period)
    const monthlyModels = [
      { name: 'employee_advances', model: this.prisma.employeeAdvance, dateField: 'issueDate' },
      { name: 'employee_bonuses', model: this.prisma.employeeBonus, dateField: 'createdAt' },
      { name: 'employee_penalties', model: this.prisma.employeePenalty, dateField: 'issueDate' },
      { name: 'leave_requests', model: this.prisma.leaveRequest, dateField: 'startDate' },
      { name: 'attendance_records', model: this.prisma.attendanceRecord, dateField: 'timestamp' },
      { name: 'daily_attendance_logs', model: this.prisma.dailyAttendanceLog, dateField: 'date' },
      { name: 'payroll_runs', model: this.prisma.payrollRun, dateField: 'periodStart' },
    ];

    for (const { name, model, dateField } of monthlyModels) {
      this.logger.log(`Exporting ${name} for ${period}...`);
      const sheet = workbook.addWorksheet(name);

      let offset = 0;
      let isFirstBatch = true;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const records = await (model as any).findMany({
          where: {
            [dateField]: { gte: startDate, lte: endDate },
          },
          skip: offset,
          take: BATCH_SIZE,
        });

        if (records.length === 0) break;

        if (isFirstBatch && records.length > 0) {
          sheet.addRow(Object.keys(records[0]));
          isFirstBatch = false;
        }

        for (const record of records) {
          const values = Object.values(record).map((v) =>
            v instanceof Date ? v.toISOString() :
            typeof v === 'object' && v !== null ? JSON.stringify(v) :
            v,
          );
          sheet.addRow(values);
        }

        offset += BATCH_SIZE;
        if (records.length < BATCH_SIZE) break;
      }
    }

    // Payroll items for this month
    const payrollRuns = await this.prisma.payrollRun.findMany({
      where: { periodStart: { gte: startDate, lte: endDate } },
      select: { id: true },
    });

    if (payrollRuns.length > 0) {
      this.logger.log(`Exporting payroll_items for ${period}...`);
      const sheet = workbook.addWorksheet('payroll_items');
      const runIds = payrollRuns.map((r) => r.id);

      let offset = 0;
      let isFirstBatch = true;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const records = await this.prisma.payrollItem.findMany({
          where: { payrollRunId: { in: runIds } },
          skip: offset,
          take: BATCH_SIZE,
        });

        if (records.length === 0) break;

        if (isFirstBatch && records.length > 0) {
          sheet.addRow(Object.keys(records[0]));
          isFirstBatch = false;
        }

        for (const record of records) {
          const values = Object.values(record).map((v) =>
            v instanceof Date ? v.toISOString() :
            typeof v === 'object' && v !== null ? JSON.stringify(v) :
            v,
          );
          sheet.addRow(values);
        }

        offset += BATCH_SIZE;
        if (records.length < BATCH_SIZE) break;
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
