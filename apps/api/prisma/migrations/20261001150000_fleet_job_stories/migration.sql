-- S1b slice 1b: the PRD story list from the runner's snapshots.
ALTER TABLE "FleetJob" ADD COLUMN "stories" JSONB;
ALTER TABLE "FleetJob" ADD COLUMN "storiesTruncated" BOOLEAN NOT NULL DEFAULT false;
