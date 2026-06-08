# Warehouse Backend — Schema Reference

مصدر: `prisma/schema.prisma`

## ملاحظات عامة
- المفتاح المرجعي الشائع للموظف هو الحقل `employeeId` (String, unique) وليس `id` في العديد من الجداول. هذا قد يسبب عدم اتساق إذا تغيّر `employeeId` أو إذا لم يُحفظ كـ PK.
- توجد تكرارات/حقول مكررة (مثلاً `birthDate` و `dateOfBirth` في `Employee`). يُنصح بتوحيد واحد فقط.
- بعض الحقول تشير إلى مفاتيح خارجية لكن لا تملك علاقة Prisma صريحة (`@relation`) مثل `AttendanceRecord.deviceId` أو `BusPassenger.employeeId` — هذا يعني عدم وجود قيد على مستوى DB بين السجلات.
- `date` مخزّن كسلسلة في `AttendanceRecord` — الأفضل استخدام `Date` أو `DateTime` لتسهيل الاستعلامات والفلترة.
- استخدام حقول من نوع `Json` و `String[]` مرن لكنه يتطلب تحققاً عند القراءة والبحث.

---

## Role
- id : `String` (UUID) PK
- name : `String` unique
- description : `String?`
- permissions : `String[]` (default [])
- علاقات: `users: User[]`, `employees: Employee[]`
- mapped: `roles`

## User
- id : `String` (UUID) PK
- username : `String` unique
- email : `String` unique
- passwordHash : `String`
- roleId : `String` (UUID) FK -> `Role.id` (onDelete: Restrict)
- status : `String` (default "active")
- failedLoginAttempts : `Int`
- lockoutUntil : `DateTime?`
- lastLogin : `DateTime?`
- ملاحظات: فهرس على `lockoutUntil`. استخدام `Restrict` عند حذف الدور.
- mapped: `users`

## Employee
- id : `String` (UUID) PK
- employeeId : `String` unique (مفتاح ربط شائع)
- name : `String`
- email : `String` unique
- mobile : `String?`
- nationalId : `String?` unique
- birthDate : `DateTime?` (@db.Date)
- dateOfBirth : `DateTime?` (@db.Date)  <-- تكرار
- gender : `String?`
- jobTitle : `String?`
- profession : `String?`
- hourlyRate : `Decimal` (@db.Decimal(10,2))
- baseSalary : `Decimal?` (@db.Decimal(14,2))
- livingAllowance : `Decimal?` (@db.Decimal(14,2))
- currency : `String` (default "SYP")
- scheduledStart / scheduledEnd : `String?`
- employmentStartDate / terminationDate : `DateTime?` (@db.Date)
- terminationReason : `String?`
- isSettled : `Boolean` (default false)
- department : `String` (default "Warehouse")  <-- مماثل لـ `departmentId`
- departmentId : `String?` (UUID) FK -> `Department.id` (onDelete: SetNull)
- roleId : `String?` (UUID) FK -> `Role.id` (onDelete: SetNull)
- status : `String` (default "active")
- workDaysInPeriod : `Int` (default 26)
- hoursPerDay : `Int` (default 8)
- overtimeCalculation : `Json?`
- gracePeriodMinutes : `Int` (default 15)
- علاقات: `attendanceRecords`, `dailyAttendanceLogs`, `advances`, `leaveRequests`
- ملاحظات: وجود كل من `department` كنص و`departmentId` كFK قد يسبب تناقضاً.
- mapped: `employees`

## Department
- id : `String` (UUID) PK
- name : `String` unique
- employees : `Employee[]`
- mapped: `departments`

## LeaveRequest
- id : `String` (UUID) PK
- employeeId : `String` FK -> `Employee.employeeId` (onDelete: Cascade)
- leaveType : `LeaveRequestType` (enum)
- status : `LeaveRequestStatus` (default PENDING)
- isPaid : `Boolean` (default false)
- startDate / endDate : `DateTime` (@db.Date)
- reason / notes : `String?`
- ملاحظات: FK يربط على `employeeId` (الحقل unique في `Employee`). mapped: `leave_requests`

## Device
- id : `String` (UUID) PK
- deviceId : `String` unique
- name : `String`
- location : `String`
- model : `String` (default "ZK Teco")
- ip : `String?`
- port : `Int?`
- status : `String` (default "active")
- lastSync : `DateTime?`
- mapped: `devices`
- ملاحظة: لا يوجد FK صريح من `AttendanceRecord.deviceId` إلى `Device.deviceId`.

## AttendanceRecord
- id : `String` (UUID) PK
- employeeId : `String` FK -> `Employee.employeeId` (onDelete: Cascade)
- timestamp : `DateTime`
- type : `String`
- deviceId : `String?`  (NO @relation)
- location : `String?`
- source : `String` (default "device")
- verified : `Boolean` (default false)
- notes : `String?`
- date : `String`  <-- يُفضّل `Date` أو `DateTime`
- shiftPair : `Json?`
- ملاحظة: عدة @@index مهيّأة للبحث.
- mapped: `attendance_records`

