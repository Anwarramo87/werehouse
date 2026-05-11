# شرح الباك إند بالكامل (مكثف) + المعادلات

> هذا الملف يشرح الباك عندك بشكل واضح ومباشر، مع تركيز خاص على معادلات الرواتب الحالية.

## 1) نظرة عامة سريعة

- المنصة: NestJS + PostgreSQL + Prisma + BullMQ
- المنفذ الافتراضي: 5001
- Base URL: http://localhost:5001/api
- المصادقة: JWT (Header أو Cookie)
- الصلاحيات: Permissions Guard على مستوى الـ endpoints

## 2) بنية الموديولات (حسب الدومين)

```
src/
├── auth/           المصادقة والصلاحيات والبصمة
├── employees/      إدارة الموظفين
├── attendance/     الحضور والانصراف
├── payroll/        حساب الرواتب + التقارير
├── salary/         الراتب الأساسي والبدلات
├── advances/       السلف
├── insurance/      التأمينات
├── bonuses/        المكافآت والمساعدات
├── penalties/      العقوبات
├── inventory/      المخزون
├── imports/        استيراد CSV/XLSX
├── devices/        أجهزة البصمة
├── files/          رفع ملفات عامة
├── dashboard/      مؤشرات اليوم ولوحة التحكم
├── queues/         طوابير BullMQ
├── common/         Guards/Decorators/Utils
└── prisma/         Prisma Service
```

## 3) أهم الجداول (Prisma)

- الموظفون: employees
- الحضور: attendance_records
- الرواتب الشهرية/السجلات: payroll_runs, payroll_items
- الراتب الأساسي والبدلات: employee_salaries
- السلف: employee_advances
- المكافآت/المساعدات: employee_bonuses
- العقوبات: employee_penalties
- التأمينات: employee_insurance
- مدخلات المعادلة (لكل موظف وفترة): payroll_inputs

## 4) مسار الطلب (Request Lifecycle)

1) Middleware
2) Guards (JWT + Permissions)
3) Validation Pipes
4) Controllers
5) Services (Business Logic)
6) Prisma / Queue
7) Error Filter

## 5) الرواتب — المعادلات الحالية (الأساسية)

### 5.1 المعادلة الأساسية (الراتب الفعلي)

الراتب = (G3) - AA3 - AB3 - AC3 - AD3 - AF3 - AG3 + (AI3 + AJ3) - AK3 + AL3 - AM3 - AN3 + I3

### 5.2 قيم الأجور المعيارية

- W3 (الراتب اليومي) = G3 / 26
- X3 (أجرة الساعة) = G3 / 26 / 9
- Y3 (أجرة الدقيقة) = G3 / 26 / 9 / 60

### 5.3 تعريف المتغيرات الأساسية

- G3: الراتب الأساسي.
- I3: بدل نقل = بدل نقل / 26 * (26 - (L3 + N3 + O3 + P3 + S3)).
- AJ3: إضافي عادي = 1.5 * Y3 * M3.
- AI3: إضافي نهاية أسبوع = W3 * T3 * 2.

### 5.4 الخصومات

- AA3: خصم تأخير صباحي = 1.5 * Y3 * J3.
- AB3: خصم خروج مبكر = K3 * Y3.
- AC3: خصم غياب = L3 * W3.
- AD3: خصم إجازة مرضية = N3 * 50% * W3.
- AF3: خصم إجازة بلا راتب = P3 * W3.
- AG3: خصم ساعة بلا راتب = Q3 * X3.
- AK3: عقوبة.
- خصم شراء ملابس: خصم مستقل ضمن قائمة الخصومات.
- AL3: مكافأة وفرق (يدوي).
- AM3: سلفة.
- AN3: تأمينات.

### 5.5 الراتب المقبوض والفرق

- الراتب المقبوض = تقريب الراتب الفعلي لأقرب ألف للأعلى.
- الفرق = الراتب المقبوض - الراتب الفعلي.
- الراتب مع السلفة = الراتب المقبوض + السلفة + العقوبة.

### 5.6 مصادر البيانات للمعادلة

- employee_salaries: baseSalary, insuranceAmount, transportAllowance
- payroll_inputs: كل مدخلات المعادلة لكل موظف وفترة

