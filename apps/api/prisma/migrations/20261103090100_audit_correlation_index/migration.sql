-- Permissions P2 US-002: `GET /api/audit?correlationId=` is an exact match on a column of an
-- append-only log, so it needs its own index; without one the filter degrades to a full table scan.
--
-- Leading column is `correlationId` (the equality), second is `createdAt`, so the list's
-- `ORDER BY "createdAt" DESC, "id" DESC` reads one correlation's newest entries as a range of the
-- index instead of sorting the subset. Mirrors `AuditEntry_actorId_createdAt_idx`, the shape the
-- other exact id filters use.
CREATE INDEX "AuditEntry_correlationId_createdAt_idx" ON "AuditEntry"("correlationId", "createdAt");
