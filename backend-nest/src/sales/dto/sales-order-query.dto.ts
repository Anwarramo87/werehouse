import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { QueryNumberish } from '../../common/types/query.types';

export class SalesOrderQueryDto {
  @IsOptional()
  page?: QueryNumberish;

  @IsOptional()
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
