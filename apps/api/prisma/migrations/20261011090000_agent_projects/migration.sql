-- S4c US-001: agent project roster. A row grants an agent project reach only;
-- it carries no project role (D529).

-- CreateTable
CREATE TABLE "AgentProject" (
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProject_pkey" PRIMARY KEY ("agentId","projectId")
);

-- CreateIndex
CREATE INDEX "AgentProject_projectId_idx" ON "AgentProject"("projectId");

-- AddForeignKey
ALTER TABLE "AgentProject" ADD CONSTRAINT "AgentProject_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProject" ADD CONSTRAINT "AgentProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProject" ADD CONSTRAINT "AgentProject_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (D527): every historical agent-project association becomes an
-- explicit roster row: tickets the agent was assigned, tickets it created, and
-- tickets it commented on (soft-deleted tickets included). addedById stays NULL
-- — no human added these. Runs exactly once, inside this migration.
INSERT INTO "AgentProject" ("agentId", "projectId", "addedById")
SELECT "assignedToAgentId", "projectId", NULL FROM "Ticket" WHERE "assignedToAgentId" IS NOT NULL
UNION
SELECT "createdByAgentId", "projectId", NULL FROM "Ticket" WHERE "createdByAgentId" IS NOT NULL
UNION
SELECT c."authorAgentId", t."projectId", NULL FROM "Comment" c JOIN "Ticket" t ON t."id" = c."ticketId" WHERE c."authorAgentId" IS NOT NULL
ON CONFLICT DO NOTHING;
