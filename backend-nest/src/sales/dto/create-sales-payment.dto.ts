import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSalesPaymentDto {
  @IsUUID()
  @IsNotEmpty()
  salesOrderId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'card', 'transfer'])
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
