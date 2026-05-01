import { IsOptional, IsString, Matches } from 'class-validator';

export class DiscountsListQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId?: string;
}
