SELECT ar.date, ar.type, 
  ((EXTRACT(HOUR FROM ar.timestamp)::int + 3) % 24)::text || ':' || LPAD(EXTRACT(MINUTE FROM ar.timestamp)::text, 2, '0') as local_time,
  ar.source
FROM attendance_records ar
WHERE ar.employee_id = 'EMP00022' 
ORDER BY ar.date DESC, ar.timestamp ASC;
