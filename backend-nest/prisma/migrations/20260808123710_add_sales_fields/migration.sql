-- AlterTable
ALTER TABLE "sales_order_items" ADD COLUMN     "location" TEXT NOT NULL DEFAULT 'WH-A';

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
