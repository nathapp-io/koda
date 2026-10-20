-- Permissions P1 US-001: a thread records who created it, and a message who sent it, as a user or an agent.
--
-- `ChatThread.createdById` and `ChatMessage.authorUserId` were foreign keys to `User`, so a thread an agent created
-- failed with a P2003. Both columns now hold a User or an Agent id and the two foreign keys are dropped;
-- `ChatThread.createdByType` says which, and `ChatMessage.authorType` does the same for the message's sender. Both
-- columns keep their names.
--
-- Every thread and message that exists was written by a user, so `createdByType`'s default backfills every row and no
-- data changes. `authorType` carries no default: a row written before this migration has no known author type, and
-- every reader treats an absent value as a user's. The `(createdById, kind, lastActivityAt)` index is unchanged, and
-- neither `authorUserId` nor `authorType` is indexed today.

ALTER TABLE "ChatThread" ADD COLUMN "createdByType" TEXT NOT NULL DEFAULT 'USER';

ALTER TABLE "ChatMessage" ADD COLUMN "authorType" TEXT;

ALTER TABLE "ChatThread" DROP CONSTRAINT "ChatThread_createdById_fkey";

ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_authorUserId_fkey";
