import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PickStrategy } from '@prisma/client';

export class CreatePickListDto {
  /** Required for every strategy except WAVE, which pulls open orders itself. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  salesOrderIds?: string[];

  @IsOptional()
  @IsEnum(PickStrategy)
  strategy?: PickStrategy;

  /** ZONE only: restricts the list to bins inside this zone. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  zoneCode?: string;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  /** WAVE only: how many open orders to sweep into the wave. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxOrders?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
