import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class StockMovementQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsIn(['IN', 'OUT', 'ADJUSTMENT', 'RESERVE', 'RELEASE'])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}
