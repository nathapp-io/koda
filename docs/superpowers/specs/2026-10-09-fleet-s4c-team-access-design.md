# Fleet S4c — Team Access (Per-Project Agents, Disabled-User Guard) — Design

Third and last part of fleet phase S4 ("team-ready koda", ruling S4-1). S4a (in-app notifications) and S4b (email +
project invites, PRs #245 #246) are merged and deployed on koda-wk (design doc §9.50).

- S4a: in-app notifications core. Done.
- S4b: email delivery + project invites. Done.
- **S4c (this spec): per-project agents (closes #61), disabled-user guard, assignee picker, members UI polish.**

## Goal

A koda agent (an API-key actor) reaches only the projects it has been put on, and a project admin manages that roster
without a global admin. Tickets can only be assigned to people and agents who can actually work on them, picked from a
list instead of typed as an id.

## Success criteria

1. An agent key that is not on project P gets 403 on every P route (tickets, comments, labels, context, code-intel,
   memory, pickup) and does not see P in `GET /projects`.
2. A project ADMIN (or global ADMIN) adds the agent to P from the web or CLI; the agent's next request to P succeeds.
3. After deploy, every existing agent can still reach every project it has history in (backfill), and nothing else.
4. Removing an agent that has open tickets in P fails with 409 and the agents page names the tickets; after
   reassigning them the removal succeeds. A concurrent assign cannot slip past a removal (roster row lock, §3.4).
5. The ticket assignee picker lists only active project members and the project's non-OFFLINE agents; the API refuses
   a disabled user (409 `tickets.userDisabled`) or an agent not on the project (409 `tickets.agentNotInProject`)
   either way.
6. Adding a disabled user as a member directly fails with 409 `members.userDisabled` (the invite path already does
   with `invites.userDisabled`).
7. With `AGENT_PROJECT_SCOPING=off`, agents reach every project as before S4c; roster, picker and guards still work.

## Rulings (user, 2026-10-09)

- D527: migration **backfills** `AgentProject` from history (S4c Q1 A); access is explicit afterwards.
- D528: `AGENT_PROJECT_SCOPING=on|off` env flag, default `on`; `off` restores pre-S4c global agent access (Q1 C).
- D529: an assignment grants **access only**; the agent's permissions inside a project still come from its global
  `AgentRoleEntry` roles via `KodaCaslAbilityFactory.agentPermissions` (Q2 A). No per-project agent role.
- D530: project ADMIN and global ADMIN manage a project's agent roster; any project member reads it. Agent CRUD and key
  rotation stay global-ADMIN-only (Q3 A).
- D531: removing an agent with open tickets in the project is refused with 409 `projectAgents.hasOpenTickets` (Q4 A).
- D532: UI scope = assignee picker, project agents page, disabled-member badge (Q5 A, B, C). No agents section on the
  members panel.
- D533: scoping covers cross-project paths too, not only `/projects/:slug` routes (Q6 A).
- D534: enforcement is central in `ProjectAccessService.resolveMembership` (approach 1).

## Ground truth (verified on main `daa3bc78`, 2026-10-09)

- `Agent` (`apps/api/prisma/schema.prisma:48-63`): `slug` unique, `apiKeyHash`, `status` ACTIVE | PAUSED | OFFLINE,
  roles via `AgentRoleEntry`, capabilities via `AgentCapabilityEntry`. No agent-project relation exists. `ProjectMember`
  is user-only (`schema.prisma:131-143`).
- Agent auth: `auth/guards/combined-auth.guard.ts:75-100` hashes a non-JWT bearer and looks up `apiKeyHash`; OFFLINE is
  rejected, PAUSED authenticates. `AgentPrincipal` (`auth/principal/koda-principal.types.ts:17-25`) has no project
  field and is cached 60 s with tags `AGENT:<id>` (`auth/agent-auth.provider.ts:41`).
- `ProjectAccessService.resolveMembership` (`projects/project-access.service.ts:27`) returns `null` for any non-user
  principal, so `ProjectMembershipGuard` lets every agent into every project; a non-member user gets 403
  `ForbiddenAppException({}, 'projects')`. `assertProjectRoles` returns early for non-users; `exemptAgents` skips the
  permission check for agents.
- Routes that gate through `resolveMembership` / `assertProjectMembership` (all fixed by D534): every `/projects/:slug/...`
  route, either via `ProjectMembershipGuard` or an inline assert (inline: `GET /projects/:slug/agents`
  projects.controller.ts:167-179, members list project-members.service.ts:39, memory-read memory-read.controller.ts:34,
  timeline timeline.controller.ts:23, ticket-links ticket-links.controller.ts:40, vcs vcs.controller.ts:82ff, live
  live.controller.ts:42), `context/:slug` (guard via `params.slug`), code-intel `symbols*` (`@ProjectSlugFrom('query',
  'projectSlug')`), `code-intel/index` (`checkProjectMembership`), `memory/*` (`assertWriteAuthorized` ->
  `assertProjectMembership`), `PATCH/DELETE comments/:id` (`assertCommentProjectMembership`, comments.service.ts:160).
- Routes that do NOT: `GET /projects` (`ProjectsService.findAllForPrincipal` returns all projects for agents,
  projects.service.ts:79-87); `GET /agents/:slug/pickup?project=` (agents.controller.ts:107;
  `AgentsService.suggestTicket` agents.service.ts:242-262 allows only the owning agent or a global ADMIN, never calls
  `resolveMembership`, unknown project -> 404 `agents`). User-only (not agent-reachable): `GET /home`, `me/events`,
  `projects/:slug/events`, `me/notifications*`, `fleet/activity`, `fleet/approval-counts`. Token-auth: webhook,
  ci-webhook, vcs-webhook, `fleet/runner/*`. Global-ADMIN-only: other `fleet/*`, `projects/:slug/ci-webhook-token`,
  `PATCH/DELETE /projects/:slug`.
- `ProjectContext.role` is documented "null for an agent" (`project-context.ts:6`, guard docblock); `'AGENT'` is
  also a legacy `ProjectMember.role` value for users (`common/enums.ts:73,81`).
- 409s: `ConflictAppException(args, prefix)` (`common/exceptions/conflict-app.exception.ts`) resolves the i18n key
  `<prefix>.409` (e.g. `invites.userDisabled.409` in `i18n/{en,zh}/invites.json`); the web sees the envelope
  `{ ret, message, errors? }` (`apps/web/composables/useApi.ts`) — no code field, no data field.
- Paging convention: `KodaPageQuery` (`current`, `size`) -> `{ total, current, size, hasNext, hasPrev, records }`.
  `GET /projects/:slug/agents` returns a bare array today (projects.controller.ts:179), consumed by web
  `agents.vue:34` and the CLI.
- `GET /projects/:slug/agents` (projects.controller.ts:167; `prisma-agent.repository.ts:118-138`) lists agents with at
  least one non-deleted ticket assigned in the project; `PATCH /projects/:slug/agents/:agentSlug` (line 183) resolves
  through that list. Web `pages/[project]/agents.vue:34` uses both.
- `TicketsService.assign` (tickets.service.ts:319-375): user assignee must exist and be a member (global ADMIN exempt),
  disabled not checked; agent assignee only has to exist.
- `ProjectMembersService.add` (project-members.service.ts:46-57) does not check `User.disabled`; the invite path does
  (`invites/project-invites.service.ts:108-115`, 409 `invites.userDisabled`).
- Ticket statuses: CREATED | VERIFIED | IN_PROGRESS | VERIFY_FIX | CLOSED | REJECTED (`common/enums.ts:8`). The ticket
  list filter has no agent-assignee filter for web use (`assignee` = user id or `self`).
- Web: `TicketProperties.vue:157-170` assigns via a free-text user id; `ProjectMembersPanel.vue` already has add, role
  select, remove; the member DTO carries `disabled` but the panel ignores it. Locales: `apps/web/i18n/locales/{en,zh}.json`.
- CLI: `apps/cli/src/commands/project.ts`, `member.ts` exist.
- There is no project activity log (only ticket-scoped `TicketEvent`) and no public-config endpoint.

## Out of scope

- Per-project agent roles or capability overrides (D529).
- Fleet runners (`Runner`, `kr_` keys): separate model, untouched.
- Restricting `GET /agents` / `GET /agents/:slug` (stay readable by any authenticated actor; no key material).
- A project admin enabling/disabling users (global ADMIN only, unchanged).
- Agent-assignee filter on the ticket list.
- Notifications for roster changes.
- Pre-existing, not agent-specific: `ContextBuilderService` / `getChangeImpact` accept `repoId` / `repoRefs` /
  `ticketIds` from the request without checking they belong to the project (projects.controller.ts:141-160,
  context-builder.service.ts:237-262). Not part of D533; file a follow-up issue.

## 1. Data

Migration `<ts>_agent_projects`:

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

// back-relations
model Agent   { /* ... */ projects           AgentProject[] }
model Project { /* ... */ agents             AgentProject[] }
model User    { /* ... */ addedAgentProjects AgentProject[] @relation("AgentProjectAddedBy") }
```

The migration creates the table, FKs and index (Prisma-generated DDL), then backfills (raw SQL appended, runs once;
`addedById` NULL, `createdAt` from the column default):

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

Column names verified against `schema.prisma` (`Ticket.assignedToAgentId`, `Ticket.createdByAgentId`,
`Comment.authorAgentId`). Soft-deleted tickets are included on purpose (history is history). Soft-deleted projects keep
their rows; a hard delete cascades.

## 2. Flag

`AGENT_PROJECT_SCOPING` (Joi: `'on' | 'off'`, default `'on'`), read through a small `agentAccessConfig`
(`registerAs`). Effects of `off` (D528): `resolveMembership` and the `GET /projects` / pickup checks behave as before
S4c. Everything else (roster, assign/member guards, 409s, assignees endpoint) applies in both modes.

## 3. API

### 3.1 Enforcement (flag `on`)

- `ProjectAccessService.resolveMembership(projectId, principal)`: for an agent principal, look up
  `AgentProject(agentId, projectId)` on every call (no cache); absent -> throw `ForbiddenAppException({}, 'projects')`
  (same as a non-member user); present -> return **`null`**, exactly what agents get today. With the flag `off` the
  lookup is skipped and `null` is returned, so `off` is identical to pre-S4c.
  - Returning `null` (not `'AGENT'`) keeps `ProjectContext.role` = "null for an agent" (`project-context.ts:6`), keeps
    members-list `viewerRole` unchanged, and avoids the legacy user role `'AGENT'`. Agent permissions inside the
    project stay with `agentPermissions` (D529). Update the `resolveMembership` and guard docblocks to say "agent:
    roster-checked, returns null".
  - The lookup is read live, so a removed agent is refused on its next request; the cached `AgentPrincipal` carries
    no project data and needs no invalidation.
- `ProjectsService.findAllForPrincipal`: agent -> non-deleted projects with an `AgentProject` row (flag `off`: all).
- `GET /agents/:slug/pickup?project=` (`AgentsService.suggestTicket`): after resolving the project (unknown project
  stays 404 `agents`), when the flag is `on` the *target* agent (`:slug`) must be on the project's roster, else 403
  `projects`. This applies to both permitted callers (the owning agent and a global ADMIN). Existing caller rules
  unchanged.
- `GET /agents/me`: adds `projects: [{ slug, name }]` (the agent's roster entries, non-deleted projects), both modes.

### 3.2 Roster endpoints (D530)

Response DTO `ProjectAgentDto { slug, name, status, roles, openTicketCount, openTicketRefs, addedAt, addedBy: { id,
name } | null }`. `openTicketCount` = tickets in this project assigned to the agent, `deletedAt` null, status not
CLOSED/REJECTED; `openTicketRefs` = up to 10 of those refs, oldest first (one grouped query for the page, not per row).

| Route | Who | Behaviour |
|---|---|---|
| `GET /projects/:slug/agents` | any project member / rostered agent (inline assert as today) | `{ scoping: boolean, items: ProjectAgentDto[] }` ordered by name; un-paged (a roster is small; documented exception to `KodaPageQuery`). **Shape change** from today's bare array: web `agents.vue` and the CLI are updated in the same PRs. |
| `POST /projects/:slug/agents` `{ agentSlug }` | project ADMIN, global ADMIN | 201 `ProjectAgentDto`. 404 `agents` unknown agent; 409 `projectAgents.alreadyAssigned` (PK conflict, incl. concurrent adds); 409 `projectAgents.agentOffline` for status OFFLINE. |
| `DELETE /projects/:slug/agents/:agentSlug` | project ADMIN, global ADMIN | 204. 404 `projectAgents` not on roster. 409 `projectAgents.hasOpenTickets` while open tickets exist (D531); message args `{ count, refs }` (refs joined, up to 10) so the CLI prints them; the web reads `openTicketRefs` from the roster row it already has (the error envelope carries no data). |
| `PATCH /projects/:slug/agents/:agentSlug` | unchanged (global ADMIN, project ADMIN, the agent itself) | Existing status route; now resolves the agent through the roster (404 if not on it). |

New i18n file `apps/api/src/i18n/{en,zh}/projectAgents.json` with `alreadyAssigned.409`, `agentOffline.409`,
`hasOpenTickets.409` ("{count} open tickets are still assigned to this agent: {refs}"), `404`.

### 3.3 Assignees endpoint

New controller `@Controller('projects/:slug/assignees')`, `GET` with `q` and `limit` (default 20, max 50), any
project member or rostered agent (guard). Un-paged typeahead (documented exception to `KodaPageQuery`):
`{ items: [{ type: 'user' | 'agent', id, name, secondary, status? }] }`, users first then agents, each by name.
- users: project members with `disabled = false` (global ADMINs who are not members are not listed); `secondary` =
  email.
- agents: roster entries with status ACTIVE or PAUSED; `secondary` = slug; `status` set for agents.
- `q` (trimmed, max 100): case-insensitive substring on name, email (users) or slug (agents).

### 3.4 Guards (both modes)

`TicketsService.assign`: the ticket lookup, the checks and the update run in one `txManager.run`. Order:
- `{ userId }`: user missing -> 404 (today); `disabled` -> 409 `tickets.userDisabled` (`findUserById`,
  prisma-tickets.repository.ts:236, now selects `disabled`); not a member -> 403 (today; global ADMIN exempt).
- `{ agentId }`: agent missing -> 404 (today); not on the roster -> 409 `tickets.agentNotInProject`; status OFFLINE ->
  409 `tickets.agentOffline`. The roster read is `SELECT ... FROM "AgentProject" WHERE ... FOR SHARE`, so it blocks
  on a concurrent removal.
- Roster removal (`DELETE /projects/:slug/agents/:agentSlug`), one transaction: `DELETE` the roster row (takes the row
  lock, waits for any assign holding `FOR SHARE` to commit), then count open tickets; count > 0 -> roll back, 409.
  An assign that committed first is counted; an assign that starts after the delete sees no row and gets 409. The
  race is closed.

`ProjectMembersService.add`: disabled user -> 409 `members.userDisabled`.

New i18n keys: `tickets.userDisabled.409`, `tickets.agentNotInProject.409`, `tickets.agentOffline.409`,
`members.userDisabled.409` (en + zh).

### 3.5 CLI

Under `apps/cli/src/commands/project.ts`, using the generated client:
- `koda project agents [--project <slug>]` — table: slug, name, status, open tickets.
- `koda project agent-add <agentSlug> [--project <slug>]`
- `koda project agent-remove <agentSlug> [--project <slug>]` — on 409 prints the count and refs.

## 4. Web

- **`AssigneePicker.vue`** (new): combobox, 200 ms debounced `GET /projects/:slug/assignees?q=`, "People" and "Agents"
  groups, "(paused)" tag; selecting posts `{ userId }` or `{ agentId }` to the existing assign route. Replaces the
  free-text input in `TicketProperties.vue`; current assignee display and Unassign unchanged. 409s surface via
  `extractApiError` toast.
- **`pages/[project]/agents.vue`** (rework): table (name, slug, roles, status, open tickets; admins also see added
  by/at and Remove). Admin "Add agent" opens **`AddProjectAgentDialog.vue`** (new): picks from `GET /agents` minus
  roster minus OFFLINE, posts `{ agentSlug }`. Remove confirm; when the row has `openTicketCount > 0` (or the DELETE returns 409) shows "Reassign its N open
  tickets first" with `openTicketRefs` as ticket links (refreshing the roster after a 409). Existing pause/resume control kept. Empty state "No agents on this
  project yet." When `scoping` is false: info note "Agent scoping is off on this server: all agents can reach every
  project."
- **`ProjectMembersPanel.vue`**: "Disabled" badge, row greyed, role select hidden for disabled members; add errors
  (`members.userDisabled`) shown as today.
- i18n keys in `en.json` and `zh.json`.

## 5. Edge cases

- Agent deleted -> roster rows cascade; ticket assignments behave as today.
- Agent goes OFFLINE while on a roster -> stays listed (status shown), excluded from the picker; assign -> 409.
- Global ADMIN user unaffected; only agent principals are scoped.
- Flag flipped `on` -> `off` -> `on`: roster is unchanged throughout; access follows the flag on the next request.
- An agent with zero roster rows and flag `on`: `GET /projects` returns `[]`; `GET /agents/me` works.
- Soft-deleted project: roster rows remain; the project is already 404 everywhere.

## 6. Security

- Scoping fails closed: `resolveMembership` throws unless a row exists (flag `on`).
- Roster mutations require project ADMIN or global ADMIN; agents cannot add themselves (agent principals never satisfy
  the ADMIN check).
- Error bodies name codes and ticket refs only; no key material in any agent listing.

## 7. Slices

1. **PR 1 — API + CLI**: migration + backfill, flag, `resolveMembership`, `GET /projects` filter, pickup, `/agents/me`
   projects, roster endpoints, assignees endpoint, assign/member guards, CLI, OpenAPI regen.
2. **PR 2 — Web**: `AssigneePicker`, agents page + `AddProjectAgentDialog`, members disabled badge, i18n, Playwright.
3. **Live check** on koda-wk (§9).

## 8. Testing

- Unit: `resolveMembership` (agent on / not on roster, flag off), `findAllForPrincipal`, pickup rule, roster service
  (add, duplicate, OFFLINE, remove, 409 with refs), assignees query (filters, `q`, limits), assign guards, member add
  guard.
- Integration (PG): a role-matrix spec running one agent key against tickets, comments (incl. `comments/:id`), labels,
  context, code-intel, memory, pickup and `GET /projects`, assigned vs unassigned, then the same with the flag off;
  backfill migration test (agents with tickets/comments in two projects, soft-deleted ticket included); a
  concurrency test: a removal and an assign racing on PG (two transactions) end with either a 409 removal or a 409
  assign, never an assigned ticket for a removed agent; `GET /projects/:slug/agents` new shape consumed by the CLI.
- CLI: unit tests for the three commands.
- Web: unit tests for `AssigneePicker`, `AddProjectAgentDialog`, the disabled badge; one Playwright journey: admin adds
  an agent, assigns a ticket to it via the picker, removal blocked with refs, reassign, remove succeeds.
- OpenAPI regenerated; existing contract checks pass.

## 9. Live check (koda-wk, after PR 2)

1. After deploy, `AgentProject` contains exactly the backfill pairs (compare with a pre-deploy SQL of the history).
2. A new agent key (not on sandbox) -> 403 on `GET /projects/sandbox/tickets`; `GET /projects` = `[]`.
3. Add it on the agents page -> the same request succeeds.
4. Assign a ticket to it via the picker.
5. Remove -> 409 with the ref; unassign; remove -> 204; next request 403.
6. Disable a test user: direct member add -> 409; not in the picker; assign by id -> 409.
7. `AGENT_PROJECT_SCOPING=off` + redeploy -> step 2's request succeeds; restore `on`.

## 10. Delivery

One spec, one plan, two PRs, then the live check. Design doc §9.x status note after each merge and after the live
check; koda-wk deploy after each PR (backup + migration as usual). PR 1 references #61; PR 2 closes it.
