import {
  IsDateString,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEmployeeDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/, { message: 'employeeId must match EMP followed by 3+ digits' })
  employeeId: string;

  /** الاسم الثلاثي */
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  /** رقم الموبايل */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  mobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationalId?: string;

  /** تاريخ الميلاد */
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  /** الجنس: male | female */
  @IsOptional()
  @IsIn(['male', 'female'])
  gender?: string;

  /** المسمى الوظيفي */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  /** القسم التابع له */
  @IsOptional()
  @IsString()
  department?: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  hourlyRate: number;

  /** الراتب الكلي */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  baseSalary?: number;

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

  @IsString()
  @IsNotEmpty()
  roleId: string;

  /** وقت بداية الدوام (HH:mm) */
  @IsOptional()
  @IsString()
  scheduledStart?: string;

  /** وقت نهاية الدوام (HH:mm) */
  @IsOptional()
  @IsString()
  scheduledEnd?: string;

  @IsOptional()
  @IsDateString()
  employmentStartDate?: string;

  @IsOptional()
  @IsDateString()
  terminationDate?: string;
}
