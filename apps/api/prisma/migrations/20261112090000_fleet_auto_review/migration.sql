ALTER TABLE "FleetRepo"
  ADD COLUMN "autoReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoReviewProfiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "autoReviewMaxCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
  ADD COLUMN "autoReviewEnabledById" TEXT,
  ADD COLUMN "autoReviewEnabledByType" TEXT,
  ADD COLUMN "autoReviewEnabledAt" TIMESTAMP(3);

CREATE INDEX "FleetRepo_autoReview_idx" ON "FleetRepo"("autoReview");
