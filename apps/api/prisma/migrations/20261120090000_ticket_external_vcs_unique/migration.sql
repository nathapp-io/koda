-- Review P2 remainder (US-003): a VCS issue imports into at most one ticket per project.
--
-- Two webhook deliveries, a "Sync now" during a polling tick, or two overlapping ticks could each
-- import the same issue, because the dedup pre-check and the insert were separate statements. The
-- unique index makes Postgres decide the race:
--   * outside a transaction the loser's insert rolls back on its own, so the import reports `skipped`;
--   * inside an enclosing transaction the violation propagates and that transaction fails as a whole.
--
-- Existing duplicates would block the index, so the older rows give up their external id first. The
-- import with the lowest ticket number per (projectId, externalVcsId) is the one that stays imported;
-- the others become ordinary hand-made tickets (they keep their number, title and history).
UPDATE "Ticket" t SET "externalVcsId" = NULL
WHERE t."externalVcsId" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "Ticket" o
  WHERE o."projectId" = t."projectId" AND o."externalVcsId" = t."externalVcsId" AND o."number" < t."number");

-- Nullable, so hand-made tickets (externalVcsId IS NULL) are never in conflict: Postgres treats
-- NULLs as distinct in a unique index.
CREATE UNIQUE INDEX "Ticket_projectId_externalVcsId_key" ON "Ticket"("projectId", "externalVcsId");
