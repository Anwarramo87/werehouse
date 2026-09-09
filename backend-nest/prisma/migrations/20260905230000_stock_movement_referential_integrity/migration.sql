-- ============================================================================
-- سلامة مرجعية على حركات المخزون
--
-- المشكلة: StockMovement.sku نصّ حرّ بلا مفتاح أجنبي، فيمكن تسجيل حركة على
-- صنف غير موجود ولا يعترض شيء. الشيء نفسه ينطبق على `location`.
--
-- لماذا NOT VALID؟
-- إضافة قيد عادي تفشل فوراً إن وُجد صفّ يتيم واحد في تاريخ المخزن كله — وهو
-- احتمال شبه مؤكّد في نظام عمل سنوات بلا قيد. الحلّ القياسي:
--   1) NOT VALID  → القيد يسري على كل صفّ جديد من الآن، والتاريخ يُترك كما هو
--   2) لاحقاً بعد تنظيف التاريخ: VALIDATE CONSTRAINT (لا يقفل الجدول للكتابة)
--
-- بهذا يُغلق باب الأخطاء الجديدة اليوم، دون أن تفشل الهجرة على بيانات قديمة
-- لا يعرف أحد قصّتها.
-- ============================================================================

-- ------------------------------------------------------- 1. الصنف على الحركة
-- المفتاح مركّب لأن sku فريد داخل المنشأة لا عالمياً. صفوف tenantId أو sku
-- فيها NULL لا يفحصها Postgres (MATCH SIMPLE)، وهو المطلوب: حركة قديمة بلا
-- منشأة تبقى كما هي.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_tenantId_sku_fkey"
  FOREIGN KEY ("tenantId", "sku")
  REFERENCES "products"("tenantId", "sku")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

-- ------------------------------------------- 2. تقرير الأصناف اليتيمة (عرض)
-- عرض تشخيصي يُظهر الحركات التي لن تجتاز VALIDATE. شغّله قبل التصديق:
--   SELECT * FROM stock_movement_orphans;
CREATE OR REPLACE VIEW "stock_movement_orphans" AS
SELECT
  sm.id,
  sm."tenantId",
  sm.sku,
  sm.location,
  sm.type,
  sm.quantity,
  sm."createdAt",
  CASE
    WHEN p.sku IS NULL THEN 'صنف غير موجود'
    ELSE 'موقع غير معرّف كخانة'
  END AS reason
FROM "stock_movements" sm
LEFT JOIN "products" p
  ON p."tenantId" IS NOT DISTINCT FROM sm."tenantId" AND p.sku = sm.sku
LEFT JOIN "storage_bins" b
  ON b."tenantId" IS NOT DISTINCT FROM sm."tenantId" AND b.code = sm.location
WHERE sm.sku IS NOT NULL
  AND (p.sku IS NULL OR b.code IS NULL);

COMMENT ON VIEW "stock_movement_orphans" IS
  'حركات مخزون تشير إلى صنف أو موقع غير موجود. نظّفها ثم صدّق القيد بـ ALTER TABLE ... VALIDATE CONSTRAINT.';

-- ------------------------------------------------- 3. الموقع على رصيد المخزون
-- لا يُضاف قيد على `location` هنا عمداً: المواقع النصّية القائمة (WH-A وما
-- شابه) سبقت هيكلة الخانات، ومطابقتها قرار بيانات يخصّ كل منشأة لا قرار
-- مخطّط. الفهرس أدناه يجعل تلك المطابقة سريعة حين تُجرى.
CREATE INDEX IF NOT EXISTS "stock_levels_tenantId_location_idx"
  ON "stock_levels"("tenantId", "location");

CREATE INDEX IF NOT EXISTS "stock_movements_tenantId_location_idx"
  ON "stock_movements"("tenantId", "location");

-- ------------------------------------------------------------------ خطوة لاحقة
-- بعد تنظيف ما يظهر في stock_movement_orphans:
--   ALTER TABLE "stock_movements" VALIDATE CONSTRAINT "stock_movements_tenantId_sku_fkey";
