import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Generates `PREFIX-<aisle>-<rack>-<level>` across a rack layout. */
export class BulkCreateBinsDto {
  @IsUUID()
  zoneId: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  prefix?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  aisles: string[];

  @IsInt()
  @Min(1)
  @Max(100)
  racksPerAisle: number;

  @IsInt()
  @Min(1)
  @Max(20)
  levelsPerRack: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  capacityUnits?: number;
}
