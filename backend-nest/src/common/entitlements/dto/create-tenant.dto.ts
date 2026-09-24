import { IsOptional, IsString, Length } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /** Unique factory code. When omitted the server derives one from the name. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  code?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}
