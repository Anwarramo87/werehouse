-- Tune autovacuum for high-churn attendance tables.
-- Default scale_factor=0.20 delays cleanup on large tables with frequent writes.
-- Biometric punch-in/out generates constant dead tuples on these two tables.

ALTER TABLE attendance_records SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE daily_attendance_logs SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
