import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecordCountLineDto {
  @IsUUID()
  itemId: string;

  @IsInt()
  @Min(0)
  countedQuantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Batched so a handheld can sync a whole aisle in one request. */
export class RecordCountDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecordCountLineDto)
  lines: RecordCountLineDto[];
}
