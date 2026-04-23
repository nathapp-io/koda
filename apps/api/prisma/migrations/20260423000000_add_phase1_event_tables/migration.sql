-- AddPhase1EventTables
-- Create TicketEvent, AgentEvent, and DecisionEvent tables with project-scoped indexes.
-- Uses IF NOT EXISTS so migration is idempotent and survives re-application.

-- CreateTable: TicketEvent
CREATE TABLE IF NOT EXISTS "TicketEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT,
    "projectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: TicketEvent projectId+createdAt
CREATE INDEX IF NOT EXISTS "TicketEvent_projectId_createdAt_idx" ON "TicketEvent"("projectId", "createdAt");

-- CreateIndex: TicketEvent projectId+ticketId
CREATE INDEX IF NOT EXISTS "TicketEvent_projectId_ticketId_idx" ON "TicketEvent"("projectId", "ticketId");

-- CreateTable: AgentEvent
CREATE TABLE IF NOT EXISTS "AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: AgentEvent projectId+createdAt
CREATE INDEX IF NOT EXISTS "AgentEvent_projectId_createdAt_idx" ON "AgentEvent"("projectId", "createdAt");

-- CreateIndex: AgentEvent projectId+actorId
CREATE INDEX IF NOT EXISTS "AgentEvent_projectId_actorId_idx" ON "AgentEvent"("projectId", "actorId");

-- CreateTable: DecisionEvent
CREATE TABLE IF NOT EXISTS "DecisionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT,
    "source" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: DecisionEvent projectId+createdAt
CREATE INDEX IF NOT EXISTS "DecisionEvent_projectId_createdAt_idx" ON "DecisionEvent"("projectId", "createdAt");
