import { PartialType, OmitType } from '@nestjs/swagger';
import { CreatePriceTierDto } from './create-price-tier.dto';

export class UpdatePriceTierDto extends PartialType(OmitType(CreatePriceTierDto, ['code'] as const)) {}
