ALTER TABLE "ChatThread" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'read',
    ADD COLUMN "pendingApprovals" JSONB;
ALTER TABLE "FleetThreadTurn" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'read';

-- Unlocked system roles preserve local edits; add only the new default developer grant.
UPDATE "Role"
SET "permissions" = "permissions" || '["thread.mode.ask"]'::jsonb, "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND NOT "permissions" @> '["thread.mode.ask"]'::jsonb;
