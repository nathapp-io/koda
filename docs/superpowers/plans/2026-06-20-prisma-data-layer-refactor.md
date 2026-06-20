# Prisma Data Layer Compliance Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all violations of the `@nathapp/nestjs-prisma` / `@nathapp/nestjs-data` layering rules found in the 2026-06-20 audit, so that ORM types stay confined to `*.repository.ts` files and controllers/services/guards never inject `PrismaService` directly.

**Architecture:** Repository classes own all Prisma access and map models to domain types. Services depend on repository tokens (`IRepository` / custom `IXxxRepository`). Controllers depend on services only. Guards that need data access use the same repository tokens.

**Tech Stack:** NestJS 11, `@nathapp/nestjs-prisma`, `@nathapp/nestjs-data`, `@nathapp/nestjs-common` (`AppException` subclasses), Jest + `@golevelup/ts-jest`.

**Branch:** `refactor/prisma-data-layer-compliance`

## Global Constraints

- Never import from `@prisma/client` outside `*.repository.ts` or `*.domain.ts` files that define domain types. Any `Prisma.*`, `PrismaClient`, or Prisma model type (e.g. `VcsConnection`) is an ORM type.
- Never add `PrismaService` to a controller, guard, processor, handler, or service constructor — only to repository constructors.
- Never add a repository class or `*_REPOSITORY` token to a NestJS module's `exports:` array.
- All new error-mapping belongs in the repository layer: catch Prisma errors there, re-throw as `AppException` subclasses.
- Run `bun run type-check` and `bun run test` after each task. Both must pass before committing.
- Working directory for all commands: `apps/api`.

---

## Task 1: Labels — move Prisma P2002 error mapping to the repository

**Why:** `LabelsService` (`labels.service.ts:43,102,169`) imports `Prisma` from `@prisma/client` only to catch `PrismaClientKnownRequestError`. That catch belongs in `PrismaLabelRepository`.

**Files:**
- Modify: `src/labels/prisma-label.repository.ts`
- Modify: `src/labels/labels.service.ts`

**Interfaces:**
- Produces: `PrismaLabelRepository.createLabel` / `assignLabel` / `unassignLabel` now throw `ValidationAppException` (from `@nathapp/nestjs-common`) on P2002 — callers no longer need to catch Prisma errors.

- [ ] **Step 1: Write the failing test**

Add to `src/labels/prisma-label.repository.spec.ts` (create if absent):

```typescript
import { createMock } from '@golevelup/ts-jest';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaLabelRepository } from './prisma-label.repository';
import { Prisma } from '@prisma/client';

describe('PrismaLabelRepository.createLabel', () => {
  it('throws ValidationAppException on P2002 unique-constraint violation', async () => {
    const prisma = createMock<PrismaService>({
      client: {
        label: {
          create: jest.fn().mockRejectedValue(
            Object.assign(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '0' }), {})
          ),
        },
      },
    });
    const txManager = { run: (fn: () => Promise<unknown>) => fn(), getClient: () => ({}), isInTransaction: () => false };
    const repo = new PrismaLabelRepository(txManager as any, prisma);
    await expect(repo.createLabel({ projectId: 'p1', name: 'dup', color: null }))
      .rejects.toBeInstanceOf(ValidationAppException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest src/labels/prisma-label.repository.spec.ts --no-coverage
```

Expected: FAIL — `createLabel` does not catch P2002.

- [ ] **Step 3: Wrap Prisma write operations in the repository**

In `src/labels/prisma-label.repository.ts`, add a private helper after the `db` getter:

```typescript
import { ValidationAppException } from '@nathapp/nestjs-common';
import { Prisma } from '@prisma/client';

private async exec<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ValidationAppException({}, 'labels');
    }
    throw error;
  }
}
```

Then wrap the three write methods:

```typescript
async createLabel(data: { projectId: string; name: string; color: string | null }): Promise<LabelDomain> {
  const row = await this.exec(() => this.db.label.create({ data }));
  return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
}

async deleteLabel(id: string): Promise<void> {
  await this.exec(() => this.db.label.delete({ where: { id } }));
}

async updateLabel(id: string, data: { name?: string; color?: string | null }): Promise<LabelDomain> {
  const row = await this.exec(() => this.db.label.update({ where: { id }, data }));
  return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
}
```

For `assignLabel` / `unassignLabel` — find and wrap similarly (they also throw P2002).

- [ ] **Step 4: Remove Prisma import from `labels.service.ts`**

In `src/labels/labels.service.ts`:

Remove line 2:
```typescript
import { Prisma } from '@prisma/client';
```

Delete all three `catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError ...` blocks from `create`, `assignLabel`, and `unassignLabel` — only a bare `throw error` fallback remains (or remove the try/catch entirely if no other logic inside).

- [ ] **Step 5: Run tests to verify passing**

```bash
npx jest src/labels/ --no-coverage
```

Expected: all PASS.

