import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CountStatus } from '@prisma/client';
import { PaginationQueryParams } from '../../common/types/query.types';

export class CycleCountQueryDto implements PaginationQueryParams {
  @IsOptional()
  page?: string | number;

  @IsOptional()
  limit?: string | number;

  @IsOptional()
  @IsEnum(CountStatus)
  status?: CountStatus;

  @IsOptional()
  @IsString()
  type?: string;
}
