import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PurchaseInvoiceItemDto {
  @IsOptional()
  @IsUUID()
  purchaseOrderItemId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku: string;

  /** Required by the service when the product is batch-tracked. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchNumber?: string;

  @IsOptional()
  @IsDateString()
  productionDate?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0)
  unitCost: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;
}

export class CreatePurchaseInvoiceDto {
  @IsUUID()
  supplierId: string;

  /** The number printed on the supplier's own paperwork. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierInvoiceNumber?: string;

  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @IsOptional()
  @IsUUID()
  goodsReceiptId?: string;

  @IsDateString()
  invoiceDate: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  /**
   * سعر الصرف المعتمد — REQUIRED when the currency is not the base currency.
   *
   * The user must state the rate that was adopted, and the date it applies
   * to. A rate is never looked up silently for the user: an invoice is a
   * statement of what was agreed on a specific day, and a rate that drifts
   * after the fact must not rewrite it.
   */
  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  exchangeRate?: number;

  /** تاريخ سعر الصرف المعتمد */
  @IsOptional()
  @IsDateString()
  exchangeRateDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseInvoiceItemDto)
  items: PurchaseInvoiceItemDto[];
}
