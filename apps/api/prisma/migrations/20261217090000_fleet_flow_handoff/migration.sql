-- US-003 (#477): the flow handoff record.
--
-- A flow created from a handoff takes over a chat run that planned and ran a feature without
-- publishing it. That run's record (`result.json` and `ledger.md`) lives in the chat checkout
-- under `.nax/features/<feature>/workflow/<runId>/`, which is git-excluded, so it travels with the
-- request and is stored here.
--
-- `FleetFlowFeature.handoff` marks the feature the record belongs to (the flow's first feature)
-- and `FleetFlowFeature.handoffRecord` holds the record. Every flow read omits `handoffRecord`, so
-- the record is never loaded on an advance tick and never reaches a flow DTO or an approval card;
-- only the RUN dispatch reads it, through `findHandoffRecord`.
--
-- `FleetJob.handoff` holds the copy the RUN job sends to its runner in the ASSIGN payload.

-- AlterTable
ALTER TABLE "FleetFlowFeature" ADD COLUMN "handoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FleetFlowFeature" ADD COLUMN "handoffRecord" JSONB;
ALTER TABLE "FleetJob" ADD COLUMN "handoff" JSONB;
