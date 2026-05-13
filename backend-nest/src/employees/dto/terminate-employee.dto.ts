import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TerminateEmployeeDto {
  @IsNotEmpty()
  @IsDateString()
  terminationDate: string;

  @IsOptional()
  @IsString()
  terminationReason?: string;
}
