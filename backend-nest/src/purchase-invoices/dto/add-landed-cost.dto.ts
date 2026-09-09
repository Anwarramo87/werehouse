import { IsEnum, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AllocationMethod } from '@prisma/client';

export class AddLandedCostDto {
  @IsIn(['freight', 'customs', 'insurance', 'handling', 'other'])
  type: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsNumber()
  @Min(0)
  amount: number;

  /** VALUE by default — customs and duty follow line value, freight weight. */
  @IsOptional()
  @IsEnum(AllocationMethod)
  allocationMethod?: AllocationMethod;
}
