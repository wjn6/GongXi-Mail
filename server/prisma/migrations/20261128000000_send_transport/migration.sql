-- CreateEnum
CREATE TYPE "SendTransport" AS ENUM ('AUTO', 'GRAPH', 'SMTP');

-- AlterTable
ALTER TABLE "email_groups" ADD COLUMN "send_transport" "SendTransport" NOT NULL DEFAULT 'AUTO';

-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN "smtp_capability" "SendCapability" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "send_logs" ADD COLUMN "transport" VARCHAR(20);
