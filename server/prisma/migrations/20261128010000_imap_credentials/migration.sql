-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN "imap_client_id" VARCHAR(100),
ADD COLUMN "imap_refresh_token" TEXT;
