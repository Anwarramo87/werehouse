# 🌟 Master Prompt لتنفيذ التكامل كاملاً (Execution Prompt)

انسخ هذا النص (الـ Prompt) وأرسله لي أو لأي نموذج ذكاء اصطناعي للبدء في كتابة أوامر البرمجة وحقنها في النظام بأعلى معايير الأداء والأمان (Level 2 Performance & Top Security):

---

**[Copy The Text Below / انسخ النص أدناه]**

```text
Please implement the complete Biometric Fingerprint (Time & Attendance) integration with the Payroll system in my NestJS (werehouse/backend-nest) and Next.js (Factory) workspace. 

I need you to ensure Top Security, Level 2 Performance, and NO ERRORS or MISMATCHES. Please execute the following:

1. **Database Schema Update (Prisma):** Add the Compound Index `@@index([employeeId, date])` to the DailyAttendanceLog. Add fields for `lateMinutes`, `lateDeductionAmount`, and `absentPenaltyAmount`.
2. **Biometric Push Controller (NestJS):** Create a highly secure, rate-limited ADMS push endpoint (`POST /biometric/push`) protected by API Key to accept webhooks natively from ZKTeco/Fingerprint devices.
3. **Payroll Math Engine (NestJS Service):** Implement the `PayrollCalculationService`. It must execute exactly at month-end using `@nestjs/schedule` (Cron). It should calculate: Hourly Rate = Base/30/8, Late Deduction, and Absence Penalty (as defined in the BIOMETRIC_PAYROLL_SYSTEM docs).
4. **Performance Optimization:** Use `groupBy` in Prisma to summarize monthly deductions in ONE optimized query (avoid N+1) when generating the final salary slip.
5. **Frontend Display (Next.js):** Create an Admin Dashboard page in Factory to view Real-time attendance synced from the device, and a unified Payroll review table showing exact calculations (Base - Advances - Lateness - Absence = Net).

Work systematically. Validate all equations. Do not leave any deprecated configurations, and verify the frontend Typescript errors do not clash. Start generating the backend modules and let me know when ready for the frontend.
```