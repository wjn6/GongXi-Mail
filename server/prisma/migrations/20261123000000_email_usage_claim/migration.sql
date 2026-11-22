-- CreateEnum
CREATE TYPE "EmailUsageStatus" AS ENUM ('CLAIMED', 'COMPLETED');

-- AlterTable
ALTER TABLE "email_usage" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "status" "EmailUsageStatus" NOT NULL DEFAULT 'COMPLETED';

-- CreateIndex
CREATE INDEX "email_usage_status_lease_expires_at_idx" ON "email_usage"("status", "lease_expires_at");

-- Backfill: existing allocations are permanent (legacy /api/get-email semantics)
UPDATE "email_usage" SET "completed_at" = "used_at" WHERE "status" = 'COMPLETED' AND "completed_at" IS NULL;
