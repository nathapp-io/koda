-- Fleet S5b 1d (US-001): the WORKSPACE thread index. A workspace-scope read lists one user's WORKSPACE threads
-- newest-activity-first, which is exactly (createdById, kind, lastActivityAt).
-- No column change: `kind` is already a TEXT column (20261017090000_chat_thread_kind).

-- CreateIndex
CREATE INDEX "ChatThread_createdById_kind_lastActivityAt_idx" ON "ChatThread"("createdById", "kind", "lastActivityAt");
