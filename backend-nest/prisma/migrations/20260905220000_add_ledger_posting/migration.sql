-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceId" UUID,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- CreateTable
CREATE TABLE "account_mappings" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "role" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_mappings_tenantId_idx" ON "account_mappings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "account_mappings_tenantId_role_key" ON "account_mappings"("tenantId", "role");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_sourceType_sourceId_idx" ON "journal_entries"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_sourceRef_key" ON "journal_entries"("tenantId", "sourceRef");

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
