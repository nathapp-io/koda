-- Review-source duplicate guards span projects and include every status/deleted row.
CREATE INDEX "MemoryItem_sourceType_sourceId_idx" ON "MemoryItem"("sourceType", "sourceId");
