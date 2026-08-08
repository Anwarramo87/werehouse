import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { QueryNumberish } from '../../common/types/query.types';

export class JournalEntryQueryDto {
  page?: QueryNumberish;
  limit?: QueryNumberish;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;
}
