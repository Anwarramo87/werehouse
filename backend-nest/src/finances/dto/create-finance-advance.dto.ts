import { IsDateString, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { AdvanceType } from '../../advances/dto/create-advance.dto';

export class CreateFinanceAdvanceDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsDateString()
  date: string;

  @IsOptional()
  advanceType?: AdvanceType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  installmentAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
