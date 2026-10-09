# SPEC: Fleet S4c — Team Access (Per-Project Agents, Disabled-User Guard)

## Summary

An agent (an API-key actor, `Agent` model) gets an explicit per-project roster, `AgentProject`. With the new
`AGENT_PROJECT_SCOPING` flag on (the default), an agent reaches only projects it is on: every project route and the
cross-project agent paths enforce it through `ProjectAccessService.resolveMembership`. A migration backfills the
roster from each agent's ticket and comment history so nothing breaks on deploy. Project admins manage the roster
through `GET/POST/DELETE /projects/:slug/agents`, the CLI and the web agents page. Ticket assignment refuses disabled
users and agents not on the roster, a new `GET /projects/:slug/assignees` feeds a web assignee picker, adding a
disabled user as a member is refused, and the members panel marks disabled members.

## Motivation

- Agents bypass project scoping entirely: `ProjectAccessService.resolveMembership` returns `null` for every non-user
  principal (`apps/api/src/projects/project-access.service.ts:28`), so any agent key reads and writes every project,
  and `ProjectsService.findAllForPrincipal` lists every project to an agent (`projects.service.ts:79-87`).
- `GET /projects/:slug/agents` lists agents that happen to have tickets assigned in the project
  (`PrismaAgentRepository.findByProjectSlug`), so a project has no real agent roster (GitHub issue #61).
- `TicketsService.assign` accepts any existing agent for any project and does not check `User.disabled`
  (`tickets.service.ts:318-375`); `ProjectMembersService.add` adds a disabled user (`project-members.service.ts:46-57`),
  while the S4b invite path already refuses one.
- The web assigns a ticket through a free-text user-id input (`TicketProperties.vue:157-172`), and the members panel
  cannot show a disabled member because `ProjectMemberDto` drops the `disabled` flag
  (`members/dto/project-member.dto.ts:4-14`).

## Design

### Rulings that bind every story (user, 2026-10-09)

- D527: the migration backfills `AgentProject` from history; access is explicit afterwards.
- D528: `AGENT_PROJECT_SCOPING=on|off`, default `on`. `off` restores pre-S4c agent **reach** exactly
  (`resolveMembership`, `GET /projects`, pickup). The roster, its routes, the assign and member-add guards (including
  the agent-roster check on assign) and the assignees endpoint apply in both modes.
- D529: a roster row grants access only. An agent's permissions inside a project still come from its global
  `AgentRoleEntry` roles via `KodaCaslAbilityFactory.agentPermissions`; there is no per-project agent role.
- D530: project ADMIN and global ADMIN change a project's roster; any project member (or rostered agent) reads it.
- D531: removing an agent with open tickets in the project is refused (409).
- D533: scoping covers cross-project paths too (`GET /projects`, pickup), not only `/projects/:slug` routes.
- D534: enforcement is central in `ProjectAccessService.resolveMembership`.
- Wiring rule (this spec): no existing constructor gains a parameter except `ProjectAccessService`, whose new
  parameter is `@Optional()`. Roster reads and writes go through existing collaborators (`PrismaProjectRepository`,
  `PrismaAgentRepository`, the tickets repository) so existing DI-compiling test suites keep resolving.

### Integration

This feature changes the symbols below. Baselines exist only to locate the code; they are never the interface to
implement.

**`authConfig` / `IAuthConfig`** — `apps/api/src/config/auth.config.ts` (US-001)
- Target: `IAuthConfig` gains `agentProjectScoping?: boolean`; `AuthConfigSchema` gains `AGENT_PROJECT_SCOPING?:
  'on' | 'off'` (`@IsOptional() @IsIn(['on', 'off'])`); the factory sets `agentProjectScoping =
  AGENT_PROJECT_SCOPING !== 'off'`. `env.validation.ts` gains `AGENT_PROJECT_SCOPING: Joi.string().valid('on',
  'off').default('on')`. Every reader treats an absent `agentProjectScoping` (or an absent config) as `true`.

**`ProjectAccessService`** — `apps/api/src/projects/project-access.service.ts` (US-001)
- Baseline: `constructor(private projectRepo: PrismaProjectRepository)`; `resolveMembership(projectId, principal):
  Promise<string | null>` returns `null` for any non-user principal without a query.
- Target: `constructor(private projectRepo: PrismaProjectRepository, @Optional() @Inject(AUTH_CFG) private
  authConfig?: IAuthConfig)` (optional with a fail-closed default: absent config = scoping on; `@Optional()` is used because the dependency has a defined default, as `ProjectMembershipGuard` and `ProjectsService` already do for config-like dependencies, so unit suites that build the service with one argument keep compiling); new
  `agentScopingEnabled(): boolean` returns `this.authConfig?.agentProjectScoping !== false`. `resolveMembership` is
  unchanged for users and for runner principals; for an agent principal (`isAgentPrincipal`) it returns `null` without a
  query when `agentScopingEnabled()` is false, returns `null` when `projectRepo.isAgentOnRoster(projectId,
  principal.id)` resolves true, and otherwise throws `ForbiddenAppException({}, 'projects')`. Its docblock and the
  `ProjectMembershipGuard` docblock say "agent: roster-checked, returns null".

**`PrismaProjectRepository`** (and `IProjectRepository` in `projects/domain/project.domain.ts`) (US-001)
- Target: new `isAgentOnRoster(projectId: string, agentId: string): Promise<boolean>` and `findAllForAgent(agentId:
  string): Promise<ProjectDomain[]>` (non-deleted projects with an `AgentProject` row for the agent, ordered like
  `findAll`).

**`ProjectsService.findAllForPrincipal`** — `apps/api/src/projects/projects.service.ts:79` (US-001)
- Baseline: agents and global admins get `projectRepo.findAll()`.
- Target: a global admin gets `findAll()`; an agent gets `findAll()` when `access.agentScopingEnabled()` is false,
  else `projectRepo.findAllForAgent(principal.id)`. Constructor unchanged (it already holds `projectRepo` and `access`).

**`PrismaAgentRepository`** — `apps/api/src/agents/prisma-agent.repository.ts` (US-001 creates the first two, US-002
and US-003 the rest)
- Target: new methods `isOnProjectRoster(agentId, projectId): Promise<boolean>`; `findRosterProjects(agentId):
  Promise<{ slug: string; name: string }[]>`; `findProjectRoster(projectId): Promise<ProjectAgentRecord[]>`;
  `addToProjectRoster(agentId, projectId, addedById): Promise<void>` (maps the PK conflict to a typed result);
  `countOpenProjectTickets(agentId, projectId): Promise<{ count: number; refs: string[] }>` (`refs` capped at 10, oldest first);
  `removeFromProjectRoster(agentId, projectId): Promise<void>`; `lockProjectAgents(projectId): Promise<void>` (calls
  `lockProjectAgents` from `advisory-lock.ts` on the transaction client).

**`AgentsService`** — `apps/api/src/agents/agents.service.ts` (US-001, US-002, US-003)
- Baseline: `suggestTicket(agentSlug, projectSlug, principal)` (`:242`) checks the caller and the project only;
  `findMe(agentId): Promise<AgentResponseDto>` (`:170`).
- Target (constructor unchanged; it already holds `agentRepo`, `AUTH_CFG` and `TRANSACTION_MANAGER`):
  - US-001: `agentScopingEnabled(): boolean` (same rule as `ProjectAccessService`); `suggestTicket`, after the
    existing caller gate and project lookup (unknown project stays 404 `agents`), throws `ForbiddenAppException({},
    'projects')` when scoping is on and the target agent is not on the project's roster; `findMe` returns
    `AgentMeResponseDto` = `AgentResponseDto` fields plus `projects: { slug, name }[]` from `findRosterProjects`
    (ordered by slug), in both modes.
  - US-002: `listProjectRoster(projectSlug): Promise<ProjectAgentListDto>`.
  - US-003: `addToProject(projectSlug, agentSlug, addedById): Promise<ProjectAgentDto>` and
    `removeFromProject(projectSlug, agentSlug): Promise<void>`; `removeFromProject` runs `lockProjectAgents` ->
    `countOpenProjectTickets` -> 409 or `removeFromProjectRoster` in one `txManager.run`.

**`ProjectsController`** — `apps/api/src/projects/projects.controller.ts` (US-002, US-003)
- Baseline: `getProjectAgents` (`:167`, no `@UseGuards`, inline `assertProjectMembership`) returns a bare
  `AgentResponseDto[]` from `agentsService.findByProject(slug)`; `updateProjectAgent` (`:183`,
  `@UseGuards(ProjectMembershipGuard)`) resolves its target through the same list.
- Target (constructor unchanged): US-002 — `getProjectAgents` keeps its membership assert and returns
  `agentsService.listProjectRoster(slug)`; `updateProjectAgent` resolves the target through the roster (404
  `projectAgents` when not on it), then keeps today's admin-or-self check and `agentsService.update`. US-003 — new
  handlers `addProjectAgent` (`POST :slug/agents`) and `removeProjectAgent` (`DELETE :slug/agents/:agentSlug`), both
  `@UseGuards(ProjectMembershipGuard)` with the project-ADMIN-or-global-ADMIN check used by `updateProjectAgent`.
  Generated CLI names: `projectsControllerAddProjectAgent`, `projectsControllerRemoveProjectAgent`.

**`ITicketRepository` / `PrismaTicketsRepository`** — `tickets/domain/ticket.domain.ts:132-133`,
`prisma-tickets.repository.ts:236-240` (US-004)
- Baseline: `findUserById(id): Promise<{ id: string; role: string } | null>`; `findAgentById(id): Promise<{ id:
  string } | null>`.
- Target: `findUserById` also selects `disabled: boolean`; `findAgentById` also selects `status: string`; new
  `isAgentOnProjectRoster(projectId, agentId): Promise<boolean>` and `lockProjectAgents(projectId): Promise<void>`.

**`TicketsService.assign`** — `apps/api/src/tickets/tickets.service.ts:318` (US-004)
- Baseline: lookups and checks run outside `txManager.run`; only the update and the ticket event run inside it.
- Target (constructor unchanged): lookups, checks and update run in one `txManager.run`. User path order: missing ->
  404 (today); `disabled` -> 409 `tickets.userDisabled`; not a member -> 403 (today; global ADMIN exempt). Agent path
  order: `ticketRepo.lockProjectAgents(projectId)`; missing -> 404 (today); not on the roster -> 409
  `tickets.agentNotInProject`; status `OFFLINE` -> 409 `tickets.agentOffline`. Applies in both flag modes (D528).

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
- `ProjectInvitesModule` (`projects/invites/project-invites.module.ts`, imported by `app.module.ts:129`) — pattern for
  the new standalone `ProjectAssigneesModule`.
- The comment "Agents qualify as today" in `memory/memory.controller.ts:38` is updated to say agents need a roster row.

### New data (US-001)

Schema edit in `apps/api/prisma/schema.prisma` (integration suites build the schema with `prisma db push`), plus migration
`apps/api/prisma/migrations/20261011090000_agent_projects/migration.sql`:

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

Soft-deleted tickets count as history. `addedById` stays NULL for backfilled rows. The backfill test follows
`test/integration/notifications/notifications-backfill-migration.integration.spec.ts` (`scratchSchemaBefore`,
`applyMigration` from `test/helpers/migration-schema.ts`).

The three roster checks (`PrismaProjectRepository.isAgentOnRoster`, `PrismaAgentRepository.isOnProjectRoster`,
`PrismaTicketsRepository.isAgentOnProjectRoster`) all run the same query: an `AgentProject` row exists for the
(agentId, projectId) pair.

### Roster DTOs (US-002)

`apps/api/src/agents/dto/project-agent.dto.ts`:
- `ProjectAgentDto { slug, name, status, roles: string[], capabilities: string[], openTicketCount: number,
  openTicketRefs: string[], addedAt: string, addedBy: { id: string; name: string | null } | null }`.
- `ProjectAgentListDto { scoping: boolean; items: ProjectAgentDto[] }`, items ordered by name, un-paged (a documented
  exception to `KodaPageQuery`).
- Open = tickets in this project assigned to the agent, `deletedAt` null, status not `CLOSED` or `REJECTED`.
  `openTicketRefs` holds up to 10 refs built as `<Project.key>-<Ticket.number>`, oldest `createdAt` first, from one
  grouped query per list call.

### Concurrency (US-003, US-004)

`advisory-lock.ts` gains `KODA_LOCK_CLASS.PROJECT_AGENTS = 72402` and `lockProjectAgents(db, projectId)`, same shape as
`lockProjectMembers`. `AgentsService.removeFromProject` and the agent path of `TicketsService.assign` both take it
first inside their transaction, so a remove and an agent-assign on the same project serialize and a ticket never ends
up assigned to an agent removed from its project.

### API

| Route | Who | Behaviour | Story |
|---|---|---|---|
| `GET /projects/:slug/agents` | project member, rostered agent (scoping on; any agent when off) (403 otherwise) | `ProjectAgentListDto` | US-002 |
| `PATCH /projects/:slug/agents/:agentSlug` | unchanged (admins, or the agent itself) | resolves through the roster; 404 `projectAgents` when not on it | US-002 |
| `POST /projects/:slug/agents` `{ agentSlug }` | project ADMIN, global ADMIN (403 otherwise) | 201 `ProjectAgentDto`; 404 `agents` unknown agent; 409 `projectAgents.alreadyAssigned`; 409 `projectAgents.agentOffline` | US-003 |
| `DELETE /projects/:slug/agents/:agentSlug` | project ADMIN, global ADMIN (403 otherwise) | 204; 404 `projectAgents` not on roster; 409 `projectAgents.hasOpenTickets`, message args `{ count, refs }` (`refs` = up to 10 refs joined with `, `) | US-003 |
| `GET /projects/:slug/assignees?q=&limit=` | project member, rostered agent (scoping on; any agent when off) (`ProjectMembershipGuard`; 403 otherwise) | `{ items: AssigneeDto[] }` (below) | US-004 |

`AssigneeDto { type: 'user' | 'agent'; id: string; name: string; secondary: string; status?: string }`: users are
non-disabled project members (`id` = `User.id`, `secondary` = email); agents are rostered agents with status `ACTIVE`
or `PAUSED` (`id` = `Agent.id`, `secondary` = slug, `status` set). Users come first, then agents, each ordered by
name. `q` is trimmed and matched case-insensitively as a substring of name, email (users) or slug (agents); `q`
longer than 100 characters is a 400 validation error. `limit` defaults to 20, applies to the combined list, and must
be an integer from 1 to 50 (400 otherwise). `%` and `_` in `q` match literally. The new repository extends
`AbstractPrismaRepository` and sits behind a symbol token the module does not export (rule api-data). The route lives in a new standalone `ProjectAssigneesModule` imported by
`AppModule`.

New i18n files `apps/api/src/i18n/{en,zh}/projectAgents.json` with `404`, `alreadyAssigned.409`, `agentOffline.409`,
`hasOpenTickets.409` (en: "{count} open tickets are still assigned to this agent: {refs}"). New keys
`members.userDisabled.409`, `tickets.userDisabled.409`, `tickets.agentNotInProject.409`, `tickets.agentOffline.409` in
both locales.

Integration ACs that need `AGENT_PROJECT_SCOPING=off` boot through `bootHttpApp` (`test/helpers/http-app.ts`), which
US-001 extends with an optional `agentProjectScoping?: 'on' | 'off'` set only around `AppFactory.create` and restored
afterwards, exactly like `registrationEnabled`.

Each API story regenerates the committed contract with `bun run generate` (`openapi.json` and
`apps/cli/src/generated/`); those generated files are never hand-edited.

### CLI Behavior (US-005)

Subcommands of `koda project`, each taking `--project <slug>` resolved through `withContext({ projectSlug })` like
`member.ts`, and `--json`:
- `koda project agents` — calls `projectsControllerGetProjectAgents`; stdout: table `Slug | Name | Status | Open
  tickets` (or the `ProjectAgentListDto` JSON); when `scoping` is false, stderr note "Agent scoping is off on this
  server".
- `koda project agent-add <agentSlug>` — calls `projectsControllerAddProjectAgent`; stdout `Added <agentSlug> to
  <project>` (or the `ProjectAgentDto` JSON).
- `koda project agent-remove <agentSlug>` — calls `projectsControllerRemoveProjectAgent`; stdout `Removed <agentSlug>
  from <project>`.
- Exit 0 success; exit 1 API/network error with the API's translated message (including the 409 open-ticket refs) on
  stderr via `handleApiError`; exit 2 config/auth error.

### Web (US-006, US-007)

- `pages/[project]/agents.vue` (US-006) reads `ProjectAgentListDto` through a new `useProjectAgents(slug)`
  composable. Table: name, slug, roles, capabilities, status, open tickets; project admins also see added by/at and a
  Remove button. "Add agent" (project admins) opens `AddProjectAgentDialog.vue`, which lists `GET /agents` minus the
  roster minus `OFFLINE` agents and posts `{ agentSlug }`. Remove asks for confirmation; a row with
  `openTicketCount > 0` shows "Reassign its N open tickets first" with `openTicketRefs` as ticket links instead of
  sending `DELETE`. When `scoping` is false the page shows an info note. Empty state "No agents on this project yet."
  The pause/resume control stays.
- `AssigneePicker.vue` (US-007): combobox over `GET /projects/:slug/assignees?q=` (200 ms debounce), "People" and
  "Agents" groups, "(paused)" tag; choosing posts `{ userId }` or `{ agentId }` to
  `/projects/:slug/tickets/:ref/assign`. It replaces the free-text input in `TicketProperties.vue`; the
  current-assignee display and Unassign stay.
- `ProjectMembersPanel.vue` (US-007): a "Disabled" badge and no role select for a member whose `disabled` is true;
  the `ProjectMember` type in `useProjectMembers.ts` gains `disabled: boolean`.
- All strings via `t(...)` in `apps/web/i18n/locales/{en,zh}.json`; API errors via `extractApiError`.

### Failure Handling

| Failure | Behaviour | Owner |
|---|---|---|
| `AGENT_PROJECT_SCOPING` set to a value other than `on`/`off` | API startup fails validation naming the variable | US-001 |
| Roster lookup throws (database error) | `resolveMembership` rejects with that error (fail-closed, never falls back to allow) | US-001 |
| Add an unknown / `OFFLINE` / already-rostered agent | 404 `agents` / 409 `projectAgents.agentOffline` / 409 `projectAgents.alreadyAssigned` | US-003 |
| Remove an agent with open tickets / not on roster | 409 `projectAgents.hasOpenTickets` / 404 `projectAgents`; roster unchanged | US-003 |
| Add a disabled user as a member | 409 `members.userDisabled`; no membership row | US-003 |
| Assign a disabled user / off-roster agent / `OFFLINE` agent | 409 `tickets.userDisabled` / `tickets.agentNotInProject` / `tickets.agentOffline`; ticket unchanged | US-004 |
| CLI command gets an API error | exit 1, translated message on stderr | US-005 |
| Web add / remove / assign gets an API error | toast via `extractApiError` | US-006, US-007 |

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
- US-001 only: agent permissions inside a rostered project are unchanged; `assertProjectRoles` and `assertProjectPermission` keep their agent behaviour.
- US-004 only: no ACs pin `limit=0` or non-integer `limit`, whitespace-only `q`, the email branch of `q`, or literal matching of `%`/`_`; the Design states that behaviour and the hardening pass may suggest tests.
- US-004 only: a user disabled concurrently with an assign to that user is best-effort (no lock); the disabled check reads the row inside the assign transaction.

## Stories

1. **US-001: Agent roster store, scoping flag and enforcement** — `Workdir: apps/api` — no dependencies.
2. **US-002: Project agent roster read and status routes** — `Workdir: apps/api` — depends on US-001.
3. **US-003: Roster add/remove and member-add guard** — `Workdir: apps/api` — depends on US-002.
4. **US-004: Assign guards and assignees endpoint** — `Workdir: apps/api` — depends on US-003 (shares the
   `lockProjectAgents` lock with the remove path).
5. **US-005: CLI project agent commands** — `Workdir: apps/cli` — depends on US-003.
6. **US-006: Web project agents page** — `Workdir: apps/web` — depends on US-003.
7. **US-007: Web assignee picker and disabled-member badge** — `Workdir: apps/web` — depends on US-004.

### Context Files

> Existing files to read, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/projects/project-access.service.ts` — `resolveMembership`, changed here
- `apps/api/src/projects/prisma-project.repository.ts` — gains the roster queries
- `apps/api/src/config/auth.config.ts` — gains `agentProjectScoping`
- `apps/api/src/agents/agents.service.ts` — `suggestTicket` and `findMe`, changed here
- `apps/api/src/projects/projects.service.ts` — `findAllForPrincipal`, changed here

**US-002**

- `apps/api/src/projects/projects.controller.ts` — `getProjectAgents` / `updateProjectAgent`, changed here
- `apps/api/src/agents/prisma-agent.repository.ts` — gains the roster list query (US-001 added the first roster methods)
- `apps/api/src/agents/dto/agent-response.dto.ts` — DTO style to mirror
- `apps/api/test/integration/projects/project-members.integration.spec.ts` — HTTP-on-PG test pattern

**US-003**

- `apps/api/src/projects/projects.controller.ts` — gains the add/remove handlers
- `apps/api/src/common/utils/advisory-lock.ts` — `lockProjectMembers` pattern for `lockProjectAgents`
- `apps/api/src/projects/members/project-members.service.ts` — `add`, changed here
- `apps/api/src/projects/members/prisma-project-members.repository.ts` — `findUserIdByEmail`, replaced here
- `apps/api/src/projects/members/dto/project-member.dto.ts` — gains `disabled`

**US-004**

- `apps/api/src/tickets/tickets.service.ts` — `assign`, changed here
- `apps/api/src/tickets/prisma-tickets.repository.ts` — gains the roster check and lock
- `apps/api/src/projects/invites/project-invites.module.ts` — standalone module pattern to mirror
- `apps/api/src/projects/members/project-members.controller.ts` — controller + Swagger decorator pattern

**US-005**

- `apps/cli/src/commands/project.ts` — the `project` command group extended here
- `apps/cli/src/commands/member.ts` — `--project` + `withContext` + `table` + `--json` pattern to mirror
- `apps/cli/src/commands/project.spec.ts` — command test pattern (mocked generated client)
- `apps/cli/src/utils/error.ts` — `handleApiError`

**US-006**

- `apps/web/pages/[project]/agents.vue` — the page reworked here
- `apps/web/tests/pages/agents.spec.ts` — the page's existing test harness
- `apps/web/components/ProjectInvitesPanel.vue` — admin dialog + list pattern to mirror
- `apps/web/composables/useProjectMembers.ts` — composable pattern to mirror
- `apps/web/composables/useProjectViewerRole.ts` — viewer project role for the admin-only controls

**US-007**

- `apps/web/components/TicketProperties.vue` — assign section changed here
- `apps/web/components/ProjectMembersPanel.vue` — gains the disabled badge
- `apps/web/composables/useProjectMembers.ts` — `ProjectMember` type gains `disabled`
- `apps/web/tests/components/ProjectMembersPanel.spec.ts` — component test pattern

### Creates

> New files each story authors.

**US-001**

- `apps/api/prisma/migrations/20261011090000_agent_projects/migration.sql` — `AgentProject` table + backfill
- `apps/api/src/agents/dto/agent-me-response.dto.ts` — `AgentMeResponseDto`
- `apps/api/test/integration/projects/agent-project-scoping.integration.spec.ts` — scoping over HTTP on PG
- `apps/api/test/integration/projects/agent-projects-backfill.integration.spec.ts` — backfill statement on PG

**US-002**

- `apps/api/src/agents/dto/project-agent.dto.ts` — `ProjectAgentDto`, `ProjectAgentListDto`
- `apps/api/src/i18n/en/projectAgents.json` — roster error messages
- `apps/api/src/i18n/zh/projectAgents.json` — roster error messages (zh)
- `apps/api/test/integration/projects/project-agents-read.integration.spec.ts` — read and status routes on PG

**US-003**

- `apps/api/src/agents/dto/add-project-agent.dto.ts` — `AddProjectAgentDto { agentSlug }`
- `apps/api/test/integration/projects/project-agents-write.integration.spec.ts` — add/remove and member guard on PG

**US-004**

- `apps/api/src/projects/assignees/project-assignees.module.ts` — `ProjectAssigneesModule`
- `apps/api/src/projects/assignees/project-assignees.controller.ts` — `ProjectAssigneesController`
- `apps/api/src/projects/assignees/project-assignees.service.ts` — `ProjectAssigneesService.search`
- `apps/api/src/projects/assignees/prisma-project-assignees.repository.ts` — module-private queries
- `apps/api/src/projects/assignees/dto/assignee.dto.ts` — `AssigneeDto`, `AssigneeListDto`, `AssigneeQuery`
- `apps/api/test/integration/tickets/ticket-assign-guards.integration.spec.ts` — assign guards + lock on PG
- `apps/api/test/integration/projects/project-assignees.integration.spec.ts` — assignees over HTTP on PG

**US-006**

- `apps/web/composables/useProjectAgents.ts` — `useProjectAgents(slug)`: list, add, remove
- `apps/web/components/AddProjectAgentDialog.vue` — add-agent dialog
- `apps/web/tests/components/AddProjectAgentDialog.spec.ts` — dialog behaviour

**US-007**

- `apps/web/components/AssigneePicker.vue` — assignee combobox
- `apps/web/tests/components/AssigneePicker.spec.ts` — picker behaviour

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — gains the AgentProject model and the Agent.projects, Project.agents and User.addedAgentProjects back-relations; integration suites build their schema from this file.
- `apps/api/test/helpers/http-app.ts` — bootHttpApp accepts only registrationEnabled. Replacing invariant: it also accepts an optional agentProjectScoping ('on' | 'off'), set in process.env only around AppFactory.create and restored in finally; omitting it leaves the default (on).
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — beforeAll (`:68-79`) seeds an agent associated with project web only through an assigned ticket, then asserts GET /api/projects/web/agents with the agent key returns 200; with scoping on that is 403 and the suite fails in setup. Replacing invariant: insert the agent's AgentProject row for project web right after seedFleetHttpAgent (before `:78`); the comment at `:71` is updated to say the roster row is the association.
- `apps/api/src/projects/project-access.service.spec.ts` — "passes without checking membership for agent principal" (`:62`) and "returns null for an agent without a membership lookup" (`:97`) assume an unscoped agent; with no config injected scoping is on. Replacing invariant: a rostered agent resolves null, an unrostered agent rejects with ForbiddenAppException, and with agentProjectScoping false an agent resolves null without a roster lookup.
- `apps/api/src/projects/project-membership.guard.spec.ts` — "AC3: returns true for an agent principal without a membership lookup" (`:195`) and "AC15: returns true for an agent principal on a handler carrying @ProjectRoles" (`:295`) assume an unscoped agent. Replacing invariant: the guard admits a rostered agent and rejects an unrostered one with 403.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — "AC8 boundary: an agent principal is admitted to POST :ref/assign with no membership row" (`:266`) expects 200 for an agent with no roster row. Replacing invariant: admitted when the agent has a roster row (still no ProjectMember row).
- `apps/api/src/projects/projects.service.spec.ts` — "passes without checking membership for agent principal" (`:196`) assumes an unscoped agent. Replacing invariant: a rostered agent passes, an unrostered agent is rejected.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — "AC8: returns every non-deleted project for an agent principal" (`:206`) expects all projects. Replacing invariant: with scoping on an agent gets only its rostered non-deleted projects; with agentProjectScoping false it gets every non-deleted project.
- `apps/api/src/agents/agents.service.spec.ts` — the findMe test (`:408-413`) asserts toEqual(mockAgentDto), which now also carries projects; the suggestTicket tests (`:673-800`) use an agentRepo mock without the roster method. Replacing invariant: findMe returns the agent fields plus projects; suggestTicket behaves as before for a rostered target.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — the agentRepo stub (`~:118`) lacks the roster method and the AC9 (`~:178-198`) and AC12 (`~:230`) 200 paths have no roster row. Replacing invariant: those paths return 200 when the target agent is rostered.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — beforeAll (`:237-248`) has agent team-bot act on team and other with no roster row; "AC8: findAllForPrincipal returns every non-deleted project for an agent principal" (`:284`) and "AC3: CommentsService.update proceeds to the CASL check" (`:349`) assume unscoped agents. Replacing invariant: seed AgentProject rows for team and other immediately after the agent is created and before the assign at `:244`; findAllForPrincipal returns only rostered projects.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the agent created at `:226-246` acts on its project with agentApiKey (`:515`, `:737`, `:1259`, `:1635`, `:1650`, `~:2395`) with no roster row, and "GET /api/agents/:slug/pickup — returns null data when no VERIFIED unassigned tickets remain" (`:1586-1612`) creates a fresh agent pickup-empty-agent and calls pickup on the project. Replacing invariant: insert an AgentProject row for every (agent, project) pair a test acts on — the main agent right after it is created, pickup-empty-agent right after its creation; the existing expectations then hold unchanged.
- `apps/api/test/e2e/agents.e2e.spec.ts` — the pickup tests (`:221`, `:247-257`) call pickup for an agent not on the project's roster; the second creates a new project AEM and picks up there. Replacing invariant: insert an AgentProject row for each (agent, project) pair the test picks up on — the setup project in setup, and AEM right after it is created; expectations unchanged.
- `apps/api/test/e2e/ast-index.e2e.spec.ts` — "DEVELOPER agent should be able to call indexCommit" (`:235`) expects 201 for an unrostered agent. Replacing invariant: the agent is rostered on the project in setup; expectation unchanged.
- `apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts` — the agent case of "%s reads every code-intel route" (`:74`, agent created `:42`) expects 200 with no roster row. Replacing invariant: insert the agent's AgentProject row in setup; expectation unchanged.

**US-002**

- `apps/api/src/projects/projects.controller.spec.ts` — describe getProjectAgents (`:261-316`) mocks agentsService.findByProject and asserts a bare array (data[0].slug); describe updateProjectAgent (`:318-~400`) mocks findByProject to resolve the target. Replacing invariant: getProjectAgents returns the ProjectAgentListDto from agentsService.listProjectRoster; updateProjectAgent resolves the target through the roster.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — "GET /api/projects/:slug/agents — 200 returns agents with assigned tickets" (`:1319`) asserts Array.isArray(data); "PATCH .../agents/:agentSlug — 200 updates agent status" (`:1346`). Replacing invariant: data.items contains the rostered agent; PATCH succeeds for a rostered agent.
- `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts` — beforeAll (`:78-79`) maps the GET /api/projects/web/agents body as an array. Replacing invariant: read data.items and assert it contains the agent.
- `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` — the matrix case for the PATCH agent-status route (`:575`) resolves the target through the old ticket-derived list. Replacing invariant: the target is resolved through the roster.

**US-003**

- `apps/api/src/projects/members/project-members.service.spec.ts` — "add: unknown email is 404, duplicate member is 409" (`:78`) mocks findUserIdByEmail, which is replaced by findUserByEmail. Replacing invariant: unknown email 404, duplicate 409, disabled user 409 members.userDisabled.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the endpoint lifecycle suite must cover every endpoint (rule api-testing); this story adds the POST and DELETE roster cases (happy path plus one error each). Existing expectations unchanged.

**US-004**

- `apps/api/src/tickets/tickets.service.spec.ts` — "should assign ticket to agent" (`~:1008`) resolves findAgentById to an object without status and the ticketRepo mock lacks isAgentOnProjectRoster and lockProjectAgents. Replacing invariant: assigning a rostered ACTIVE agent sets assignedToAgentId; an unrostered agent is refused with 409.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — "POST .../assign — assigns ticket to agent" (`:1196`) passes once the agent is rostered (US-001 setup); this story adds the assignees route cases (happy path plus one error). Existing expectations unchanged.

**US-005**

None. The story only adds subcommands to `project.ts` and new cases to `project.spec.ts`; no existing CLI test asserts on the project agents routes.

**US-006**

- `apps/web/tests/pages/agents.spec.ts` — pins the page's fetch and columns (`:39` path pattern, `:71` capabilities column, `:110` capabilities badges, `:207` patch path) against a bare-array response. Replacing invariant: the page fetches the project agents route, renders the items of the ProjectAgentListDto (capabilities column kept) and patches status at the per-agent route.

**US-007**

None. No existing web test pins the free-text assign input (`assigneeUserId`, `tickets.assign.userIdPlaceholder`); `tests/openapi/web-gap-ops.spec.ts:41-47` checks that the `TicketProperties.vue` source still contains the assign URL literal, which stays because Unassign keeps posting to it.

### Seams

- SEAM-1 (US-001 -> US-004): `PrismaTicketsRepository.isAgentOnProjectRoster` reads the `AgentProject` table US-001 creates; US-004 ACs exercise it through `POST /api/projects/:slug/tickets/:ref/assign`.
- SEAM-2 (US-003 -> US-005, US-006): the add/remove routes are consumed by the CLI (generated client) and the web page; US-005 ACs assert the generated functions are called with the slug and body, US-006 ACs assert the request path and body.
- SEAM-3 (US-004 -> US-007): `GET /projects/:slug/assignees` and the assign route are consumed by `AssigneePicker` inside `TicketProperties`.
- SEAM-4 (US-003 -> US-007): `ProjectMemberDto.disabled` is consumed by `ProjectMembersPanel`.

## Acceptance Criteria

### US-001: Agent roster store, scoping flag and enforcement (`Workdir: apps/api`)

1. [unit] `authConfig()` with `AGENT_PROJECT_SCOPING` unset returns `agentProjectScoping: true`.
2. [unit] `authConfig()` with `AGENT_PROJECT_SCOPING=maybe` throws a validation error naming `AGENT_PROJECT_SCOPING`.
3. [integration] Running the `20261011090000_agent_projects` migration's `INSERT INTO "AgentProject"` backfill over a database where agent A is assigned a ticket in project P1, agent A wrote a comment on a soft-deleted ticket in P2, and agent B created a ticket in P1 yields exactly the rows (A, P1), (A, P2), (B, P1), each with `addedById` null.
4. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` resolves `null` when `PrismaProjectRepository.isAgentOnRoster(projectId, agentId)` resolves true and no auth config is injected.
5. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` rejects with `ForbiddenAppException` (prefix `projects`) when `isAgentOnRoster` resolves false and no auth config is injected.
6. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` resolves `null` without calling `isAgentOnRoster` when the injected auth config has `agentProjectScoping: false`.
7. [unit] `ProjectAccessService.resolveMembership(projectId, runnerPrincipal)` resolves `null` without calling `isAgentOnRoster`.
8. [unit] `ProjectAccessService.resolveMembership(projectId, agentPrincipal)` rejects with the database error when `isAgentOnRoster` rejects with it.
9. [integration] With scoping on, `GET /api/projects/:slug/tickets` with an agent API key returns 403 when the agent has no `AgentProject` row for the project.
10. [integration] With scoping on, `GET /api/projects/:slug/tickets` with an agent API key returns 200 after an `AgentProject` row for that agent and project is inserted.
11. [integration] With scoping on, `GET /api/projects` with an agent API key returns only the non-deleted projects the agent has `AgentProject` rows for.
12. [integration] With `AGENT_PROJECT_SCOPING=off`, `GET /api/projects` with an agent API key returns every non-deleted project.
13. [integration] With scoping on, `GET /api/agents/:slug/pickup?project=<slug>` called by a global ADMIN returns 403 when the target agent has no `AgentProject` row for that project.
14. [integration] With `AGENT_PROJECT_SCOPING=off`, `GET /api/agents/:slug/pickup?project=<slug>` called by a global ADMIN returns 200 for a target agent with no `AgentProject` row.
15. [integration] `GET /api/agents/me` with an agent API key returns `projects` listing `{ slug, name }` for each non-deleted project on the agent's roster, ordered by slug.

### US-002: Project agent roster read and status routes (`Workdir: apps/api`)

1. [integration] `GET /api/projects/:slug/agents` by a project member returns `scoping: true` and `items` including a rostered agent that has no tickets in the project.
2. [integration] `GET /api/projects/:slug/agents` returns each item with the agent's `roles`, `capabilities`, `status`, `addedAt`, and `addedBy` set to the adding user's `{ id, name }`.
3. [integration] `GET /api/projects/:slug/agents` returns `addedBy: null` for a backfilled row whose `addedById` is null.
4. [integration] `GET /api/projects/:slug/agents` excludes an agent that has tickets assigned in the project but no `AgentProject` row.
5. [integration] For a rostered agent with tickets in statuses `CREATED`, `IN_PROGRESS`, `CLOSED`, `REJECTED` and one soft-deleted `CREATED` ticket, the item has `openTicketCount` 2 and `openTicketRefs` holding those two refs as `<Project.key>-<number>`, oldest first.
6. [integration] `openTicketRefs` holds 10 refs when a rostered agent has 12 open tickets in the project, while `openTicketCount` is 12.
7. [integration] `GET /api/projects/:slug/agents` by a user who is not a project member returns 403.
8. [integration] With scoping on, `GET /api/projects/:slug/agents` with the API key of an agent not on that project's roster returns 403.
9. [integration] `GET /api/projects/:slug/agents` with `AGENT_PROJECT_SCOPING=off` returns `scoping: false`.
10. [integration] `PATCH /api/projects/:slug/agents/:agentSlug` with `{ status: 'PAUSED' }` by a project ADMIN returns 200 for a rostered agent that has no tickets.
11. [integration] `PATCH /api/projects/:slug/agents/:agentSlug` by a project ADMIN returns 404 for an unrostered agent that has tickets assigned in the project.
12. [integration] With scoping on, `PATCH /api/projects/:slug/agents/:agentSlug` with the target agent's own API key returns 403 when that agent is not on the project's roster.

### US-003: Roster add/remove and member-add guard (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/agents` with `{ agentSlug }` by a project ADMIN returns 201 with the `ProjectAgentDto` and stores the row with `addedById` = that admin.
2. [integration] `POST /api/projects/:slug/agents` by a global ADMIN who is not a project member returns 201.
3. [integration] `POST /api/projects/:slug/agents` by a project DEVELOPER returns 403 and stores no row.
4. [integration] `POST /api/projects/:slug/agents` for an agent already on the roster returns 409 with the `projectAgents.alreadyAssigned` message.
5. [integration] `POST /api/projects/:slug/agents` for an agent whose status is `OFFLINE` returns 409 with the `projectAgents.agentOffline` message.
6. [integration] `POST /api/projects/:slug/agents` with an unknown `agentSlug` returns 404.
7. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for a rostered agent with 2 open tickets returns 409 whose message contains `2` and both ticket refs, and the `AgentProject` row remains.
8. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for a rostered agent with no open tickets returns 204 and deletes its `AgentProject` row.
9. [integration] After `DELETE /api/projects/:slug/agents/:agentSlug` returns 204, that agent's next `GET /api/projects/:slug/tickets` with its API key returns 403.
10. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` for an agent not on the roster returns 404.
11. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` by a project DEVELOPER returns 403 and the `AgentProject` row remains.
12. [integration] `POST /api/projects/:slug/agents` with `{ agentSlug }` using the API key of an agent already on that project's roster returns 403 and stores no row.
13. [integration] `DELETE /api/projects/:slug/agents/:agentSlug` using the API key of that rostered agent itself returns 403 and the `AgentProject` row remains.
14. [integration] `POST /api/projects/:slug/members` with the email of a disabled user returns 409 with the `members.userDisabled` message and creates no membership row.
15. [integration] `GET /api/projects/:slug/members` returns `disabled: true` for a member whose user account is disabled and `disabled: false` for an enabled member.

### US-004: Assign guards and assignees endpoint (`Workdir: apps/api`)

1. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ userId }` of a disabled user who is not a project member returns 409 with the `tickets.userDisabled` message and leaves the ticket unassigned.
2. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of an agent that is not on the project's roster and has status `OFFLINE` returns 409 with the `tickets.agentNotInProject` message.
3. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of a rostered agent whose status is `OFFLINE` returns 409 with the `tickets.agentOffline` message.
4. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of a rostered `ACTIVE` agent returns 200 and sets `assignedToAgentId`.
5. [integration] With `AGENT_PROJECT_SCOPING=off`, `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId }` of an unrostered agent still returns 409 with the `tickets.agentNotInProject` message.
6. [integration] For a rostered agent holding no open tickets in the project, running `DELETE /api/projects/:slug/agents/:agentSlug` and `POST /api/projects/:slug/tickets/:ref/assign` with that agent's `agentId` concurrently on PG ends in exactly one of: DELETE 204 with the assign 409 `tickets.agentNotInProject`, or the assign 200 with the DELETE 409 `projectAgents.hasOpenTickets`.
7. [integration] `GET /api/projects/:slug/assignees` lists non-disabled project members as `type: 'user'` with `id` = the user id and `secondary` = email, and omits a disabled member.
8. [integration] `GET /api/projects/:slug/assignees` lists rostered `ACTIVE` and `PAUSED` agents as `type: 'agent'` with `id` = the agent id, `secondary` = slug and `status` set, and omits an `OFFLINE` rostered agent.
9. [integration] `GET /api/projects/:slug/assignees` omits an agent that is not on the project's roster.
10. [integration] `GET /api/projects/:slug/assignees` returns all users before all agents, each group ordered by name.
11. [integration] `GET /api/projects/:slug/assignees?q=ALI` matches a member named "Alice" and an agent with slug `alias-bot`, case-insensitively.
12. [integration] `GET /api/projects/:slug/assignees?limit=2` returns 2 items when 3 users and 2 agents match.
13. [integration] `GET /api/projects/:slug/assignees?limit=51` returns 400.
14. [integration] `GET /api/projects/:slug/assignees` with a `q` of 101 characters returns 400.
15. [integration] `GET /api/projects/:slug/assignees` by a user who is not a project member returns 403.

### US-005: CLI project agent commands (`Workdir: apps/cli`)

1. [unit] `koda project agents --project alpha` calls `projectsControllerGetProjectAgents` with `path: { slug: 'alpha' }` and prints one table row per item with slug, name, status and open-ticket count.
2. [unit] `koda project agents --project alpha --json` prints the `{ scoping, items }` response as JSON.
3. [unit] `koda project agents` writes "Agent scoping is off on this server" to stderr when the response has `scoping: false`.
4. [unit] `koda project agent-add bot-1 --project alpha` calls `projectsControllerAddProjectAgent` with `path: { slug: 'alpha' }` and body `{ agentSlug: 'bot-1' }` and exits 0.
5. [unit] `koda project agent-remove bot-1 --project alpha` calls `projectsControllerRemoveProjectAgent` with `path: { slug: 'alpha', agentSlug: 'bot-1' }` and exits 0.
6. [unit] `koda project agent-remove bot-1 --project alpha` exits 1 and writes the API error message to stderr when the API responds 409.

### US-006: Web project agents page (`Workdir: apps/web`)

1. [unit] `pages/[project]/agents.vue` renders one row per entry of `items` from `GET /projects/:slug/agents`, showing name, slug, roles, capabilities, status and open-ticket count.
2. [unit] `pages/[project]/agents.vue` shows the "Add agent" button and the Remove buttons only when the viewer is a project ADMIN or global ADMIN.
3. [unit] `AddProjectAgentDialog` lists agents from `GET /agents` excluding agents already on the roster and agents whose status is `OFFLINE`.
4. [unit] Confirming `AddProjectAgentDialog` posts `{ agentSlug }` to `/projects/:slug/agents` and reloads the roster.
5. [unit] When the `POST /projects/:slug/agents` request fails, `AddProjectAgentDialog` shows the error via `extractApiError` and stays open.
6. [unit] Removing a roster row with `openTicketCount` 0 sends `DELETE /projects/:slug/agents/:agentSlug` after confirmation and reloads the roster.
7. [unit] Removing a roster row with `openTicketCount` 2 shows the "Reassign its 2 open tickets first" message with each `openTicketRefs` entry linked to its ticket page, and sends no `DELETE`.
8. [unit] When `DELETE /projects/:slug/agents/:agentSlug` returns 409, the page shows the error via `extractApiError` and reloads the roster.
9. [unit] `pages/[project]/agents.vue` shows the scoping-off info note when the response has `scoping: false`.
10. [unit] `pages/[project]/agents.vue` shows the "No agents on this project yet." empty state when `items` is empty.

### US-007: Web assignee picker and disabled-member badge (`Workdir: apps/web`)

1. [unit] `AssigneePicker` requests `GET /projects/:slug/assignees?q=<text>` once, 200 ms after the user stops typing.
2. [unit] `AssigneePicker` renders user items under a "People" heading and agent items under an "Agents" heading, with a "(paused)" tag on an agent item whose `status` is `PAUSED`.
3. [unit] Choosing a user item in `AssigneePicker` inside `TicketProperties` posts `{ userId: <id> }` to `/projects/:slug/tickets/:ref/assign` and emits `changed`.
4. [unit] Choosing an agent item in `AssigneePicker` inside `TicketProperties` posts `{ agentId: <id> }` to `/projects/:slug/tickets/:ref/assign` and emits `changed`.
5. [unit] When the assign request returns 409, `TicketProperties` shows the error through `extractApiError` and does not emit `changed`.
6. [unit] `TicketProperties` no longer renders the free-text user-id assign input.
7. [unit] `ProjectMembersPanel` renders the "Disabled" badge for a member whose `disabled` is true.
8. [unit] `ProjectMembersPanel` hides the role select for a disabled member even when the viewer can manage members.
9. [unit] `ProjectMembersPanel` renders no "Disabled" badge for a member whose `disabled` is false.
