# 🚀 دليل البداية السريعة - نظام البصمة

## ✅ جاهز للتشغيل الآن!

كل شيء معد ومهيأ. اتبع الخطوات التالية:

---

## 📋 الخطوة 1: تأكد من الإعدادات

الملف `.env` جاهز بالإعدادات التالية:

```env
# وضع المحاكاة (للتطوير بدون جهاز)
USE_BIOMETRIC_SIMULATOR=true

# استراتيجية التكرار (الأعدل للموظفين)
BIOMETRIC_DUPLICATE_STRATEGY=keep_earliest

# نافذة اكتشاف التكرار (5 دقائق)
BIOMETRIC_DUPLICATE_WINDOW_MINUTES=5
```

✅ **كل شيء جاهز!** لا حاجة لتغيير شيء للاختبار.

---

## 🎯 الخطوة 2: شغل الباك اند

```bash
cd c:\Users\anwar\Downloads\Backend2\werehouse\backend-nest
npm run start:dev
```

ستشاهد في السجلات:
```
🔧 BiometricService initialized in SIMULATOR mode
```

---

## 🧪 الخطوة 3: اختبر المزامنة

### طريقة 1: من المتصفح/Postman

**تسجيل الدخول أولاً:**
```
POST http://localhost:5001/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "change_this_password_in_production"
}
```

**ثم المزامنة:**
```
POST http://localhost:5001/biometric/trigger-sync
Cookie: warehouse_access_token=YOUR_TOKEN
```

### طريقة 2: من PowerShell (مع الكوكيز)

```powershell
# 1. تسجيل الدخول والحصول على التوكن
$loginResponse = Invoke-WebRequest -Uri "http://localhost:5001/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"username":"admin","password":"change_this_password_in_production"}' `
  -SessionVariable session

# 2. المزامنة
$syncResponse = Invoke-WebRequest -Uri "http://localhost:5001/biometric/trigger-sync" `
  -Method POST `
  -WebSession $session

# 3. عرض النتيجة
$syncResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

---

## 📊 الخطوة 4: شاهد النتائج

### النتيجة المتوقعة من المزامنة:
```json
{
  "success": true,
  "synced": 8,
  "updated": 0,
  "skipped": 0,
  "errors": 0,
  "logs": [
    {
      "employeeId": "EMP000006",
      "timestamp": "2026-06-11T08:37:00.000Z",
      "type": "check-in",
      "action": "inserted",
      "metrics": {
        "lateMinutes": 22,
        "earlyLeaveMinutes": 0,
        "overtimeMinutes": 0
      }
    }
  ]
}
```

### البيانات المولدة من المحاكي:
1. **هبا (EMP000006):**
   - حضور: 8:37 (تأخير 22 دقيقة بعد السماح)
   - انصراف: 5:00 عادي
   - عمل يوم السبت (عطلة)

2. **موظف 10 (EMP000010):**
   - حضور: 7:00 (مبكر)
   - انصراف: 7:00 PM (وقت إضافي)

3. **موظف 15 (EMP000015):**
   - حضور: 8:00 عادي
   - انصراف: 3:00 PM (مبكر - 2 ساعات)

---

## 🔍 الخطوة 5: تحقق من قاعدة البيانات

### طريقة 1: من Prisma Studio
```bash
npx prisma studio
```
افتح جدول `attendance_records` وشاهد السجلات الجديدة.

### طريقة 2: استعلام SQL
```sql
SELECT 
  ar.id,
  ar.employeeId,
  e.name,
  TO_CHAR(ar.timestamp, 'HH24:MI:SS') as time,
  ar.type,
  ar.notes
FROM attendance_records ar
JOIN employees e ON ar.employeeId = e.employeeId
WHERE ar.date = CURRENT_DATE
ORDER BY ar.timestamp;
```

---

## 🧪 الخطوة 6: اختبر معالجة التكرار

### 1. زامن مرة ثانية (نفس الأمر):
```
POST http://localhost:5001/biometric/trigger-sync
```

**النتيجة المتوقعة:**
```json
{
  "success": true,
  "synced": 0,
  "updated": 0,
  "skipped": 8,  // ← كل السجلات تم تجاهلها (تكرار)
  "errors": 0
}
```

✅ **رائع!** النظام اكتشف التكرار وتجاهله.

### 2. تحقق: لا يوجد تكرار في القاعدة
```sql
SELECT 
  employeeId,
  type,
  COUNT(*) as count
FROM attendance_records
WHERE date = CURRENT_DATE
GROUP BY employeeId, type
HAVING COUNT(*) > 1;
```

