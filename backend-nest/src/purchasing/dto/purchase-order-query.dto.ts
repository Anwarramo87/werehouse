import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { QueryNumberish } from '../../common/types/query.types';

export class PurchaseOrderQueryDto {
  @IsOptional()
  page?: QueryNumberish;

  @IsOptional()
  limit?: QueryNumberish;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['draft', 'sent', 'received', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;
}
