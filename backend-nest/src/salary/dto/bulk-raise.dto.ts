import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class BulkRaiseDto {
  /**
   * مبلغ الزيادة الذي يُضاف على baseSalary الحالي.
   * إذا كان الراتب 20000 والزيادة 10000 يصبح 30000 بشكل دائم.
   */
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amount: number;

  /**
   * اختياري — إذا أُرسل يطبق الزيادة على موظف واحد فقط.
   * إذا لم يُرسل (أو ALL) تطبق على كل الموظفين النشطين.
   */
  @IsOptional()
  @IsString()
  employeeId?: string;

  /** ملاحظة اختيارية لتوثيق سبب الزيادة */
  @IsOptional()
  @IsString()
  notes?: string;
}
