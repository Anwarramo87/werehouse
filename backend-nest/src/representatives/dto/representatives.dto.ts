import {
  IsString,
  IsOptional,
  IsEmail,
  IsUUID,
  IsNumber,
  IsPositive,
  IsArray,
  IsDateString,
  IsEnum,
  Min,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ---------------------------------------------------------------------------
// Representative CRUD
// ---------------------------------------------------------------------------

export class CreateRepresentativeDto {
  @IsUUID()
  userId: string; // حساب المستخدم المرتبط بالمندوب

  @IsString()
  name: string;

  @IsString()
  code: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateRepresentativeDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export class CreateRepRouteDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  areas?: string[];

  @IsString()
  @IsOptional()
  schedule?: string;
}

// ---------------------------------------------------------------------------
// Assign customers / products
// ---------------------------------------------------------------------------

export class AssignCustomersDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  customerIds: string[];
}

export class AssignProductsDto {
  @IsArray()
  @IsString({ each: true })
  skus: string[];
}

// ---------------------------------------------------------------------------
// Stock Transfer (Warehouse → Representative)
// ---------------------------------------------------------------------------

export class TransferStockItemDto {
  @IsString()
  sku: string;

  @IsNumber()
  @IsPositive()
  quantity: number;
}

export class TransferStockToRepDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferStockItemDto)
  items: TransferStockItemDto[];

  @IsString()
  @IsOptional()
  warehouseLocation?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

/** إعادة مخزون من المندوب إلى المخزن الرئيسي */
export class TransferStockFromRepDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferStockItemDto)
  items: TransferStockItemDto[];

  @IsString()
  @IsOptional()
  warehouseLocation?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export class RepSaleItemDto {
  @IsString()
  sku: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsNumber()
  @IsPositive()
  unitPrice: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  discountPercent?: number;
}

export class CreateRepSaleDto {
  @IsUUID()
  customerId: string;

  @IsDateString()
  saleDate: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RepSaleItemDto)
  items: RepSaleItemDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  discountAmount?: number;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export class CreateRepCollectionDto {
  @IsUUID()
  customerId: string;

  @IsUUID()
  @IsOptional()
  saleId?: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsOptional()
  method?: string;

  @IsDateString()
  collectionDate: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export class CreateRepReturnDto {
  @IsUUID()
  customerId: string;

  @IsUUID()
  @IsOptional()
  saleId?: string;

  @IsString()
  sku: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsNumber()
  @IsPositive()
  unitPrice: number;

  @IsString()
  @IsOptional()
  reason?: string;

  @IsDateString()
  returnDate: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export class CreateSettlementDto {
  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsArray()
  @IsOptional()
  actualStock?: Array<{ sku: string; quantity: number }>;

  @IsString()
  @IsOptional()
  varianceReason?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class ApproveSettlementDto {
  @IsBoolean()
  @IsOptional()
  approved?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}

// ---------------------------------------------------------------------------
// Query DTOs
// ---------------------------------------------------------------------------

export class RepQueryDto {
  @IsString()
  @IsOptional()
  status?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class RepSaleQueryDto {
  @IsString()
  @IsOptional()
  status?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
