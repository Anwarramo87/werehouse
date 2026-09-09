import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateSalesInvoicePaymentDto {
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsIn(['cash', 'card', 'transfer', 'cheque'])
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
