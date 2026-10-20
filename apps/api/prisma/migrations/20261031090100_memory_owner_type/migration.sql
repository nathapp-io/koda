-- Permissions P1 US-008: a memory item says which table its `ownerId` names, so `memory.update.own`
-- can be decided against the item's owner.
--
-- `ownerId` has always held a User *or* an Agent id with nothing saying which, so an own-row check
-- cannot compare it to a principal. `ownerType` is nullable with no foreign key and no index — the value
-- is compared, never joined (like `MemoryItem.ownerId` itself). Null means the system wrote the row, or
-- that the row's owner cannot be known: a system item (the outbox subscriber, the governance processor)
-- and any row whose `ownerId` names neither table keeps null. A null-owner row can be superseded only by
-- a principal holding the any-row `memory.update`.
--
-- The backfill is the one historical-data rewrite this story performs. Each row is attributed to the
-- table its existing `ownerId` actually names; everything else stays null.

ALTER TABLE "MemoryItem" ADD COLUMN "ownerType" TEXT;

UPDATE "MemoryItem" SET "ownerType" = 'USER' WHERE "ownerId" IN (SELECT "id" FROM "User");

UPDATE "MemoryItem" SET "ownerType" = 'AGENT' WHERE "ownerType" IS NULL AND "ownerId" IN (SELECT "id" FROM "Agent");
