import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsPositive,
  Min,
  Max,
  IsDateString,
  IsUUID,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductionStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// BOM DTOs
// ---------------------------------------------------------------------------

export class BOMItemDto {
  @IsString()
  materialSku: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsString()
  @IsOptional()
  unit?: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  wastePercent?: number;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class CreateBOMDto {
  @IsString()
  productSku: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BOMItemDto)
  items: BOMItemDto[];

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateBOMDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BOMItemDto)
  @IsOptional()
  items?: BOMItemDto[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Production Order DTOs
// ---------------------------------------------------------------------------

export class CreateProductionOrderDto {
  @IsUUID()
  bomId: string;

  @IsNumber()
  @IsPositive()
  plannedQty: number;

  @IsDateString()
  plannedDate: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  laborCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  overheadCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  packagingCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherCost?: number;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class CompleteProductionOrderDto {
  @IsNumber()
  @IsPositive()
  actualQty: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  wasteQty?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  laborCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  overheadCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  packagingCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherCost?: number;

  @IsString()
  @IsOptional()
  warehouseLocation?: string;

  @IsString()
  @IsOptional()
  batchNumber?: string;

  @IsDateString()
  @IsOptional()
  batchExpiryDate?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateProductionOrderStatusDto {
  @IsEnum(ProductionStatus)
  status: ProductionStatus;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class ProductionOrderQueryDto {
  @IsEnum(ProductionStatus)
  @IsOptional()
  status?: ProductionStatus;

  @IsString()
  @IsOptional()
  productSku?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
