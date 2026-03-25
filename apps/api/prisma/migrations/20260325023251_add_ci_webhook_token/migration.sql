-- AlterTable
ALTER TABLE "Project" ADD COLUMN "ciWebhookToken" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "gitRefFile" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "gitRefLine" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "gitRefVersion" TEXT;
