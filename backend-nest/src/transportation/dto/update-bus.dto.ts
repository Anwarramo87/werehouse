import { PartialType } from '@nestjs/mapped-types';
import { CreateBusDto } from './create-bus.dto';
import { IsIn, IsOptional } from 'class-validator';

export class UpdateBusDto extends PartialType(CreateBusDto) {
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;
}
