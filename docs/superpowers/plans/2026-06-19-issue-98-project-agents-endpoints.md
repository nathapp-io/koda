# Issue #98 — Project-Scoped Agent Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /projects/:slug/agents` and `PATCH /projects/:slug/agents/:agentSlug` to the NestJS API so that the web `/:project/agents` page loads without errors.

**Architecture:** Derive "agents in a project" from tickets — return distinct agents that have at least one assigned ticket in the project. The `Ticket` model already has `projectId` + `assignedToAgentId` with an index, so no schema migration is needed. Two new endpoints are added to `ProjectsController`, which gains an `AgentsService` dependency. The web page's PATCH call is fixed to use `agent.slug` instead of `agent.id` to stay consistent with the rest of the API.

**Tech Stack:** NestJS 11 + Fastify, Prisma 6, `@nathapp/nestjs-common` (JsonResponse/exceptions), Jest unit tests, TypeScript strict.

## Global Constraints

- No Prisma schema migrations — solution derives data from existing `Ticket` relations
- Do not use Prisma enums; use local constants/types from `src/common/enums.ts`
- API responses must use `JsonResponse.Ok(data)` envelope pattern
- All user-facing strings use i18n; new API error messages go in `apps/api/src/i18n/{en,zh}/`
- Unit tests live beside source files as `*.spec.ts`; do not add DB-requiring tests under `src/`
- TypeScript strict mode — no implicit `any`, no `!` assertions without justification
- Conventional commit format: `feat:`, `fix:`, `test:`
- Never manually edit `apps/cli/src/generated/` — regenerate via `bun run generate`

---

## File Map

| Action | File |
|--------|------|
| Modify | `apps/api/src/agents/prisma-agent.repository.ts` |
| Modify | `apps/api/src/agents/agents.service.ts` |
| Modify | `apps/api/src/agents/agents.service.spec.ts` |
| Modify | `apps/api/src/projects/projects.controller.ts` |
| Modify | `apps/api/src/projects/projects.controller.spec.ts` |
| Modify | `apps/api/src/projects/projects.module.ts` |
| Create | `apps/api/src/projects/projects.module.spec.ts` |
| Modify | `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` |
| Modify | `apps/web/pages/[project]/agents.vue` |
| Regenerate | `openapi.json` |
| Regenerate | `apps/cli/src/generated/` |

---

### Task 1: Add `findByProjectSlug` to `PrismaAgentRepository`

**Files:**
- Modify: `apps/api/src/agents/prisma-agent.repository.ts`

**Interfaces:**
- Produces: `findByProjectSlug(projectSlug: string): Promise<{ project: { id: string; slug: string }; agents: Agent[] } | null>`
  - Returns `null` if project does not exist
  - Returns `{ project, agents }` otherwise; `agents` is the set of distinct agents with `roles` and `capabilities` included

> **Note — legacy carve-out:** `PrismaAgentRepository` is a pre-`AbstractPrismaRepository` class (it predates the repository pattern). Adding a method here is tolerated legacy, not a model to copy. Do **not** refactor the whole class to extend `AbstractPrismaRepository` as part of this task — that is out of scope and would break existing tests.

- [ ] **Step 1: Add the method to the repository**

Open `apps/api/src/agents/prisma-agent.repository.ts`.

Append this method inside the `PrismaAgentRepository` class, after the existing `findProjectBySlug` method (line 110):

```typescript
async findByProjectSlug(projectSlug: string) {
  const project = await this.db.project.findUnique({
    where: { slug: projectSlug },
    select: { id: true, slug: true },
  });
  if (!project) return null;

  const agents = await this.db.agent.findMany({
    where: {
      assignedTickets: {
        some: {
          projectId: project.id,
          deletedAt: null,
        },
      },
    },
    include: { roles: true, capabilities: true },
  });

  return { project, agents };
}
```

