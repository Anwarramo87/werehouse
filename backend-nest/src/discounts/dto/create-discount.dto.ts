import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { AdvanceType } from '../../advances/dto/create-advance.dto';

export enum DiscountKind {
  ADVANCE = 'advance',
  ASSISTANCE = 'assistance',
}

export class CreateDiscountDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsOptional()
  @IsEnum(DiscountKind)
  kind?: DiscountKind;

  @IsOptional()
  @IsEnum(AdvanceType)
  advanceType?: AdvanceType;

  @IsString()
  @MaxLength(100)
  type: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
