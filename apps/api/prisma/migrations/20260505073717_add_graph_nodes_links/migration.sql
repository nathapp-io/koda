/*
  Warnings:

  - You are about to drop the `OutboxEvent_unmapped` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "OutboxEvent_unmapped";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT,
    "sourceFile" TEXT,
    "community" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GraphNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GraphLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '{}',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AgentEvent" ("action", "actorId", "agentId", "createdAt", "data", "id", "projectId", "source", "timestamp") SELECT "action", "actorId", "agentId", "createdAt", "data", "id", "projectId", "source", "timestamp" FROM "AgentEvent";
DROP TABLE "AgentEvent";
ALTER TABLE "new_AgentEvent" RENAME TO "AgentEvent";
CREATE INDEX "AgentEvent_projectId_createdAt_idx" ON "AgentEvent"("projectId", "createdAt");
CREATE INDEX "AgentEvent_projectId_actorId_idx" ON "AgentEvent"("projectId", "actorId");
CREATE TABLE "new_DecisionEvent" (
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
    CONSTRAINT "DecisionEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DecisionEvent" ("action", "agentId", "createdAt", "data", "decision", "id", "projectId", "rationale", "source", "timestamp") SELECT "action", "agentId", "createdAt", "data", "decision", "id", "projectId", "rationale", "source", "timestamp" FROM "DecisionEvent";
DROP TABLE "DecisionEvent";
ALTER TABLE "new_DecisionEvent" RENAME TO "DecisionEvent";
CREATE INDEX "DecisionEvent_projectId_createdAt_idx" ON "DecisionEvent"("projectId", "createdAt");
CREATE TABLE "new_MemoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "ttlAt" DATETIME,
    "ownerId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "supersededBy" TEXT,
    "activeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "MemoryItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryItem_supersededBy_fkey" FOREIGN KEY ("supersededBy") REFERENCES "MemoryItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MemoryItem" ("activeKey", "confidence", "createdAt", "deletedAt", "id", "kind", "object", "ownerId", "predicate", "projectId", "sourceId", "sourceType", "status", "subject", "supersededBy", "ttlAt", "updatedAt") SELECT "activeKey", "confidence", "createdAt", "deletedAt", "id", "kind", "object", "ownerId", "predicate", "projectId", "sourceId", "sourceType", "status", "subject", "supersededBy", "ttlAt", "updatedAt" FROM "MemoryItem";
DROP TABLE "MemoryItem";
ALTER TABLE "new_MemoryItem" RENAME TO "MemoryItem";
CREATE INDEX "MemoryItem_projectId_kind_idx" ON "MemoryItem"("projectId", "kind");
CREATE INDEX "MemoryItem_projectId_status_idx" ON "MemoryItem"("projectId", "status");
CREATE INDEX "MemoryItem_projectId_kind_subject_predicate_idx" ON "MemoryItem"("projectId", "kind", "subject", "predicate");
CREATE INDEX "MemoryItem_projectId_deletedAt_idx" ON "MemoryItem"("projectId", "deletedAt");
CREATE INDEX "MemoryItem_projectId_sourceType_sourceId_idx" ON "MemoryItem"("projectId", "sourceType", "sourceId");
CREATE UNIQUE INDEX "MemoryItem_projectId_activeKey_key" ON "MemoryItem"("projectId", "activeKey");
CREATE TABLE "new_TicketEvent" (
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
    CONSTRAINT "TicketEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TicketEvent" ("action", "actorId", "actorType", "createdAt", "data", "id", "projectId", "source", "ticketId", "timestamp") SELECT "action", "actorId", "actorType", "createdAt", "data", "id", "projectId", "source", "ticketId", "timestamp" FROM "TicketEvent";
DROP TABLE "TicketEvent";
ALTER TABLE "new_TicketEvent" RENAME TO "TicketEvent";
CREATE INDEX "TicketEvent_projectId_createdAt_idx" ON "TicketEvent"("projectId", "createdAt");
CREATE INDEX "TicketEvent_projectId_ticketId_idx" ON "TicketEvent"("projectId", "ticketId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_projectId_nodeId_key" ON "GraphNode"("projectId", "nodeId");

-- CreateIndex
CREATE INDEX "GraphLink_projectId_sourceId_idx" ON "GraphLink"("projectId", "sourceId");

-- CreateIndex
CREATE INDEX "GraphLink_projectId_sourceId_targetId_idx" ON "GraphLink"("projectId", "sourceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphLink_projectId_sourceId_targetId_relation_key" ON "GraphLink"("projectId", "sourceId", "targetId", "relation");
