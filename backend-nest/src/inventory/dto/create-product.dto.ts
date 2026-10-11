import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  category: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsNumber()
  costPrice: number;

  @IsOptional()
  @IsNumber()
  profitPercent?: number;

  @IsOptional()
  @IsIn(['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED'])
  productType?: 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED';

  @IsOptional()
  @IsNumber()
  reorderLevel?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  photo?: string;

  @IsOptional()
  batchTracked?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  feature?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  barcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string;
}
