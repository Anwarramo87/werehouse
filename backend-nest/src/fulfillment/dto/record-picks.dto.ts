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

export class RecordPickLineDto {
  @IsUUID()
  itemId: string;

  @IsInt()
  @Min(0)
  quantityPicked: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class RecordPicksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecordPickLineDto)
  lines: RecordPickLineDto[];
}
