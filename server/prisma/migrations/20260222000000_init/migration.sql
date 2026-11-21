-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('ACTIVE', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "MailFetchStrategy" AS ENUM ('GRAPH_FIRST', 'IMAP_FIRST', 'GRAPH_ONLY', 'IMAP_ONLY');

-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "email" VARCHAR(100),
    "role" "Role" NOT NULL DEFAULT 'ADMIN',
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_secret" TEXT,
    "two_factor_temp_secret" TEXT,
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "key_prefix" VARCHAR(8) NOT NULL,
    "permissions" JSONB,
    "allowed_group_ids" JSONB,
    "allowed_email_ids" JSONB,
    "rate_limit" INTEGER NOT NULL DEFAULT 60,
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "usage_count" BIGINT NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_groups" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(255),
    "fetch_strategy" "MailFetchStrategy" NOT NULL DEFAULT 'GRAPH_FIRST',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "client_id" VARCHAR(100) NOT NULL,
    "password" VARCHAR(255),
    "refresh_token" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'ACTIVE',
    "group_id" INTEGER,
    "last_check_at" TIMESTAMP(3),
    "token_refreshed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "token_refresh_enabled" BOOLEAN NOT NULL DEFAULT true,
    "token_refresh_interval_hours" INTEGER NOT NULL DEFAULT 12,
    "token_refresh_concurrency" INTEGER NOT NULL DEFAULT 10,
    "token_refresh_next_run_at" TIMESTAMP(3),
    "token_refresh_last_auto_completed_at" TIMESTAMP(3),
    "token_refresh_last_auto_total" INTEGER,
    "token_refresh_last_auto_success" INTEGER,
    "token_refresh_last_auto_failed" INTEGER,
    "token_refresh_last_auto_duration_ms" INTEGER,
    "token_refresh_last_auto_failures" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_usage" (
    "id" SERIAL NOT NULL,
    "api_key_id" INTEGER NOT NULL,
    "email_account_id" INTEGER NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_logs" (
    "id" BIGSERIAL NOT NULL,
    "api_key_id" INTEGER,
    "email_account_id" INTEGER,
    "action" VARCHAR(50) NOT NULL,
    "request_ip" VARCHAR(45),
    "response_code" INTEGER,
    "response_time_ms" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "email_groups_name_key" ON "email_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_email_key" ON "email_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "email_usage_api_key_id_email_account_id_key" ON "email_usage"("api_key_id", "email_account_id");

-- CreateIndex
CREATE INDEX "api_logs_api_key_id_idx" ON "api_logs"("api_key_id");

-- CreateIndex
CREATE INDEX "api_logs_email_account_id_idx" ON "api_logs"("email_account_id");

-- CreateIndex
CREATE INDEX "api_logs_created_at_idx" ON "api_logs"("created_at");

-- CreateIndex
CREATE INDEX "api_logs_action_created_at_idx" ON "api_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "email_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_usage" ADD CONSTRAINT "email_usage_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_usage" ADD CONSTRAINT "email_usage_email_account_id_fkey" FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_email_account_id_fkey" FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

