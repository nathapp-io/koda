# Permission, Actor and Approval Redesign

**Status:** APPROVED direction, 2026-10-18. Decisions 1-9 are ruled (see "Decisions"). Next step: the P1 nax feature spec (`permissions-p1-roles`).
**Baseline code:** main `44269581`. Every "today" statement below describes that commit.
**Inputs:**
- `docs/20261018-review-whole-repo.md`: the review findings cited as `A/…`, `B/…` and `C/…`.
- `2026-10-18-permission-action-inventory.tsv`, next to this doc: every action, with its current enforcement.

This doc is meant to be read on its own. Each reference to another document is summarised where it appears.

## Intent

Replace today's per-surface permission and audit rules with one model that applies the same way to REST, CLI, MCP, assistant threads, fleet and background jobs.

For every action, the model answers three questions:
1. **May this principal do this?** (permission)
2. **Does someone else have to agree first, and who?** (approval)
3. **Who acted, and who approved?** (actor and approver, recorded on every write)

**Standing rules** (from the user, earlier in koda's history):
- koda is **agent-first**. Agents are first-class principals: they use their own API keys and act on their own authority. There are no personal access tokens, and no rule may special-case one surface. For example, MCP must not behave differently from REST for the same principal.
- **Every write records two things as separate, explicit fields:** who acted (actor type and id), and how it was approved (approval mode, plus approver type and id). A single "requested by" field is not enough, because it can't tell the actor from the approver.
- **The approval mode for an action is policy, not code**, and an admin can configure it in the web UI.

**Absorbs koda issue #301.** That issue asks for:
- a store for approval policies, so modes are not hard-coded per tool;
- a web editor for those policies;
- a way for an agent to decide an approval;
- an explicit confirm step for `self` mode.

#301 is closed by phase P3.

## Glossary

- **Principal:** who is calling: a user, an agent, a runner, or a system component.
- **Permission key:** a string `resource.verb[.qualifier]` naming one action, for example `ticket.delete`.
- **Role:** a named set of permission keys.
- **Binding:** a role given to a principal, either globally or in one project.
- **Approval mode:** `none`, `self`, `agent` or `human`. These are ordered as a ladder (see §4).
- **Floor:** the lowest approval mode a policy may set for a key. Code defines it; the web cannot go below it.
- **Actor:** the principal that performed a write.
- **On behalf of:** the principal the actor worked for, for example the user who asked the assistant in a thread.
- **Approver:** the principal that satisfied the approval.

---

## Current state (at `44269581`)

### Principals
`KodaPrincipal` (`apps/api/src/auth/principal/koda-principal.types.ts`) has three kinds:
- **User.**
  - Global `User.role` is MEMBER or ADMIN.
  - Inside a project, the user also has `projectRole`, from `ProjectMember.role`: ADMIN, DEVELOPER, AGENT or VIEWER.
  - Project invites (`ProjectInvite.role`) carry ADMIN, DEVELOPER or VIEWER.
- **Agent.**
  - Its roles are **global**: `AgentRoleEntry(agentId, role)`. The values are DEVELOPER, REVIEWER, VERIFIER and TRIAGER (`apps/api/src/common/enums.ts`; the schema comment omits TRIAGER).
  - Project access is a role-less roster row, `AgentProject(agentId, projectId, addedById)`.
- **Runner.**
  - Gets no CASL permissions.
  - Uses its own route family, `/fleet/runner/*`, and every write is checked against its job lease.

### Four permission mechanisms that disagree
1. **CASL**, in `apps/api/src/auth/casl/koda-casl-ability.factory.ts`. Routes use it through `@ProjectPermission` / `@RequiredPermission` and `ProjectMembershipGuard`. Grants today:
   - **Global ADMIN user:** MANAGE on everything.
   - **Project ADMIN:** MANAGE Ticket, Label and FleetJob, plus DELETE any Comment.
   - **Project DEVELOPER:** create, update and transition tickets; create labels; create and update FleetJob.
   - **Project VIEWER:** read, create comments, and edit or delete only their own comments.
   - **Any rostered agent**, with or without roles:
     - read, create comments, and edit or delete only their own comments;
     - read and import CodeIntel;
     - MANAGE Label, CREATE Ticket and **DELETE Ticket**. The comment at `koda-casl-ability.factory.ts:116` says this keeps the old "agents can soft-delete tickets" behaviour.
     - DEVELOPER, REVIEWER and VERIFIER agent roles each add the **same** `TRANSITION Ticket`. TRIAGER adds `UPDATE Ticket`.
2. **`@ProjectRoles(...)` with `exemptAgents`.** Agents skip the role check entirely (`apps/api/src/projects/project-membership.guard.ts:80`).
3. **Fleet helpers** in controllers and services, which refuse agents outright. Example: `apps/api/src/fleet/logs/fleet-job-logs.controller.ts:16`, with the comment "R10: logs are for people; agents and runners get 403". That route also throttles at 600 requests/min per client IP.
4. **Assistant tool permissions** in `apps/api/src/fleet/assistant/tools/*`:
   - Each tool declares `permission: { kind: 'member' }` (15 tools) or `{ kind: 'ability', ... }` (8 tools).
   - The same 23 tools serve thread callers, who are always users, and MCP callers, who are agents (`POST /mcp`).
   - So an agent can read over MCP what REST refuses it (review B/SEC-1).

### Approval today
- **`FleetApproval`** (`schema.prisma`): approvals raised on fleet jobs.
  - Two types: `nax_bash_escalate` (a running nax job asks to run a shell command outside its grants) and `budget_override_required` (a budget hard stop paused a scope).
  - Bash asks are decided by project DEVELOPER and above. Budget asks are decided by global ADMIN.
  - The decider is stored as `decidedById` (a user).
- **`PendingAction`**: assistant write tools.
  - Fields: `actorType`, `actorId`, `origin` (thread or mcp), `approvalMode` (default `human`), `approverType`, `approverId`.
  - Status: PENDING, APPROVED, REJECTED, EXPIRED, EXECUTED, FAILED.
  - The mode comes from `approvalModeFor(origin, tool)` in `apps/api/src/fleet/assistant/actions/approval-policy.ts`:
    - thread: `human`. The thread's creator confirms in the UI.
    - mcp: `none`. This was ruled for the MCP feature; see `.nax/features/fleet-s5b-koda-mcp/spec.md`.
- **Nothing else has an approval step.** Ticket `verify` and `verify-fix` work as approvals in practice, but they are plain transitions.

### Actor and audit today
- `PendingAction` is the only record with actor, approval mode and approver all together.
- Ticket events go through the outbox envelope (`apps/api/src/events/outbox-envelope.util.ts`), which carries `actorId` and `actorType`.
- **System actor:** `apps/api/src/fleet/common/system-actor.ts` defines `SYSTEM_ACTOR = { type: 'SYSTEM', id: 'system' }` for automatic fleet transitions.
  - The fleet approval closer records `ApprovalActor { type: 'USER'|'SYSTEM'|'RUNNER', responsibleUserId }`.
- **Inventory counts for the 174 writes** (see the TSV):
  - 77 record the actor;
  - 65 record none and 2 record the wrong one;
  - 27 were not traced;
  - 3 are not applicable.
- **Wrong or missing actors include:**
  - agent creation and key rotation record the new agent, not the admin who acted;
  - pickup triggered by an admin records the agent;
  - scheduled dispatches are recorded as the schedule owner acting as a user;
  - project CRUD, members, invites, webhooks, labels, links, comment edits, KB, memory, skills, VCS and code-intel writes record no actor.

---

## Action inventory

`2026-10-18-permission-action-inventory.tsv` has 286 rows:
- 232 REST routes (134 writes);
- 23 assistant/MCP tools (9 writes);
- 31 system writers: schedulers, sweepers, retention jobs, VCS and CI intake, outbox subscribers.

**Columns:** surface, module, route or name, read/write, today's scope, today's enforcement, allowed principals, actor recorded, approval step, `proposed_key`, `catalog_scope`, evidence, source.
- `proposed_key` holds one key, or several separated by `;` when a route needs more than one (see §1, "Routes needing several keys").
- `catalog_scope` maps the inventory's raw scope onto the catalog's access classes:

| `catalog_scope` | Meaning in the catalog |
|:--|:--|
| `project` | `scope: 'project'`, granted through roles |
| `global` | `scope: 'global'`, granted through roles. This includes workspace reads that span all of a principal's projects. |
| `own (see design §1)` | Ownership-qualified key. A role grants `X.own` (rows the principal created) or `X` (any row). |
| `implicit` | Every authenticated principal holds it, on its own data only (§1). |
| `public` | No authentication (login, refresh, register, health, invite preview and accept). |
| `runner` | Runner protocol. Lease-fenced, never in roles. |
| `system` | System writer identity (§5). Never in roles. |

- **216 distinct keys** in total.
- **Five rows are unverified**, marked `decorator/name only` in the evidence column: `ApprovalExpirySweeper`, `PendingActionExpirySweeper`, `BundleIngestSweeper`, `MemoryOutboxSubscriber` and `TicketNotificationSubscriber`. Check these when writing the P1 and P2 specs.

---

## Gaps this redesign closes

| Gap (review ID) | Today | Closed by |
|:--|:--|:--|
| B/SEC-1 | MCP gives agents fleet job, log, spend and approval reads that REST refuses ("R10"). | P1. These are ordinary keys held through roles; Developer and Viewer include them (decision 9). R10 is retired, and the 600/min log throttle stays. |
| A/SEC-3 | Every rostered agent can delete tickets and manage labels. | P1. `ticket.delete` and `label.delete` are only in Project Admin. |
| A/SEC-5 | No separation of duties: one `TRANSITION` permission, and an agent can verify its own fix. | P1 splits transitions into one key per edge. P3 adds a policy: verify-fix by the fix's own actor needs `agent` mode (§4). |
| A/ENH-1, C/ENH-1 | Actor and approval are recorded only on `PendingAction`. | P2 (`ActionContext` + `AuditEntry`). |
| A/SEC-2 | `PATCH /projects/:slug/agents/:agentSlug` changes the agent's global record, and an agent can edit itself. | P1. The route is replaced by the binding routes. Global agent fields need `agent.update` (global). Nobody may hold `agent.update` over themselves (§7). |
| A/SEC-4 | Any member can delete ticket links, including fleet and VCS PR links. | P1. `ticket.link.remove.own` for Developer; the any-row `ticket.link.remove` for Project Admin. Links created by a system actor count as nobody's own. |
| A/BUG-3 | Pickup refuses VERIFIER-only agents. | P1. `agent.pickup` is a key in Developer, Reviewer, Verifier and Triager. |
| B/SEC-2 | Thread writes are checked against the creator only, so a demoted creator keeps full control. | P1. Thread write keys are `.own` keys, checked against **current** bindings on every call. |
| C/SEC-1 | A KB write replaces rows by `source_id` alone, so any agent or Developer can overwrite rows owned by other components. | P1 rule: replace and delete match on `(source, source_id)`. `kb.document.*` only reaches `source = 'manual'` rows; system sources are reserved for system actors. |
| C/SEC-2 | A memory write can replace another principal's fact, and any member (Viewer too) can write memory. | P1. `memory.create` needs Developer. Replacing another principal's row needs `memory.update` (any); `memory.update.own` covers own rows only. `memory.extract` checks that the ticket belongs to the project. |
| #301 | Approval modes are hard-coded per tool. | P3. |
| B/BUG-1 | An approved action can stay APPROVED forever if the process dies between approve and execute. | P3. Execute and the status update happen in one transaction. |

---

## Architecture

### Principles

1. **One permission vocabulary.** Every route, tool and system writer declares the permission key(s) it needs, from one catalog in code. All of them check through one `PermissionService`, so a principal gets the same answer on every surface.
2. **Roles are data.** Code owns the catalog; roles are bundles of keys stored in the database. The web UI has full CRUD for custom roles, and koda ships predefined system roles.
3. **One role system for users and agents.** A binding gives a role to a user or an agent, either globally or in one project.
4. **Permission and approval are separate.** A permission lets you *request* an action. The approval policy decides whether it runs immediately or waits. Policy is data, editable in the web UI above code-defined floors.
5. **Every write carries an action context** with actor, origin, on-behalf-of and approval. A write without one is a bug: dev and test throw; production records `system:unknown` and logs an error (§5).
6. **No privilege escalation through configuration** (§7).

### 1. Permission catalog (code)

`apps/api/src/permissions/catalog.ts` has one entry per key:

```ts
{
  key: 'ticket.delete',
  scope: 'project',                  // 'global' | 'project'
  access: 'role',                    // 'role' | 'implicit' | 'public' | 'runner' | 'system'
  risk: 'high',                      // 'low' | 'medium' | 'high' | 'critical'
  principals: ['user', 'agent'],     // which principal types may ever hold it
  ownable: false,                    // true: a role may grant 'ticket.delete.own' instead of the any-row key
  approval: { approvable: true, floor: 'none', default: 'none' },  // used from P3; placeholders before that
}
```

- **Source of keys:** the TSV `proposed_key` and `catalog_scope` columns give the 216 keys and their access class. The keys introduced by this design are added on top (listed in Appendix A).
- **How the implementer assigns risk:**
  - reads: `low`;
  - creates and updates: `medium`;
  - deletes and removes, credential, key, webhook, VCS connection, repo, runner and budget writes: `high`;
  - role, binding, policy and Owner keys: `critical`.
- **`principals`:** `['user','agent']` unless a key says otherwise. The exceptions are `role.binding.owner`, which is `['user']`, and anything under `runner.*` or `system.*`.
- **Ownable keys:** `comment.update`, `comment.delete`, `ticket.link.remove`, `memory.update`, `kb.document.delete`, and the thread write keys (`thread.*` except `thread.read` and `thread.create`).
  - Holding `X` implies holding `X.own`.
  - `X.own` allows the action only on rows whose recorded creator is the caller.
- **Implicit keys** are held by every authenticated principal, on its own data only. They can't be removed, so login and notifications can't be broken by role edits:
  - `auth.me.read`, `session.logout`, `home.read`, `notification.*`, `agent.self.read`, `assistant.action.read`.
  - Listing projects (`project.read`) is filtered to projects the caller can access.
- **Public keys** need no principal: `session.login`, `session.refresh`, `auth.register`, `auth.registration.read`, `health.read`, `invite.preview`, `invite.accept`.
- **Runner and system keys** are never placed in roles (§3, §5).
- **Ticket transitions:** one key per edge of `apps/api/src/tickets/state-machine/ticket-transitions.ts`.

  | Key | Edge |
  |:--|:--|
  | `ticket.transition.verify` | CREATED → VERIFIED |
  | `ticket.transition.start` | CREATED or VERIFIED → IN_PROGRESS |
  | `ticket.transition.reject` | CREATED or VERIFIED → REJECTED |
  | `ticket.transition.fix` | IN_PROGRESS → VERIFY_FIX |
  | `ticket.transition.verify-fix.approve` | VERIFY_FIX → CLOSED |
  | `ticket.transition.verify-fix.return` | VERIFY_FIX → IN_PROGRESS |
  | `ticket.transition.close` | the `/close` route |

  - The unreachable edge IN_PROGRESS → VERIFIED (GENERAL), commented as unreachable in that file, is deleted and gets no key.
  - There is no reopen edge; adding one is out of scope.
- **Routes needing several keys:**
  - A route may require all of a set of keys, or pick a key from its input.
  - `PATCH` on a ticket needs `ticket.update`, plus the edge key when `status` changes.
  - `POST /projects/:slug/tickets/:ref/verify-fix` needs `.approve` or `.return`, depending on `approve`.
  - The fleet approval decide route needs the key for the approval's type.
- **CI contract:** a test walks every controller route, tool descriptor and system writer, and checks that:
  - each one declares its key(s);
  - every declared key exists in the catalog;
  - every catalog key is used at least once.

### 2. Roles and bindings (data, web CRUD)

```
Role         { id, key, name, description, scope: GLOBAL|PROJECT, system: bool, locked: bool,
               permissions: string[], createdAt, updatedAt }
RoleBinding  { id, principalType: USER|AGENT, principalId, roleId, projectId: string | null,
               grantedByType, grantedById, createdAt }
               @@unique([principalType, principalId, roleId, projectId])
```

**Grammar for role permission entries:**
- A role's `permissions` is a list of entries. Each entry is:
  - a key;
  - `X.own`;
  - a prefix wildcard `prefix.*`, which matches every key starting with `prefix.`;
  - `*`, which matches every role-grantable key in the role's scope;
  - an exclusion `!entry`.
- Exclusions apply after inclusions.
- `approval.decide@<pattern>` narrows the decide permission to actions matching `<pattern>`, for example `approval.decide@ticket.*`. Plain `approval.decide` covers everything.

**Effective permissions:**
- In a project: the union of the principal's global bindings and its bindings in that project.
- A GLOBAL-scope role only grants global keys.
- A PROJECT-scope role bound with `projectId = null` grants its keys in **every** project, including ones created later (decision 1). Example: one review agent for the whole fleet.
  - Creating such a binding needs `role.binding.global`, which is in Owner and Admin only.

**Project access:**
- A principal can access a project when it has a binding there, or a PROJECT-scope role bound with `projectId = null`.
- GLOBAL-scope roles never grant project access. The exception is Owner and Admin: `*` covers every project.

**Baseline bindings, made automatically:**
- A new user gets global `Member`.
- A new agent gets global `Agent`.

**System roles:**
- Seeded with `system = true` and can't be deleted.
- `Owner` is also `locked`: it can't be edited.
- Other system roles can be edited.
- Custom roles have full CRUD.

**Seeded roles.** The exact entries are in Appendix A, and the P1 allow/deny test matrix is derived from that appendix.

| Role | Scope | Intent |
|:--|:--|:--|
| Owner | global | Everything. Locked; at least one must exist. |
| Admin | global | Everything except binding Owner. |
| Member | global | Baseline for users: workspace threads and agent directory. |
| Agent | global | Baseline for agents: MCP access and agent directory. No project access. |
| Project Admin | project | Every project-scope key. |
| Developer | project | Day-to-day work: tickets and all transitions, comments, labels, links, fleet jobs, threads, KB, memory, code-intel. |
| Reviewer | project | Read, comment, the verify-fix edges, close, pickup, decide approvals (P3). |
| Verifier | project | Read, comment, verify, the verify-fix edges, pickup. |
| Triager | project | Read, comment, update, assign, verify, reject, labels, pickup. |
| Approver | project | Read and decide approvals (P3), with no write keys of its own. |
| Viewer | project | Every project read, including fleet logs and spend (unchanged for users). |

**Typical agent setups:**
- a coding agent: Developer in its projects;
- a review agent: Reviewer, bound to all projects.

### 3. Permission resolution

- **Interface:** `PermissionService.can(principal, key, { projectId?, resource? })` returns `{ allowed, reason }`.
- **How it decides:**
  - Implicit and public keys are allowed (implicit only on the caller's own data).
  - Runner and system keys are refused for role principals.
  - Otherwise the key must match the effective entries, and for `.own` the resource's creator must be the caller.
- **Caching:** the effective key set is cached per principal and project. A global `permissionsVersion` counter is bumped on any write to roles or bindings and is part of the cache key. This replaces today's 60-second stale-role window.
- **Library:** built on the `@nathapp/nestjs-auth` CASL primitives already installed (`PermissionProvider`, `BaseCaslAbilityFactory`, `~4.1.1`). Keys map to CASL action/subject pairs, and ownership maps to CASL conditions.
- **Surface adapters:**
  - REST: `@Requires('ticket.delete')`, or `@Requires(['ticket.update'], { plus: ... })` for routes needing several keys.
  - Tools: `permission: 'ticket.delete'` on the descriptor.
  - The MCP `tools/list` is filtered by `can()`.
- **Runners** keep their own protocol (`/fleet/runner/*`), fenced by the job lease. They are outside roles.
- **Removed in P1:**
  - `@RequiredPermission('ADMIN')`, `@ProjectPermission`, `@ProjectRoles`, `exemptAgents`;
  - the fleet `requireUser`/`assertUser` helpers;
  - the tool `permission.kind`.

### 4. Approval engine (P3)

**Modes, as a ladder:** `none` < `self` < `agent` < `human`.

| Policy mode | Satisfied by |
|:--|:--|
| `none` | Nobody needed; it runs at once. |
| `self` | The actor confirming its own request, or any other agent or human holding the decide permission. |
| `agent` | An agent other than the actor holding the decide permission, or a human holding it. |
| `human` | A human holding the decide permission. |

- **A higher-tier approver always satisfies a lower requirement.** An agent that may approve other agents can also approve a `self` request. A human can approve any request.
- **The actor satisfies up to its own tier** (decision 8):
  - An agent actor can satisfy `self` only.
  - A human acting directly satisfies any mode, because a human did it. A `human` floor therefore means "an agent can't do this without a human". It does not block a human admin acting alone.
  - The per-policy flag `requireDistinctApprover` (default `false`) requires an approver other than the actor.
- **Assistant writes in a thread:**
  - From P2, the actor is the system actor `system:assistant`, acting on behalf of the thread's user, with that user's permissions.
  - The on-behalf-of user may approve, as today's confirm step does.
  - `system:assistant` itself never satisfies any mode above `none`.
- **The decide permission:**
  - The key is `approval.decide` (or `approval.decide@<pattern>`). Agents may hold it.
  - Confirming one's own `self` request needs only the action's own key.
  - `approverMustHoldAction` (per policy, default `true`; decision 3): the approver must also hold the action's key. `false` lets a pure Approver role decide actions it can't perform.

**Policy (data, web-editable):**

```
ApprovalPolicy { id, projectId: string | null, permissionPattern,           // a key or 'prefix.*'
                 appliesTo: { principalType?: USER|AGENT, roleId?, principalId? },
                 mode, timeoutSec?, onTimeout: 'reject' | 'approve',          // 'approve' only when floor = 'none'
                 requiredApprovals: 1, approverMustHoldAction: true, requireDistinctApprover: false,
                 updatedByType, updatedById, updatedAt }
```

**Resolution:**
- The most specific policy wins:
  1. project + principal
  2. project + role
  3. project + principal type
  4. project + pattern
  5. the same four at global level
  6. the catalog default
- Among patterns, an exact key beats a wildcard, and a longer prefix beats a shorter one.
- The result is clamped up to the catalog floor.

**Shipped defaults:**
- Reads are not approvable.
- Humans acting directly: `none`.
- Agents, by risk tier: low and medium `none`, high `agent`, critical `human`.
- Role, binding and policy keys: floor `human`.
- MCP agent writes otherwise keep the MCP feature's `none`.
- Thread assistant writes: `human`, which is today's behaviour.
- `ticket.transition.verify-fix.approve`: when the caller is also the actor of the ticket's latest `fix`, the mode is `agent`.

**Who edits policies:**
- Global policies: `approval.policy.manage` (Owner and Admin).
- A project's policies: Project Admin (decision 4).
- Nobody can go below a floor.

**Timeouts:** reject by default. Auto-approve on timeout is allowed only when the floor is `none` (decision 5).

**Multiple approvers:** `requiredApprovals` is in the model, but only `1` ships (decision 6).

**One request model** replaces `PendingAction` and `FleetApproval`:

```
ApprovalRequest  { id, permissionKey, projectId?, actorType, actorId, onBehalfOfType?, onBehalfOfId?,
                   origin: rest|cli|mcp|thread|system|runner, input Json (frozen), inputHash,
                   requiredMode, status: pending|approved|rejected|expired|cancelled|executed|failed,
                   expiresAt, result Json?, createdAt }
ApprovalDecision { id, requestId, deciderType, deciderId, decision: approve|reject, comment, decidedAt }
```

- **Execution:**
  - The command runs from the frozen input.
  - The actor's permission is re-checked at execution time.
  - The domain write and `status = executed` commit in one transaction.
- **Asks raised by runners and the system:**
  - `nax_bash_escalate` becomes `fleet.job.shell.escalate`; the actor is the job's agent.
  - `budget_override_required` becomes `fleet.budget.override`; the actor is `system:budget`.
- **Ways to decide:**
  - the web inbox;
  - `POST /approvals/:id/decisions`;
  - the MCP tool `koda_decide_approval`.
- **Before P3:** `PendingAction` and `FleetApproval` stay as they are. Only their checks move onto the new keys in P1:
  - bash asks: `fleet.approval.decide.bash`, held by Developer and up;
  - budget asks: `fleet.approval.decide.budget`, held by Admin;
  - assistant actions: `fleet.approval.decide.assistant`, satisfied by the thread's creator, as today.

### 5. Action context and audit (P2)

**`ActionContext`**, held in AsyncLocalStorage next to the Prisma transaction:

```
ActionContext { actor: { type: USER|AGENT|SYSTEM, id }, onBehalfOf?: { type, id }, origin,
                approval: { requiredMode, satisfiedBy: none|self|agent|human,
                            approverType?, approverId?, requestId? },
                correlationId }
```

- `requiredMode` is what policy demanded. `satisfiedBy` is how it was met.
- Example: a human acting directly under a `human` floor has `requiredMode: human`, `satisfiedBy: self`, and approver = the actor.

**System actors** extend the existing `SYSTEM_ACTOR` shape (`{ type: 'SYSTEM', id }`) with a component id instead of the generic `'system'`.
- The ids: `scheduler`, `assistant`, `budget`, `vcs-sync`, `ci-webhook`, `sweeper`, `outbox`, `retention`.
- One id per `system.*` key family in the TSV.
- The fleet `ApprovalActor.responsibleUserId` maps to `onBehalfOf`.

**Scheduled dispatch** (decision 7):
- Actor `SYSTEM/scheduler`, on behalf of the schedule's owner, using the owner's permissions checked when the schedule fires.
- If the owner has lost the permission, the fire is refused and the refusal recorded.

**`AuditEntry` table**, written in the same transaction as each domain write:
- Fields: key, resource type and id, project, the full context, and a short change summary.
- Written by the command layer (a generalised `apps/api/src/koda-domain-writer/`), not by a route interceptor, so tools and system writers are covered too.
- Library: P2 adds `@nathapp/nestjs-audit`, version-aligned with the other `@nathapp/*` packages (`~4.1`), and implements its `IAuditStorage` with Prisma.
  - Its route interceptor is not used.
  - If the package is unavailable at a compatible version, an in-repo storage with the same shape is fine.

**Outbox:** the envelope gains the same `approval` block.

**A write without a context:**
- dev and test: throws;
- production: records `SYSTEM/unknown` and logs an error, so an audit gap never becomes an outage.
- The P2 coverage test walks the TSV write rows so none are left.

### 6. Web UI

**P1 pages** (they replace existing pages):

| Page | Needs | Replaces |
|:--|:--|:--|
| Admin → Roles | `role.read` and `role.manage` | New. Role list and CRUD; a permission matrix grouped by resource, with risk badges; system and locked roles marked. |
| Admin → Users | `user.*`, `role.binding.global` | The user admin's MEMBER/ADMIN toggle becomes global role bindings. |
| Admin → Agents (`apps/web/pages/agents.vue`) | `agent.*` | `EditAgentRolesDialog.vue` and `lib/agent-roles.ts` (global agent roles) are replaced by global and all-projects bindings. |
| Project → Members (`ProjectMembersPanel.vue`) | `member.*` | One list of users **and** agents, with role chips, add, remove and a role picker. It absorbs the project agent roster in `pages/[project]/agents.vue`; that page keeps only agent status and activity views. |
| Invites (S4c invite flow) | `invite.*` | Unchanged flow. The invite carries a project `roleId` instead of ADMIN/DEVELOPER/VIEWER. |

**P2 page:**

| Page | Needs | What |
|:--|:--|:--|
| Audit log | `audit.read` | Filter by actor, approver, key, project and date. |

**P3 pages:**

| Page | Needs | What |
|:--|:--|:--|
| Global approval policies | `approval.policy.manage` | Per key: floor, default and current mode, plus overrides. |
| Project approval policies | Project Admin | Project overrides. |
| Unified approvals inbox | `approval.decide*` | Replaces the fleet and assistant inboxes. |

### 7. Safety rails

- **Anti-escalation:**
  - You may grant a role only if every key it contains is in your effective set at that scope.
  - Nobody may change their own bindings or hold `agent.update` over themselves.
  - Agents may never change roles, bindings or policies that apply to them.
- **No lock-out:**
  - At least one Owner binding must exist.
  - The Owner role is locked.
  - `role.binding.owner` is user-only and held by Owner only.
- **Floors** come from code and can't be lowered from the web.
- **Before P3,** role, binding and policy changes are permission-only: Owner, Admin, or Project Admin within its project. From P3 they are also approvable, with a `human` floor. They are audited from P2.

### 8. No data migration (decision 2)

koda has no production use, so this is a schema replacement.

- **P1 replaces** `User.role`, `ProjectMember`, `AgentProject` and `AgentRoleEntry` with `Role` and `RoleBinding`. `ProjectInvite.role` becomes `roleId`. The tables and columns are physically dropped in `permissions-p1-cleanup`.
- **P3 drops** `PendingAction` and `FleetApproval`, replacing them with `ApprovalRequest` and `ApprovalDecision`.
- No data is copied.
- **Bootstrap:**
  - A seed creates the system roles. From P3 it also creates the default policies.
  - The existing first-user path in `apps/api/src/auth/auth.service.ts` stays: while the users table is empty, registration is open. The first user to register gets **Owner**.
  - If `KODA_OWNER_EMAIL` is set, only that email may take the first registration.
  - With `NODE_ENV=production`, startup fails when `KODA_OWNER_EMAIL` is unset.
  - `REGISTRATION_ENABLED` (`apps/api/src/config/auth.config.ts`) keeps its meaning for later registrations, which get `Member`.
- **koda-wk** (the user's local deployment) is reset and re-seeded when P1 ships. Projects, tickets and agents may stay; memberships and agent roles are recreated in the UI.

### 9. Phasing

| Phase | Delivers | Behaviour change |
|:--|:--|:--|
| P1 `permissions-p1-roles` | Everything in the list below. | New role model; agent roles per project or all projects; the gaps marked P1 above are closed. |
| P2 | `ActionContext`, `AuditEntry`, system actor ids (including `assistant`), the context-less write rule, all actor gaps closed, Audit log page. | Audit only; thread writes are recorded as `system:assistant` on behalf of the user. |
| P3 | `ApprovalRequest` and `ApprovalDecision`, policies, floors, the policy pages, the unified inbox, `koda_decide_approval`; `PendingAction` and `FleetApproval` dropped; closes #301. | Gated actions start waiting for approval. |

P1 delivers:
- the catalog and `PermissionService`;
- `@Requires` and tool keys;
- the `Role` and `RoleBinding` tables, the seeded roles (Appendix A) and the Owner bootstrap;
- removal of the four old mechanisms and their tables;
- the P1 web pages;
- the KB, memory, link and thread ownership rules;
- the CI catalog contract test and the role allow/deny matrix test.

Each phase can be split into an API feature and a web feature. P1 and P2 can run in parallel; P3 needs both.

**P1 is delivered as five nax features**, in this order (split 2026-10-18, because P1 exceeds one spec's story limit):

1. `permissions-p1-roles` (api): the catalog, `PermissionService` and `MembershipService`, the `Role` and `RoleBinding` tables, the seeded roles and the Owner bootstrap, and the role and binding REST API.
   - The legacy membership routes write bindings.
   - A compatibility layer derives today's `role`, `projectRole` and `agentRoles` from bindings, so no permission check changes yet.
   - Until cleanup, reads see bindings **unioned with** the legacy rows, so existing fixtures stay valid. New writes go only to bindings, and removals clear both.
2. `permissions-p1-enforce-core` (api): `@Requires` keys on the ticket, comment, label, link, project, agent, user and admin routes.
3. `permissions-p1-enforce-fleet` (api): fleet routes, assistant and MCP tool keys, and the KB, memory and thread ownership rules.
4. `permissions-p1-cleanup` (api): removes the compatibility layer and the old mechanisms, **drops the legacy tables and columns**, and adds the catalog contract and role-matrix tests.
5. `permissions-p1-web` (web): the P1 web pages. It can run in parallel with 2–4.

---

## Decisions

| # | Decision | Ruled |
|:--|:--|:--|
| 0 | One model across all surfaces. Review rulings 1-4 (MCP vs R10, agent ticket delete, self-verify, audit scope) are folded into this redesign and not fixed one at a time. | User, 2026-10-18 |
| 1 | Per-project bindings for users and agents. Global bindings are allowed too: a GLOBAL role, or a PROJECT role in all projects (`role.binding.global`). New agents get a baseline `Agent` role. | User, 2026-10-18 |
| 2 | No data migration (no production use). Drop the legacy tables, seed the roles, bootstrap the Owner, reset koda-wk. | User, 2026-10-18 |
| 3 | The approver must also hold the action's key. Configurable per policy (`approverMustHoldAction`), default `true`. | User, 2026-10-18 |
| 4 | Project Admin edits approval policies for their project, within the floors. | User, 2026-10-18 |
| 5 | A timeout rejects. Auto-approve is allowed only when the floor is `none`. | User, 2026-10-18 |
| 6 | `requiredApprovals` is in the model; only 1 ships. | User, 2026-10-18 |
| 7 | Schedules run with the owner's permissions, checked at fire time. The actor is the scheduler, on behalf of the owner. | User, 2026-10-18 |
| 8 | A human acting directly satisfies any mode. A thread's on-behalf-of user may approve the assistant's write. `requireDistinctApprover` is a per-policy flag, default off. | User, 2026-10-18 |
| 9 | Fleet job, log, spend and approval reads are role keys (Developer and Viewer have them), the same on REST and MCP. R10 is retired. | User, 2026-10-18 |

**Designer's calls (not ruled by the user; change them in review if wrong):**
- the risk-tier defaults;
- `KODA_OWNER_EMAIL` required in production;
- deleting the unreachable ticket edge, and no reopen edge;
- agents may hold `approval.decide`;
- `system:assistant` as the thread actor;
- the exact role contents in Appendix A;
- `@nathapp/nestjs-audit` for audit storage.

---

## Notes for writing the P1 specs (read before drafting any `permissions-p1-*` spec)

The first spec, `permissions-p1-roles`, needed three spec-review passes. Each item below was a blocker in one of those passes. A spec that follows these notes should pass in one or two.

### Before drafting

- **Size the feature first.** Count the routes, readers and writers it touches, and the existing tests that build the services it changes, before writing any story. If the count points past 7 stories or 15 ACs per story, split the feature **before** drafting, not after the first review. `permissions-p1-roles` was split after review 1 into roles + membership.
- **Treat `.nax/features/permissions-p1-roles/spec.md` as the reference.** Reuse its conventions: rulings 1-9 in its Design, the Service signatures, Failure Handling with exception classes, and the Modifies wording. Its decisions carry over to every later P1 feature unless a spec says otherwise.

### Decisions already made: do not re-decide them

- **Global Owner and Admin** hold every key in `expandEntries(['*'], 'PROJECT')`, in every project **and** in the `'global'` set used for escalation checks.
- **Order of checks** on every new write route:
  1. the permission key;
  2. input validation and lookups;
  3. self-binding;
  4. escalation;
  5. Owner lock.

  Write ACs that match this order. An AC that expects a later step's error when an earlier step fails is a contradiction.
- **Legacy reads are unioned until `permissions-p1-cleanup`.** Membership answers combine bindings with the legacy `ProjectMember`, `AgentProject` and `User.role = 'ADMIN'`. New writes go to bindings only. Removals and demotions also clear the legacy row or column.
- **Every change to `User.role`** bumps `tokenVersion` and invalidates `userTokenVersionCacheTag` and `userAuthStateCacheKey`, as `UsersAdminService.update` does today. A spec that drops this is a security regression.
- **Exceptions** are constructed as `new XAppException({}, 'permissions.<code>')`, with messages at the nested i18n key `permissions.<code>.<status>` in both `en` and `zh`.
- **Repositories** extend `AbstractPrismaRepository`, sit behind symbol tokens, and are never exported (`.nax/rules/api-data.md`).
- **Unique index names must contain the column** that `isUniqueViolation(error, field)` matches on. The helper substring-matches index names, because Prisma 7 driver adapters give no field list.
- **A new module** must be added to `AppModule` imports, and the spec must list `apps/api/src/app.module.ts` in Modifies.
- **Tests that need seeded roles** run `SystemRoleSeeder` after `resetDb`, which truncates every table.

### Checks to run before handing a draft to spec-review

1. **Derivation check.**
   - Before `permissions-p1-roles` is implemented: run any catalog, scope or role-entry rule the spec states against the TSV with a script. Expand every seeded role and every wildcard.
   - After it is implemented: use `expandEntries` and `findCatalogEntry` from `apps/api/src/permissions/` instead of re-deriving.

   A rule that is never executed is where review 1 found its blockers.
2. **Constructor and DI sweep.** For every service whose constructor or module wiring changes, grep `src/` and `test/` for:
   - `new <Service>(`;
   - provider lists that include the real class, not a `useValue` double;
   - module specs with their own `FakeGlobalsModule`.

   Every hit that a correct implementation breaks goes into `### Modifies`, one file per bullet. Also state the position of any new constructor parameter: required parameters come before the `@Optional()` ones.
3. **Prisma-stub sweep.** For every reader moved off a legacy table, grep its `*.spec.ts` for stubs of `projectMember`, `agentProject`, `agentRoleEntry` or `user`, and for exact `where` assertions. Each stub test goes into Modifies.
4. **Story-order check.** No AC may call a route or symbol created by a later story. No Modifies entry may import a class a later story creates. That was the `GlobalStubsModule` blocker.
5. **Fix-induced drift.** After fixing review findings, re-read every place the changed rule is used before re-submitting: the `can` rules, the escalation rules, the Failure table and the ACs. Review 3's blockers were all fixes that reached only one of the places the rule applies.
6. Run `nax spec lint` and the banned-token sweep last.

## Appendix A: seeded roles (P1 seed and test matrix)

Entries use the grammar in §2. Keys come from the TSV, plus the new keys listed below. Expand wildcards against the catalog at seed time.

**New keys added by this design:**
- `role.read`, `role.manage`
- `role.binding.manage` (project), `role.binding.global`, `role.binding.owner`
- `approval.decide` (P3)
- `approval.policy.read`, `approval.policy.manage` (P3)
- `audit.read` (P2)
- `memory.update`

**Keys removed** (folded into `role.binding.manage`, `member.*` and `agent.update`):
- `project.agent.add`, `project.agent.update`, `project.agent.remove`
- `agent.roles.update`
- `member.role.update`
- `fleet.approval.decide.*` (P3; until then they are ordinary keys, as in §4)

| Role | Entries |
|:--|:--|
| Owner | `*` |
| Admin | `*`, `!role.binding.owner` |
| Member | `agent.read`, `thread.workspace.read.own`, `thread.workspace.create`, `thread.workspace.message.send.own`, `thread.workspace.archive.own` |
| Agent | `agent.read`, `mcp.access` |
| Project Admin | `*` (every project-scope key), `approval.decide`, `approval.policy.manage` |
| Developer | `*.read`, `ticket.create`, `ticket.update`, `ticket.assign`, `ticket.transition.*`, `ticket.label.*`, `ticket.link.add`, `ticket.link.remove.own`, `ticket.watch.*`, `comment.create`, `comment.update.own`, `comment.delete.own`, `label.create`, `label.update`, `agent.pickup`, `fleet.job.*`, `fleet.schedule.*`, `fleet.ticket-job.*`, `fleet.approval.decide.bash`, `fleet.knowledge.repo.reindex`, `thread.create`, `thread.*.own`, `kb.document.add`, `kb.document.delete.own`, `kb.search`, `memory.create`, `memory.extract`, `memory.decision.record`, `memory.update.own`, `codeintel.*`, `context.*` |
| Reviewer | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.transition.verify-fix.*`, `ticket.transition.close`, `agent.pickup`, `approval.decide` |
| Verifier | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.transition.verify`, `ticket.transition.verify-fix.*`, `agent.pickup` |
| Triager | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.update`, `ticket.assign`, `ticket.transition.verify`, `ticket.transition.reject`, `ticket.label.*`, `label.create`, `agent.pickup` |
| Approver | `*.read`, `approval.decide` |
| Viewer | `*.read`, `comment.create`, `comment.update.own`, `comment.delete.own`, `ticket.watch.*` |

**Notes on the table:**
- In a PROJECT role, `*.read` means every project-scope key whose verb is `read`. That includes `fleet.job.logs.read`, `fleet.analytics.read` and the other fleet reads (decision 9).
- Global-only operations stay with Owner and Admin, through `*`. These are fleet repos, runners, enrollment, credentials, ingest, budgets, skills sources, users, outbox and global webhooks.
- `project.create` is Admin-only, as today.

**The P1 test matrix:**
- one row per (seeded role, key), expected allow or deny;
- plus `.own` cases, each tested with a row owned by the caller and a row owned by someone else.

## Related documents (background only; not needed to build P1)

- `docs/20261018-review-whole-repo.md`: review findings and IDs.
- `.nax/features/fleet-s5b-koda-mcp/spec.md`: the MCP feature; `PendingAction` actor and approval fields.
- `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md`: `FleetApproval`, bash and budget asks.
- `docs/superpowers/specs/2026-10-09-fleet-s4c-team-access-design.md`: project members and invites.
- `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md`: assistant tools.
