import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { LEDGER_ROLES } from '../../common/wms/ledger-posting.service';

const ROLES = Object.keys(LEDGER_ROLES);

export class SetAccountMappingDto {
  /** One of the roles the ledger poster knows about. */
  @IsIn(ROLES)
  role: string;

  @IsUUID()
  accountId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
