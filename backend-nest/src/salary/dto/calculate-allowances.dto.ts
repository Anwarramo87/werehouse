import { IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CalculateAllowancesDto {
  /**
   * الراتب الكلي
   */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  salary: number;

  /**
   * الراتب المقطوع
   */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  lumpSumSalary: number;

  /**
   * بدل المعيشة
   */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  livingAllowance: number;
}
