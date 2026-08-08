import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { QueryNumberish } from '../../common/types/query.types';

export class SalesOrderQueryDto {
  page?: QueryNumberish;
  limit?: QueryNumberish;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['draft', 'confirmed', 'delivered', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
