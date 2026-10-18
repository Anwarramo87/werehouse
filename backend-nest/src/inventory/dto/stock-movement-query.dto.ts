import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class StockMovementQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsIn(['IN', 'OUT', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'PURCHASE_RECEIPT', 'PRODUCTION_OUTPUT', 'RETURN_TO_STOCK', 'SALES_SHIPMENT', 'PRODUCTION_CONSUMPTION', 'DAMAGE_LOSS', 'WAREHOUSE_TRANSFER'])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @IsOptional()
  @IsIn(['purchase', 'production', 'sales', 'warehouse', 'manual', 'transfer'])
  category?: string;
}
