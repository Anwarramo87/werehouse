import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { BatchStatus } from '@prisma/client';

export class BatchStatusDto {
  @IsEnum(BatchStatus)
  status: BatchStatus;

  /** Recorded on the batch when quarantining — auditors ask why, not just when. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