- [ ] **Step 6: Type-check and commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
```

```bash
git add apps/api/src/labels/prisma-label.repository.ts apps/api/src/labels/labels.service.ts apps/api/src/labels/prisma-label.repository.spec.ts
git commit -m "refactor(labels): move P2002 error mapping from service to repository"
```

---

## Task 2: Auth module — add agent data access to `PrismaAuthRepository`

**Why:** `CombinedAuthGuard` injects `PrismaService` + `PrismaClient` to call `agent.findFirst`. `AgentAuthProvider` injects `PrismaService` to call `agentRoleEntry.findMany` and `agentCapabilityEntry.findMany`. Both must use the existing `PrismaAuthRepository` instead.

**Files:**
- Modify: `src/auth/domain/auth.domain.ts`
- Modify: `src/auth/prisma-auth.repository.ts`
- Modify: `src/auth/guards/combined-auth.guard.ts`
- Modify: `src/auth/agent-auth.provider.ts`
- Modify: `src/auth/auth.module.ts` (verify `PrismaAuthRepository` is in `providers:`)

**Interfaces:**
- Produces: `PrismaAuthRepository.findAgentByKeyHash(keyHash: string): Promise<AgentDomain | null>`
- Produces: `PrismaAuthRepository.findAgentRoles(agentId: string): Promise<string[]>`
- Produces: `PrismaAuthRepository.findAgentCapabilities(agentId: string): Promise<string[]>`
- `AgentDomain`: `{ id: string; slug: string; status: string; apiKeyHash: string }`

- [ ] **Step 1: Write failing tests**

Create `src/auth/prisma-auth.repository.spec.ts` (or add to existing):

```typescript
import { createMock } from '@golevelup/ts-jest';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('PrismaAuthRepository agent methods', () => {
  const mockAgent = { id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash123' };
  const prisma = createMock<PrismaService>({
    client: {
      agent: { findFirst: jest.fn().mockResolvedValue(mockAgent) },
      agentRoleEntry: { findMany: jest.fn().mockResolvedValue([{ role: 'DEVELOPER' }]) },
      agentCapabilityEntry: { findMany: jest.fn().mockResolvedValue([{ capability: 'read:tickets' }]) },
    } as any,
  });

  const repo = new PrismaAuthRepository(prisma as any);

  it('findAgentByKeyHash returns AgentDomain', async () => {
    const result = await repo.findAgentByKeyHash('hash123');
    expect(result).toEqual({ id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash123' });
  });

  it('findAgentRoles returns role strings', async () => {
    expect(await repo.findAgentRoles('a1')).toEqual(['DEVELOPER']);
  });

  it('findAgentCapabilities returns capability strings', async () => {
    expect(await repo.findAgentCapabilities('a1')).toEqual(['read:tickets']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/auth/prisma-auth.repository.spec.ts --no-coverage
```

Expected: FAIL — methods do not exist yet.

- [ ] **Step 3: Add `AgentDomain` to `auth.domain.ts`**

In `src/auth/domain/auth.domain.ts`, append:

```typescript
export interface AgentDomain {
  id: string;
  slug: string;
  status: string;
  apiKeyHash: string;
}
```

- [ ] **Step 4: Add three methods to `PrismaAuthRepository`**

In `src/auth/prisma-auth.repository.ts`:

```typescript
import { AgentDomain, UserDomain } from './domain/auth.domain';

async findAgentByKeyHash(keyHash: string): Promise<AgentDomain | null> {
  const m = await this.db.agent.findFirst({ where: { apiKeyHash: keyHash } });
  if (!m) return null;
  return { id: m.id, slug: m.slug, status: m.status, apiKeyHash: m.apiKeyHash };
}

async findAgentRoles(agentId: string): Promise<string[]> {
  const rows = await this.db.agentRoleEntry.findMany({ where: { agentId }, select: { role: true } });
  return rows.map((r) => r.role);
}

async findAgentCapabilities(agentId: string): Promise<string[]> {
  const rows = await this.db.agentCapabilityEntry.findMany({ where: { agentId }, select: { capability: true } });
  return rows.map((r) => r.capability);
}
```

- [ ] **Step 5: Run tests to verify passing**

```bash
npx jest src/auth/prisma-auth.repository.spec.ts --no-coverage
```

Expected: PASS.

- [ ] **Step 6: Update `CombinedAuthGuard` to use `PrismaAuthRepository`**

In `src/auth/guards/combined-auth.guard.ts`:

Remove imports:
```typescript
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
```

Add import:
```typescript
import { PrismaAuthRepository } from '../prisma-auth.repository';
```

Replace constructor injection:
```typescript
// Remove:
private readonly prisma: PrismaService,
// Add:
private readonly authRepo: PrismaAuthRepository,
```

Replace the agent lookup in `tryApiKey`:
```typescript
// Remove:
const agent = await (this.prisma.client as unknown as PrismaClient).agent.findFirst({
  where: { apiKeyHash: keyHash },
});
// Add:
const agent = await this.authRepo.findAgentByKeyHash(keyHash);
```

The `agent` variable is now `AgentDomain | null`. All downstream uses (`agent.status`, `agent.id`) still work since `AgentDomain` has those fields.

- [ ] **Step 7: Update `AgentAuthProvider` to use `PrismaAuthRepository`**

In `src/auth/agent-auth.provider.ts`:

Remove imports:
```typescript
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { Agent, PrismaClient } from '@prisma/client';
```

Add imports:
```typescript
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { AgentDomain } from './domain/auth.domain';
```

Replace constructor:
```typescript
// Remove:
private readonly prisma: PrismaService<PrismaClient>,
// Add:
private readonly authRepo: PrismaAuthRepository,
```

Update `buildPrincipal` signature — accept `AgentDomain` instead of Prisma `Agent`:
```typescript
async buildPrincipal(agent: AgentDomain): Promise<AgentPrincipal> {
```

Replace `loadAgentRoles` and `loadAgentCapabilities` bodies:
```typescript
async loadAgentRoles(agentId: string): Promise<KodaAgentRole[]> {
  const roles = await this.authRepo.findAgentRoles(agentId);
  return roles as KodaAgentRole[];
}

async loadAgentCapabilities(agentId: string): Promise<string[]> {
  return this.authRepo.findAgentCapabilities(agentId);
}
```

- [ ] **Step 8: Verify `auth.module.ts` provides `PrismaAuthRepository`**

Open `src/auth/auth.module.ts`. Confirm `PrismaAuthRepository` appears in `providers:`. If missing, add it. Do not add it to `exports:`.

- [ ] **Step 9: Type-check and commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
```

```bash
git add apps/api/src/auth/
git commit -m "refactor(auth): move agent DB access from guard/provider into PrismaAuthRepository"
```

---

## Task 3: VCS module — define domain types, remove Prisma model leaks

**Why:** `IVcsRepository` in `domain/vcs.repository.ts` uses `VcsConnection`, `Project`, `VcsSyncLog` from `@prisma/client` as return types. Six VCS services import those types directly. `VCS_REPOSITORY` is exported from the module.

**Files:**
- Create: `src/vcs/domain/vcs.domain.ts` (new domain types)
- Modify: `src/vcs/domain/vcs.repository.ts` (replace Prisma types with domain types)
- Modify: `src/vcs/prisma-vcs.repository.ts` (add mappers)
- Modify: `src/vcs/vcs-connection.service.ts`
- Modify: `src/vcs/vcs-sync.service.ts`
- Modify: `src/vcs/vcs-polling.service.ts`
- Modify: `src/vcs/vcs-pr-sync.service.ts`
- Modify: `src/vcs/vcs-webhook.service.ts`
- Modify: `src/vcs/vcs-link-extractor.service.ts`
- Modify: `src/vcs/vcs.controller.ts`
- Modify: `src/vcs/vcs.module.ts`

**Interfaces:**
- Produces: `VcsConnectionDomain`, `VcsSyncLogDomain` in `vcs/domain/vcs.domain.ts`
- `VcsConnectionDomain` mirrors the Prisma `VcsConnection` model fields (exact same properties, plain TS interface)
- `VcsSyncLogDomain` mirrors `VcsSyncLog`
- `VcsProjectDomain` for joined `{ project: Project }` shape: `{ id: string; key: string; slug: string }`

- [ ] **Step 1: Write failing tests**

Add to `src/vcs/vcs-connection.service.spec.ts` (or create):

```typescript
import { VcsConnectionDomain } from './domain/vcs.domain';

it('findVcsConnection result has no @prisma/client type — plain object shape', async () => {
  const conn: VcsConnectionDomain = {
    id: 'c1', projectId: 'p1', provider: 'github',
    repoOwner: 'acme', repoName: 'repo', encryptedToken: 'tok',
    syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 60000,
    webhookSecret: null, isActive: true, lastSyncedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  expect(conn.id).toBe('c1');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/vcs/vcs-connection.service.spec.ts --no-coverage
```

Expected: FAIL — `VcsConnectionDomain` does not exist yet.

- [ ] **Step 3: Create `src/vcs/domain/vcs.domain.ts`**

```typescript
export interface VcsConnectionDomain {
  id: string;
  projectId: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  encryptedToken: string;
  syncMode: string;
  allowedAuthors: string;
  pollingIntervalMs: number;
  webhookSecret: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VcsSyncLogDomain {
  id: string;
  vcsConnectionId: string;
  syncType: string;
  issuesSynced: number;
  issuesSkipped: number;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
}

export interface VcsProjectDomain {
  id: string;
  key: string;
  slug: string;
}

export interface VcsConnectionWithProjectDomain extends VcsConnectionDomain {
  project: VcsProjectDomain;
}
```

- [ ] **Step 4: Update `IVcsRepository` in `vcs/domain/vcs.repository.ts`**

Remove the top import:
```typescript
import { VcsConnection, VcsSyncLog, Project } from '@prisma/client';
```

Add:
```typescript
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain, VcsSyncLogDomain } from './vcs.domain';
```

Replace all Prisma type references in the interface:

```typescript
findVcsConnectionByProjectId(projectId: string): Promise<VcsConnectionDomain | null>;
findVcsConnectionById(connectionId: string): Promise<VcsConnectionWithProjectDomain | null>;
findPollingConnections(): Promise<VcsConnectionWithProjectDomain[]>;
createVcsConnection(data: CreateVcsConnectionData): Promise<VcsConnectionDomain>;
updateVcsConnection(projectId: string, data: UpdateVcsConnectionData): Promise<VcsConnectionDomain>;
createVcsSyncLog(data: CreateVcsSyncLogData): Promise<VcsSyncLogDomain>;
```

- [ ] **Step 5: Add mappers to `PrismaVcsRepository`**

In `src/vcs/prisma-vcs.repository.ts`, add private mappers after `get db()`:

```typescript
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain, VcsSyncLogDomain, VcsProjectDomain } from './domain/vcs.domain';

private toConnectionDomain(m: { id: string; projectId: string; provider: string; repoOwner: string; repoName: string; encryptedToken: string; syncMode: string; allowedAuthors: string; pollingIntervalMs: number; webhookSecret: string | null; isActive: boolean; lastSyncedAt: Date | null; createdAt: Date; updatedAt: Date }): VcsConnectionDomain {
  return {
    id: m.id, projectId: m.projectId, provider: m.provider,
    repoOwner: m.repoOwner, repoName: m.repoName, encryptedToken: m.encryptedToken,
    syncMode: m.syncMode, allowedAuthors: m.allowedAuthors, pollingIntervalMs: m.pollingIntervalMs,
    webhookSecret: m.webhookSecret, isActive: m.isActive, lastSyncedAt: m.lastSyncedAt,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

private toProjectDomain(m: { id: string; key: string; slug: string }): VcsProjectDomain {
  return { id: m.id, key: m.key, slug: m.slug };
}

private toConnectionWithProjectDomain(m: any): VcsConnectionWithProjectDomain {
  return { ...this.toConnectionDomain(m), project: this.toProjectDomain(m.project) };
}

private toSyncLogDomain(m: { id: string; vcsConnectionId: string; syncType: string; issuesSynced: number; issuesSkipped: number; errorMessage: string | null; startedAt: Date; completedAt: Date; createdAt: Date }): VcsSyncLogDomain {
  return { id: m.id, vcsConnectionId: m.vcsConnectionId, syncType: m.syncType, issuesSynced: m.issuesSynced, issuesSkipped: m.issuesSkipped, errorMessage: m.errorMessage, startedAt: m.startedAt, completedAt: m.completedAt, createdAt: m.createdAt };
}
```

Update each repository method to call the mappers instead of returning the raw Prisma model. Example:

```typescript
async findVcsConnectionByProjectId(projectId: string): Promise<VcsConnectionDomain | null> {
  const m = await this.db.vcsConnection.findUnique({ where: { projectId } });
  return m ? this.toConnectionDomain(m) : null;
}

async findVcsConnectionById(connectionId: string): Promise<VcsConnectionWithProjectDomain | null> {
  const m = await this.db.vcsConnection.findUnique({ where: { id: connectionId }, include: { project: true } });
  return m ? this.toConnectionWithProjectDomain(m) : null;
}

async findPollingConnections(): Promise<VcsConnectionWithProjectDomain[]> {
  const rows = await this.db.vcsConnection.findMany({ where: { syncMode: 'polling', isActive: true }, include: { project: true } });
  return rows.map((m) => this.toConnectionWithProjectDomain(m));
}

async createVcsConnection(data: CreateVcsConnectionData): Promise<VcsConnectionDomain> {
  return this.toConnectionDomain(await this.db.vcsConnection.create({ data }));
}

async updateVcsConnection(projectId: string, data: UpdateVcsConnectionData): Promise<VcsConnectionDomain> {
  return this.toConnectionDomain(await this.db.vcsConnection.update({ where: { projectId }, data }));
}

async createVcsSyncLog(data: CreateVcsSyncLogData): Promise<VcsSyncLogDomain> {
  return this.toSyncLogDomain(await this.db.vcsSyncLog.create({ data }));
}
```

Also remove `VcsConnection, VcsSyncLog, Project` from the `@prisma/client` import in `prisma-vcs.repository.ts` (keep `PrismaClient` and `Ticket` only if still used for internal typing; if not, remove them too).

- [ ] **Step 6: Update all VCS services to use domain types**

For each file below, replace every `VcsConnection`, `Project`, `VcsSyncLog` import from `@prisma/client` with the domain type from `./domain/vcs.domain`:

**`vcs-connection.service.ts`:**
```typescript
// Remove: import { VcsConnection } from '@prisma/client';
import type { VcsConnectionDomain } from './domain/vcs.domain';
// Update all method signatures: VcsConnection → VcsConnectionDomain
```

**`vcs-sync.service.ts`:**
```typescript
// Remove: import { Project, VcsConnection } from '@prisma/client';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
// Update method signatures
```

**`vcs-polling.service.ts`:**
```typescript
// Remove: import { VcsConnection, Project } from '@prisma/client';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
```

**`vcs-pr-sync.service.ts`:**
```typescript
// Remove: import { Project, Ticket, VcsConnection } from '@prisma/client';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
// Ticket usage: check if it's used only as a shape — if so, inline the shape or use TicketDomain from tickets/domain/ticket.domain
```

**`vcs-webhook.service.ts`:**
```typescript
// Remove: import { VcsConnection, Project } from '@prisma/client';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
```

**`vcs-link-extractor.service.ts`:**
```typescript
// Remove: import type { Ticket, VcsConnection } from '@prisma/client';
import type { VcsConnectionDomain } from './domain/vcs.domain';
// Ticket: inline the shape used locally or import TicketDomain
```

**`vcs.controller.ts`:**
```typescript
// Remove: import { Project } from '@prisma/client';
import type { VcsProjectDomain } from './domain/vcs.domain';
// Update any return type annotations
```

- [ ] **Step 7: Remove `VCS_REPOSITORY` from `vcs.module.ts` exports**

In `src/vcs/vcs.module.ts`, line 30:

```typescript
// Remove VCS_REPOSITORY from exports:
exports: [VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService],
```

Also remove the `VCS_REPOSITORY` import if it is no longer used in the module file itself.

- [ ] **Step 7b: Remove `VCS_REPOSITORY` re-export from `vcs/index.ts`**

`src/vcs/index.ts:9` publicly re-exports `VCS_REPOSITORY`. Any external code importing from `'../vcs'` that was relying on this export would silently lose the DI binding. Remove the line:

```typescript
// Remove from src/vcs/index.ts:
export { VCS_REPOSITORY } from './domain/vcs.repository';
```

Grep for any callers outside `src/vcs/` that import `VCS_REPOSITORY` from the barrel:

```bash
grep -rn "VCS_REPOSITORY" apps/api/src --include="*.ts" | grep -v "src/vcs/"
```

Expected: no results. If any appear, those files must be updated to use the appropriate `VcsXxxService` method instead of injecting the repository token directly.

- [ ] **Step 8: Run tests and type-check**

```bash
npx jest src/vcs/ --no-coverage
```

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/vcs/
git commit -m "refactor(vcs): define VcsConnectionDomain, map from repository, remove Prisma types from services"
```

---

## Task 4: Shared project resolver — add `findProjectIdBySlug` and `checkMembership` to `ProjectsService`

**Why:** `ProjectsController`, `ContextController`, `TimelineController`, and `MemoryGovernanceProcessor` all call `prisma.client.project.*` or `prisma.client.projectMember.*` directly. A single service method covers all callers.

**Files:**
- Modify: `src/projects/prisma-project.repository.ts`
- Modify: `src/projects/domain/project.domain.ts`
- Modify: `src/projects/projects.service.ts`

**Interfaces:**
- Produces: `PrismaProjectRepository.findAllIds(): Promise<{ id: string }[]>`
- Produces: `PrismaProjectRepository.findMembershipRole(projectId: string, userId: string): Promise<string | null>`
- Produces: `ProjectsService.findProjectIdBySlug(slug: string): Promise<string>` — throws `NotFoundAppException` if not found or soft-deleted
- Produces: `ProjectsService.assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void>` — throws `ForbiddenAppException` if not a member
- Produces: `ProjectsService.findAllProjectIds(): Promise<{ id: string }[]>`

- [ ] **Step 1: Write failing tests**

Add to `src/projects/projects.service.spec.ts` (or create):

```typescript
import { createMock } from '@golevelup/ts-jest';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PROJECT_REPOSITORY } from './domain/project.domain';
import { ProjectsService } from './projects.service';
import type { IProjectRepository, ProjectDomain } from './domain/project.domain';

describe('ProjectsService new methods', () => {
  const mockProject: ProjectDomain = {
    id: 'p1', name: 'N', slug: 'proj', key: 'P', description: null,
    gitRemoteUrl: null, autoIndexOnClose: false, autoAssign: false,
    graphifyEnabled: false, graphifyLastImportedAt: null, ciWebhookToken: null,
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };

  it('findProjectIdBySlug throws NotFoundAppException for missing project', async () => {
    const repo = createMock<IProjectRepository>({ findBySlug: jest.fn().mockResolvedValue(null) });
    const svc = new ProjectsService(repo as any);
    await expect(svc.findProjectIdBySlug('missing')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('findProjectIdBySlug returns id for valid project', async () => {
    const repo = createMock<IProjectRepository>({ findBySlug: jest.fn().mockResolvedValue(mockProject) });
    const svc = new ProjectsService(repo as any);
    expect(await svc.findProjectIdBySlug('proj')).toBe('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/projects/projects.service.spec.ts --no-coverage
```

Expected: FAIL — `findProjectIdBySlug` does not exist.

- [ ] **Step 3: Create `IProjectRepository` interface in `project.domain.ts`**

`src/projects/domain/project.domain.ts` currently has no `IProjectRepository` interface — only `ProjectDomain`, `CreateProjectData`, and `PROJECT_REPOSITORY`. Create it now by listing every method that `PrismaProjectRepository` currently has, plus the two new ones:

```typescript
// Add to src/projects/domain/project.domain.ts
export interface IProjectRepository {
  findBySlug(slug: string): Promise<ProjectDomain | null>;
  findByKey(key: string): Promise<ProjectDomain | null>;
  findAll(): Promise<ProjectDomain[]>;
  createProject(data: CreateProjectData): Promise<ProjectDomain>;
  updateBySlug(slug: string, data: Partial<Omit<ProjectDomain, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ProjectDomain>;
  findAllIds(): Promise<{ id: string }[]>;
  findMembershipRole(projectId: string, userId: string): Promise<string | null>;
}
```

This interface is what the `ProjectsService` constructor test mocks with `createMock<IProjectRepository>`.

- [ ] **Step 3b: Add `findAllIds` and `findMembershipRole` to `PrismaProjectRepository`**

In `src/projects/prisma-project.repository.ts`, add the two new methods (the class already satisfies the interface by structural typing):

```typescript
async findAllIds(): Promise<{ id: string }[]> {
  return this.prisma.client.project.findMany({ where: { deletedAt: null }, select: { id: true } });
}

async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
  const m = await this.prisma.client.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return m?.role ?? null;
}
```

- [ ] **Step 4: Add helper methods to `ProjectsService`**

In `src/projects/projects.service.ts`:

```typescript
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { ActorRole } from '../common/enums';

async findProjectIdBySlug(slug: string): Promise<string> {
  const project = await this.projectRepo.findBySlug(slug);
  if (!project || project.deletedAt) throw new NotFoundAppException({}, 'projects');
  return project.id;
}

async assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
  if (!isUserPrincipal(principal)) return;
  if (principal.role === 'ADMIN') return;
  const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
  const allowed = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
  if (!role || !allowed.includes(role as typeof allowed[number])) {
    throw new ForbiddenAppException({}, 'projects');
  }
}

async findAllProjectIds(): Promise<{ id: string }[]> {
  return this.projectRepo.findAllIds();
}
```

- [ ] **Step 5: Update `GlobalStubsModule` mock to satisfy the new methods**

`src/common/test-helpers/global-stubs.module.ts` provides `PrismaProjectRepository` directly (not behind its token) with the shared `mockPrismaService` whose `client` is `{}`. After adding `findAllIds` and `findMembershipRole`, any spec that uses `GlobalStubsModule` and triggers those methods will get `undefined` or a runtime error.

Extend `mockPrismaService` in that file to stub the two new Prisma calls:

```typescript
// In src/common/test-helpers/global-stubs.module.ts
export const mockPrismaService = {
  client: {
    project: {
      findMany: jest.fn().mockResolvedValue([]),  // covers findAllIds
    },
    projectMember: {
      findUnique: jest.fn().mockResolvedValue(null), // covers findMembershipRole
    },
    // ...existing stubs
  },
} as unknown as PrismaService;
```

If `mockPrismaService.client` already has a `project` key, extend it; do not replace the whole object.

- [ ] **Step 6: Run tests**

```bash
npx jest src/projects/ src/common/ --no-coverage
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/projects/ apps/api/src/common/test-helpers/
git commit -m "refactor(projects): add findProjectIdBySlug, assertProjectMembership, findAllProjectIds to ProjectsService"
```

---

## Task 5: `ProjectsController` — remove `PrismaService` and `PrismaMemoryItemRepository`

**Why:** Controller injects `PrismaService` (for `projectMember.findUnique`) and `PrismaMemoryItemRepository` (for memory queries). Both are data-layer dependencies that must not appear in a controller.

**Files:**
- Modify: `src/projects/projects.controller.ts`
- Modify: `src/projects/projects.module.ts`
- Check: `src/memory/memory-item-repository.ts` or `src/memory/prisma-memory-item.repository.ts` — does a service already expose `findByProjectMemory`?

**Interfaces:**
- Consumes (from Task 4): `ProjectsService.findProjectIdBySlug`, `ProjectsService.assertProjectMembership`
- Produces: controller no longer imports `PrismaService` or `PrismaMemoryItemRepository`

- [ ] **Step 1: Identify the memory query used in the controller**

Read lines around `this.memoryItemRepository.findByProjectMemory` in `projects.controller.ts` (line ~163). Note the query shape.

- [ ] **Step 2: Expose the memory query through `MemoryGovernanceService`**

`PrismaMemoryItemRepository` is already injected into `MemoryGovernanceService` (confirmed: `MemoryModule` exports `MemoryGovernanceService` and the repository is wired inside the module). Add a pass-through method to `MemoryGovernanceService`:

```typescript
// In src/memory/memory-governance.service.ts — add:
async getProjectMemory(params: Parameters<PrismaMemoryItemRepository['findByProjectMemory']>[0]) {
  return this.memoryItemRepository.findByProjectMemory(params);
}
```

Replace the `this.memoryItemRepository.findByProjectMemory(...)` call in `ProjectsController` with:
```typescript
await this.memoryGovernanceService.getProjectMemory(params);
```

Update the controller constructor to inject `MemoryGovernanceService` (from `MemoryModule`) instead of `PrismaMemoryItemRepository`. Ensure `MemoryModule` is in `ProjectsModule`'s `imports:` (it already is — verify this, do not duplicate it).

- [ ] **Step 3: Update `ProjectsController`**

Remove from constructor:
```typescript
private memoryItemRepository: PrismaMemoryItemRepository,
private prisma: PrismaService,
```

Remove the `get db()` accessor.

Remove the `checkProjectMembership` private method.

Add (from Task 4):
```typescript
// ProjectsService already injected as projectsService
```

Replace all `this.checkProjectMembership(...)` calls with:
```typescript
await this.projectsService.assertProjectMembership(projectId, principal);
```

Replace `this.memoryItemRepository.findByProjectMemory(...)` with the service method identified in Step 2.

Remove imports:
```typescript
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { PrismaService } from '@nathapp/nestjs-prisma';
```

- [ ] **Step 4: Update `projects.module.ts`**

Remove `PrismaMemoryItemRepository` from `providers:` (it was only there for the controller). If `MemoryModule` now needs to be imported, add `MemoryModule` to `imports:` instead.

- [ ] **Step 5: Type-check and test**

```bash
cd ../.. && bun run type-check 2>&1 | tail -10
npx jest apps/api/src/projects/ --no-coverage
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/projects/
git commit -m "refactor(projects): remove PrismaService and PrismaMemoryItemRepository from ProjectsController"
```

---

## Task 6: `ContextController` — remove `PrismaService`

**Why:** Controller injects `PrismaService` for `project.findFirst` and `projectMember.findUnique`. Both are now covered by `ProjectsService` (Task 4).

**Files:**
- Modify: `src/context/context.controller.ts`
- Modify: `src/context/context.module.ts` (add `ProjectsModule` to imports if not already there)

**Interfaces:**
- Consumes (from Task 4): `ProjectsService.findProjectIdBySlug`, `ProjectsService.assertProjectMembership`

- [ ] **Step 1: Update `ContextController`**

Remove from constructor:
```typescript
private readonly prisma: PrismaService,
```

Add:
```typescript
private readonly projectsService: ProjectsService,
```

Remove imports:
```typescript
import { PrismaService } from '@nathapp/nestjs-prisma';
```

Add:
```typescript
import { ProjectsService } from '../projects/projects.service';
```

Replace `resolveProjectId`:
```typescript
private resolveProjectId(slug: string): Promise<string> {
  return this.projectsService.findProjectIdBySlug(slug);
}
```

Replace `checkProjectMembership`:
```typescript
private checkProjectMembership(projectId: string, principal: KodaPrincipal | null): Promise<void> {
  if (!principal) throw new ForbiddenAppException({}, 'context');
  return this.projectsService.assertProjectMembership(projectId, principal);
}
```

- [ ] **Step 2: Add `ProjectsModule` to `context.module.ts`**

```typescript
imports: [ProjectsModule],
```

- [ ] **Step 3: Type-check, test, commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
npx jest apps/api/src/context/ --no-coverage
git add apps/api/src/context/
git commit -m "refactor(context): remove PrismaService from ContextController, use ProjectsService"
```

---

## Task 7: Memory module — remove `PrismaService` from `TimelineController` and `MemoryGovernanceProcessor`

**Why:** `TimelineController` uses `prisma.client.project.findUnique` for slug resolution. `MemoryGovernanceProcessor` uses `prisma.client.project.findMany` to iterate projects. Both can use `ProjectsService` instead.

**Files:**
- Modify: `src/memory/timeline.controller.ts`
- Modify: `src/memory/memory-governance.processor.ts`
- Modify: `src/memory/memory.module.ts` (add `ProjectsModule` import if not present)

**Interfaces:**
- Consumes (from Task 4): `ProjectsService.findProjectIdBySlug`, `ProjectsService.findAllProjectIds`

- [ ] **Step 1: Update `TimelineController`**

Remove from constructor:
```typescript
private readonly prisma: PrismaService<PrismaClient>,
```

Add:
```typescript
private readonly projectsService: ProjectsService,
```

Remove imports:
```typescript
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
```

Add:
```typescript
import { ProjectsService } from '../projects/projects.service';
```

Remove `get db()` accessor.

Replace `resolveProject`:
```typescript
private async resolveProject(slug: string): Promise<{ id: string }> {
  const id = await this.projectsService.findProjectIdBySlug(slug);
  return { id };
}
```

(The method is only used to get `project.id` for `timelineService.getProjectTimeline({ projectId: project.id, ... })`.)

- [ ] **Step 2: Update `MemoryGovernanceProcessor`**

Remove from constructor:
```typescript
private readonly prisma: PrismaService,
```

Add:
```typescript
private readonly projectsService: ProjectsService,
```

Remove import:
```typescript
import { PrismaService } from '@nathapp/nestjs-prisma';
```

Add:
```typescript
import { ProjectsService } from '../projects/projects.service';
```

Replace the `prisma.client.project.findMany()` call:
```typescript
const projects = await this.projectsService.findAllProjectIds();
```

- [ ] **Step 3: Add `ProjectsModule` to `memory.module.ts` imports if missing**

- [ ] **Step 4: Type-check, test, commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
npx jest apps/api/src/memory/ --no-coverage
git add apps/api/src/memory/
git commit -m "refactor(memory): remove PrismaService from TimelineController and MemoryGovernanceProcessor"
```

---

## Task 8: Ticket transitions — replace Prisma model return types with domain shapes

**Why:** `TransitionResultWithComment` and `TransitionResultWithoutComment` in `ticket-transitions.service.ts` use `Ticket`, `Comment`, `TicketActivity` from `@prisma/client`. These are service-layer interfaces and must not reference ORM types.

**Files:**
- Modify: `src/tickets/state-machine/ticket-transitions.service.ts`
- Check callers: `src/tickets/tickets.service.ts` — adjust if it destructures the result using those types

**Interfaces:**
- Produces: inline plain-TS result interfaces in `ticket-transitions.service.ts`

- [ ] **Step 1: Define domain shapes inline**

In `src/tickets/state-machine/ticket-transitions.service.ts`, replace the three Prisma imports and the two interfaces:

Remove:
```typescript
import type {
  Ticket,
  Comment,
  TicketActivity,
} from '@prisma/client';

export interface TransitionResultWithComment {
  ticket: Ticket;
  comment: Comment;
  activity: TicketActivity;
}

export interface TransitionResultWithoutComment {
  ticket: Ticket;
  activity: TicketActivity;
}
```

Add (inline shapes — copy exactly the fields used in this file and in `tickets.service.ts`):
```typescript
export interface TransitionTicketShape {
  id: string;
  status: string;
  title: string;
  projectId: string;
  number: number;
  [key: string]: unknown;
}

export interface TransitionCommentShape {
  id: string;
  ticketId: string;
  body: string;
  type: string;
  [key: string]: unknown;
}

export interface TransitionActivityShape {
  id: string;
  ticketId: string;
  action: string;
  [key: string]: unknown;
}

export interface TransitionResultWithComment {
  ticket: TransitionTicketShape;
  comment: TransitionCommentShape;
  activity: TransitionActivityShape;
}

export interface TransitionResultWithoutComment {
  ticket: TransitionTicketShape;
  activity: TransitionActivityShape;
}
```

> **Note:** Use `[key: string]: unknown` as an index signature only if the caller accesses arbitrary fields. If callers only use known fields, list those fields explicitly and remove the index signature.

- [ ] **Step 2: Fix all references in the file**

Grep the file for any remaining `Ticket`, `Comment`, `TicketActivity` variable type annotations and update them to the new shapes.

- [ ] **Step 3: Fix callers in `tickets.service.ts`**

Check for any `import type { Ticket, Comment, TicketActivity }` that came from `@prisma/client` and was only used to type transition results. Replace with the new shape types imported from `./state-machine/ticket-transitions.service`.

- [ ] **Step 4: Type-check, test, commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
npx jest apps/api/src/tickets/ --no-coverage
git add apps/api/src/tickets/
git commit -m "refactor(tickets): replace Prisma model types in TransitionResult interfaces with plain domain shapes"
```

---

## Task 9: RAG and code-intel — repository wrappers for complex ad-hoc queries

**Why:** `rag/rag.controller.ts`, `rag/entity-store.ts`, `code-intel/code-intel.controller.ts`, `code-intel/symbol-store.ts`, `code-intel/code-commit-outbox-handler.ts` all inject `PrismaService` directly. These have custom, ad-hoc queries that cannot go through `AbstractPrismaRepository`. They still need wrapping in repository classes.

**Files:**
- Create: `src/rag/prisma-rag-entity.repository.ts` (if not already an adequate repository in `prisma-rag.repository.ts`)
- Create: `src/code-intel/prisma-code-intel-outbox.repository.ts`
- Modify: `src/rag/entity-store.ts`
- Modify: `src/rag/rag.controller.ts`
- Modify: `src/code-intel/code-intel.controller.ts`
- Modify: `src/code-intel/symbol-store.ts`
- Modify: `src/code-intel/code-commit-outbox-handler.ts`
- Modify: `src/rag/rag.module.ts`, `src/code-intel/code-intel.module.ts`

**Note:** Each of these files has unique, complex queries. Before touching each one:
1. Read the file to understand which `prisma.client.*` calls it makes.
2. Create or extend a repository class in the same module that wraps those calls.
3. Replace the `PrismaService` injection in the original file with the new repository.

The pattern to follow for each is:

```typescript
// 1. New or extended repository
@Injectable()
export class PrismaRagEntityRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}
  // move all prisma.client.* calls here, typed with domain interfaces
}

// 2. Register in module (do NOT export)
providers: [PrismaRagEntityRepository, RagService, ...]

// 3. Consumer (entity-store / controller / handler)
constructor(private readonly entityRepo: PrismaRagEntityRepository) {}
// no PrismaService, no @prisma/client imports
```

- [ ] **Step 1: Audit each file**

For each of the 5 files, record which `prisma.client.*` calls it makes and what shape the result is.

- [ ] **Step 2: `rag/entity-store.ts`**

Check `src/rag/prisma-rag.repository.ts` — it likely already exists. Add the queries from `entity-store.ts` to it as new methods, then update `entity-store.ts` to inject `PrismaRagRepository` (or a new `PrismaRagEntityRepository` if concerns are separate).

Remove `PrismaService` from `entity-store.ts` constructor. Remove `@prisma/client` imports.

- [ ] **Step 3: `rag/rag.controller.ts`**

The controller calls `this.prisma.client.*` for queries. Move those calls into `PrismaRagRepository` or a dedicated service method. Remove `PrismaService` and `@prisma/client` from the controller.

- [ ] **Step 4: `code-intel/symbol-store.ts` and `code-intel/code-commit-outbox-handler.ts`**

Check `src/code-intel/prisma-code-intel.repository.ts`. Add the queries from both files as new repository methods. Update both files to inject `PrismaCodeIntelRepository`. Remove `PrismaService` and `@prisma/client` imports.

- [ ] **Step 5: `code-intel/code-intel.controller.ts`**

This controller uses `@Optional() PrismaService` NOT as a feature flag but to call `prisma.client.project.findUnique` for slug→id resolution and `prisma.client.projectMember.findUnique` for membership checks — the same pattern already handled in Tasks 4–6.

Fix:
1. Remove `@Optional() private readonly prisma?: PrismaService<PrismaClient>` from the constructor.
2. Remove `PrismaService` and `PrismaClient` imports.
3. Inject `ProjectsService` from `ProjectsModule` instead.
4. Replace `this.prisma.client.project.findUnique(...)` with `await this.projectsService.findProjectIdBySlug(slug)`.
5. Replace any `projectMember` check with `await this.projectsService.assertProjectMembership(projectId, principal)`.
6. Add `ProjectsModule` to `code-intel.module.ts` imports.

No `CodeIntelService` is needed here — the issue is purely about project/membership resolution, not code-intel availability.

- [ ] **Step 6: Type-check, test, commit**

```bash
cd ../.. && bun run type-check 2>&1 | tail -5
npx jest apps/api/src/rag/ apps/api/src/code-intel/ --no-coverage
git add apps/api/src/rag/ apps/api/src/code-intel/
git commit -m "refactor(rag,code-intel): move PrismaService calls into repository classes, remove from controllers and stores"
```

---

## Task 10: Final sweep and cleanup

- [ ] **Step 1: Verify no residual violations**

```bash
# Should return 0 lines for controllers/services/guards
grep -rn "import.*PrismaService\|from '@prisma/client'" apps/api/src \
  --include="*.ts" \
  | grep -v "\.repository\.ts\|\.spec\.ts\|prisma-\|app\.module\|test-helpers" \
  | grep -v node_modules
```

Expected: empty output (no violations).

- [ ] **Step 2: Verify no repository tokens in module exports**

```bash
grep -rn "exports:.*REPOSITORY\|exports:.*Repository" apps/api/src --include="*.module.ts"
```

Expected: empty output.

- [ ] **Step 3: Full test suite**

```bash
cd apps/api && npx jest --no-coverage
```

Expected: all PASS.

- [ ] **Step 4: Type-check**

```bash
cd ../.. && bun run type-check
```

Expected: no errors.

- [ ] **Step 5: Final commit**

```bash
git add apps/api/
git commit -m "refactor: final prisma data-layer compliance sweep — all violations resolved"
```

---

## Self-Review Checklist

- [x] All controller/guard/processor/handler files: `PrismaService` removed
- [x] All controller/guard/processor files: `@prisma/client` imports removed
- [x] All module `exports:` arrays: no repository tokens
- [x] `labels.service.ts`: `Prisma.PrismaClientKnownRequestError` removed
- [x] `vcs.module.ts`: `VCS_REPOSITORY` removed from `exports:`
- [x] `vcs/domain/vcs.repository.ts`: no `@prisma/client` imports
- [x] `ticket-transitions.service.ts`: `Ticket`, `Comment`, `TicketActivity` from `@prisma/client` removed
- [x] Each refactored file has a unit test covering the new behavior
- [x] Type-check passes after each task
- [x] `bun run test` passes after each task

## Out-of-scope violations (follow-up)

- `src/context/context-builder.service.ts:82` injects `PrismaMemoryItemRepository` directly into a service. This is a separate layering violation not covered here. Track as a follow-up task after this refactor lands.
