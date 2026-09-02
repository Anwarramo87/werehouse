import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReceiveGoodsItemDto {
  @IsUUID()
  @IsNotEmpty()
  purchaseOrderItemId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  location: string;
}

export class ReceiveGoodsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReceiveGoodsItemDto)
  items: ReceiveGoodsItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /**
   * Client-supplied receipt number, used as the idempotency key.
   *
   * `receiptNumber` is already unique per factory (`@@unique([tenantId,
   * receiptNumber])`), so sending the same one twice returns the receipt created
   * the first time instead of receiving the goods again. Retries after a network
   * timeout are then safe.
   *
   * Omitted, the server generates one as before -- and a retry WILL receive the
   * goods a second time, because there is nothing to recognise it by.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  receiptNumber?: string;
}
