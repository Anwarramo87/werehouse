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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEmployeeDto {
  @ApiProperty({ description: 'رقم الموظف (EMP + 3 أرقام أو أكثر)', example: 'EMP001' })
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/, { message: 'employeeId must match EMP followed by 3+ digits' })
  employeeId: string;

  @ApiProperty({ description: 'الاسم الثلاثي للموظف', example: 'أحمد محمد سالم' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'اسم المستخدم لتسجيل الدخول', example: 'ahmed.salem' })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiPropertyOptional({ description: 'كلمة المرور الأولية', example: 'TempPass@2025' })
  @IsString()
  @IsOptional()
  password: string;

  @ApiPropertyOptional({ description: 'رقم الجوال', example: '0501234567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  mobile?: string;

  @ApiPropertyOptional({ description: 'رقم الهوية الوطنية', example: '1234567890' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationalId?: string;

  @ApiPropertyOptional({ description: 'تاريخ الميلاد', example: '1990-05-15' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'تاريخ الميلاد (اسم بديل من الفرونت)', example: '1990-05-15' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ description: 'الجنس', enum: ['male', 'female'], example: 'male' })
  @IsOptional()
  @IsIn(['male', 'female'])
  gender?: string;

  @ApiPropertyOptional({ description: 'المسمى الوظيفي', example: 'مشرف مستودعات' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @ApiPropertyOptional({ description: 'المسمى الوظيفي (اسم موحّد)', example: 'مشرف مستودعات' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  profession?: string;

  @ApiPropertyOptional({ description: 'اسم القسم', example: 'المستودعات' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'الأجر بالساعة', example: 25.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  hourlyRate?: number;

  @ApiPropertyOptional({ description: 'الراتب الأساسي الكلي (شامل جميع البنود)', example: 1500000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  baseSalary?: number;

  @ApiPropertyOptional({ description: 'الراتب المقطوع', example: 700000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  lumpSumSalary?: number;

  @ApiPropertyOptional({ description: 'بدل غلاء المعيشة', example: 300000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  livingAllowance?: number;

  @ApiProperty({ description: 'معرّف الدور (Role ID)', example: 'clx1234abc', required: false })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({ description: 'وقت بداية الدوام (HH:mm)', example: '08:00' })
  @IsOptional()
  @IsString()
  scheduledStart?: string;

  @ApiPropertyOptional({ description: 'وقت نهاية الدوام (HH:mm)', example: '17:00' })
  @IsOptional()
  @IsString()
  scheduledEnd?: string;

  @ApiPropertyOptional({ description: 'تاريخ بداية الخدمة', example: '2020-01-01' })
  @IsOptional()
  @IsDateString()
  employmentStartDate?: string;

  @ApiPropertyOptional({ description: 'تاريخ انتهاء الخدمة', example: '2025-12-31' })
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

  @ApiPropertyOptional({ description: 'عدد ساعات العمل في اليوم', example: 9 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  hoursPerDay?: number;

  @ApiPropertyOptional({ description: 'فترة السماح بالتأخير بالدقائق قبل الخصم', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  gracePeriodMinutes?: number;

  @ApiPropertyOptional({ description: 'مكان الإقامة', example: 'بغداد - الكرخ' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  residence?: string;
}
