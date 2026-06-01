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

  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsOptional()
  password: string;

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

  /** تاريخ الميلاد (اسم قديم من الفرونت) */
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  /** الجنس: male | female */
  @IsOptional()
  @IsIn(['male', 'female'])
  gender?: string;

  /** المسمى الوظيفي */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  /** المسمى الوظيفي الموحّد مع الفرونت */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  profession?: string;

  /** القسم التابع له */
  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  hourlyRate?: number;

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

  /** نوع الإنهاء: استقالة أو إقالة */
  @IsOptional()
  @IsIn(['resignation', 'termination'])
  terminationType?: 'resignation' | 'termination';

  /** سبب الإنهاء */
  @IsOptional()
  @IsString()
  terminationReason?: string;

  /** ملاحظات الإنهاء */
  @IsOptional()
  @IsString()
  terminationNotes?: string;

  /** حالة التصفية المالية */
  @IsOptional()
  @IsIn(['pending', 'completed'])
  financialSettlementStatus?: 'pending' | 'completed';

  /** تاريخ التصفية المالية */
  @IsOptional()
  @IsDateString()
  financialSettlementDate?: string;

  /** تاريخ إعادة التعيين */
  @IsOptional()
  @IsDateString()
  rehireDate?: string;

  /** هل تمت التصفية المالية */
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  isFinanciallySettled?: string;

  /** عدد أيام العمل في الفترة */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  workDaysInPeriod?: number;

  /** عدد ساعات العمل في اليوم */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  hoursPerDay?: number;

  /** فترة السماح بالدقائق قبل خصم التأخير */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  gracePeriodMinutes?: number;

  /** مكان الإقامة (مدينة أو منطقة) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  residence?: string;
}
