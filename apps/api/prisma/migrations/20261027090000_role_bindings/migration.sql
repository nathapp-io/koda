-- Permissions P1a US-002: roles and their bindings.
-- `Role.permissions` is a JSON array of catalog entries (the string[] grammar of entry-matcher.ts).
-- `RoleBinding.principalId` has no foreign key on purpose: it points at a User or an Agent, and the
-- server removes an agent's bindings when the agent is deleted.

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleBinding" (
    "id" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "projectId" TEXT,
    "grantedByType" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "RoleBinding_principalType_principalId_idx" ON "RoleBinding"("principalType", "principalId");

-- CreateIndex
CREATE INDEX "RoleBinding_projectId_idx" ON "RoleBinding"("projectId");

-- CreateIndex
CREATE INDEX "RoleBinding_roleId_idx" ON "RoleBinding"("roleId");

-- One binding per principal, role and project — and, when projectId is null, one per principal and
-- role globally. Two partial indexes because a plain unique index treats NULLs as distinct and would
-- never block a duplicate global binding. Replayed by test/global-setup.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "RoleBinding_principalId_roleId_projectId_key" ON "RoleBinding" ("principalType", "principalId", "roleId", "projectId") WHERE "projectId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "RoleBinding_principalId_roleId_global_key" ON "RoleBinding" ("principalType", "principalId", "roleId") WHERE "projectId" IS NULL;

-- AddForeignKey
ALTER TABLE "RoleBinding" ADD CONSTRAINT "RoleBinding_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleBinding" ADD CONSTRAINT "RoleBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
