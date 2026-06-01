-- Manual superadmin seed migration
-- Reason: restore the requested superadmin account in an existing database.

DO $$
DECLARE
  admin_role_id UUID;
BEGIN
  INSERT INTO "roles" ("id", "name", "description", "permissions", "createdAt", "updatedAt")
  VALUES (
    gen_random_uuid(),
    'admin',
    'Administrator role',
    ARRAY[
      'view_employees',
      'edit_employees',
      'delete_employees',
      'view_devices',
      'manage_devices',
      'manage_users',
      'manage_roles',
      'view_attendance',
      'edit_attendance',
      'view_payroll',
      'run_payroll',
      'approve_payroll',
      'view_inventory',
      'edit_inventory',
      'view_imports',
      'run_imports',
      'manage_salary',
      'manage_advances',
      'manage_insurance',
      'manage_bonuses',
      'manage_penalties'
    ]::TEXT[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("name") DO UPDATE
    SET "permissions" = EXCLUDED."permissions"
      , "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "id" INTO admin_role_id;

  IF admin_role_id IS NULL THEN
    SELECT "id" INTO admin_role_id
    FROM "roles"
    WHERE "name" = 'admin'
    LIMIT 1;
  END IF;

  INSERT INTO "users" ("id", "username", "email", "passwordHash", "roleId", "status", "failedLoginAttempts", "createdAt", "updatedAt")
  VALUES (
    gen_random_uuid(),
    'superadmin',
    'superadmin@warehouse.local',
    '$2a$10$1mVRJ6H4Q3ICEoh1/bx8W.e0xUcoK3v1EEEHNZqDel5ULZd5.rgT6',
    admin_role_id,
    'active',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("username") DO UPDATE
    SET "email" = EXCLUDED."email",
        "passwordHash" = EXCLUDED."passwordHash",
        "roleId" = EXCLUDED."roleId",
        "status" = EXCLUDED."status",
        "updatedAt" = CURRENT_TIMESTAMP;
END $$;