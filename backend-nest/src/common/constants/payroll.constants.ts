/**
 * ثوابت حسابات الرواتب
 * تمركز كل الأرقام الثابتة المستخدمة في معادلات الراتب
 */

/** عدد أيام العمل في الشهر */
export const WORK_DAYS_PER_MONTH = 26;

/** عدد ساعات الدوام اليومي */
export const WORK_HOURS_PER_DAY = 8;

/** عدد دقائق الساعة */
export const MINUTES_PER_HOUR = 60;

/** معامل تضخيم الإضافي والتأخير (1.5×) */
export const OVERTIME_MULTIPLIER = 1.5;

/** معامل خصم الإجازة المرضية (50% من اليوم) */
export const SICK_LEAVE_DEDUCTION_RATIO = 0.5;

/** معامل أجر عمل نهاية الأسبوع (2×) */
export const WEEKEND_MULTIPLIER = 2.0;

/** نسبة بدل المسؤولية من فرق الراتب (50%) */
export const RESPONSIBILITY_ALLOWANCE_RATIO = 0.50;

/** نسبة بدل الجهد الإضافي من فرق الراتب (30%) */
export const EXTRA_EFFORT_ALLOWANCE_RATIO = 0.30;

/** حد المعالجة الدفعية للرواتب (موظف/دفعة) */
export const PAYROLL_BATCH_SIZE = 250;

/** أقرب قيمة للتقريب للأعلى في صافي الراتب */
export const PAYROLL_ROUNDING_UNIT = 1000;
