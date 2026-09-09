import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CompletePutawayDto {
  /** Where the goods actually went. Falls back to the suggested bin. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actualBin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
