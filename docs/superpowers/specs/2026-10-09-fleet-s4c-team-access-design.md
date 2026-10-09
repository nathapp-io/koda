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
4. Removing an agent that has open tickets in P fails with 409 and names the tickets; after reassigning them the
   removal succeeds.
5. The ticket assignee picker lists only active project members and the project's non-OFFLINE agents; the API refuses
   a disabled user (409 `USER_DISABLED`) or an agent not on the project (409 `AGENT_NOT_IN_PROJECT`) either way.
6. Adding a disabled user as a member directly fails with 409 `USER_DISABLED` (the invite path already does).
7. With `AGENT_PROJECT_SCOPING=off`, agents reach every project as before S4c; roster, picker and guards still work.

## Rulings (user, 2026-10-09)

- D527: migration **backfills** `AgentProject` from history (S4c Q1 A); access is explicit afterwards.
- D528: `AGENT_PROJECT_SCOPING=on|off` env flag, default `on`; `off` restores pre-S4c global agent access (Q1 C).
- D529: an assignment grants **access only**; the agent's permissions inside a project still come from its global
  `AgentRoleEntry` roles via `KodaCaslAbilityFactory.agentPermissions` (Q2 A). No per-project agent role.
- D530: project ADMIN and global ADMIN manage a project's agent roster; any project member reads it. Agent CRUD and key
  rotation stay global-ADMIN-only (Q3 A).
- D531: removing an agent with open tickets in the project is refused with 409 `AGENT_HAS_OPEN_TICKETS` (Q4 A).
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
  route (guard), `context/:slug` (guard via `params.slug`), code-intel `symbols*` (`@ProjectSlugFrom('query',
  'projectSlug')`), `code-intel/index` (`checkProjectMembership`), `memory/*` (`assertWriteAuthorized` ->
  `assertProjectMembership`), `PATCH/DELETE comments/:id` (`assertCommentProjectMembership`, comments.service.ts:160).
- Routes that do NOT: `GET /projects` (`ProjectsService.findAllForPrincipal` returns all projects for agents,
  projects.service.ts:79-87); `GET /agents/:slug/pickup?project=` (agents.controller.ts:107). `GET /home` is user-only.
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
```

Backfill in the same migration (raw SQL, runs once), `addedById` NULL:

```sql
INSERT INTO "AgentProject" ("agentId", "projectId", "createdAt")
SELECT DISTINCT a, p, now() FROM (
  SELECT "assignedToAgentId" AS a, "projectId" AS p FROM "Ticket" WHERE "assignedToAgentId" IS NOT NULL
  UNION SELECT "createdByAgentId", "projectId" FROM "Ticket" WHERE "createdByAgentId" IS NOT NULL
  UNION SELECT c."authorAgentId", t."projectId" FROM "Comment" c JOIN "Ticket" t ON t.id = c."ticketId"
        WHERE c."authorAgentId" IS NOT NULL
) s
ON CONFLICT DO NOTHING;
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
  `AgentProject(agentId, projectId)` on every call (no cache); present -> return `'AGENT'`, absent -> throw
  `ForbiddenAppException({}, 'projects')` (same as a non-member user). User and global-ADMIN branches unchanged.
  - Returning `'AGENT'` must not change agent permissions: `assertProjectRoles` keeps returning early for non-users,
    and `assertProjectPermission` keeps using `agentPermissions` (D529). The plan verifies no caller treats a non-null
    agent role as a project role.
  - The membership lookup is read live, so a removed agent is refused on its next request; the cached
    `AgentPrincipal` carries no project data and needs no invalidation.
- `ProjectsService.findAllForPrincipal`: agent -> projects with an `AgentProject` row (non-deleted).
- `GET /agents/:slug/pickup?project=`: 403 `projects` unless the *target* agent (`:slug`) is on the project's roster;
  when the caller is an agent, it must also be on the roster (via `resolveMembership`). The caller still needs
  today's permission to call the route.
- `GET /agents/me`: adds `projects: [{ slug, name }]` (the agent's roster entries, non-deleted projects), in both modes.

### 3.2 Roster endpoints (D530)

| Route | Who | Behaviour |
|---|---|---|
| `GET /projects/:slug/agents` | any project member / assigned agent | `{ scoping: boolean, items: [{ slug, name, status, roles, openTicketCount, addedAt, addedBy: { id, name } \| null }] }` ordered by name. Replaces the "agents with tickets here" meaning. `openTicketCount` = tickets in this project assigned to the agent, not deleted, status not CLOSED/REJECTED. |
| `POST /projects/:slug/agents` `{ agentSlug }` | project ADMIN, global ADMIN | 201 roster entry. 404 unknown agent; 409 `AGENT_ALREADY_ASSIGNED` (PK conflict, incl. concurrent adds); 409 `AGENT_OFFLINE` for status OFFLINE. |
| `DELETE /projects/:slug/agents/:agentSlug` | project ADMIN, global ADMIN | 204. 404 not on roster. 409 `AGENT_HAS_OPEN_TICKETS` with `{ count, refs }` (`refs` = up to 10 ticket refs, oldest first) while `openTicketCount > 0` (D531). |
| `PATCH /projects/:slug/agents/:agentSlug` | unchanged (global ADMIN, project ADMIN, the agent itself) | Existing status route; now resolves the agent through the roster (404 if not on it). |

Error codes are i18n keys in the existing `projects` namespace style; the plan picks exact keys.

### 3.3 Assignees endpoint

`GET /projects/:slug/assignees?q=&limit=` (any project member; `limit` default 20, max 50):
`{ items: [{ type: 'user' | 'agent', id, name, secondary }] }`, users first then agents, each by name.
- users: project members with `disabled = false` (global ADMINs who are not members are not listed);
  `secondary` = email.
- agents: roster entries with status ACTIVE or PAUSED; `secondary` = slug; PAUSED surfaces as `status` on the item.
- `q` (trimmed, max 100): case-insensitive substring on name, email (users) or slug (agents).

### 3.4 Guards (both modes)

- `TicketsService.assign`:
  - `{ userId }`: user `disabled` -> 409 `USER_DISABLED` (checked before membership).
  - `{ agentId }`: agent not on the project's roster -> 409 `AGENT_NOT_IN_PROJECT`; status OFFLINE -> 409
    `AGENT_OFFLINE`.
  - Check and update in one `txManager.run`.
- `ProjectMembersService.add`: disabled user -> 409 `USER_DISABLED`.
- Remove vs concurrent assign: the roster delete and the open-ticket count run in one transaction; an assign that
  commits after the count can leave one ticket assigned to a removed agent. Accepted: the agent then simply has no
  access, and the ticket can be reassigned.

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
  roster minus OFFLINE, posts `{ agentSlug }`. Remove confirm; on `AGENT_HAS_OPEN_TICKETS` shows "Reassign its N open
  tickets first" with the refs as ticket links. Existing pause/resume control kept. Empty state "No agents on this
  project yet." When `scoping` is false: info note "Agent scoping is off on this server: all agents can reach every
  project."
- **`ProjectMembersPanel.vue`**: "Disabled" badge, row greyed, role select hidden for disabled members; add errors
  (`USER_DISABLED`) shown as today.
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
  backfill migration test (agents with tickets/comments in two projects, soft-deleted ticket included).
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
