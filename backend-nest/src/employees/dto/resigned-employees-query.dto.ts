import { Transform, Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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

  @IsOptional()
  @IsString()
  @IsIn(['current', 'previous', 'all'])
  @Transform(({ value }) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!v || v === '') return 'all';
    return v;
  })
  month?: 'current' | 'previous' | 'all';
}
