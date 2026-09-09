import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateTaxRateDto } from './create-tax-rate.dto';

/** `code` is the business key other rows are matched on — it does not change. */
export class UpdateTaxRateDto extends PartialType(OmitType(CreateTaxRateDto, ['code'] as const)) {}
