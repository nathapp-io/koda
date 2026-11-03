-- Review P2 remainder (US-007): deleting an agent is a soft delete.
--
-- A hard delete set every optional relation to NULL (`ON DELETE SET NULL`), so the agent's comments
-- became authorless and its tickets lost `createdByAgentId` / `assignedToAgentId`. The row now stays
-- as a tombstone: `deletedAt` marks it, the status becomes OFFLINE, the key hash is replaced by a
-- dead `deleted:` value and the slug is renamed to `<slug>~deleted-<id>`, which frees the original
-- slug for a new agent.
--
-- Nullable and indexed: every live-agent read filters on `deletedAt IS NULL` (US-008), and existing
-- rows are live agents.
ALTER TABLE "Agent" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Agent_deletedAt_idx" ON "Agent"("deletedAt");
