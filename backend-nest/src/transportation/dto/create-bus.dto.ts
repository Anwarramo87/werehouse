import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBusDto {
  /** الخط / مسار الرحلة */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  route: string;

  /** رقم اللوحة (أرقام وحروف) */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9\u0600-\u06FF\s\-]+$/, {
    message: 'plateNumber must contain only letters, numbers, Arabic characters, spaces, or hyphens',
  })
  @MaxLength(20)
  plateNumber: string;

  /** اسم السائق */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  driverName: string;

  /** رقم السائق — رقم سوري 10 أرقام */
  @IsString()
  @Matches(/^(09[0-9]{8}|[0-9]{9})$/, { message: 'driverPhone must be a valid Syrian mobile number' })
  driverPhone: string;

  /** التكلفة الإجمالية (ل.س) */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  totalCost: number;

  /** حسم الشركة بالنسبة المئوية (0-100) */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @Type(() => Number)
  companyDeductionPct: number;

  /** حسم موظف الرحلة بالنسبة المئوية (0-100) */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @Type(() => Number)
  employeeDeductionPct?: number;

  /** سعة الركاب */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  capacity: number;
}
