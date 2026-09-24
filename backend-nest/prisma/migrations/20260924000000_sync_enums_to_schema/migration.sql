-- Sync enum values to match schema.prisma.
-- The shared Neon DB drifted: an earlier state of the phase1 migration left the
-- enums with older value sets. No production data uses these (only ProductType
-- has live rows: 'RAW' -> renamed to 'RAW_MATERIAL').
--
--   ProductType:      (RAW, FINISHED)              -> (RAW_MATERIAL, SEMI_FINISHED, FINISHED)
--   ProductionStatus: lacks PLANNED                -> add PLANNED
--   RepMovementType:  (ASSIGNMENT,SALE,RETURN,RESTOCK,SETTLEMENT)
--                     -> (RECEIVED,SOLD,RETURNED,ADJUSTED,SETTLED)
--   SettlementStatus: (PENDING,APPROVED,REJECTED)  -> (PENDING,SUBMITTED,APPROVED,DISPUTED,CLOSED)

-- ProductType: rename 'RAW' -> 'RAW_MATERIAL' (if the old value still exists)
DO $$
DECLARE
  has_raw BOOLEAN;
  has_raw_material BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ProductType' AND e.enumlabel = 'RAW'
  ) INTO has_raw;
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ProductType' AND e.enumlabel = 'RAW_MATERIAL'
  ) INTO has_raw_material;
  IF has_raw AND NOT has_raw_material THEN
    ALTER TYPE "ProductType" RENAME VALUE 'RAW' TO 'RAW_MATERIAL';
  END IF;
END $$;

ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'SEMI_FINISHED';

-- ProductionStatus: add missing 'PLANNED'
ALTER TYPE "ProductionStatus" ADD VALUE IF NOT EXISTS 'PLANNED';

-- RepMovementType: rename old values to the schema's canonical set
DO $$
DECLARE
  has_label BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'RepMovementType' AND e.enumlabel = 'ASSIGNMENT'
  ) INTO has_label;
  IF has_label THEN
    ALTER TYPE "RepMovementType" RENAME VALUE 'ASSIGNMENT' TO 'RECEIVED';
    ALTER TYPE "RepMovementType" RENAME VALUE 'SALE' TO 'SOLD';
    ALTER TYPE "RepMovementType" RENAME VALUE 'RETURN' TO 'RETURNED';
    ALTER TYPE "RepMovementType" RENAME VALUE 'RESTOCK' TO 'ADJUSTED';
    ALTER TYPE "RepMovementType" RENAME VALUE 'SETTLEMENT' TO 'SETTLED';
  END IF;
END $$;

-- SettlementStatus: rename REJECTED -> CLOSED, add SUBMITTED and DISPUTED
DO $$
DECLARE
  has_rejected BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'SettlementStatus' AND e.enumlabel = 'REJECTED'
  ) INTO has_rejected;
  IF has_rejected THEN
    ALTER TYPE "SettlementStatus" RENAME VALUE 'REJECTED' TO 'CLOSED';
  END IF;
END $$;

ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';