ALTER TABLE "PendingAction"
  ADD COLUMN "actorType" TEXT,
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'thread',
  ADD COLUMN "approvalMode" TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN "approverType" TEXT,
  ADD COLUMN "approverId" TEXT,
  ALTER COLUMN "threadId" DROP NOT NULL,
  ALTER COLUMN "jobId" DROP NOT NULL,
  ALTER COLUMN "toolCallId" DROP NOT NULL,
  ALTER COLUMN "requestedById" DROP NOT NULL;

UPDATE "PendingAction" SET "actorType" = 'user', "actorId" = "requestedById";
UPDATE "PendingAction" SET "approverType" = 'user', "approverId" = "decidedById"
  WHERE "decidedById" IS NOT NULL;

ALTER TABLE "PendingAction"
  ALTER COLUMN "actorType" SET NOT NULL,
  ALTER COLUMN "actorId" SET NOT NULL;

ALTER TABLE "AssistantToolCall"
  ADD COLUMN "actorType" TEXT,
  ADD COLUMN "actorId" TEXT,
  ALTER COLUMN "jobId" DROP NOT NULL,
  ALTER COLUMN "threadId" DROP NOT NULL,
  ALTER COLUMN "toolCallId" DROP NOT NULL,
  ALTER COLUMN "projectId" DROP NOT NULL;

UPDATE "AssistantToolCall" AS audit SET "actorType" = 'user', "actorId" = job."requestedById"
  FROM "FleetJob" AS job WHERE audit."jobId" = job."id";

ALTER TABLE "AssistantToolCall"
  ALTER COLUMN "actorType" SET NOT NULL,
  ALTER COLUMN "actorId" SET NOT NULL;
