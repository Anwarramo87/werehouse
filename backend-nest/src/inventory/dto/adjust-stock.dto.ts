import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdjustStockDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  location: string;

  /** Signed delta: positive = add stock, negative = remove stock. */
  @IsNumber()
  change: number;

  /** Movement type. When omitted it is derived from the sign of `change`. */
  @IsOptional()
  @IsIn(['IN', 'OUT', 'ADJUSTMENT', 'PURCHASE_RECEIPT', 'PRODUCTION_OUTPUT', 'RETURN_TO_STOCK', 'SALES_SHIPMENT', 'PRODUCTION_CONSUMPTION', 'DAMAGE_LOSS', 'WAREHOUSE_TRANSFER'])
  type?: 'IN' | 'OUT' | 'ADJUSTMENT' | 'PURCHASE_RECEIPT' | 'PRODUCTION_OUTPUT' | 'RETURN_TO_STOCK' | 'SALES_SHIPMENT' | 'PRODUCTION_CONSUMPTION' | 'DAMAGE_LOSS' | 'WAREHOUSE_TRANSFER';

  @IsString()
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  referenceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  referenceId?: string;
}
