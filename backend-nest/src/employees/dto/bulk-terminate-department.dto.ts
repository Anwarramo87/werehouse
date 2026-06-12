import { IsDateString, IsNotEmpty, IsOptional, IsString, IsIn } from 'class-validator';

export class BulkTerminateDepartmentDto {
  @IsNotEmpty()
  @IsString()
  department: string;

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
