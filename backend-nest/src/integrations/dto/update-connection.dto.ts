import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateConnectionDto } from './create-connection.dto';

/** `provider` is part of the connection's identity and does not change. */
export class UpdateConnectionDto extends PartialType(
  OmitType(CreateConnectionDto, ['provider'] as const),
) {}