**النتيجة المتوقعة:** 0 صفوف (لا يوجد تكرار)

---

## 🎯 الخطوة 7: اختبر الاستراتيجيات المختلفة

### اختبر `keep_last`:
```bash
# 1. غير في .env
BIOMETRIC_DUPLICATE_STRATEGY=keep_last

# 2. احذف بيانات اليوم
DELETE FROM attendance_records WHERE date = CURRENT_DATE;

# 3. أعد تشغيل الباك اند
npm run start:dev

# 4. زامن
POST http://localhost:5001/biometric/trigger-sync
```

### اختبر `average`:
```bash
# 1. غير في .env
BIOMETRIC_DUPLICATE_STRATEGY=average

# 2. كرر نفس الخطوات
```

### العودة للموصى به:
```bash
BIOMETRIC_DUPLICATE_STRATEGY=keep_earliest
```

---

## 🔧 الخطوة 8: اختبار endpoints أخرى

### حالة الجهاز:
```
GET http://localhost:5001/biometric/status
```

**النتيجة:**
```json
{
  "mode": "simulator",
  "connected": true
}
```

### إعدادات التكرار:
```
GET http://localhost:5001/biometric/duplicate-config
```

**النتيجة:**
```json
{
  "strategy": "keep_earliest",
  "windowMinutes": 5,
  "description": "For check-in keeps earliest, for check-out keeps latest",
  "fairnessLevel": "high",
  "recommended": true
}
```

---

## 🎮 الخطوة 9: الواجهة الأمامية (اختياري)

إذا كان لديك الفرونت اند شغال:

```
http://localhost:3000/attendance/biometric
```

ستشاهد لوحة تحكم بالبصمات مع:
- عدد السجلات الجديدة
- عدد التحديثات
- عدد المتجاهلة
- حالة المزامنة

---

## 🚀 الخطوة 10: التبديل للجهاز الحقيقي

عندما يكون الجهاز جاهز:

```env
# في .env
USE_BIOMETRIC_SIMULATOR=false
BIOMETRIC_DEVICE_IP=192.168.1.201  # IP الجهاز الحقيقي
BIOMETRIC_DEVICE_PORT=4370
```

ثم أعد تشغيل الباك اند:
```bash
npm run start:dev
```

ستشاهد:
```
🔧 BiometricService initialized in HARDWARE mode
```

---

## ✅ قائمة التحقق

- [ ] الباك اند يعمل (`npm run start:dev`)
- [ ] تم تسجيل الدخول والحصول على توكن
- [ ] المزامنة الأولى نجحت (synced: 8)
- [ ] المزامنة الثانية تجاهلت التكرار (skipped: 8)
- [ ] لا يوجد تكرار في قاعدة البيانات
- [ ] endpoint حالة الجهاز يعمل
- [ ] endpoint إعدادات التكرار يعمل
- [ ] تم اختبار استراتيجية مختلفة

---

## 🐛 حل المشاكل

### المشكلة: لا يوجد موظف بـ ID 6, 10, 15
```sql
-- أضف موظفين للاختبار
INSERT INTO employees (employeeId, name, department, hourlyRate, currency, status, workDaysInPeriod, hoursPerDay, scheduledStart, scheduledEnd)
VALUES 
('EMP000006', 'هبا السيد أحمد', 'IT', 50, 'SYP', 'active', 26, 8, '08:00', '17:00'),
('EMP000010', 'موظف اختبار 10', 'HR', 50, 'SYP', 'active', 26, 8, '08:00', '17:00'),
('EMP000015', 'موظف اختبار 15', 'Sales', 50, 'SYP', 'active', 26, 8, '08:00', '17:00');
```

### المشكلة: خطأ في التوكن
```bash
# تأكد من نسخ التوكن بشكل صحيح من response تسجيل الدخول
# أو استخدم -SessionVariable في PowerShell
```

### المشكلة: Port 5001 مستخدم
```bash
# غير PORT في .env
PORT=5002
```

---

## 📚 للمزيد من المعلومات

- **الشرح الكامل بالعربي:** `docs/BIOMETRIC_SUMMARY_AR.md`
- **دليل الاختبار التفصيلي:** `test-biometric-sync.md`
- **إعداد الجهاز الحقيقي:** `docs/BIOMETRIC_HARDWARE_SETUP.md`
- **معالجة التكرار:** `docs/BIOMETRIC_DUPLICATE_HANDLING.md`

---

## 🎉 تهانينا!

نظام البصمة يعمل بشكل كامل مع معالجة ذكية للتكرار!

**آخر تحديث:** 11 يونيو 2026  
**الحالة:** ✅ جاهز للاستخدام
