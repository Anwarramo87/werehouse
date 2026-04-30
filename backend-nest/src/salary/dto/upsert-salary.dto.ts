import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpsertSalaryDto {
  @IsOptional()
  @IsString()
  profession?: string;

  /** الراتب الأساسي الكلي */
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  baseSalary: number;

  /** الراتب المقطوع */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  lumpSumSalary?: number;

  /** بدل غلاء معيشة */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  livingAllowance?: number;

  /** تعويض مسؤولية (50% من الفرق — يُحسب تلقائياً إذا لم يُرسل) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  responsibilityAllowance?: number;

  /** تعويض جهد إضافي (30% من الفرق — يُحسب تلقائياً إذا لم يُرسل) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  extraEffortAllowance?: number;

  /** تعويض حوافز إنتاجية (20% من الفرق — يُحسب تلقائياً إذا لم يُرسل) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  productionIncentive?: number;

  /** التأمينات — تُدخل يدوياً */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  insuranceAmount?: number;

  /** بدل النقل */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  transportAllowance?: number;
}
