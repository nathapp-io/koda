-- US-008 (#370): the rule override a job was assigned. The repo's override is read when the job is
-- assigned, so the job records the summary of what it was assigned: { sha256, ruleFiles, rulesMode,
-- contextMode }. Nullable and additive, like `agentInput`: every existing job — and every job of a
-- command that never carries an override (a thread turn, a config job) — keeps NULL.
ALTER TABLE "FleetJob" ADD COLUMN "ruleOverride" JSONB;
