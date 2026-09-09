import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { PaginationQueryParams } from '../../common/types/query.types';

export class SalesInvoiceQueryDto implements PaginationQueryParams {
  @IsOptional()
  page?: string | number;

  @IsOptional()
  limit?: string | number;

  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @IsOptional()
  @IsUUID()
  customerId?: string;

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
  @IsString()
  overdue?: string;
}
