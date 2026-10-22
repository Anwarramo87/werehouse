import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PurchaseInvoiceItemDto } from './create-purchase-invoice.dto';

export class UpdatePurchaseInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierInvoiceNumber?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  /** العملة الأصلية للفاتورة */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  /** سعر الصرف المعتمد — مطلوب عندما تكون العملة أصلاً غير الليرة */
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

  /** When present, replaces every line — partial line edits are not supported. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseInvoiceItemDto)
  items?: PurchaseInvoiceItemDto[];
}
