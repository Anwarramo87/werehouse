import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateExpiryRuleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Scope. Leave both empty for the factory-wide default rule. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  warnDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  criticalDays?: number;

  /** Days before expiry at which the batch is quarantined. 0 disables it. */
  @IsOptional()
  @IsInt()
  @Min(0)
  blockDays?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyEmails?: string[];

  @IsOptional()
  @IsBoolean()
  notifySales?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
