import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RestoreDto {
  @ApiProperty({
    enum: ['validate', 'dryRun', 'apply'],
    default: 'validate',
    description:
      'validate = structural checks only, no database access. ' +
      'dryRun = performs the real writes inside a transaction, then rolls back. ' +
      'apply = commits.',
  })
  @IsOptional()
  @IsIn(['validate', 'dryRun', 'apply'])
  mode: 'validate' | 'dryRun' | 'apply' = 'validate';

  @ApiProperty({
    enum: ['merge', 'replace'],
    default: 'merge',
    description:
      'merge = insert missing rows and update matching ids; deletes nothing. ' +
      'replace = delete the factory rows this snapshot covers, then insert. ' +
      'Super Admin only, and requires `confirm`.',
  })
  @IsOptional()
  @IsIn(['merge', 'replace'])
  strategy: 'merge' | 'replace' = 'merge';

  @ApiPropertyOptional({
    description: 'Required for mode=apply with strategy=replace. Must equal "REPLACE <tenantId>".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  confirm?: string;
}
