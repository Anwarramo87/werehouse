import { IsBoolean, IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SetUserSubscriptionDto {
  /** Whole months from now, e.g. 1 = شهر, 12 = سنة. Restarts the window now. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  months?: number;

  /** Whole days from now, e.g. 7 = أسبوع, 30 = شهر. Restarts the window now. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  days?: number;

  /** Explicit end date (ISO). Used when months/days are absent. */
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  /** Lifetime access (plan=lifetime, ends 2100). Takes precedence over months/days/endsAt. */
  @IsOptional()
  @IsBoolean()
  permanent?: boolean;
}