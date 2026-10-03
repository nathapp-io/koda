-- Fleet S1.5 slice 2a: approval relay fields (spec §1.6). FleetJob.bashMode already exists (S1, raw only).
ALTER TABLE "FleetJob" ADD COLUMN "approvalTimeoutSec" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "JobSchedule" ADD COLUMN "bashMode" TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE "JobSchedule" ADD COLUMN "approvalTimeoutSec" INTEGER NOT NULL DEFAULT 600;
