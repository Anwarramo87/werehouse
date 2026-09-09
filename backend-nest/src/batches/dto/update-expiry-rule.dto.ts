import { PartialType } from '@nestjs/swagger';
import { CreateExpiryRuleDto } from './create-expiry-rule.dto';

export class UpdateExpiryRuleDto extends PartialType(CreateExpiryRuleDto) {}
