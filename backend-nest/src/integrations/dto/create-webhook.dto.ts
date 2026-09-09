import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  url: string;

  /** e.g. stock.changed, batch.expiring, shipment.dispatched */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  /** Signs deliveries with HMAC-SHA256. Generated when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
