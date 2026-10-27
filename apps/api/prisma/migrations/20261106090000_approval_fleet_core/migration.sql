-- Permissions P3 approval + fleet core (US-002, US-003, US-009): each statement touches a different
-- table, so they land in whatever order the stories do.

UPDATE "Role"
SET "permissions" = "permissions" || '["approval.decide@fleet.job.shell.escalate"]'::jsonb, "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND "permissions" @> '["fleet.approval.decide.bash"]'::jsonb
  AND NOT "permissions" @> '["approval.decide@fleet.job.shell.escalate"]'::jsonb;

ALTER TABLE "ApprovalDecision" ADD COLUMN "params" JSONB;