الحقول داخل payroll_inputs:
- lateMinutes (J3)
- earlyLeaveMinutes (K3)
- absenceDays (L3)
- sickLeaveDays (N3)
- adminLeaveDays (O3)
- unpaidLeaveDays (P3)
- deathLeaveDays (S3)
- overtimeRegularMinutes (M3)
- overtimeWeekendDays (T3)
- unpaidHours (Q3)
- penaltyAmount (AK3)
- clothingDeduction (خصم ملابس)
- bonusAdjustment (AL3)
- advanceAmount (AM3)
- insuranceAmount (AN3)
- transportAllowanceOverride (بدل نقل يدوي إذا لزم)

### 5.7 ملاحظات تشغيل المعادلة

- إذا لم يوجد payroll_inputs للفترة، يتم أخذ التأخير/الغياب/الإضافي من attendance تلقائيا عند تفعيل includeAttendanceDeductions.
- بدل النقل يحسب بناء على عدد الأيام الفعلية بعد خصم الإجازات المذكورة.
- الصافي المقرب محفوظ في payroll_items.netPayRounded.
- الفرق محفوظ في payroll_items.roundingDifference.
- الراتب مع السلفة محفوظ في payroll_items.netPayWithAdvance.

## 6) الرواتب — الـ API الرئيسية

- POST /api/payroll/inputs
  - إدخال/تعديل مدخلات المعادلة للموظف والفترة.
- GET /api/payroll/inputs
  - قراءة مدخلات المعادلة.
- POST /api/payroll/calculate
  - حساب الرواتب للفترة.
- POST /api/payroll/calculate/async
  - حساب الرواتب بشكل غير متزامن.
- GET /api/payroll/:runId
  - تفاصيل تشغيل الرواتب.
- GET /api/payroll/:runId/export
  - تصدير CSV.
- GET /api/payroll/:runId/export/pdf
  - تصدير PDF.

## 7) attendance — ملخص الحسابات

- يحسب دقائق التأخير من shiftPair.minutesLate.
- يحسب ساعات العمل من shiftPair.hoursWorked.
- عند غياب يوم كامل لا يوجد سجل IN لذلك يتم احتساب غياب.

## 8) salary — توزيع البدلات

- calculate-allowances:
  - Difference = Salary - LumpSumSalary - LivingAllowance
  - ResponsibilityAllowance = Difference * 0.50
  - ExtraEffortAllowance    = Difference * 0.30
  - ProductionIncentives    = Difference - Responsibility - ExtraEffort

## 9) أين تجد التفاصيل بسرعة

- شرح باك عام: docs/BACKEND_EXPLAINED_AR.md
- معادلات الرواتب: docs/PAYROLL_EXCEL_MAPPING_AR.md
- Postman: docs/postman/postman.nest.collection.json
- Prisma schema: prisma/schema.prisma

## 10) التحديثات الأخيرة في الباك

### 10.1 الأقسام Departments

- تمت إضافة جدول مستقل `departments` بدل الاعتماد على نص القسم داخل جدول الموظفين فقط.
- الحقول الأساسية: `id`, `name`, `createdAt`, `updatedAt`.
- تم ربط الموظف بالقسم عبر `departmentId` مع الإبقاء المؤقت على الحقل النصي `department` للتوافق الخلفي مع التقارير والـ filters الحالية.
- الـ API الجديد:
  - `POST /api/departments`
  - `GET /api/departments`

### 10.2 حقول الموظف الجديدة

- تمت إضافة دعم الحقول التالية في `CreateEmployeeDto` و `UpdateEmployeeDto` عبر الوراثة:
  - `birthDate`
  - `profession`
  - `monthlySalary`
- تم تعديل منطق الإنشاء والتحديث بحيث يقبل أيضاً الاسم القديم لبعض الحقول عند الحاجة:
  - `dateOfBirth` ما زال مدعوماً كمدخل قديم، لكنه ينعكس على `birthDate` في قاعدة البيانات.
  - `jobTitle` ما زال مدعوماً، لكنه ينعكس أيضاً على `profession`.
  - `baseSalary` و `monthlySalary` يتم توحيدهما عند الحفظ إذا أرسل الفرونت أحدهما.

### 10.3 الخلاصة التشغيلية

- إنشاء/تعديل الموظف لم يعد يرفض الحقول الإضافية المذكورة أعلاه.
- القسم صار يُخزن ككيان حقيقي في قاعدة البيانات بدل string فقط.
- تم الحفاظ على التوافق الخلفي حتى لا تنكسر الشاشات القديمة أثناء الانتقال التدريجي للمعمارية الجديدة.

إذا بدك توسعة لأي جزء (مثلا: auth بالتفصيل، أو inventory، أو imports)، قل لي وأكمّل لك بقسم منفصل.