## DailyAttendanceLog
- id : `String` (UUID) PK
- employeeId : `String` FK -> `Employee.employeeId` (onDelete: Cascade)
- date : `DateTime` (@db.Date)
- recordType : `DailyRecordType` (enum)
- value : `Decimal` (@db.Decimal(10,2))
- notes : `String?` (@db.Text)
- source : `String` (default "manual")
- createdBy : `String?`
- mapped: `daily_attendance_logs`

## Product
- id : `String` (UUID) PK
- sku : `String` unique
- name : `String`
- category : `String`
- unitPrice / costPrice : `Decimal` (@db.Decimal(12,2))
- reorderLevel : `Int` (default 10)
- status : `String` (default "active")
- relations: `stockLevels`
- mapped: `products`

## StockLevel
- id : `String` (UUID) PK
- sku : `String` FK -> `Product.sku` (onDelete: Cascade)
- location : `String`
- quantity / reserved / available : `Int`
- UNIQUE(sku, location)
- mapped: `stock_levels`

## ImportJob
- id : `String` (UUID) PK
- jobId : `String` unique
- entity : `String`
- fileName : `String`
- uploadedBy : `String`
- uploadedAt : `DateTime`
- status : `String` (default "pending")
- errors : `Json` (default [])
- mapped: `import_jobs`

## PayrollRun
- id : `String` (UUID) PK
- runId : `String` unique
- periodStart / periodEnd : `DateTime` (@db.Date)
- periodType : `String` (default "monthly")
- status / approvalStatus : `String`
- totals : `Decimal` (gross/deductions/net)
- items : `PayrollItem[]`
- mapped: `payroll_runs`

## PayrollItem
- id : `String` (UUID) PK
- payrollRunId : `String` FK -> `PayrollRun.id` (onDelete: Cascade)
- employeeId : `String`
- employeeName : `String`
- hoursWorked / hourlyRate / grossPay / netPay : `Decimal`
- anomalies : `String[]`
- UNIQUE(payrollRunId, employeeId)
- mapped: `payroll_items`

## PayrollInput
- id : `String` (UUID) PK
- employeeId : `String`
- periodStart / periodEnd : `DateTime` (@db.Date)
- various numeric inputs (lateMinutes, absenceDays, overtime, penaltyAmount, advanceAmount...)
- UNIQUE(employeeId, periodStart, periodEnd)
- mapped: `payroll_inputs`

## EmployeeSalary
- id : `String` (UUID) PK
- employeeId : `String` unique
- baseSalary / lumpSumSalary / livingAllowance / insuranceAmount / transportAllowance : `Decimal`
- mapped: `employee_salaries`

## EmployeeAdvance
- id : `String` (UUID) PK
- employeeId : `String` FK -> `Employee.employeeId` (onDelete: Cascade)
- advanceType : `String`
- totalAmount / installmentAmount / remainingAmount : `Decimal`
- mapped: `employee_advances`

## DeletedRecordHistory
- id : `String` (UUID) PK
- entityType : `String`
- recordId : `String`
- payload : `Json`
- deletedBy / restoredBy : `String?`
- mapped: `deleted_record_history`

## EmployeeInsurance
- id : `String` (UUID) PK
- employeeId : `String` unique
- insuranceSalary : `Decimal`
- socialSecurityNumber : `String?`
- mapped: `employee_insurance`

## EmployeeBonus
- id : `String` (UUID) PK
- employeeId : `String`
- bonusAmount / assistanceAmount : `Decimal`
- period : `String?`
- mapped: `employee_bonuses`

## EmployeePenalty
- id : `String` (UUID) PK
- employeeId : `String`
- category : `String`
- amount : `Decimal`
- issueDate : `DateTime`
- mapped: `employee_penalties`

## Bus
- id : `String` (UUID) PK
- busId : `String` unique
- route / plateNumber / driverName / driverPhone
- capacity : `Int`
- passengers : `BusPassenger[]`
- mapped: `buses`

## BusPassenger
- id : `String` (UUID) PK
- busId : `String` FK -> `Bus.id` (onDelete: Cascade)
- employeeId : `String`
- UNIQUE(busId, employeeId)
- mapped: `bus_passengers`

---

# توصيات سريعة لإصلاح التكرار/التحسينات
1. **توحد على مفتاح مرجعي واحد للموظف**: إما استخدم `id` (UUID) في كل الجداول كFK أو اجعل `employeeId` هو الـ PK في `Employee` (أي تزيل `id` أو تعيّنه كمرادف). الحالية تخلط بين الحقول مما قد يؤدي لاختلالات.
2. **احذف حقل مكرر `birthDate` أو `dateOfBirth`**.
3. **حوّل `AttendanceRecord.date` إلى `Date`** أو أزله واشتقّ `date` من `timestamp` عند الحاجة.
4. **أضف @relation بين `AttendanceRecord.deviceId` و`Device.deviceId` إن أردت قيود DB** أو احتفظ كمرجع نصي إذا التصميم متعمد.
5. **راجع الحقول النصية المكرّرة مثل `department` + `departmentId`** وقرّر إن كانت للعرض فقط أو للتخزين المرجعي.
6. **فكّر باستخدام FK على `Product.id` بدلاً من `sku`** لتجنّب مشكلات تغيير الـ SKU.

---

ملف ERD (Mermaid) مرفق في `erd_full.mmd`.
