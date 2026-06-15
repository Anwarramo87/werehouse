

import { 
  IsString, 
  IsNumber, 
  IsOptional, 
  IsEnum, 
  IsDateString, 
  Matches, 
  Min, 
  MaxLength 
} from 'class-validator';

// تعريف الـ Enum لنوع السلفة
export enum AdvanceType {
  SALARY = 'salary',
  CLOTHING = 'clothing',
  OTHER = 'other',
}

export class CreateAdvanceDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsOptional()
  @IsEnum(AdvanceType)
  advanceType?: AdvanceType;

  @IsNumber()
  @Min(1)
  totalAmount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  installmentAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be in YYYY-MM format' })
  period?: string;
}