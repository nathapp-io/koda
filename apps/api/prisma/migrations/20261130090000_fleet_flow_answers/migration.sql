ALTER TABLE "FleetFlowFeature"
  ADD COLUMN "questionsJobId" TEXT,
  ADD COLUMN "questions" JSONB,
  ADD COLUMN "answers" JSONB,
  ADD COLUMN "answeredById" TEXT,
  ADD COLUMN "answeredAt" TIMESTAMP(3);
