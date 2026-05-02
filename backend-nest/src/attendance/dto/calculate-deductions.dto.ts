import { IsDateString, IsOptional, IsNumber, IsUUID } from 'class-validator';

export class CalculateDeductionsDto {
  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsOptional()
  @IsNumber()
  gracePeriodMinutes?: number;

  @IsOptional()
  @IsNumber()
  workDaysInPeriod?: number;

  @IsOptional()
  @IsNumber()
  hoursPerDay?: number;

  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
