import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

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

  // الفرونت يطلب تعديلات الشهر كاملةً (limit=500) — بدونها كان الباك
  // يرجع 50 فقط ويُسقط تعديلات بصمت. البايب العام forbidNonWhitelisted
  // يرفض أي بارامتر غير مصرّح به هنا (400)، لذا التوثيق إلزامي.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
