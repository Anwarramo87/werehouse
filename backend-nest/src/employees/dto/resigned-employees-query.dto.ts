import { Transform, Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ResignedEmployeesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (value && value.trim() ? value.trim() : undefined))
  department?: string;

  @IsOptional()
  @IsString()
  @IsIn(['resignation', 'termination'])
  @Transform(({ value }) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!v || v === 'all' || v === '') return undefined;
    return v;
  })
  type?: 'resignation' | 'termination';

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'completed'])
  @Transform(({ value }) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!v || v === 'all' || v === '') return undefined;
    return v;
  })
  financialStatus?: 'pending' | 'completed';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (value && value.trim() ? value.trim() : undefined))
  search?: string;

  /**
   * Which month's departures to return.
   *
   * `current` / `previous` / `all` are relative to today. An explicit
   * `YYYY-MM` selects one calendar month -- without it a past month such as
   * 2026-05 is unreachable: it is neither `current` nor distinguishable inside
   * `previous`, which means "everything before this month".
   */
  @IsOptional()
  @IsString()
  @Matches(/^(current|previous|all|\d{4}-(0[1-9]|1[0-2]))$/, {
    message: 'month must be current, previous, all, or YYYY-MM',
  })
  @Transform(({ value }) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!v || v === '') return 'all';
    return v;
  })
  month?: string;
}
