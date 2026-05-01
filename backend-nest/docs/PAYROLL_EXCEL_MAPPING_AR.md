# مطابقة معادلات الرواتب مع ملف الاكسل

هذا الملف يوضح كيف أصبحت معادلات الرواتب مطابقة لملف الاكسل (قبض نظامي).

## المعادلة الأساسية (الراتب المقبوض)

الراتب المقبوض = (الراتب الأساسي + المكافآت + الإضافي) - (التأمينات + السلف + العقوبات + خصم الدوام + بدل النقل)

## مصادر البيانات

- **راتب ووظيف**: `employee_salaries`
  - baseSalary, lumpSumSalary, livingAllowance, responsibilityAllowance, extraEffortAllowance, productionIncentive
- **مكافأة&مساعدة**: `employee_bonuses`
  - bonusAmount (مكافآت) و assistanceAmount (خصومات إدارية)
- **سلف**: `employee_advances`
  - installmentAmount + remainingAmount
- **مطعم+ملابس (عقوبات)**: `employee_penalties`
- **دوام**: `attendance_records`
  - دقائق التأخير وغياب الأيام
- **بدل نقل**: `bus_passengers` + `buses.employeeDeductionAmount`
- **تأمينات**: `employee_salaries.insuranceAmount`

## قواعد الحساب الحالية

- **الغياب**: يوم كامل عند الغياب فقط.
- **التأخير**: خصم بالدقيقة بعد فترة السماح (من `gracePeriodMinutes`).
- **الإضافي**: إضافي عادي فقط (يُستخرج من ساعات العمل في `shiftPair.hoursWorked`).
- **بدل النقل**: يخصم من راتب الموظف بناءً على قيمة `employeeDeductionAmount` من الباص المرتبط.

## ثوابت الحساب

- `workDaysInPeriod` (افتراضي 26 يوم عمل)
- `hoursPerDay` (افتراضي 8 ساعات)

يمكن تمريرها في `POST /payroll/calculate` لتطابق ملف الاكسل بدقة.

## نقاط مهمة

- أي تعديل في رقم الموظف أو نوع الخصم ينعكس مباشرة على الراتب المقبوض.
- الحسابات التفصيلية موجودة في `payroll.service.ts` ويمكن توسيعها لاحقاً لإضافي نهاية أسبوع أو عيد.
