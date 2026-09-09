import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A gateway handing over what a reader saw.
 *
 * Barcode scanners read one label at a time; an RFID portal sweeps a pallet
 * and returns dozens of EPCs at once. This endpoint takes that whole sweep in
 * one call — resolving them one HTTP request at a time is what makes RFID
 * unusable in practice.
 */
export class BulkScanDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  codes: string[];

  /** Where the reader is mounted, recorded on the response for context. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  readerLocation?: string;

  /** What produced the read. Only affects reporting, not resolution. */
  @IsOptional()
  @IsIn(['barcode', 'rfid', 'manual'])
  source?: string;
}
