# 🚀 تشغيل الباك اند يدوياً

## المشكلة
في مشكلة permissions (EPERM) لما نحاول نشغل الباك اند من خلال Kiro.

## الحل البسيط

### الطريقة 1: تشغيل يدوي (موصى به)

**خطوة 1:** افتح PowerShell جديد أو CMD في المجلد:
```
c:\Users\anwar\Downloads\Backend2\werehouse\backend-nest
```

**خطوة 2:** شغل الباك اند:
```bash
npm run start:dev
```

أو إذا ما اشتغل، جرب:
```bash
npm run start:dev:fast
```

**خطوة 3:** انتظر لحتى تشوف:
```
🔧 BiometricService initialized in SIMULATOR mode
[Nest] Application is running on: http://localhost:5001
```

**خطوة 4:** بعد ما يصير الباك اند شغال، ارجع لـ Kiro وقلي "الباك اند شغال، شغل الاختبار"

---

### الطريقة 2: من VS Code Terminal

إذا عندك VS Code مفتوح:

1. اضغط `` Ctrl + ` `` لفتح Terminal
2. تأكد إنك في المجلد الصح:
   ```
   cd c:\Users\anwar\Downloads\Backend2\werehouse\backend-nest
   ```
3. شغل:
   ```
   npm run start:dev
   ```

---

### الطريقة 3: إعادة المحاولة مع Kiro

إذا بدك تحاول مع Kiro مرة ثانية:

1. أغلق كل ال terminals المفتوحة
2. افتح PowerShell جديد كـ Administrator
3. روح للمجلد وشغل

---

## بعد ما يشتغل الباك اند

1. تحقق إنو شغال:
   ```bash
   curl http://localhost:5001/health
   ```

2. أو افتح المتصفح:
   ```
   http://localhost:5001/health
   ```

3. لازم تشوف:
   ```json
   {"status":"ok","info":{"database":{"status":"up"}}}
   ```

4. قلي في Kiro: "الباك اند شغال" وأنا لح شغل الاختبار!

---

## 🎯 بعد التشغيل

سكريبت الاختبار رح يعمل:
- ✅ تسجيل دخول
- ✅ فحص حالة الجهاز
- ✅ مزامنة أولى (بيانات جديدة)
- ✅ مزامنة ثانية (اختبار التكرار)
- ✅ عرض النتائج بالعربي

---

آخر تحديث: 11 يونيو 2026
