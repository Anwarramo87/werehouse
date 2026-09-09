import { IsIn, IsOptional } from 'class-validator';
import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateBinDto } from './create-bin.dto';

export class UpdateBinDto extends PartialType(OmitType(CreateBinDto, ['zoneId', 'code'] as const)) {
  @IsOptional()
  @IsIn(['free', 'occupied', 'blocked'])
  status?: string;
}
