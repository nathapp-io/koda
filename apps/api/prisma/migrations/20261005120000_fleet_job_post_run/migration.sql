-- Fleet S2b (j) slice 1: nax post-run stage statuses mirrored from the runner (spec §1.3, D438).
ALTER TABLE "FleetJob" ADD COLUMN "postRun" JSONB;
