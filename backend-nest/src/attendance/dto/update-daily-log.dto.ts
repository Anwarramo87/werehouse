import { IsEnum, IsNumber, IsOptional, IsDateString, IsString, Min } from 'class-validator';
import { DailyRecordType } from '@prisma/client';

export class UpdateDailyLogDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsEnum(DailyRecordType)
  recordType?: DailyRecordType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  source?: string;
}
