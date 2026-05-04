INSERT INTO "employees" ("employeeId", "name", "email", "hourlyRate", "status")
VALUES ('EMP-2026-001', 'EMP 2026 Senior', 'emp-2026-001@example.com', 0, 'active')
ON CONFLICT ("employeeId") DO UPDATE
SET "name" = EXCLUDED."name",
    "email" = EXCLUDED."email",
    "hourlyRate" = EXCLUDED."hourlyRate",
    "status" = EXCLUDED."status";

INSERT INTO "employee_salaries" (
  "employeeId",
  "baseSalary",
  "livingAllowance",
  "responsibilityAllowance",
  "extraEffortAllowance",
  "productionIncentive",
  "transportAllowance",
  "insuranceAmount"
)
VALUES (
  'EMP-2026-001',
  4200000,
  600000,
  800000,
  500000,
  400000,
  850000,
  210000
)
ON CONFLICT ("employeeId") DO UPDATE
SET "baseSalary" = EXCLUDED."baseSalary",
    "livingAllowance" = EXCLUDED."livingAllowance",
    "responsibilityAllowance" = EXCLUDED."responsibilityAllowance",
    "extraEffortAllowance" = EXCLUDED."extraEffortAllowance",
    "productionIncentive" = EXCLUDED."productionIncentive",
    "transportAllowance" = EXCLUDED."transportAllowance",
    "insuranceAmount" = EXCLUDED."insuranceAmount";
