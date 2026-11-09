-- US-001: feature-scoped flow jobs.
ALTER TABLE "FleetJob" ADD COLUMN "flowFeatureId" TEXT;
ALTER TABLE "FleetFlowFeature" ADD COLUMN "branch" TEXT;

-- The set's sha starts as the spec sha every existing flow was approved with.
ALTER TABLE "FleetFlow" ADD COLUMN "setSha" TEXT NOT NULL DEFAULT '';
UPDATE "FleetFlow" SET "setSha" = "specSha";
ALTER TABLE "FleetFlow" ALTER COLUMN "setSha" DROP DEFAULT;

-- Every existing flow job belongs to the flow's first feature (the only feature of a single-feature flow).
UPDATE "FleetJob" AS job
   SET "flowFeatureId" = feature."id"
  FROM "FleetFlowFeature" AS feature
 WHERE feature."flowId" = job."flowId"
   AND feature."position" = 0;

CREATE INDEX "FleetJob_flowId_flowFeatureId_queuedAt_idx" ON "FleetJob"("flowId", "flowFeatureId", "queuedAt");
