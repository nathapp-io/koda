-- Fleet FIX (fix detected checks): a repo-level, default-off switch that allows `nax bot fix` to run
-- the check commands it detects for a base branch that has no nax check commands. Additive and
-- defaulted, so every existing repo keeps the setting off.
ALTER TABLE "FleetRepo" ADD COLUMN "fixTrustDetectedChecks" BOOLEAN NOT NULL DEFAULT false;
