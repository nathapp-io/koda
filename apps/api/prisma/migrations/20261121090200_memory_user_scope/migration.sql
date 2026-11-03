-- memory-notes US-004 (#378): a principal-owned, user-scoped note.
--
-- `scope` says whose memory a row is. `project` is what every row was before this story; `user` is a NOTE
-- owned by the principal that wrote it, stored once and read in every project that passes the owner. Only a
-- NOTE may be user-scoped — the triples (FACT, DECISION, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN) stay
-- project-scoped, and the write path refuses the combination before anything is written.
--
-- A user row keeps `projectId` null; that is why the column becomes nullable and why it is safe: every read
-- that does not pass an owner filters on `projectId`, so a user row is invisible to it.
--
-- Two unique keys, one per kind of row, and neither one touches the other:
--   * `MemoryItem_projectId_activeKey_key` (already shipped) keys a project's active rows;
--   * `MemoryItem_ownerKey_activeKey_key` keys one principal's user notes.
-- `ownerKey` is set on user rows only, and Postgres treats a null as distinct, so the second index never
-- constrains a project row; a user row's null `projectId` keeps the first index out of its way in the same
-- way. That is what lets an agent hold a user note and a project note of the same slug at the same time.
--
-- No backfill: `scope` defaults to 'project' and `ownerKey` stays null, which is exactly the state every
-- existing row is in. The index name is Prisma's own default for `@@unique([ownerKey, activeKey])`.

ALTER TABLE "MemoryItem" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "MemoryItem" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'project';
ALTER TABLE "MemoryItem" ADD COLUMN "ownerKey" TEXT;
CREATE UNIQUE INDEX "MemoryItem_ownerKey_activeKey_key" ON "MemoryItem"("ownerKey", "activeKey");
