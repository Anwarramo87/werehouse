import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class EmployeesListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (value && value.trim() ? value.trim() : undefined))
  department?: string;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'inactive', 'terminated', 'resigned'])
  @Transform(({ value }) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!v || v === 'all' || v === '') return undefined;
    return v;
  })
  status?: 'active' | 'inactive' | 'terminated' | 'resigned';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (value && value.trim() ? value.trim() : undefined))
  search?: string;
}
