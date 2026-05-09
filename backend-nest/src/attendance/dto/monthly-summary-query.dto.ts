import { IsString, Matches } from 'class-validator';

export class MonthlySummaryQueryDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be in YYYY-MM format (e.g., 2026-05)',
  })
  month: string; // YYYY-MM format
}
