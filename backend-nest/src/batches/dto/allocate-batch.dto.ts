import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AllocateBatchDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  location?: string;

  /** FEFO is the default: expiry drives the draw, not arrival order. */
  @IsOptional()
  @IsIn(['FEFO', 'FIFO'])
  strategy?: 'FEFO' | 'FIFO';
}
