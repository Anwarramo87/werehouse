import { IsArray, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class RecordInspectionDto {
  @IsInt()
  @Min(0)
  quantityPassed: number;

  /** Defaults to whatever was inspected but did not pass. */
  @IsOptional()
  @IsInt()
  @Min(0)
  quantityFailed?: number;

  @IsOptional()
  @IsArray()
  checklist?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  failureReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
