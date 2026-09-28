-- Track 3 Slice 5 (M19): graph nodes whose LanceDB vector is missing or out of date.
-- Existing rows backfill to false.
ALTER TABLE "GraphNode" ADD COLUMN "vectorStale" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "GraphNode_projectId_vectorStale_idx" ON "GraphNode"("projectId", "vectorStale");
