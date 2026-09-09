import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBinDto {
  @IsUUID()
  zoneId: string;

  /** Also the value written into stock_levels.location — keep it short. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  aisle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  rack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  position?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxWeightKg?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxVolumeM3?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  capacityUnits?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pickPriority?: number;

  /** Fixed slotting: reserves the bin for one product. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dedicatedSku?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
