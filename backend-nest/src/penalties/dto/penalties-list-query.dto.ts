import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

export class PenaltiesListQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be in YYYY-MM format' })
  period?: string;
}
