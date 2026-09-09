import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCycleCountDto {
  @IsOptional()
  @IsIn(['cycle', 'full', 'spot'])
  type?: string;

  /** What to count. `scopeValue` names the zone / bin / SKU / category / class. */
  @IsOptional()
  @IsIn(['all', 'zone', 'bin', 'sku', 'category', 'abc'])
  scope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  scopeValue?: string;

  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
