import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCarrierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactPhone?: string;

  /** `{tracking}` is substituted with the shipment's tracking number. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  trackingUrlTemplate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
