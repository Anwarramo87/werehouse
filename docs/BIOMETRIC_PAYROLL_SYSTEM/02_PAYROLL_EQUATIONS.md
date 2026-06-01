# 🧮 معادلات الرواتب والخصومات (Payroll Equations & Formulas)

يشرح هذا الملف جميع المعادلات الرياضية (Equations) الدقيقة المستخدمة لحساب الرواتب بناءً على جهاز البصمة (دوام الموظف، تأخيره، وغيابه)، ليأخذ النظام الأكشن التلقائي نهاية الشهر.

## 1. تفكيك الراتب الأساسي (Base Salary Deconstruction)
- **الراتب الأساسي (Base Salary):** $S_{base}$
- **أجرة اليوم الواحد (Daily Rate):** $S_{daily} = \frac{S_{base}}{30}$ (بافتراض الشهر 30 يوم)
- **أجرة الساعة (Hourly Rate):** $S_{hourly} = \frac{S_{daily}}{8}$ (بافتراض 8 ساعات عمل يومياً)

---

## 2. معادلة التأخير (Lateness Equation)
عندما يسجل الموظف بصمته متأخراً عن وقت بداية الدوام (مثال: الدوام 08:00 صباحاً، بصم 08:45).
- **دقائق التأخير (Late Minutes):** $T_{late} = Time_{punch\_in} - Time_{shift\_start}$
- **ساعات التأخير (Late Hours):** $H_{late} = \frac{T_{late}}{60}$
- **معامل الخصم (Penalty Factor):** $P_{late}$ (افتراضياً 1.0 أو 1.5 حسب سياسة الشركة كعقوبة).
- **خصم التأخير الإجمالي (Lateness Deduction):** 
  $$Deduction_{late} = \sum (H_{late} \times S_{hourly} \times P_{late})$$

---

## 3. معادلة الغياب (Absence Equation)
إذا لم يستقبل الخادم أي بصمة دخول للموظف في يوم العمل.
- **أيام الغياب (Absent Days):** $D_{absent}$
- **عقوبة الغياب (Absence Penalty):** $P_{absent}$ (عادة يخصم يومين عن كل يوم غياب بدون عذر، أي 2.0).
- **خصم الغياب الإجمالي (Absence Deduction):** 
  $$Deduction_{absent} = D_{absent} \times S_{daily} \times P_{absent}$$

---

## 4. معادلة الراتب النهائي المستحق (Final Salary Equation)
نهاية الشهر، يقوم النظام بحساب هذا الراتب تلقائياً.
- **الراتب النهائي (Net Salary):** $S_{net}$
- **السلف المسحوبة (Advances):** $A_{total}$

$$S_{net} = S_{base} - Deduction_{late} - Deduction_{absent} - A_{total}$$

### خوارزمية التطبيق (Algorithm Flow):
1. نهاية كل يوم `00:00`، يعمل (CRON Job).
2. يبحث عن الموظفين الذين ليس لديهم `Punch In`.
3. يسجللهم `Absent` في جدول الحضور.
4. يحسب دقائق التأخير لمن حضر، ويحدث حقل `lateDeductionAmount`.
5. نهاية الشهر تبدأ عملية الـ Payroll بجمع هذه الخصومات وتطبيق المعادلة الأخيرة.
