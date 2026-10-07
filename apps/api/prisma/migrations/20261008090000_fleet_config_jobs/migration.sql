-- Fleet S3: config jobs (spec §1, D465, D466, D475).
-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "configResult" JSONB;

-- CreateTable
CREATE TABLE "FleetConfigEdit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "edits" JSONB NOT NULL,
    "prTitle" TEXT,
    "prBody" TEXT,
    "baseSha" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetConfigEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetConfigEdit_jobId_key" ON "FleetConfigEdit"("jobId");

-- AddForeignKey
ALTER TABLE "FleetConfigEdit" ADD CONSTRAINT "FleetConfigEdit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

