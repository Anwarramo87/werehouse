import { IsBooleanString, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BatchStatus } from '@prisma/client';
import { PaginationQueryParams } from '../../common/types/query.types';

export class BatchQueryDto implements PaginationQueryParams {
  @IsOptional()
  page?: string | number;

  @IsOptional()
  limit?: string | number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  batchNumber?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(BatchStatus)
  status?: BatchStatus;

  /** Narrows to batches expiring inside this many days — powers the alert tabs. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiringWithinDays?: number;

  @IsOptional()
  onlyInStock?: string | boolean;
}
