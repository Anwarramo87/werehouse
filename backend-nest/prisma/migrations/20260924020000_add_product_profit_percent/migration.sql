-- Add profit % on cost to products (pricing & profit loop).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "profitPercent" DECIMAL(8,3);