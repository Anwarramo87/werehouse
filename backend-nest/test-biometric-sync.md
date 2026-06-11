# 🧪 Quick Test Guide - Biometric Duplicate Handling

## 🎯 Test Setup

### Step 1: Ensure Simulator Mode is Active
In `.env`:
```env
USE_BIOMETRIC_SIMULATOR=true
BIOMETRIC_DUPLICATE_STRATEGY=keep_earliest
BIOMETRIC_DUPLICATE_WINDOW_MINUTES=5
```

### Step 2: Start Backend
```bash
cd werehouse/backend-nest
npm run start:dev
```

### Step 3: Get JWT Token
Login to get authentication token:
```bash
curl -X POST http://localhost:5001/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your_password"
  }'
```

Save the JWT token from the response.

---

## 🚀 Test Scenarios

### Test 1: First Sync (No Duplicates)
```bash
curl -X POST http://localhost:5001/biometric/trigger-sync \
  -H "Cookie: jwt=YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Output:**
```json
{
  "success": true,
  "synced": 8,
  "skipped": 0,
  "updated": 0,
  "errors": 0,
  "logs": [...]
}
```

### Test 2: Second Sync (All Duplicates - Should Skip)
Run the same command again immediately:
```bash
curl -X POST http://localhost:5001/biometric/trigger-sync \
  -H "Cookie: jwt=YOUR_JWT_TOKEN"
```

**Expected Output with `keep_earliest` strategy:**
```json
{
  "success": true,
  "synced": 0,
  "skipped": 8,
  "updated": 0,
  "errors": 0,
  "logs": []
}
```

### Test 3: Check Device Status
```bash
curl http://localhost:5001/biometric/status \
  -H "Cookie: jwt=YOUR_JWT_TOKEN"
```

**Expected Output:**
```json
{
  "mode": "simulator",
  "connected": true
}
```

### Test 4: Check Duplicate Configuration
```bash
curl http://localhost:5001/biometric/duplicate-config \
  -H "Cookie: jwt=YOUR_JWT_TOKEN"
```

**Expected Output:**
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

## 🔍 Verify in Database

### Check Attendance Records
```sql
-- View all synced records
SELECT 
  ar.id,
  ar.employeeId,
  e.name,
  ar.timestamp,
  ar.type,
  ar.notes,
  ar.createdAt,
  ar.updatedAt
FROM attendance_records ar
JOIN employees e ON ar.employeeId = e.employeeId
WHERE ar.date = CURRENT_DATE
ORDER BY ar.employeeId, ar.timestamp;
```

### Check for Duplicates (Should be None)
```sql
SELECT 
  employeeId,
  type,
  DATE(timestamp) as date,
  COUNT(*) as count
FROM attendance_records
WHERE date = CURRENT_DATE
GROUP BY employeeId, type, DATE(timestamp)
HAVING COUNT(*) > 1;
```
**Expected:** No rows (no duplicates)

---

## 🧪 Manual Duplicate Test

### Step 1: Clear Today's Data
```sql
DELETE FROM attendance_records WHERE date = CURRENT_DATE;
```

### Step 2: Insert First Record Manually
```sql
INSERT INTO attendance_records (
  employeeId,
  timestamp,
  type,
  deviceId,
  source,
  verified,
  date,
  notes
) VALUES (
  'EMP900006',
  NOW(),
  'check-in',
  'ZK-SIM',
  'manual',
  true,
  CURRENT_DATE,
  'First scan'
);
```

### Step 3: Run Sync (Will Detect Duplicate)
```bash
curl -X POST http://localhost:5001/biometric/trigger-sync \
  -H "Cookie: jwt=YOUR_JWT_TOKEN"
```

### Step 4: Check Result
```sql
SELECT * FROM attendance_records 
WHERE employeeId = 'EMP900006' 
  AND date = CURRENT_DATE 
  AND type = 'check-in'
ORDER BY timestamp;
```

**Expected:** Only ONE record (duplicate was handled based on strategy)

---

## 📊 Test Different Strategies

### Test `keep_first` Strategy
```env
BIOMETRIC_DUPLICATE_STRATEGY=keep_first
```
Result: Always keeps the first scan, ignores later ones

### Test `keep_last` Strategy
```env
BIOMETRIC_DUPLICATE_STRATEGY=keep_last
```
Result: Updates to the last scan time

### Test `keep_earliest` Strategy ⭐
```env
BIOMETRIC_DUPLICATE_STRATEGY=keep_earliest
```
Result: 
- Check-in: Keeps earliest (fair to employee)
- Check-out: Keeps latest (credits all work)

### Test `average` Strategy
```env
BIOMETRIC_DUPLICATE_STRATEGY=average
```
Result: Calculates average time of all scans

---

## 🎯 Simulator Data

The simulator generates these logs by default:

| Employee | User ID | Time     | Type       | Notes                     |
|----------|---------|----------|------------|---------------------------|
| هبا      | 6       | 08:37 AM | Check-in   | Late 37 minutes (22 net) |
| هبا      | 6       | 05:00 PM | Check-out  | Normal                    |
| Emp 10   | 10      | 07:00 AM | Check-in   | Early (overtime)          |
| Emp 10   | 10      | 07:00 PM | Check-out  | Late (overtime)           |
| Emp 15   | 15      | 08:00 AM | Check-in   | Normal                    |
| Emp 15   | 15      | 03:00 PM | Check-out  | Early leave 2 hours       |
| هبا      | 6       | Saturday | Weekend    | Weekend work              |

---

## ✅ Success Criteria

- [ ] First sync inserts all records
- [ ] Second sync skips duplicates (0 new records)
- [ ] No duplicate records in database
- [ ] Metrics calculated correctly (late, early leave, overtime)
- [ ] Strategy changes are respected
- [ ] Audit logs show duplicate attempts

---

## 🐛 Troubleshooting

### Issue: "Cannot find module 'zklib'"
**Solution:** Run `npm install zklib`

### Issue: TypeScript errors
**Solution:** Run `npm run build` to see errors, they should all be fixed

### Issue: No data synced
**Solution:** 
1. Check `.env` has `USE_BIOMETRIC_SIMULATOR=true`
2. Verify employees with IDs 6, 10, 15 exist
3. Check logs: `npm run start:dev` shows detailed logs

### Issue: All records skipped as duplicates
**Solution:** This is correct if you already synced today! Clear data:
```sql
DELETE FROM attendance_records WHERE date = CURRENT_DATE;
```

---

## 📖 Documentation References

- Full Testing Guide: `docs/BIOMETRIC_TESTING.md`
- Hardware Setup: `docs/BIOMETRIC_HARDWARE_SETUP.md`
- Duplicate Handling: `docs/BIOMETRIC_DUPLICATE_HANDLING.md`
- Integration Summary: `docs/BIOMETRIC_INTEGRATION_SUMMARY.md`
- Completion Status: `docs/BIOMETRIC_COMPLETION_STATUS.md`

---

Last Updated: June 11, 2026
