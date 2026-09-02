import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class InventoryProductsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'inactive'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /**
   * Whitelisted so the value can go straight into Prisma's `orderBy` without
   * letting a caller name an arbitrary column.
   */
  @IsOptional()
  @IsIn(['name', 'sku', 'category', 'unitPrice', 'costPrice', 'reorderLevel', 'status', 'createdAt'])
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}
