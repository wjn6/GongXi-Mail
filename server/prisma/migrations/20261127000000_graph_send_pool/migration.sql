-- CreateEnum
CREATE TYPE "SendStrategy" AS ENUM ('LEAST_USED', 'ROUND_ROBIN', 'RANDOM');

-- CreateEnum
CREATE TYPE "SendCapability" AS ENUM ('UNKNOWN', 'ALLOWED', 'DENIED');

-- CreateEnum
CREATE TYPE "SendSource" AS ENUM ('RESEND', 'ADMIN');

-- CreateEnum
CREATE TYPE "SendStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED');

-- AlterTable
ALTER TABLE "email_groups" ADD COLUMN     "send_daily_limit" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "send_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "send_interval_seconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "send_max_recipients" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "send_strategy" "SendStrategy" NOT NULL DEFAULT 'LEAST_USED';

-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "last_sent_at" TIMESTAMP(3),
ADD COLUMN     "send_capability" "SendCapability" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "send_checked_at" TIMESTAMP(3),
ADD COLUMN     "send_cooldown_until" TIMESTAMP(3),
ADD COLUMN     "send_error_message" TEXT;

-- CreateTable
CREATE TABLE "send_logs" (
    "id" UUID NOT NULL,
    "source" "SendSource" NOT NULL,
    "status" "SendStatus" NOT NULL,
    "api_key_id" INTEGER,
    "admin_id" INTEGER,
    "group_id" INTEGER,
    "email_account_id" INTEGER,
    "requested_from" VARCHAR(512) NOT NULL,
    "from_name" VARCHAR(255),
    "from_address" VARCHAR(255),
    "to_addresses" JSONB NOT NULL,
    "cc_addresses" JSONB,
    "bcc_addresses" JSONB,
    "reply_to" JSONB,
    "subject" VARCHAR(998) NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "headers" JSONB,
    "tags" JSONB,
    "recipient_count" INTEGER NOT NULL,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "attachment_bytes" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "batch_id" UUID,
    "batch_index" INTEGER,
    "request_ip" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),

    CONSTRAINT "send_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resend_idempotency" (
    "id" SERIAL NOT NULL,
    "api_key_id" INTEGER NOT NULL,
    "endpoint" VARCHAR(32) NOT NULL,
    "key" VARCHAR(256) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resend_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "send_logs_email_account_id_status_attempted_at_idx" ON "send_logs"("email_account_id", "status", "attempted_at");

-- CreateIndex
CREATE INDEX "send_logs_api_key_id_created_at_idx" ON "send_logs"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "send_logs_status_next_attempt_at_idx" ON "send_logs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "send_logs_group_id_created_at_idx" ON "send_logs"("group_id", "created_at");

-- CreateIndex
CREATE INDEX "send_logs_batch_id_idx" ON "send_logs"("batch_id");

-- CreateIndex
CREATE INDEX "send_logs_created_at_idx" ON "send_logs"("created_at");

-- CreateIndex
CREATE INDEX "resend_idempotency_expires_at_idx" ON "resend_idempotency"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "resend_idempotency_api_key_id_endpoint_key_key" ON "resend_idempotency"("api_key_id", "endpoint", "key");

-- AddForeignKey
ALTER TABLE "send_logs" ADD CONSTRAINT "send_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_logs" ADD CONSTRAINT "send_logs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "email_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_logs" ADD CONSTRAINT "send_logs_email_account_id_fkey" FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resend_idempotency" ADD CONSTRAINT "resend_idempotency_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
