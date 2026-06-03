import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FinancialSettlementDto {
  @IsNotEmpty()
  @IsString()
  employeeId: string;

  @IsNotEmpty()
  @IsDateString()
  settlementDate: string;

  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  finalSalaryAmount: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  deductions?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  bonuses?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}