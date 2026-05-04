import { IsDateString, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

export class UpsertPayrollInputDto {
  @IsString()
  employeeId: string;

  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsOptional()
  @IsInt()
  lateMinutes?: number;

  @IsOptional()
  @IsInt()
  earlyLeaveMinutes?: number;

  @IsOptional()
  @IsInt()
  absenceDays?: number;

  @IsOptional()
  @IsInt()
  sickLeaveDays?: number;

  @IsOptional()
  @IsInt()
  adminLeaveDays?: number;

  @IsOptional()
  @IsInt()
  unpaidLeaveDays?: number;

  @IsOptional()
  @IsInt()
  deathLeaveDays?: number;

  @IsOptional()
  @IsNumber()
  unpaidHours?: number;

  @IsOptional()
  @IsInt()
  overtimeRegularMinutes?: number;

  @IsOptional()
  @IsNumber()
  overtimeWeekendDays?: number;

  @IsOptional()
  @IsNumber()
  penaltyAmount?: number;

  @IsOptional()
  @IsNumber()
  clothingDeduction?: number;

  @IsOptional()
  @IsNumber()
  bonusAdjustment?: number;

  @IsOptional()
  @IsNumber()
  advanceAmount?: number;

  @IsOptional()
  @IsNumber()
  insuranceAmount?: number;

  @IsOptional()
  @IsNumber()
  transportAllowanceOverride?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class PayrollInputsQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}
