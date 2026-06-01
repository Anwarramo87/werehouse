import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

const TIME_HH_MM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

  // ── حقول الإجازة الساعية ──────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  isHourly?: boolean;

  @IsOptional()
  @IsString()
  @Matches(TIME_HH_MM_REGEX, { message: 'startTime must be HH:mm format' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_HH_MM_REGEX, { message: 'endTime must be HH:mm format' })
  endTime?: string;
}

// ── Bulk Create DTO ──────────────────────────────────────────────────────────
export const BULK_LEAVE_REQUEST_MAX_ITEMS = 500;

export class BulkCreateLeaveRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_LEAVE_REQUEST_MAX_ITEMS, {
    message: `لا يمكن إرسال أكثر من ${BULK_LEAVE_REQUEST_MAX_ITEMS} طلب إجازة دفعة واحدة`,
  })
  @ValidateNested({ each: true })
  @Type(() => CreateLeaveRequestDto)
  items: CreateLeaveRequestDto[];
}
