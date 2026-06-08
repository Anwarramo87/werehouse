# اختبار توزيع تكلفة المواصلات

## الإعداد

### البيانات الأساسية:
- **تكلفة الباص**: 20,000 ل.س
- **خصم الشركة**: 20%
- **التكلفة الصافية**: 16,000 ل.س
- **رقم اللوحة**: `TEST123`
- **الخط**: `خط الاختبار`

## خطوات الاختبار

### 1. إنشاء الباص

```bash
POST http://localhost:3000/api/transportation/buses
Content-Type: application/json

{
  "route": "خط الاختبار",
  "plateNumber": "TEST123",
  "driverName": "أبو محمد",
  "driverPhone": "0933123456",
  "totalCost": 20000,
  "companyDeductionPct": 20,
  "employeeDeductionPct": 0,
  "capacity": 10
}
```

**النتيجة المتوقعة**: 
- تم إنشاء باص بنجاح
- احفظ الـ `busId` للاستخدام في الخطوات التالية

---

### 2. إضافة الموظف الأول

```bash
POST http://localhost:3000/api/transportation/buses/{busId}/passengers
Content-Type: application/json

{
  "employeeId": "EMP001"
}
```

**النتيجة المتوقعة**:
- ✅ تمت إضافة الموظف للباص
- ✅ في console: `[Transportation] Creating new discount for EMP001: 16000`
- ✅ في صفحة الخصومات: خصم "بدل مواصلات - خط الاختبار (TEST123)" = **16,000 ل.س**

**التحقق**:
```bash
GET http://localhost:3000/api/discounts?employeeId=EMP001
```

يجب أن ترى:
```json
[
  {
    "employeeId": "EMP001",
    "type": "بدل مواصلات - خط الاختبار (TEST123)",
    "amount": 16000,
    ...
  }
]
```

---

### 3. إضافة الموظف الثاني

```bash
POST http://localhost:3000/api/transportation/buses/{busId}/passengers
Content-Type: application/json

{
  "employeeId": "EMP002"
}
```

**النتيجة المتوقعة**:
- ✅ تمت إضافة الموظف الثاني
- ✅ في console: 
  ```
  [Transportation] Processing 2 passengers, cost per employee: 8000
  [Transportation] Updating discount for EMP001: 16000 → 8000
  [Transportation] Creating new discount for EMP002: 8000
  ```
- ✅ في صفحة الخصومات:
  - EMP001: **8,000 ل.س** (تم التحديث من 16,000)
  - EMP002: **8,000 ل.س** (جديد)

**التحقق**:
```bash
# للموظف الأول
GET http://localhost:3000/api/discounts?employeeId=EMP001

# للموظف الثاني
GET http://localhost:3000/api/discounts?employeeId=EMP002
```

كلاهما يجب أن يكون `amount: 8000`

---

### 4. إضافة الموظف الثالث

```bash
POST http://localhost:3000/api/transportation/buses/{busId}/passengers
Content-Type: application/json

{
  "employeeId": "EMP003"
}
```

**النتيجة المتوقعة**:
- ✅ في console:
  ```
  [Transportation] Processing 3 passengers, cost per employee: 5333.33
  [Transportation] Updating discount for EMP001: 8000 → 5333.33
  [Transportation] Updating discount for EMP002: 8000 → 5333.33
  [Transportation] Creating new discount for EMP003: 5333.33
  ```
- ✅ في صفحة الخصومات:
  - EMP001: **5,333.33 ل.س**
  - EMP002: **5,333.33 ل.س**
  - EMP003: **5,333.33 ل.س**

---

### 5. إزالة موظف

```bash
DELETE http://localhost:3000/api/transportation/buses/{busId}/passengers/EMP003
```

**النتيجة المتوقعة**:
- ✅ تمت إزالة EMP003
- ✅ حُذف خصم EMP003
- ✅ تم إعادة حساب خصومات المتبقين:
  - EMP001: **8,000 ل.س**
  - EMP002: **8,000 ل.س**

---

## استكشاف الأخطاء

### المشكلة: الخصومات لا تتحدث

**الحلول**:

1. **تحقق من console logs**:
   ```bash
   # شغل البروجكت وشاهد ال logs
   npm run start:dev
   ```
   ابحث عن:
   - `[Transportation] Processing X passengers`
   - `[Transportation] Updating discount for ...`
   - `[Transportation] Creating new discount for ...`

2. **تحقق من الخصومات في Database**:
   ```sql
   SELECT 
     "employeeId", 
     "bonusReason", 
     "assistanceAmount", 
     "deletedAt"
   FROM "EmployeeBonus"
   WHERE "bonusReason" LIKE '%TEST123%'
   AND "deletedAt" IS NULL;
   ```

3. **تحقق من رقم اللوحة**:
   - تأكد أن `plateNumber` هو نفسه في كل مكان
   - البحث يعتمد على `LIKE '%{plateNumber}%'`

4. **تحقق من نوع الخصم**:
   - يجب أن يكون `kind = 'assistance'`
   - يُخزّن في جدول `EmployeeBonus`

---

## الإعدادات الافتراضية

```typescript
// في transportation.service.ts

// حساب التكلفة الصافية
netCost = totalCost × (100 - companyDeductionPct) ÷ 100

// حساب التكلفة للفرد
costPerEmployee = netCost ÷ totalPassengers

// البحث عن خصم موجود
WHERE "bonusReason" LIKE '%{plateNumber}%'
AND "deletedAt" IS NULL

// إنشاء خصم جديد
type = `بدل مواصلات - ${route} (${plateNumber})`
kind = ASSISTANCE
amount = costPerEmployee
```

---

## النتيجة النهائية المتوقعة

| الموظف | قبل | بعد إضافة EMP002 | بعد إضافة EMP003 | بعد إزالة EMP003 |
|--------|-----|------------------|------------------|------------------|
| EMP001 | 16,000 | **8,000** | **5,333.33** | **8,000** |
| EMP002 | - | **8,000** | **5,333.33** | **8,000** |
| EMP003 | - | - | **5,333.33** | ❌ (محذوف) |

✅ **التوزيع عادل ومتساوي دائماً!**
