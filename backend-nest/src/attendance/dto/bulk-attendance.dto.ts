import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsString, IsNumber, IsOptional, IsISO8601, ValidateNested } from 'class-validator';

export enum AttendanceType {
  IN = 'IN',
  OUT = 'OUT',
}

export class BulkAttendanceItemDto {
  @IsString()
  employeeId: string;

  @IsISO8601()
  timestamp: string;

  @IsEnum(AttendanceType)
  @IsOptional()
  type?: AttendanceType;

  @IsString()
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  deviceId?: string;

  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsNumber()
  @IsOptional()
  confidence?: number;
}

export class BulkAttendanceDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkAttendanceItemDto)
  records: BulkAttendanceItemDto[];
}
