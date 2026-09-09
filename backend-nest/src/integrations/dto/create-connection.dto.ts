import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IntegrationProvider } from '@prisma/client';

export class CreateConnectionDto {
  @IsEnum(IntegrationProvider)
  provider: IntegrationProvider;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  /** Stored encrypted; never returned by any endpoint. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiSecret?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  /** products | stock | orders | customers */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  syncEntities?: string[];

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  syncInterval?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
