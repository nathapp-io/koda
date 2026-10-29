-- Permissions P3 approval gate, gate-secret US-001: the redeem mode of a request's command.
-- DEFAULT false keeps every row written before this migration an execute-after-approval request, and
-- the sweeper's due scan and the stale-approved retry read the flag as a column because the command
-- registry is not visible to them. No index change: the flag is read with the request row.
ALTER TABLE "ApprovalRequest" ADD COLUMN "redeem" BOOLEAN NOT NULL DEFAULT false;
