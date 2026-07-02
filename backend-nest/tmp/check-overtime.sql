-- Check today's OUT records and overtime data
SELECT 
  ar."employeeId",
  e."name",
  e."scheduledEnd",
  ar."type",
  ar."timestamp",
  ar."date",
  ar."shiftPair"
FROM "AttendanceRecord" ar
JOIN "Employee" e ON e."employeeId" = ar."employeeId"
WHERE ar."date" = TO_CHAR(NOW() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD')
  AND ar."type" = 'OUT'
ORDER BY ar."timestamp" DESC
LIMIT 20;
