import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class BonusesListQueryDto {
  /** فلترة بالموظف */
  @IsOptional()
  @IsString()
  employeeId?: string;

  /** فلترة بالفترة (YYYY-MM) */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be in YYYY-MM format' })
  period?: string;

  /** بحث نصي (اسم الموظف أو السبب) */
  @IsOptional()
  @IsString()
  search?: string;

  /** نوع المكافأة: bonus | assistance */
  @IsOptional()
  @IsIn(['bonus', 'assistance', 'all'])
  type?: 'bonus' | 'assistance' | 'all';

  /** تاريخ البداية (YYYY-MM-DD) */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** تاريخ النهاية (YYYY-MM-DD) */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** رقم الصفحة */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  /** عدد النتائج في الصفحة */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}
