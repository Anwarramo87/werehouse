import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ZoneType } from '@prisma/client';

export class CreateZoneDto {
  @IsUUID()
  warehouseId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsEnum(ZoneType)
  type?: ZoneType;

  /** Lower runs earlier in a pick route. */
  @IsOptional()
  @IsInt()
  @Min(0)
  pickSequence?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
