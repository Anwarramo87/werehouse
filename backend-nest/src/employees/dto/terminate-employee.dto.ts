import { IsDateString, IsNotEmpty, IsOptional, IsString, IsIn } from 'class-validator';

export class TerminateEmployeeDto {
  @IsNotEmpty()
  @IsDateString()
  terminationDate: string;

  @IsNotEmpty()
  @IsString()
  @IsIn(['resignation', 'termination'])
  terminationType: 'resignation' | 'termination';

  @IsOptional()
  @IsString()
  terminationReason?: string;

  @IsOptional()
  @IsString()
  terminationNotes?: string;
}
