import { Body, Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('salary')
@Controller('salary/public')
export class SalaryPublicController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('calculate')
  @ApiOperation({ summary: 'Calculate salary for an employee for a specific month' })
  async calculateSalary(
    @Query('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: number,
  ) {
    if (!employeeId || !month || !year) {
      throw new BadRequestException('employeeId, month, and year are required');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { employeeId },
    });

    if (!employee) {
      throw new BadRequestException('Employee not found');
    }

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, Number(month), 0).toISOString().slice(0, 10);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
        type: 'IN',
      },
    });

    let totalHours = 0;
    const shiftPairs: any[] = [];

    for (const record of records) {
      const shiftPair = record.shiftPair as any;
      if (shiftPair?.hoursWorked) {
        totalHours += Number(shiftPair.hoursWorked);
      } else {
        const outRecord = await this.prisma.attendanceRecord.findFirst({
          where: {
            employeeId,
            date: record.date,
            type: 'OUT',
          },
        });
        if (outRecord && !shiftPair) {
          const hours = (outRecord.timestamp.getTime() - record.timestamp.getTime()) / (1000 * 60 * 60);
          totalHours += hours;
          shiftPairs.push({ date: record.date, hoursWorked: hours });
        }
      }
    }

    const hourlyRate = Number(employee.hourlyRate) || 0;
    const grossSalary = totalHours * hourlyRate;
    const deductions = 0;
    const netSalary = grossSalary - deductions;

    return {
      employeeId,
      employeeName: employee.name,
      period: { startDate, endDate },
      hoursWorked: Math.round(totalHours * 100) / 100,
      hourlyRate,
      grossSalary: Math.round(grossSalary * 100) / 100,
      deductions,
      netSalary: Math.round(netSalary * 100) / 100,
    };
  }
}