import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * تسجيل حضور يومي لباص واحد: حضر / لم يحضر، مع التاريخ والملاحظات.
 *
 * The date is a DATE, not a timestamp: one row per bus per day, enforced by
 * the unique index on (tenantId, busId, attendDate). Re-recording the same
 * day updates the row rather than stacking a second one, so a day's record
 * cannot drift into "attended twice".
 */
export class RecordBusAttendanceDto {
  /** تاريخ اليوم (YYYY-MM-DD) */
  @IsDateString()
  attendDate: string;

  /** حضر = true، لم يحضر = false */
  @IsBoolean()
  @Type(() => Boolean)
  attended: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** تسجيل حضور عدة أيام دفعة واحدة — لتسوية شهر كامل. */
export class RecordBusAttendanceBatchDto {
  /** أيام الحضور لهذا الباص */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecordBusAttendanceDto)
  entries: RecordBusAttendanceDto[];
}

/** إعدادات التكلفة اليومية الافتراضية للباص. */
export class UpdateBusSettingsDto {
  /** التكلفة اليومية الافتراضية (ل.س) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  defaultDailyCost?: number;

  /** عدد أيام العمل في الشهر المستخدمة في احتساب التكلفة الشهرية */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  @Type(() => Number)
  workingDaysPerMonth?: number;
}

/** استعلام تفصيل باص واحد. */
export class BusDetailQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
