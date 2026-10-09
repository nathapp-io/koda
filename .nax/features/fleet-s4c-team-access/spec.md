<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Fleet S4c — Team Access (Per-Project Agents, Disabled-User Guard)

## Summary

An agent (an API-key actor, `Agent` model) gets an explicit per-project roster, `AgentProject`. With the new
`AGENT_PROJECT_SCOPING` flag on (the default), an agent reaches only projects it is on, and every project route and
cross-project listing enforces that through `ProjectAccessService.resolveMembership`. A migration backfills the roster
from each agent's ticket and comment history so nothing breaks on deploy. Project admins manage the roster through
`GET/POST/DELETE /projects/:slug/agents`, the CLI and the web agents page. Ticket assignment refuses disabled users and
agents not on the roster, a new `GET /projects/:slug/assignees` feeds a web assignee picker, adding a disabled user as
a member is refused, and the members panel marks disabled members.

## Motivation

- Agents bypass project scoping entirely: `ProjectAccessService.resolveMembership` returns `null` for every non-user
  principal (`apps/api/src/projects/project-access.service.ts:28`), so any agent key reads and writes every project,
  and `ProjectsService.findAllForPrincipal` lists every project to an agent (`projects.service.ts:79-87`).
- `GET /projects/:slug/agents` lists agents that happen to have tickets assigned in the project
  (`prisma-agent.repository.ts:~118-138`), so a project has no real agent roster (GitHub issue #61).
- `TicketsService.assign` accepts any existing agent for any project and does not check `User.disabled`
  (`tickets.service.ts:318-375`); `ProjectMembersService.add` adds a disabled user (`project-members.service.ts:46-57`),
  while the S4b invite path already refuses one.
- The web assigns a ticket through a free-text user-id input (`TicketProperties.vue:157-172`), and the members panel
  cannot show a disabled member because `ProjectMemberDto` drops the `disabled` flag
  (`members/dto/project-member.dto.ts:4-14`).

## Design

### Rulings that bind every story (user, 2026-10-09)

- D527: the migration backfills `AgentProject` from history; access is explicit afterwards.
- D528: `AGENT_PROJECT_SCOPING=on|off`, default `on`; `off` restores pre-S4c agent access exactly. Roster, guards,
  assignees endpoint and UI work the same in both modes.
- D529: a roster row grants access only. An agent's permissions inside a project still come from its global
  `AgentRoleEntry` roles via `KodaCaslAbilityFactory.agentPermissions`; there is no per-project agent role.
- D530: project ADMIN and global ADMIN change a project's roster; any project member (or rostered agent) reads it.
- D531: removing an agent with open tickets in the project is refused (409).
- D533: scoping covers cross-project paths too (`GET /projects`, pickup), not only `/projects/:slug` routes.
- D534: enforcement is central in `ProjectAccessService.resolveMembership`.

### Integration

This feature changes the symbols below. Baselines exist only to locate the code; they are never the interface to
implement.

**`ProjectAccessService`** — `apps/api/src/projects/project-access.service.ts` (US-001)
- Baseline: `constructor(private projectRepo: PrismaProjectRepository)`; `resolveMembership(projectId, principal):
  Promise<string | null>` returns `null` for any non-user principal without a query.
- Target: `constructor(private projectRepo: PrismaProjectRepository, private projectAgents: ProjectAgentsService)`;
  `resolveMembership` is unchanged for users and runners; for an agent principal (`isAgentPrincipal`) it returns `null`
  when `projectAgents.scopingEnabled()` is false (no query), returns `null` when
  `projectAgents.isAssigned(projectId, principal.id)` is true, and otherwise throws `ForbiddenAppException({},
  'projects')`. The docblock and the `ProjectMembershipGuard` docblock say "agent: roster-checked, returns null".

**`ProjectsService.findAllForPrincipal`** — `apps/api/src/projects/projects.service.ts:79` (US-001)
- Baseline: agents and global admins get `projectRepo.findAll()`.
- Target: a global admin gets `findAll()`; an agent gets `findAll()` when scoping is off, else
  `projectRepo.findAllForAgent(agentId)` (non-deleted projects with an `AgentProject` row for that agent).

**`AgentsService.suggestTicket`** — `apps/api/src/agents/agents.service.ts:242` (US-001)
- Target: after the existing caller gate and project lookup (unknown project stays 404 `agents`), when scoping is on
  and the target agent (`agentSlug`) is not on the project's roster, throws `ForbiddenAppException({}, 'projects')`.

**`AgentsService.findMe`** — `apps/api/src/agents/agents.service.ts:170` (US-001)
- Baseline: returns `AgentResponseDto`.
- Target: returns `AgentMeResponseDto` = `AgentResponseDto` fields plus `projects: { slug: string; name: string }[]`
  (the agent's roster, non-deleted projects, ordered by slug), in both flag modes.

**`ProjectsController.getProjectAgents` / `updateProjectAgent`** — `apps/api/src/projects/projects.controller.ts:167`,
`:183` (US-002)
- Baseline: `GET :slug/agents` returns a bare `AgentResponseDto[]` from `agentsService.findByProject(slug)` (agents with
  tickets in the project); `PATCH :slug/agents/:agentSlug` resolves its target through the same list.
- Target: `GET` returns `{ scoping: boolean; items: ProjectAgentDto[] }` from `projectAgents.list(projectId)`;
  `PATCH` resolves the target through the roster (404 `projectAgents` when not on it), then keeps today's admin-or-self
  check and `agentsService.update(agentSlug, dto)`. New handlers `POST :slug/agents` and `DELETE
  :slug/agents/:agentSlug` live in the same controller.

**`TicketsService.assign`** — `apps/api/src/tickets/tickets.service.ts:318` (US-003)
- Baseline: project, ticket, user/agent existence and membership checks run outside `txManager.run`; only the update
  and the ticket event run inside it.
- Target: the lookups, the checks and the update run in one `txManager.run`. User path order: missing -> 404 (today);
  `disabled` -> 409 `tickets.userDisabled`; not a member -> 403 (today; global ADMIN exempt). Agent path order:
  `lockProjectAgents(projectId)`; missing -> 404 (today); not on the roster -> 409 `tickets.agentNotInProject`; status
  `OFFLINE` -> 409 `tickets.agentOffline`. The constructor gains `projectAgents: ProjectAgentsService`.

**`ITicketRepository.findUserById` / `findAgentById`** — `tickets/domain/ticket.domain.ts:132-133`,
`prisma-tickets.repository.ts:236-240` (US-003)
- Baseline: `findUserById(id): Promise<{ id: string; role: string } | null>`; `findAgentById(id): Promise<{ id: string }
  | null>`.
- Target: `findUserById` also selects `disabled: boolean`; `findAgentById` also selects `status: string`.

**`PrismaProjectMembersRepository.findUserIdByEmail`** — `members/prisma-project-members.repository.ts:49` (US-003)
- Baseline: `findUserIdByEmail(email): Promise<string | null>`.
- Target: replaced by `findUserByEmail(email): Promise<{ id: string; disabled: boolean } | null>`;
  `ProjectMembersService.add` throws `ConflictAppException({}, 'members.userDisabled')` for a disabled user before
  `createMember`.

**`ProjectMemberDto.from`** — `members/dto/project-member.dto.ts:4-14` (US-003)
- Target: adds `disabled: boolean` from `ProjectMemberRecord.disabled`.

Symbols this feature reads but does not change:
- `isAgentPrincipal`, `isUserPrincipal`, `KodaPrincipal` — `apps/api/src/auth/principal/koda-principal.types.ts:39-44`
- `ConflictAppException(args, prefix)` -> i18n `<prefix>.409` — `apps/api/src/common/exceptions/conflict-app.exception.ts`
- `lockProjectMembers` / `KODA_LOCK_CLASS` — `apps/api/src/common/utils/advisory-lock.ts` (pattern for the new lock)
- `notifications.config.ts` `registerAs` + `validateUtil` — pattern for the new config
- `ProjectAccessModule` (`projects/project-access.module.ts`): a leaf module importing only `PrismaModule`; the new
  roster provider lives here so `ProjectsModule`, `TicketsModule` (via `ProjectsModule`'s export) and `AgentsModule`
  (new plain import) can inject it without a new cycle.

### New data (US-001)

Migration `apps/api/prisma/migrations/20261011090000_agent_projects/migration.sql`:

```prisma
model AgentProject {
  agentId   String
  projectId String
  addedById String?
  createdAt DateTime @default(now())

  agent   Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  addedBy User?   @relation("AgentProjectAddedBy", fields: [addedById], references: [id], onDelete: SetNull)

  @@id([agentId, projectId])
  @@index([projectId])
}
// back-relations: Agent.projects AgentProject[]; Project.agents AgentProject[];
// User.addedAgentProjects AgentProject[] @relation("AgentProjectAddedBy")
```

After the Prisma-generated DDL the migration appends the one-time backfill:

```sql
INSERT INTO "AgentProject" ("agentId", "projectId")
SELECT a, p FROM (
  SELECT "assignedToAgentId" AS a, "projectId" AS p FROM "Ticket" WHERE "assignedToAgentId" IS NOT NULL
  UNION SELECT "createdByAgentId", "projectId" FROM "Ticket" WHERE "createdByAgentId" IS NOT NULL
  UNION SELECT c."authorAgentId", t."projectId" FROM "Comment" c JOIN "Ticket" t ON t.id = c."ticketId"
        WHERE c."authorAgentId" IS NOT NULL
) s
ON CONFLICT ("agentId", "projectId") DO NOTHING;
```

Soft-deleted tickets count as history. `addedById` stays NULL for backfilled rows.

### Config (US-001)

`apps/api/src/config/agent-access.config.ts`, mirroring `notifications.config.ts`:

```ts
export const AGENT_ACCESS_CFG = 'agentAccess';
export interface IAgentAccessConfig { projectScoping: boolean }
// registerAs(AGENT_ACCESS_CFG, ...): AGENT_PROJECT_SCOPING 'on' | 'off', unset -> 'on'; projectScoping = value === 'on'
```

`env.validation.ts` gains `AGENT_PROJECT_SCOPING: Joi.string().valid('on', 'off').default('on')`; the config is added
to the `load` array in `app.module.ts`.

### Roster service (US-001 creates, US-002 extends)

`apps/api/src/projects/agents/project-agents.service.ts`, provided and exported by `ProjectAccessModule`, backed by a
module-private `PrismaProjectAgentsRepository` (`prisma-project-agents.repository.ts`):

```ts
export class ProjectAgentsService {
  scopingEnabled(): boolean;                                          // US-001
  isAssigned(projectId: string, agentId: string): Promise<boolean>;    // US-001
  projectsForAgent(agentId: string): Promise<{ slug: string; name: string }[]>; // US-001
  list(projectId: string): Promise<ProjectAgentRecord[]>;             // US-002
  add(projectId: string, agentSlug: string, addedById: string): Promise<ProjectAgentRecord>; // US-002
  remove(projectId: string, agentSlug: string): Promise<void>;        // US-002
}
```

`ProjectAgentDto` (US-002, `apps/api/src/projects/agents/dto/project-agent.dto.ts`): `{ slug, name, status, roles:
string[], capabilities: string[], openTicketCount: number, openTicketRefs: string[], addedAt: string, addedBy: { id,
name } | null }`. Open = tickets in this project assigned to the agent, `deletedAt` null, status not `CLOSED` or
`REJECTED`; `openTicketRefs` holds up to 10 refs, oldest first, computed with one grouped query per list call.

### Concurrency (US-002, US-003)

`advisory-lock.ts` gains `KODA_LOCK_CLASS.PROJECT_AGENTS = 72402` and `lockProjectAgents(db, projectId)`, same shape
as `lockProjectMembers`. `ProjectAgentsService.remove` runs `lockProjectAgents` -> count open tickets -> 409 or delete
in one `txManager.run`; `TicketsService.assign` takes the same lock first on the agent path. A remove and an
agent-assign on the same project therefore serialize: a ticket can never end up assigned to an agent removed from its
project.

### API (US-002, US-003)

| Route | Who | Behaviour |
|---|---|---|
| `GET /projects/:slug/agents` | project member, rostered agent | `{ scoping, items: ProjectAgentDto[] }` ordered by name; un-paged (documented exception to `KodaPageQuery`) |
| `POST /projects/:slug/agents` `{ agentSlug }` | project ADMIN, global ADMIN | 201 `ProjectAgentDto`; 404 `agents` unknown agent; 409 `projectAgents.alreadyAssigned`; 409 `projectAgents.agentOffline` |
| `DELETE /projects/:slug/agents/:agentSlug` | project ADMIN, global ADMIN | 204; 404 `projectAgents` not on roster; 409 `projectAgents.hasOpenTickets` with message args `{ count, refs }` |
| `PATCH /projects/:slug/agents/:agentSlug` | unchanged | resolves through the roster (404 `projectAgents` when not on it) |
| `GET /projects/:slug/assignees?q=&limit=` | project member, rostered agent | `{ items: [{ type: 'user' \| 'agent', id, name, secondary, status? }] }`; users (non-disabled members, `secondary` = email) then agents (roster, status `ACTIVE`/`PAUSED`, `secondary` = slug, `status` set), each ordered by name; `q` trimmed, max 100 chars, case-insensitive substring on name, email or slug; `limit` default 20, max 50, applied to the combined list |

New i18n files `apps/api/src/i18n/{en,zh}/projectAgents.json` with `404`, `alreadyAssigned.409`, `agentOffline.409`,
`hasOpenTickets.409` (en: "{count} open tickets are still assigned to this agent: {refs}"). New keys
`tickets.userDisabled.409`, `tickets.agentNotInProject.409`, `tickets.agentOffline.409`, `members.userDisabled.409` in
both locales.

Each API story regenerates the committed contract with `bun run generate` (updates `openapi.json` and
`apps/cli/src/generated/`).

### CLI Behavior (US-004)

Subcommands of `koda project`, each taking `--project <slug>` resolved through `withContext({ projectSlug })` like
`member.ts`, and `--json`:
- `koda project agents` — stdout: table `Slug | Name | Status | Open tickets` (or the `{ scoping, items }` JSON); when
  `scoping` is false, a stderr note "Agent scoping is off on this server".
- `koda project agent-add <agentSlug>` — stdout: `Added <agentSlug> to <project>` (or the `ProjectAgentDto` JSON).
- `koda project agent-remove <agentSlug>` — stdout: `Removed <agentSlug> from <project>`.
- Exit 0 success; exit 1 API/network error, with the API's translated message (including the 409 open-ticket refs) on
  stderr via `handleApiError`; exit 2 config/auth error.

### Web (US-005, US-006)

- `pages/[project]/agents.vue` (US-005): reads `{ scoping, items }`; table columns name, slug, roles, capabilities,
  status, open tickets; project admins also see added by/at and a Remove button. "Add agent" (project admins) opens
  `AddProjectAgentDialog.vue`, which lists `GET /agents` minus the roster minus `OFFLINE` agents and posts
  `{ agentSlug }`. Remove asks for confirmation; for a row with `openTicketCount > 0`, or when `DELETE` returns 409, it
  shows "Reassign its N open tickets first" with `openTicketRefs` rendered as ticket links. When `scoping` is false the
  page shows an info note. Empty state "No agents on this project yet." The pause/resume control stays.
- `AssigneePicker.vue` (US-006): combobox over `GET /projects/:slug/assignees?q=` (200 ms debounce), "People" and
  "Agents" groups, "(paused)" tag; choosing posts `{ userId }` or `{ agentId }` to
  `/projects/:slug/tickets/:ref/assign`. It replaces the free-text input in `TicketProperties.vue`; the current-assignee
  display and Unassign stay.
- `ProjectMembersPanel.vue` (US-006): a "Disabled" badge, muted row and no role select for a member whose `disabled`
  is true.
- All strings via `t(...)` in `apps/web/i18n/locales/{en,zh}.json`; API errors via `extractApiError`.

### Failure Handling

| Failure | Behaviour | Owner |
|---|---|---|
| `AGENT_PROJECT_SCOPING` set to a value other than `on`/`off` | API startup fails env validation naming the variable | US-001 |
| Roster lookup throws (database error) | `resolveMembership` rejects with that error (fail-closed, no fallback to allow) | US-001 |
| Add an unknown / `OFFLINE` / already-rostered agent | 404 `agents` / 409 `projectAgents.agentOffline` / 409 `projectAgents.alreadyAssigned` | US-002 |
| Remove an agent with open tickets / not on roster | 409 `projectAgents.hasOpenTickets` / 404 `projectAgents`; roster unchanged | US-002 |
| Assign a disabled user / off-roster agent / `OFFLINE` agent | 409 `tickets.userDisabled` / `tickets.agentNotInProject` / `tickets.agentOffline`; ticket unchanged | US-003 |
| Add a disabled user as a member | 409 `members.userDisabled`; no membership row | US-003 |
| CLI command gets an API error | exit 1, translated message on stderr | US-004 |
| Web add/remove/assign gets an API error | toast via `extractApiError`; list unchanged | US-005, US-006 |

## Out of Scope

- Per-project agent roles or per-project capability overrides; an agent's permissions inside a project come only from its global `AgentRoleEntry` roles.
- Fleet runners (`Runner` model, `kr_` keys, `RunnerPrincipal`) are not scoped by the agent roster and keep their current behaviour.
- Restricting `GET /agents` and `GET /agents/:slug`; both stay readable by any authenticated actor.
- A project admin enabling or disabling user accounts; only a global ADMIN does that, unchanged.
- An agent-assignee filter on the ticket list.
- Notifications or emails about roster changes.
- Removing the now-unused `AgentsService.findByProject` and `PrismaAgentRepository.findByProjectSlug`; they stay in place for a later cleanup.
- Ownership checks on `repoId` / `repoRefs` / `ticketIds` passed to `ContextBuilderService` and `getChangeImpact`; a pre-existing gap, not agent-specific.
- An agents section on the members panel.
- Caching roster lookups; `resolveMembership` reads the roster on every request.
- Re-running the backfill after deploy; it runs once inside the migration.
- US-003 only: a user disabled concurrently with an assign to that user is best-effort (no lock); the disabled check reads the row inside the assign transaction.
- US-001 only: agent permissions inside a rostered project are not changed; `assertProjectRoles` and `assertProjectPermission` keep their agent behaviour.

## Stories

1. **US-001: Agent roster store, scoping flag and enforcement** — `Workdir: apps/api` — no dependencies.
2. **US-002: Project agent roster routes** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Assign and member guards, assignees endpoint** — `Workdir: apps/api` — depends on US-002 (shares the
   `lockProjectAgents` lock and the roster remove path).
4. **US-004: CLI project agent commands** — `Workdir: apps/cli` — depends on US-002.
5. **US-005: Web project agents page** — `Workdir: apps/web` — depends on US-002.
6. **US-006: Web assignee picker and disabled-member badge** — `Workdir: apps/web` — depends on US-003.

### Context Files

> Existing files to read, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/projects/project-access.service.ts` — `resolveMembership`, changed here
- `apps/api/src/projects/project-access.module.ts` — leaf module that will provide the roster service
- `apps/api/src/config/notifications.config.ts` — `registerAs` + `validateUtil` config pattern to mirror
- `apps/api/src/agents/agents.service.ts` — `suggestTicket` and `findMe`, changed here
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`, changed here

**US-002**

- `apps/api/src/projects/agents/project-agents.service.ts` — created by US-001, extended here
- `apps/api/src/projects/projects.controller.ts` — `getProjectAgents` / `updateProjectAgent`, changed here
- `apps/api/src/projects/members/project-members.service.ts` — admin gate (`assertProjectAdmin`) and 409 mapping to mirror
- `apps/api/src/common/utils/advisory-lock.ts` — `lockProjectMembers` pattern for `lockProjectAgents`
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — HTTP-on-PG test pattern

**US-003**

- `apps/api/src/tickets/tickets.service.ts` — `assign`, changed here
- `apps/api/src/tickets/prisma-tickets.repository.ts` — `findUserById` / `findAgentById`, changed here
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — `findUserIdByEmail`, replaced here
- `apps/api/src/projects/members/dto/project-member.dto.ts` — gains `disabled`
- `apps/api/src/projects/agents/project-agents.service.ts` — created by US-001, extended by US-002, consumed here

**US-004**

- `apps/cli/src/commands/project.ts` — the `project` command group extended here
- `apps/cli/src/commands/member.ts` — `--project` + `withContext` + `table` + `--json` pattern to mirror
- `apps/cli/src/commands/project.spec.ts` — command test pattern (mocked generated client)
- `apps/cli/src/utils/error.ts` — `handleApiError`

**US-005**

- `apps/web/pages/[project]/agents.vue` — the page reworked here
- `apps/web/tests/pages/agents.spec.ts` — the page's existing test harness
- `apps/web/components/ProjectInvitesPanel.vue` — admin dialog + list pattern to mirror
- `apps/web/composables/useProjectMembers.ts` — composable pattern to mirror for the roster

**US-006**

- `apps/web/components/TicketProperties.vue` — assign section changed here
- `apps/web/components/ProjectMembersPanel.vue` — gains the disabled badge
- `apps/web/composables/useProjectMembers.ts` — `ProjectMember` type gains `disabled`
- `apps/web/tests/components/ProjectMembersPanel.spec.ts` — component test pattern

### Creates

> New files each story authors.

**US-001**

- `apps/api/prisma/migrations/20261011090000_agent_projects/migration.sql` — `AgentProject` table + backfill
- `apps/api/src/config/agent-access.config.ts` — `AGENT_ACCESS_CFG`, `IAgentAccessConfig`, `agentAccessConfig`
- `apps/api/src/projects/agents/prisma-project-agents.repository.ts` — `PrismaProjectAgentsRepository` (module-private)
- `apps/api/src/projects/agents/project-agents.service.ts` — `ProjectAgentsService`
- `apps/api/src/agents/dto/agent-me-response.dto.ts` — `AgentMeResponseDto`
- `apps/api/test/integration/projects/agent-project-scoping.integration.spec.ts` — scoping over HTTP on PG
- `apps/api/test/integration/projects/agent-projects-backfill.integration.spec.ts` — backfill statement on PG

**US-002**

- `apps/api/src/projects/agents/dto/project-agent.dto.ts` — `ProjectAgentDto`, `ProjectAgentListDto`
- `apps/api/src/projects/agents/dto/add-project-agent.dto.ts` — `AddProjectAgentDto { agentSlug }`
- `apps/api/src/i18n/en/projectAgents.json` — roster error messages
- `apps/api/src/i18n/zh/projectAgents.json` — roster error messages (zh)
- `apps/api/test/integration/projects/project-agents.integration.spec.ts` — roster routes over HTTP on PG

**US-003**

- `apps/api/src/projects/assignees/project-assignees.controller.ts` — `ProjectAssigneesController`
- `apps/api/src/projects/assignees/project-assignees.service.ts` — `ProjectAssigneesService.search`
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.ts` — module-private queries
- `apps/api/src/projects/assignees/dto/assignee.dto.ts` — `AssigneeDto`, `AssigneeListDto`, `AssigneeQuery`
- `apps/api/test/integration/tickets/ticket-assign-guards.integration.spec.ts` — assign guards + lock on PG
- `apps/api/test/integration/projects/project-assignees.integration.spec.ts` — assignees over HTTP on PG

**US-005**

- `apps/web/composables/useProjectAgents.ts` — `useProjectAgents(slug)`: list, add, remove
- `apps/web/components/AddProjectAgentDialog.vue` — add-agent dialog
- `apps/web/tests/components/AddProjectAgentDialog.spec.ts` — dialog behaviour

**US-006**

- `apps/web/components/AssigneePicker.vue` — assignee combobox
- `apps/web/tests/components/AssigneePicker.spec.ts` — picker behaviour

### Modifies

**US-001**

- `apps/api/src/projects/project-access.service.spec.ts` — `new ProjectAccessService(mockProjectRepo)` (`:15`) gains the `ProjectAgentsService` argument; the tests "passes without checking membership for agent principal" (`:62`) and "returns null for an agent without a membership lookup" (`:97`) now hold only when the agent is rostered or scoping is off. Replacing invariant: a rostered agent resolves `null`, an unrostered agent rejects with `ForbiddenAppException`, scoping off resolves `null` without a lookup.
- `apps/api/src/projects/project-membership.guard.spec.ts` — constructs `ProjectAccessService` with one argument (`:133`); "AC3: returns true for an agent principal without a membership lookup" (`:195`) and "AC15: returns true for an agent principal on a handler carrying @ProjectRoles" (`:295`) need a rostered agent. Replacing invariant: the guard admits a rostered agent and rejects an unrostered one with 403.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — constructs `ProjectAccessService` with one argument (`:152`); "AC8 boundary: an agent principal is admitted to POST :ref/assign with no membership row" (`:266`) expects 200 with no roster row. Replacing invariant: admitted when the agent has a roster row (still no `ProjectMember` row).
- `apps/api/src/projects/projects.service.spec.ts` — constructs `ProjectAccessService` with one argument (`:49`); "passes without checking membership for agent principal" (`:196`) needs a rostered agent. Same replacing invariant as the ProjectAccessService unit spec.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — constructs `ProjectAccessService` with one argument (`:180`); "AC8: returns every non-deleted project for an agent principal" (`:206`) expects all projects. Replacing invariant: with scoping on an agent gets only its rostered non-deleted projects; with scoping off it gets every non-deleted project.
- `apps/api/src/agents/agents.service.spec.ts` — `findMe` (`:408-413`) asserts `toEqual(mockAgentDto)`, which now also carries `projects`; the `suggestTicket` tests (`:673-800`) build the service without the roster dependency. Replacing invariant: `findMe` returns the agent fields plus `projects`; `suggestTicket` behaves as before for a rostered target.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — builds the real `AgentsService` (`~:118`) without the new `ProjectAgentsService` provider; the AC9 (`~:178-198`) and AC12 (`~:230`) 200 paths have no roster row. Replacing invariant: those paths return 200 when the target agent is rostered.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — `beforeAll` (`:237-248`) has agent `team-bot` act on `team` and `other` with no roster row; "AC8: findAllForPrincipal returns every non-deleted project for an agent principal" (`:284`) and "AC3: CommentsService.update proceeds to the CASL check" (`:349`) assume unscoped agents. Replacing invariant: seed `AgentProject` rows for the projects the agent acts on; `findAllForPrincipal` returns only rostered projects.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the agent created at `:226-246` acts on its project via `agentApiKey` (`:515`, `:737`, `:1259`, `:1635`, `:1650`, `~:2395`) with no roster row. Replacing invariant: insert the agent's `AgentProject` row right after creating it; the existing expectations then hold unchanged.
- `apps/api/test/e2e/agents.e2e.spec.ts` — the pickup tests (`:221`, `~:248`) call pickup for an agent not on the project's roster. Replacing invariant: insert the `AgentProject` row in setup; expectations unchanged.
- `apps/api/test/e2e/ast-index.e2e.spec.ts` — "DEVELOPER agent should be able to call indexCommit" (`:235`) expects 201 for an unrostered agent. Replacing invariant: the agent is rostered on the project in setup; expectation unchanged.
- `apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts` — the `agent` case of "%s reads every code-intel route" (`:74`, agent created `:42`) expects 200 with no roster row. Replacing invariant: insert the agent's `AgentProject` row in setup; expectation unchanged.

**US-002**

- `apps/api/src/projects/projects.controller.spec.ts` — `describe('getProjectAgents')` (`:261-316`) mocks `agentsService.findByProject` and asserts a bare array (`data[0].slug`); `describe('updateProjectAgent')` (`:318-~400`) mocks `findByProject` to resolve the target. Replacing invariant: `getProjectAgents` returns `{ scoping, items }` from `ProjectAgentsService.list`; `updateProjectAgent` resolves the target through the roster.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — "GET /api/projects/:slug/agents — 200 returns agents with assigned tickets" (`:1319`) asserts `Array.isArray(data)`; "PATCH .../agents/:agentSlug — 200 updates agent status" (`:1346`). Replacing invariant: `data.items` contains the rostered agent; `PATCH` succeeds for a rostered agent. This story also adds the new `POST`/`DELETE` roster cases here (happy path + one error each).
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — the matrix case for PATCH /api/projects/:slug/agents/:agentSlug (`:575`) resolves through the old ticket-derived list. Replacing invariant: the target is resolved through the roster.

**US-003**

- `apps/api/src/tickets/tickets.service.spec.ts` — "should assign ticket to agent" (`~:1008`) resolves `findAgentById` to `{ id }` with no roster or `status`, and the service is built without `ProjectAgentsService`. Replacing invariant: assigning a rostered `ACTIVE` agent sets `assignedToAgentId`; an unrostered agent is refused with 409.
- `apps/api/src/projects/members/project-members.service.spec.ts` — "add: unknown email is 404, duplicate member is 409" (`:78`) mocks `findUserIdByEmail`, which is replaced by `findUserByEmail`. Replacing invariant: unknown email 404, duplicate 409, disabled user 409 `members.userDisabled`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — "POST .../assign — assigns ticket to agent" (`:1196`) assigns an agent; it passes only once the agent is rostered (US-001 setup). This story adds the assignees route cases here (happy path + one error).

**US-004**

None. The story only adds subcommands to `project.ts` and new cases to `project.spec.ts`; no existing CLI test asserts on `/projects/{slug}/agents`.

**US-005**

- `apps/web/tests/pages/agents.spec.ts` — pins the page's data shape and fetch (`:39` path regex, `:71` capabilities column, `:110` capabilities badges, `:207` patch path); the page now reads `{ scoping, items }`. Replacing invariant: the page fetches /projects/${slug}/agents, renders items (capabilities column kept) and patches status at /projects/${slug}/agents/${agent.slug}.
- `apps/web/tests/pages/loading-states.spec.ts` — the agents-page cases (`:147-185`) assume the bare-array response. Replacing invariant: same loading/empty/error states over the `{ scoping, items }` response.

**US-006**

- `apps/web/tests/pages/ticket-detail.spec.ts` — the assign assertions (`:200`) pin the free-text assign flow in `TicketProperties`. Replacing invariant: assignment goes through `AssigneePicker`, which posts `{ userId }` or `{ agentId }` to the same assign URL.
- `apps/web/tests/pages/ticket-role-visibility.spec.ts` — source-pattern checks (`:25`, `:34`) on the assign controls. Replacing invariant: the assign control (now `AssigneePicker`) shows under the same role condition as before.

### Seams

- SEAM-1 (US-001 -> US-002, US-003): `ProjectAgentsService` is created in US-001 and consumed by `ProjectsController` (US-002) and `TicketsService.assign` (US-003); US-003's assign ACs exercise it through `POST /projects/:slug/tickets/:ref/assign`.
- SEAM-2 (US-002 -> US-004, US-005): the roster routes are consumed by the CLI (generated client) and the web page; the CLI ACs assert the generated functions are called with the project slug, the web ACs assert the request path and body.
- SEAM-3 (US-003 -> US-006): `GET /projects/:slug/assignees` and the assign route are consumed by `AssigneePicker`.

## Acceptance Criteria

### US-001: Agent roster store, scoping flag and enforcement (`Workdir: apps/api`)

1. [unit] `agentAccessConfig()` with `AGENT_PROJECT_SCOPING` unset returns `{ projectScoping: true }`.
2. [unit] `agentAccessConfig()` with `AGENT_PROJECT_SCOPING=off` returns `{ projectScoping: false }`.
3. [unit] env validation rejects `AGENT_PROJECT_SCOPING=maybe` with an error naming `AGENT_PROJECT_SCOPING`.
4. [integration] Running the `20261011090000_agent_projects` migration's `INSERT INTO "AgentProject"` backfill over a database where agent A is assigned a ticket in project P1, agent A wrote a comment on a soft-deleted ticket in P2, and agent B created a ticket in P1 yields exactly the rows (A, P1), (A, P2), (B, P1), each with `addedById` null.
5. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` resolves `null` when `ProjectAgentsService.isAssigned(projectId, agentId)` resolves true and scoping is on.
6. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` rejects with `ForbiddenAppException` (prefix `projects`) when `isAssigned` resolves false and scoping is on.
7. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` resolves `null` without calling `isAssigned` when `ProjectAgentsService.scopingEnabled()` returns false.
8. [unit] `ProjectAccessService.resolveMembership(projectId, runnerPrincipal)` resolves `null` without calling `isAssigned`.
9. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` rejects with the same error when `isAssigned` rejects with a database error.
10. [integration] With scoping on, `GET /api/projects/:slug/tickets` with an agent API key returns 403 when the agent has no `AgentProject` row for the project.
11. [integration] With scoping on, `GET /api/projects/:slug/tickets` with an agent API key returns 200 after an `AgentProject` row for that agent and project is inserted.
12. [integration] With scoping on, `GET /api/projects` with an agent API key returns only the non-deleted projects the agent has `AgentProject` rows for.
13. [integration] With scoping on, `GET /api/agents/:slug/pickup?project=<slug>` called by a global ADMIN returns 403 when the target agent has no `AgentProject` row for that project.
14. [integration] `GET /api/agents/me` with an agent API key returns `projects` listing `{ slug, name }` for each non-deleted project on the agent's roster, ordered by slug.

### US-002: Project agent roster routes (`Workdir: apps/api`)

1. [integration] `GET /api/projects/:slug/agents` by a project member returns `{ scoping: true, items }` where `items` includes a rostered agent that has no tickets in the project.
2. [integration] `GET /api/projects/:slug/agents` excludes an agent that has tickets assigned in the project but no `AgentProject` row.
3. [integration] For a rostered agent with tickets in statuses `CREATED`, `IN_PROGRESS`, `CLOSED`, `REJECTED` and one soft-deleted `CREATED` ticket, the `ProjectAgentDto` has `openTicketCount` 2 and `openTicketRefs` holding those two refs oldest first.
4. [integration] `openTicketRefs` holds at most 10 refs when a rostered agent has 12 open tickets in the project, while `openTicketCount` is 12.
5. [integration] `POST /api/projects/:slug/agents` with `{ agentSlug }` by a project ADMIN returns 201 with the `ProjectAgentDto` and stores the row with `addedById` = that admin.
6. [integration] `POST /api/projects/:slug/agents` by a project DEVELOPER returns 403 and stores no row.
7. [integration] `POST /api/projects/:slug/agents` for an agent already on the roster returns 409 with the `projectAgents.alreadyAssigned` message.
8. [integration] `POST /api/projects/:slug/agents` for an agent whose status is `OFFLINE` returns 409 with the `projectAgents.agentOffline` message.
9. [integration] `POST /api/projects/:slug/agents` with an unknown `agentSlug` returns 404.
10. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for a rostered agent with 2 open tickets returns 409 whose message contains the count `2` and both ticket refs, and the `AgentProject` row remains.
11. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for a rostered agent with no open tickets returns 204 and deletes its `AgentProject` row.
12. [integration] After `DELETE /api/projects/:slug/agents/:agentSlug` returns 204, that agent's next `GET /api/projects/:slug/tickets` with its API key returns 403.
13. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for an agent not on the roster returns 404.
14. [integration] `PATCH /api/projects/:slug/agents/:agentSlug` with `{ status: 'PAUSED' }` by a project ADMIN returns 200 for a rostered agent that has no tickets.
15. [integration] `PATCH /api/projects/:slug/agents/:agentSlug` by a project ADMIN returns 404 for an unrostered agent that has tickets assigned in the project.

### US-003: Assign and member guards, assignees endpoint (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ userId }` of a disabled project member returns 409 with the `tickets.userDisabled` message and leaves the ticket unassigned.
2. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of an agent not on the project's roster returns 409 with the `tickets.agentNotInProject` message.
3. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of a rostered agent whose status is `OFFLINE` returns 409 with the `tickets.agentOffline` message.
4. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of a rostered `ACTIVE` agent returns 200 and sets `assignedToAgentId`.
5. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of an agent that is both unrostered and `OFFLINE` returns 409 with the `tickets.agentNotInProject` message (roster check first).
6. [integration] When `DELETE /api/projects/:slug/agents/:agentSlug` and an assign of a second ticket to that agent run concurrently on PG, the outcome is either a 409 removal with the agent still rostered or a 409 assign with the agent removed — never a removed agent holding an open ticket in the project.
7. [integration] `POST /api/projects/:slug/members` with the email of a disabled user returns 409 with the `members.userDisabled` message and creates no membership row.
8. [integration] `GET /api/projects/:slug/members` returns `disabled: true` for a member whose user account is disabled.
9. [integration] `GET /api/projects/:slug/assignees` lists non-disabled project members as `type: 'user'` with `secondary` = email, and omits a disabled member.
10. [integration] `GET /api/projects/:slug/assignees` lists rostered `ACTIVE` and `PAUSED` agents as `type: 'agent'` with `secondary` = slug and `status` set, omits an `OFFLINE` rostered agent and omits an unrostered agent.
11. [integration] `GET /api/projects/:slug/assignees` returns all users before all agents, each group ordered by name.
12. [integration] `GET /api/projects/:slug/assignees?q=ALI` matches a member named "Alice" and an agent with slug `alias-bot`, case-insensitively.
13. [integration] `GET /api/projects/:slug/assignees?limit=2` returns 2 items when 3 users and 2 agents match.
14. [integration] `GET /api/projects/:slug/assignees` by a user who is not a project member returns 403.

### US-004: CLI project agent commands (`Workdir: apps/cli`)

1. [unit] `koda project agents --project alpha` calls the generated `projectsControllerGetProjectAgents` with `path: { slug: 'alpha' }` and prints one table row per item with slug, name, status and open-ticket count.
2. [unit] `koda project agents --project alpha --json` prints the `{ scoping, items }` response as JSON.
3. [unit] `koda project agents` writes "Agent scoping is off on this server" to stderr when the response has `scoping: false`.
4. [unit] `koda project agent-add bot-1 --project alpha` calls the generated add-agent function with `path: { slug: 'alpha' }` and body `{ agentSlug: 'bot-1' }` and exits 0.
5. [unit] `koda project agent-remove bot-1 --project alpha` calls the generated remove-agent function with `path: { slug: 'alpha', agentSlug: 'bot-1' }` and exits 0.
6. [unit] `koda project agent-remove bot-1` exits 1 and writes the API error message to stderr when the API responds 409.

### US-005: Web project agents page (`Workdir: apps/web`)

1. [unit] `pages/[project]/agents.vue` renders one row per entry of the `items` array returned by `GET /projects/:slug/agents`, showing name, slug, roles, capabilities, status and open-ticket count.
2. [unit] `pages/[project]/agents.vue` shows the "Add agent" button and the Remove buttons only when the viewer is a project ADMIN or global ADMIN.
3. [unit] `AddProjectAgentDialog` lists agents from `GET /agents` excluding agents already on the roster and agents whose status is `OFFLINE`.
4. [unit] Confirming `AddProjectAgentDialog` posts `{ agentSlug }` to `/projects/:slug/agents` and reloads the roster.
5. [unit] Removing a roster row with `openTicketCount` 0 sends `DELETE /projects/:slug/agents/:agentSlug` after confirmation and reloads the roster.
6. [unit] Removing a roster row with `openTicketCount` 2 shows the "Reassign its 2 open tickets first" message with each `openTicketRefs` entry linked to its ticket page, and sends no `DELETE`.
7. [unit] When `DELETE /projects/:slug/agents/:agentSlug` returns 409, the page shows the error via `extractApiError` and reloads the roster.
8. [unit] `pages/[project]/agents.vue` shows the scoping-off info note when the response has `scoping: false`.
9. [unit] `pages/[project]/agents.vue` shows the "No agents on this project yet." empty state when `items` is empty.

### US-006: Web assignee picker and disabled-member badge (`Workdir: apps/web`)

1. [unit] `AssigneePicker` requests `GET /projects/:slug/assignees?q=<text>` once, 200 ms after the user stops typing.
2. [unit] `AssigneePicker` renders user items under a "People" heading and agent items under an "Agents" heading, with a "(paused)" tag on an agent item whose `status` is `PAUSED`.
3. [unit] Choosing a user item in `AssigneePicker` inside `TicketProperties` posts `{ userId: <id> }` to `/projects/:slug/tickets/:ref/assign` and emits `changed`.
4. [unit] Choosing an agent item in `AssigneePicker` inside `TicketProperties` posts `{ agentId: <id> }` to `/projects/:slug/tickets/:ref/assign` and emits `changed`.
5. [unit] When the assign request returns 409, `TicketProperties` shows the error through `extractApiError` and does not emit `changed`.
6. [unit] `TicketProperties` no longer renders the free-text user-id assign input.
7. [unit] `ProjectMembersPanel` renders the "Disabled" badge for a member whose `disabled` is true.
8. [unit] `ProjectMembersPanel` hides the role select for a disabled member even when the viewer can manage members.
9. [unit] `ProjectMembersPanel` renders no "Disabled" badge for a member whose `disabled` is false.
