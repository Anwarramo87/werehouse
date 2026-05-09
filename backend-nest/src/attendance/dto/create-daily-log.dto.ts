import { IsString, IsEnum, IsNumber, IsOptional, IsDateString, Min } from 'class-validator';
import { DailyRecordType } from '@prisma/client';

export class CreateDailyLogDto {
  @IsString()
  employeeId: string;

  @IsDateString()
  date: string; // YYYY-MM-DD format

  @IsEnum(DailyRecordType)
  recordType: DailyRecordType;

  @IsNumber()
  @Min(0)
  value: number; // e.g., 1 for 1 day absence, 120 for 120 minutes delay

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  source?: string; // manual | biometric | calculated

  @IsOptional()
  @IsString()
  createdBy?: string;
}
