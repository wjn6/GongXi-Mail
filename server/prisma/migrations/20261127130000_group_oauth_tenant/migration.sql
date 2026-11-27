-- CreateEnum
CREATE TYPE "OAuthTenant" AS ENUM ('CONSUMERS', 'ORGANIZATIONS', 'COMMON');

-- AlterTable
ALTER TABLE "email_groups" ADD COLUMN     "oauth_tenant" "OAuthTenant" NOT NULL DEFAULT 'CONSUMERS';
