-- Permissions P1d US-002: a fleet job and a schedule may be requested by an agent.
--
-- `FleetJob.requestedById` and `JobSchedule.createdById` were foreign keys to `User`, so an agent's
-- dispatch or schedule failed with a P2003. Both columns now hold a User or an Agent id and the two
-- foreign keys are dropped; the new `requestedByType` / `createdByType` columns say which, and an
-- absent value (no row can have one: the default applies) means a user's. Every existing row was
-- written by a user, so the default is the backfill and no row changes. No index changes: neither
-- column was ever indexed on its own beyond its unique/primary key.

ALTER TABLE "FleetJob" ADD COLUMN "requestedByType" TEXT NOT NULL DEFAULT 'USER';

ALTER TABLE "JobSchedule" ADD COLUMN "createdByType" TEXT NOT NULL DEFAULT 'USER';

ALTER TABLE "FleetJob" DROP CONSTRAINT "FleetJob_requestedById_fkey";

ALTER TABLE "JobSchedule" DROP CONSTRAINT "JobSchedule_createdById_fkey";
