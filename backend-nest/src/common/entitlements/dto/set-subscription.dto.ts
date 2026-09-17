import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SetSubscriptionDto {
  /** Whole months from now, e.g. 1 = شهر, 12 = سنة. Restarts the window now. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  months?: number;

  /** Explicit end date (ISO). Used when months is absent. */
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
