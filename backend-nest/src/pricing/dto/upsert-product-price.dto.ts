import { IsDateString, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class UpsertProductPriceDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsUUID()
  priceTierId: string;

  @IsNumber()
  @Min(0)
  price: number;

  /** Quantity break: this price applies from this quantity upward. */
  @IsOptional()
  @IsInt()
  @Min(1)
  minQuantity?: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;
}
