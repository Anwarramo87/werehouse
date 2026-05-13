import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';

export enum LeaveRequestTypeDto {
  PAID = 'PAID',
  UNPAID = 'UNPAID',
  SICK = 'SICK',
  ADMIN = 'ADMIN',
  DEATH = 'DEATH',
  OTHER = 'OTHER',
}

export enum LeaveRequestStatusDto {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export class CreateLeaveRequestDto {
  @IsString()
  @Matches(/^EMP[0-9]{3,}$/)
  employeeId: string;

  @IsEnum(LeaveRequestTypeDto)
  leaveType: LeaveRequestTypeDto;

  @IsOptional()
  @IsEnum(LeaveRequestStatusDto)
  status?: LeaveRequestStatusDto;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
