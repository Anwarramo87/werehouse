import { IsDateString, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class CreatePenaltyDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsString()
  @MaxLength(50)
  category: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;
}
