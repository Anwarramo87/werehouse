# 🧪 ZKTeco Biometric Integration - Testing Protocol

## Phase 4: Simulation Testing & Endpoint Verification

### Prerequisites
- ✅ Backend running: `npm run start:dev`
- ✅ `USE_BIOMETRIC_SIMULATOR=true` in `.env`
- ✅ Database accessible
- ✅ Test employee exists: `EMP900006` (هبا السيد أحمد)

---

## 1. Manual Sync Trigger (cURL)

### Test Command
```bash
curl -X POST http://localhost:5001/api/v1/biometric/trigger-sync \
  -H "Content-Type: application/json" \
  -H "Cookie: warehouse_access_token=YOUR_TOKEN_HERE" \
  -v
```

### Expected Response
```json
{
  "success": true,
  "synced": 6,
  "skipped": 0,
  "errors": 0,
  "logs": [
    {
      "employeeId": "EMP900006",
      "timestamp": "2026-06-11T08:37:00.000Z",
      "type": "check-in",
      "metrics": {
        "lateMinutes": 37,
        "earlyLeaveMinutes": 0,
        "overtimeMinutes": 0
      }
    }
  ]
}
```

---

## 2. Device Status Check (cURL)

```bash
curl -X GET http://localhost:5001/api/v1/biometric/status \
  -H "Cookie: warehouse_access_token=YOUR_TOKEN_HERE"
```

### Expected Response (Simulator Mode)
```json
{
  "mode": "simulator",
  "connected": true
}
```

---

## 3. Postman Testing Collection

### Request 1: Trigger Sync
```
Method: POST
URL: http://localhost:5001/api/v1/biometric/trigger-sync
Headers:
  - Content-Type: application/json
  - Cookie: warehouse_access_token={{token}}
```

### Request 2: Check Status
```
Method: GET
URL: http://localhost:5001/api/v1/biometric/status
Headers:
  - Cookie: warehouse_access_token={{token}}
```

---

## 4. Database Validation (Prisma Studio)

### Step 1: Open Prisma Studio
```bash
cd werehouse/backend-nest
npx prisma studio
```

### Step 2: Verify AttendanceRecord Table
```sql
-- Check latest synced records
SELECT * FROM "attendance_records"
WHERE source = 'simulator'
ORDER BY timestamp DESC
LIMIT 10;
```

### Expected Results
| employeeId | timestamp | type | source | notes | lateMinutes |
|------------|-----------|------|--------|-------|-------------|
| EMP900006 | 2026-06-11 08:37:00 | check-in | simulator | تأخير: 37 دقيقة | - |
| EMP900006 | 2026-06-11 17:00:00 | check-out | simulator | حضور عادي | - |

### Step 3: Verify Employee Metrics
```sql
-- Check if late minutes are calculated
SELECT 
  employeeId,
  timestamp,
  type,
  notes
FROM "attendance_records"
WHERE employeeId = 'EMP900006'
  AND date = CURRENT_DATE::text
ORDER BY timestamp;
```

---

## 5. Duplicate Prevention Test

### Test Scenario
Run sync twice in a row:
```bash
# First sync
curl -X POST http://localhost:5001/api/v1/biometric/trigger-sync

# Second sync (should skip duplicates)
curl -X POST http://localhost:5001/api/v1/biometric/trigger-sync
```

### Expected Response (Second Run)
```json
{
  "success": true,
  "synced": 0,
  "skipped": 6,
  "errors": 0,
  "logs": []
}
```

---

## 6. Error Handling Test

### Test Non-Existent Employee

Edit simulator in `biometric.service.ts` temporarily:
```typescript
{
  deviceUserId: 99999, // Non-existent employee
  recordTime: new Date(),
  checkType: 0,
}
```

### Expected Console Log
```
⚠️ Employee EMP099999 (Device ID: 99999) not found in database. Skipping log.
```

### Expected Response
```json
{
  "success": true,
  "synced": 6,
  "skipped": 0,
  "errors": 0,
  "logs": [...]
}
```
*Notice: Non-existent employee doesn't crash the system*

---

## 7. Frontend Dashboard Test

### Step 1: Open Dashboard
```
http://localhost:3000/attendance/biometric
```

### Step 2: Click "مزامنة الآن" Button

### Expected UI
- ✅ Device Status: 🧪 محاكي | متصل
- ✅ Summary Cards showing synced count
- ✅ Detailed logs table with:
  - Employee ID
  - Timestamp
  - Check type badge (green for in, blue for out)
  - Late/Early/Overtime badges

### Step 3: Verify Real-Time Update
- Click sync again → Should show "مكرر (متخطى)" count increase

---

## 8. Performance Metrics

### Benchmarks (Simulator Mode)
- ✅ Sync 100 records: < 2 seconds
- ✅ Duplicate check: < 100ms per record
- ✅ Database transaction: < 50ms per insert

### Load Test
```bash
# Run 10 sync requests concurrently
for i in {1..10}; do
  curl -X POST http://localhost:5001/api/v1/biometric/trigger-sync &
done
wait
```

### Expected: No crashes, all requests complete successfully

---

## 9. Validation Checklist

Before moving to hardware testing:

- [ ] ✅ Sync endpoint returns 200 OK
- [ ] ✅ Device status shows "simulator" mode
- [ ] ✅ Attendance records inserted in database
- [ ] ✅ Late minutes calculated correctly (37 min for EMP900006)
- [ ] ✅ Duplicate prevention works (skipped count increases)
- [ ] ✅ Non-existent employees don't crash system
- [ ] ✅ Frontend dashboard displays logs
- [ ] ✅ UI badges show correct metrics
- [ ] ✅ No console errors in backend logs

---

## 10. Troubleshooting

### Issue: "Permission denied" error
**Solution:** Ensure user has `edit_attendance` permission

### Issue: No logs synced (synced: 0)
**Solution:** Check if `EMP900006` exists in employees table:
```sql
SELECT * FROM employees WHERE employeeId = 'EMP900006';
```

### Issue: Database timeout
**Solution:** Check if Neon database is awake (might be cold start)

### Issue: Frontend can't fetch
**Solution:** Verify CORS settings allow `http://localhost:3000`

---

## Next Step: Phase 5 - Hardware Connection

Once all tests pass, proceed to connecting physical ZKTeco device.
