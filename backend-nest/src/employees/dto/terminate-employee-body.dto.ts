import { IsDateString, IsNotEmpty, IsOptional, IsString, IsIn, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for POST /employees/terminate
 * Uses class-validator instead of Zod for consistency with the rest of the codebase.
 */
export class TerminateEmployeeBodyDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsNotEmpty()
  @IsDateString()
  terminationDate: string;

  @IsNotEmpty()
  @IsString()
  @IsIn(['resignation', 'termination'])
  terminationType: 'resignation' | 'termination';

  @IsNotEmpty()
  @IsString()
  @MinLength(10, { message: 'Reason must be at least 10 characters' })
  @MaxLength(500, { message: 'Reason must not exceed 500 characters' })
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Notes must not exceed 1000 characters' })
  notes?: string;
}
