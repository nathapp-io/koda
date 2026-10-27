UPDATE "Role"
SET "permissions" = "permissions" || '["approval.decide@fleet.job.shell.escalate"]'::jsonb, "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND "permissions" @> '["fleet.approval.decide.bash"]'::jsonb
  AND NOT "permissions" @> '["approval.decide@fleet.job.shell.escalate"]'::jsonb;
