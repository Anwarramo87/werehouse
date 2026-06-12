# TODO

## Backend (NestJS + Prisma)
- [ ] توحيد فلترة status للموظفين في:
  - [ ] src/employees/employees.service.ts (list, stats, byDepartment)
  - [ ] src/attendance/daily-logs.service.ts (getAllEmployeesMonthlySummary)
- [ ] تصحيح فلترة تاريخ الإجازات في src/leaves/leaves.service.ts (list) باستخدام تداخل الفترات
- [ ] ربط overtime بمحرك الرواتب في src/payroll/payroll.service.ts:
  - [ ] حساب weekend overtime تلقائياً (الجمعة/عطلات لاحقاً)
  - [ ] تصنيف overtimeRegular/overtimeWeekend
  - [ ] استخدام DailyAttendanceLog كقيمة أساسية والـ PayrollInput override فوقها
- [ ] تصحيح معادلة latePenalty في payroll.service.ts: minuteWage * lateMinutes
- [ ] استثناء الإجازات المدفوعة من absenceDays في absenceDaysFallback عبر طرح LeaveRequest APPROVED المدفوعة ضمن الفترة
- [x] إضافة unit tests scaffolding:
  - [x] backend-nest/src/employees/employees.service.spec.ts
  - [x] backend-nest/src/leaves/leaves.service.spec.ts
- [ ] تحديث backend-nest/src/payroll/payroll.service.spec.ts
- [ ] تشغيل الاختبارات: npm test (داخل backend-nest) + تأكيد النجاح


