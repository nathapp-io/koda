-- memory-notes US-006 (#379): the incremental export feed's keyset indexes.
--
-- `GET /projects/:slug/memory/export` answers the authorized union of two sides — the project's rows and the
-- caller's user-scoped rows — ordered and continued by `(updatedAt, id)`, with every status, kind and
-- soft-deleted row included. A row's supersede, retire or soft delete goes through `update`, which rewrites
-- `updatedAt`, so the change reappears after the cursor a mirror holds.
--
-- Each side is indexed on the pair it pages by, so the feed never sorts the whole table:
--   * `MemoryItem_projectId_updatedAt_id_idx` is the project's side;
--   * `MemoryItem_ownerKey_updatedAt_id_idx` is the user side (`ownerKey` is null on every project row).
-- Both names are Prisma's own defaults for `@@index([projectId, updatedAt, id])` and
-- `@@index([ownerKey, updatedAt, id])`.
--
-- No data migration: the columns already exist and nothing is backfilled. `updatedAt` is `@updatedAt`, so
-- every row the table already holds carries a value the feed can order on.

CREATE INDEX "MemoryItem_projectId_updatedAt_id_idx" ON "MemoryItem"("projectId", "updatedAt", "id");
CREATE INDEX "MemoryItem_ownerKey_updatedAt_id_idx" ON "MemoryItem"("ownerKey", "updatedAt", "id");