The relation name `assignedTickets` is confirmed in `schema.prisma:51`:
`assignedTickets Ticket[] @relation("TicketAssignedToAgent")`.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/api && bun run type-check
```

Expected: no errors relating to `prisma-agent.repository.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agents/prisma-agent.repository.ts
git commit -m "feat: add findByProjectSlug to PrismaAgentRepository"
```

---

### Task 2: Add `findByProject` to `AgentsService` (TDD)

**Files:**
- Modify: `apps/api/src/agents/agents.service.ts`
- Modify: `apps/api/src/agents/agents.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaAgentRepository.findByProjectSlug(projectSlug: string)` (Task 1)
- Produces: `AgentsService.findByProject(projectSlug: string): Promise<AgentResponseDto[]>`
  - Throws `NotFoundAppException({}, 'projects')` if project does not exist

- [ ] **Step 1: Write the failing test**

Open `apps/api/src/agents/agents.service.spec.ts`.

Find the `describe('AgentsService', ...)` block. Locate the block for `mockAgentRepo` (the jest mock object near line 65 in that file) and add `findByProjectSlug` to the mock object:

```typescript
findByProjectSlug: jest.fn(),
```

Then add a new `describe` block at the end of the outer `describe('AgentsService', ...)` block:

```typescript
describe('findByProject', () => {
  it('returns agents derived from project tickets', async () => {
    const mockRepoResult = {
      project: { id: 'proj-1', slug: 'alpha' },
      agents: [
        {
          id: 'agent-1',
          name: 'Bot',
          slug: 'bot',
          status: 'ACTIVE',
          maxConcurrentTickets: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
          roles: [{ id: 'r1', agentId: 'agent-1', role: 'DEVELOPER' }],
          capabilities: [{ id: 'c1', agentId: 'agent-1', capability: 'typescript' }],
        },
      ],
    };
    mockAgentRepo.findByProjectSlug.mockResolvedValue(mockRepoResult);

    const result = await service.findByProject('alpha');

    expect(mockAgentRepo.findByProjectSlug).toHaveBeenCalledWith('alpha');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('bot');
  });

  it('throws NotFoundAppException when project does not exist', async () => {
    mockAgentRepo.findByProjectSlug.mockResolvedValue(null);

    await expect(service.findByProject('nonexistent')).rejects.toThrow(NotFoundAppException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && bun run test --testPathPattern="agents.service.spec"
```

Expected: FAIL — `service.findByProject is not a function`

- [ ] **Step 3: Implement `findByProject` in `AgentsService`**

Open `apps/api/src/agents/agents.service.ts`.

Add this method after the `findMe` method (around line 200):

```typescript
async findByProject(projectSlug: string): Promise<AgentResponseDto[]> {
  const result = await this.agentRepo.findByProjectSlug(projectSlug);
  if (!result) throw new NotFoundAppException({}, 'projects');
  return AgentResponseDto.fromMany(result.agents);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && bun run test --testPathPattern="agents.service.spec"
```

Expected: all tests PASS including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agents/agents.service.ts apps/api/src/agents/agents.service.spec.ts
git commit -m "feat: add findByProject to AgentsService"
```

---

### Task 3: Add project-scoped agent endpoints to `ProjectsController` (TDD)

This task wires `AgentsService` into `ProjectsController`, adds two new routes, and creates the required DI-wiring module spec.

- `GET /projects/:slug/agents` — list agents active in the project
- `PATCH /projects/:slug/agents/:agentSlug` — update an agent's status

**Files:**
- Modify: `apps/api/src/projects/projects.controller.ts`
- Modify: `apps/api/src/projects/projects.controller.spec.ts`
- Modify: `apps/api/src/projects/projects.module.ts`
- Create: `apps/api/src/projects/projects.module.spec.ts`

**Interfaces:**
- Consumes: `AgentsService.findByProject(projectSlug: string): Promise<AgentResponseDto[]>` (Task 2)
- Consumes: `AgentsService.update(agentSlug: string, dto: UpdateAgentDto): Promise<AgentResponseDto>` (existing)
- Produces: `GET /projects/:slug/agents` → `JsonResponse<AgentResponseDto[]>`
- Produces: `PATCH /projects/:slug/agents/:agentSlug` → `JsonResponse<AgentResponseDto>`

- [ ] **Step 1: Write the failing tests**

Open `apps/api/src/projects/projects.controller.spec.ts`.

**1a.** Add `AgentsService` import at the top of the imports block:

```typescript
import { AgentsService } from '../agents/agents.service';
```

**1b.** Add `agentsService` to the describe block variable declarations (after line 68 where `impactAnalysisService` is declared):

```typescript
let agentsService: jest.Mocked<AgentsService>;
```

**1c.** Inside `beforeEach`, add the mock object (after the `impactAnalysisService` mock object definition):

```typescript
agentsService = {
  findByProject: jest.fn(),
  update: jest.fn(),
} as unknown as jest.Mocked<AgentsService>;
```

**1d.** Add `AgentsService` to the `providers` array in `Test.createTestingModule` (after the `PrismaService` provider):

```typescript
{ provide: AgentsService, useValue: agentsService },
```

**1e.** Add these test blocks at the end of the outer `describe('ProjectsController', ...)` block:

```typescript
describe('getProjectAgents', () => {
  const mockAgent = {
    id: 'agent-1',
    name: 'Bot',
    slug: 'bot',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    roles: [],
    capabilities: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('returns agents for a project (admin bypasses membership check)', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    agentsService.findByProject.mockResolvedValue([mockAgent] as any);

    const result = await controller.getProjectAgents('alpha', adminPrincipal);

    expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
    expect(agentsService.findByProject).toHaveBeenCalledWith('alpha');
    expect((result as any).data).toHaveLength(1);
    expect((result as any).data[0].slug).toBe('bot');
  });

  it('returns agents for a project member', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    mockProjectMemberFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
    agentsService.findByProject.mockResolvedValue([mockAgent] as any);

    const result = await controller.getProjectAgents('alpha', memberPrincipal);

    expect((result as any).data).toHaveLength(1);
  });

  it('throws ForbiddenAppException for non-member', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    mockProjectMemberFindUnique.mockResolvedValue(null);

    await expect(
      controller.getProjectAgents('alpha', memberPrincipal),
    ).rejects.toThrow(ForbiddenAppException);
  });

  it('allows agent principals without membership check', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    agentsService.findByProject.mockResolvedValue([mockAgent] as any);

    const result = await controller.getProjectAgents('alpha', agentPrincipal);

    expect(mockProjectMemberFindUnique).not.toHaveBeenCalled();
    expect((result as any).data).toHaveLength(1);
  });
});

describe('updateProjectAgent', () => {
  const mockUpdatedAgent = {
    id: 'agent-1',
    name: 'Bot',
    slug: 'bot',
    status: 'PAUSED',
    maxConcurrentTickets: 3,
    roles: [],
    capabilities: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('updates agent status for admin principal', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

    const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, adminPrincipal);

    expect(projectsService.findBySlug).toHaveBeenCalledWith('alpha');
    expect(agentsService.update).toHaveBeenCalledWith('bot', { status: 'PAUSED' });
    expect((result as any).data.status).toBe('PAUSED');
  });

  it('updates agent status for project member', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    mockProjectMemberFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
    agentsService.update.mockResolvedValue(mockUpdatedAgent as any);

    const result = await controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal);

    expect((result as any).data.status).toBe('PAUSED');
  });

  it('throws ForbiddenAppException for non-member', async () => {
    projectsService.findBySlug.mockResolvedValue(mockProject as any);
    mockProjectMemberFindUnique.mockResolvedValue(null);

    await expect(
      controller.updateProjectAgent('alpha', 'bot', { status: 'PAUSED' }, memberPrincipal),
    ).rejects.toThrow(ForbiddenAppException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && bun run test --testPathPattern="projects.controller.spec"
```

Expected: FAIL — `controller.getProjectAgents is not a function`, `controller.updateProjectAgent is not a function`, and DI compile error for `AgentsService`.

- [ ] **Step 3: Add `AgentsService` import and inject it into `ProjectsController`**

Open `apps/api/src/projects/projects.controller.ts`.

**3a.** Add these two imports at the top alongside existing imports.

> **Important:** `UpdateAgentDto` exists in two places. Import from the DTO file, **not** from `agents.service` — the service's version lacks `@IsIn(['ACTIVE', 'PAUSED', 'OFFLINE'])` validation on the `status` field.

```typescript
import { AgentsService } from '../agents/agents.service';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';
```

**3b.** Add `AgentsService` to the constructor (after `private impactAnalysisService: ImpactAnalysisService`):

```typescript
constructor(
  private projectsService: ProjectsService,
  private memoryItemRepository: PrismaMemoryItemRepository,
  private impactAnalysisService: ImpactAnalysisService,
  private prisma: PrismaService,
  private agentsService: AgentsService,
) {}
```

**3c.** Add the two new route handlers at the end of the class, before the closing `}`:

```typescript
@Get(':slug/agents')
@ApiOperation({ summary: 'List agents active in a project (derived from assigned tickets)' })
@ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
@ApiResponse({ status: 401, description: 'Unauthorized' })
@ApiResponse({ status: 403, description: 'Forbidden - no project access' })
@ApiResponse({ status: 404, description: 'Project not found' })
async getProjectAgents(
  @Param('slug') slug: string,
  @Principal() principal: KodaPrincipal,
) {
  const project = await this.projectsService.findBySlug(slug);
  await this.checkProjectMembership(project.id, principal);
  const data = await this.agentsService.findByProject(slug);
  return JsonResponse.Ok(data);
}

@Patch(':slug/agents/:agentSlug')
@ApiOperation({ summary: 'Update an agent status within a project context (admin or project member)' })
@ApiResponse({ status: 200, description: 'Agent updated successfully' })
@ApiResponse({ status: 401, description: 'Unauthorized' })
@ApiResponse({ status: 403, description: 'Forbidden - no project access' })
@ApiResponse({ status: 404, description: 'Project or agent not found' })
async updateProjectAgent(
  @Param('slug') slug: string,
  @Param('agentSlug') agentSlug: string,
  @Body() updateDto: UpdateAgentDto,
  @Principal() principal: KodaPrincipal,
) {
  const project = await this.projectsService.findBySlug(slug);
  await this.checkProjectMembership(project.id, principal);
  const data = await this.agentsService.update(agentSlug, updateDto);
  return JsonResponse.Ok(data);
}
```

- [ ] **Step 4: Wire `AgentsModule` into `ProjectsModule`**

Open `apps/api/src/projects/projects.module.ts`.

Replace the file contents with:

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaProjectRepository } from './prisma-project.repository';
import { PROJECT_REPOSITORY } from './domain/project.domain';
import { RagModule } from '../rag/rag.module';
import { MemoryModule } from '../memory/memory.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [PrismaModule, RagModule, MemoryModule, CodeIntelModule, AgentsModule],
  controllers: [ProjectsController],
  providers: [
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    ProjectsService,
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
```

- [ ] **Step 5: Create `projects.module.spec.ts` (DI wiring test)**

Create a new file `apps/api/src/projects/projects.module.spec.ts` with these contents:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AgentsService } from '../agents/agents.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('ProjectsModule — DI wiring', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: {} },
        { provide: AgentsService, useValue: {} },
        { provide: PrismaMemoryItemRepository, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
        {
          provide: PrismaService,
          useValue: { client: { projectMember: { findUnique: jest.fn() } } },
        },
      ],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('ProjectsController resolves with AgentsService injected', () => {
    const controller = module.get(ProjectsController);
    expect(controller).toBeDefined();
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && bun run test --testPathPattern="projects\.(controller|module)\.spec"
```

Expected: all tests PASS including the 7 new controller tests and the 1 module wiring test.

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
cd apps/api && bun run test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/projects/projects.controller.ts \
        apps/api/src/projects/projects.controller.spec.ts \
        apps/api/src/projects/projects.module.ts \
        apps/api/src/projects/projects.module.spec.ts
git commit -m "feat: add GET/PATCH /projects/:slug/agents endpoints to ProjectsController"
```

---

### Task 4: Fix web page to use `agent.slug` in PATCH URL

The web page currently calls `$api.patch(\`/projects/${slug}/agents/${agent.id}\`, ...)`. The new API endpoint uses `:agentSlug` — so the web must send `agent.slug` to match.

**Files:**
- Modify: `apps/web/pages/[project]/agents.vue`

**Interfaces:**
- Consumes: `PATCH /projects/:slug/agents/:agentSlug` (Task 3) — route param is agent slug, not UUID

- [ ] **Step 1: Fix the PATCH URL in the web page**

Open `apps/web/pages/[project]/agents.vue`.

On line 34, change:

```typescript
await $api.patch(`/projects/${slug}/agents/${agent.id}`, { status: newStatus })
```

to:

```typescript
await $api.patch(`/projects/${slug}/agents/${agent.slug}`, { status: newStatus })
```

- [ ] **Step 2: Run the web test suite to verify no regressions**

```bash
cd apps/web && bun run test
```

Expected: all tests PASS. The `apps/web/tests/pages/agents.spec.ts` AC7 test checks for presence of `/agents/` in the source, not `.id` specifically, so it continues to pass.

- [ ] **Step 3: Run web type check**

```bash
cd apps/web && bun run type-check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/pages/[project]/agents.vue
git commit -m "fix: use agent.slug instead of agent.id in project agents PATCH URL"
```

---

### Task 5: Add e2e coverage for the new endpoints

The `.nax/rules/api-testing.md` rule requires all API endpoint changes to be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`. This task adds a new `describe` section covering happy paths and error cases for both new routes.

**Files:**
- Modify: `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`

**Context:** The e2e spec runs a sequential lifecycle. By section 18 ("Ticket Assign"), a ticket has been assigned to `agentSlug` inside `projectSlug`, so `GET /api/projects/:slug/agents` will return that agent. Sections 14 ("Project Delete") deletes a **separate** project ("Delete Me") — `projectSlug` remains live throughout. `nonAdminUserAccessToken` is a non-admin user who has no project membership.

- [ ] **Step 1: Find the insertion point**

Open `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`.

Find the closing `});` of `describe('19. Agent Auto-Pickup', ...)` (around line 1193). The new section goes immediately after it, before the next `describe` block.

- [ ] **Step 2: Insert the new test section**

Add the following block after the closing `});` of `describe('19. Agent Auto-Pickup', ...)`:

```typescript
// ─────────────────────────────────────────────────────────────────
// 19b. Project-Scoped Agent Routes
// ─────────────────────────────────────────────────────────────────

describe('19b. Project-Scoped Agent Routes', () => {
  it('GET /api/projects/:slug/agents — 200 returns agents with assigned tickets', async () => {
    const res = await request(httpServer)
      .get(`/api/projects/${projectSlug}/agents`)
      .set('Authorization', `Bearer ${userAccessToken}`)
      .expect(200);

    const data = body<{ id: string; slug: string; status: string }[]>(res);
    expect(Array.isArray(data)).toBe(true);
    // agentSlug was assigned a ticket in section 18; it must appear in the list
    const found = data.find((a) => a.slug === agentSlug);
    expect(found).toBeDefined();
    expect(found?.status).toBeDefined();
  });

  it('GET /api/projects/:slug/agents — 401 without auth token', async () => {
    await request(httpServer)
      .get(`/api/projects/${projectSlug}/agents`)
      .expect(401);
  });

  it('GET /api/projects/nonexistent/agents — 404 for unknown project slug', async () => {
    await request(httpServer)
      .get('/api/projects/no-such-project/agents')
      .set('Authorization', `Bearer ${userAccessToken}`)
      .expect(404);
  });

  it('PATCH /api/projects/:slug/agents/:agentSlug — 200 updates agent status', async () => {
    const res = await request(httpServer)
      .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ status: 'PAUSED' })
      .expect(200);

    const data = body<{ slug: string; status: string }>(res);
    expect(data.slug).toBe(agentSlug);
    expect(data.status).toBe('PAUSED');

    // Restore to ACTIVE so downstream tests are not affected
    await request(httpServer)
      .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
  });

  it('PATCH /api/projects/:slug/agents/nonexistent — 404 for unknown agent slug', async () => {
    await request(httpServer)
      .patch(`/api/projects/${projectSlug}/agents/no-such-agent`)
      .set('Authorization', `Bearer ${userAccessToken}`)
      .send({ status: 'PAUSED' })
      .expect(404);
  });

  it('PATCH /api/projects/:slug/agents/:agentSlug — 403 for non-member user', async () => {
    await request(httpServer)
      .patch(`/api/projects/${projectSlug}/agents/${agentSlug}`)
      .set('Authorization', `Bearer ${nonAdminUserAccessToken}`)
      .send({ status: 'PAUSED' })
      .expect(403);
  });
});
```

- [ ] **Step 3: Run the e2e suite to verify**

```bash
cd apps/api && DATABASE_URL=file:./koda-test.ephemeral.db bun run test:integration --testPathPattern="endpoint.e2e"
```

Expected: all existing tests pass and the 6 new tests in `19b` pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts
git commit -m "test: add e2e coverage for GET/PATCH /projects/:slug/agents"
```

---

### Task 6: Regenerate OpenAPI spec and CLI client

After adding new API routes, the OpenAPI spec and CLI generated client must be regenerated. This keeps `openapi.json` and `apps/cli/src/generated/` in sync with the actual API contract.

**Files:**
- Regenerate: `openapi.json`
- Regenerate: `apps/cli/src/generated/`

- [ ] **Step 1: Build the API and export the spec**

Run from the monorepo root:

```bash
bun run api:export-spec
```

Expected: `openapi.json` updated at repo root. Verify the new paths appear:

```bash
grep -A 2 '"\/projects\/{slug}\/agents"' openapi.json
grep -A 2 '"\/projects\/{slug}\/agents\/{agentSlug}"' openapi.json
```

Expected: both paths present with `get` and `patch` operations respectively.

- [ ] **Step 2: Regenerate CLI client**

```bash
bun run generate
```

Expected: `apps/cli/src/generated/` files updated with the new project-agents endpoints. No manual edits needed.

- [ ] **Step 3: Run full monorepo build to confirm nothing is broken**

```bash
bun run build
```

Expected: all workspaces build successfully.

- [ ] **Step 4: Commit**

```bash
git add openapi.json apps/cli/src/generated/
git commit -m "feat: regenerate OpenAPI spec and CLI client for project-scoped agent endpoints"
```

---

## Self-Review Checklist

- [x] `GET /projects/:slug/agents` — implemented in Task 3
- [x] `PATCH /projects/:slug/agents/:agentSlug` — implemented in Task 3
- [x] Web page loads without errors — Task 4 fixes the PATCH URL; Task 3 makes GET work
- [x] Endpoint contract documented in `openapi.json` — Task 6
- [x] Unit tests for new service method — Task 2
- [x] Unit tests for new controller endpoints — Task 3
- [x] DI wiring test for `ProjectsModule` — Task 3 Step 5
- [x] E2E coverage for both endpoints (happy path + error cases) — Task 5
- [x] Permissions consistent with existing project auth — `checkProjectMembership` reused in Task 3
- [x] No Prisma schema migration — only queries through existing `Ticket` relations
- [x] `openapi.json` regenerated — Task 6
- [x] CLI client regenerated — Task 6
