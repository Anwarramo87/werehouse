import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateInspectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku: string;

  @IsInt()
  @Min(1)
  quantityInspected: number;

  /** Naming a batch quarantines it for the duration of the inspection. */
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsOptional()
  @IsUUID()
  goodsReceiptId?: string;

  @IsOptional()
  @IsUUID()
  goodsReceiptItemId?: string;

  /** [{ criterion, expected, actual, passed }] */
  @IsOptional()
  @IsArray()
  checklist?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
