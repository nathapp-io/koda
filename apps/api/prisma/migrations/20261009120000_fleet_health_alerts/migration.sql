-- Fleet S4a: global outbox events (D512) and fleet health alert episodes (§1, D507).
-- AlterTable
ALTER TABLE "OutboxEvent" ALTER COLUMN "projectId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "FleetHealthAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "FleetHealthAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FleetHealthAlert_kind_subjectKey_closedAt_idx" ON "FleetHealthAlert"("kind", "subjectKey", "closedAt");

-- CreateIndex
CREATE INDEX "FleetHealthAlert_closedAt_idx" ON "FleetHealthAlert"("closedAt");

-- One open episode per subject (not expressible in Prisma; replayed by test/global-setup.ts).
CREATE UNIQUE INDEX IF NOT EXISTS "FleetHealthAlert_open_subject_key" ON "FleetHealthAlert" ("kind", "subjectKey") WHERE "closedAt" IS NULL;
