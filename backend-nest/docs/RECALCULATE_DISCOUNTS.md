# إعادة حساب خصومات المواصلات

## المشكلة
عندما يكون لديك موظفين موجودين مسبقاً في الباص، ولم تتحدث خصوماتهم بشكل صحيح.

## الحل: Endpoint جديد لإعادة الحساب

### الاستخدام:

```bash
POST http://localhost:3000/api/transportation/buses/{busId}/recalculate-discounts
```

### مثال:

```bash
# باستخدام curl
curl -X POST http://localhost:3000/api/transportation/buses/4bc9ada1-4493-48f1-a859-c4360b0f46bc/recalculate-discounts \
  -H "Content-Type: application/json" \
  -H "Cookie: your-auth-cookie"

# باستخدام Postman أو أي REST client
POST http://localhost:3000/api/transportation/buses/4bc9ada1-4493-48f1-a859-c4360b0f46bc/recalculate-discounts
```

### الاستجابة المتوقعة:

```json
{
  "message": "Discounts recalculated successfully",
  "totalPassengers": 3,
  "costPerEmployee": 5333.33,
  "updated": 3,
  "created": 0
}
```

---

## كيف يعمل:

1. **يجلب جميع الموظفين النشطين** في الباص
2. **يحسب التكلفة لكل موظف**: `netCost ÷ عدد الموظفين`
3. **لكل موظف**:
   - إذا كان لديه خصم موجود → يُحدّث المبلغ
   - إذا لم يكن لديه خصم → يُضاف خصم جديد

---

## متى تستخدمه:

### ✅ استخدم هذا الـ endpoint عندما:
- الموظفين موجودين لكن خصوماتهم غير صحيحة
- أضفت موظفين يدوياً في Database
- حصل خطأ وتريد إعادة الحساب
- تريد تأكيد أن كل الخصومات محدثة

### ⚠️ ملاحظات:
- يعمل فقط على الموظفين **النشطين** (status = 'active')
- **لا يحذف** الخصومات القديمة، فقط يحدثها
- آمن للاستخدام المتكرر

---

## مثال عملي:

### السيناريو:
لديك باص بـ ID: `4bc9ada1-4493-48f1-a859-c4360b0f46bc`
- التكلفة: 20,000 ل.س
- خصم الشركة: 20%
- التكلفة الصافية: 16,000 ل.س
- عدد الموظفين: 3

### الخطوات:

#### 1. تحقق من الموظفين الحاليين:
```bash
GET http://localhost:3000/api/transportation/buses/4bc9ada1-4493-48f1-a859-c4360b0f46bc
```

#### 2. شاهد الخصومات الحالية:
```bash
GET http://localhost:3000/api/discounts
```

#### 3. أعد حساب الخصومات:
```bash
POST http://localhost:3000/api/transportation/buses/4bc9ada1-4493-48f1-a859-c4360b0f46bc/recalculate-discounts
```

#### 4. تحقق من النتيجة:
```bash
GET http://localhost:3000/api/discounts
```

يجب أن ترى:
- كل موظف لديه خصم = `16,000 ÷ 3 = 5,333.33 ل.س`

---

## Console Logs

عند تشغيل الـ endpoint، ستشاهد في console:

```
[Transportation] Recalculating 3 passengers, cost per employee: 5333.33
[Transportation] Updating discount for EMP001: 16000 → 5333.33
[Transportation] Updating discount for EMP002: 8000 → 5333.33
[Transportation] Creating new discount for EMP003: 5333.33
[Transportation] Recalculation complete: 2 updated, 1 created
```

---

## استكشاف الأخطاء

### خطأ: "Bus not found"
- تأكد من أن `busId` صحيح
- جرب استخدام الـ ID الكامل (UUID)

### خطأ: "No passengers to recalculate"
- الباص لا يحتوي على موظفين نشطين
- تحقق من حالة الموظفين (status = 'active')

### الخصومات لا تزال غير صحيحة:
1. تحقق من console logs
2. تأكد من أن `plateNumber` هو نفسه في الخصومات الموجودة
3. قد تحتاج لحذف الخصومات القديمة يدوياً أولاً

---

## SQL للتحقق اليدوي

### التحقق من الخصومات:
```sql
SELECT 
  eb."employeeId",
  eb."bonusReason",
  eb."assistanceAmount",
  eb."createdAt"
FROM "EmployeeBonus" eb
WHERE eb."bonusReason" LIKE '%رقم_اللوحة%'
AND eb."deletedAt" IS NULL
ORDER BY eb."createdAt" DESC;
```

### التحقق من موظفي الباص:
```sql
SELECT 
  bp."employeeId",
  bp."status",
  bp."joinDate",
  b."plateNumber",
  b."totalCost",
  b."companyDeductionPct"
FROM "BusPassenger" bp
JOIN "Bus" b ON bp."busId" = b.id
WHERE b.id = 'bus-uuid-here'
AND bp."status" = 'active';
```

---

## الحالة: ✅ جاهز للاستخدام

استخدم هذا الـ endpoint الآن لإعادة حساب خصومات الباص الخاص بك!

```bash
POST http://localhost:3000/api/transportation/buses/4bc9ada1-4493-48f1-a859-c4360b0f46bc/recalculate-discounts
```
