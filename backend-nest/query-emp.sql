SELECT date, type, 
  (EXTRACT(HOUR FROM timestamp) + 3)::int % 24 || ':' || LPAD(EXTRACT(MINUTE FROM timestamp)::text, 2, '0') as local_time,
  source
FROM "AttendanceRecord" 
WHERE "employeeId" = 'EMP00022' 
ORDER BY date DESC, timestamp ASC;

SELECT date::text, "recordType", value, notes
FROM "DailyAttendanceLog"
WHERE "employeeId" = 'EMP00022'
ORDER BY date DESC;
