# SPEC: Permissions P2d — Audit Entries for the Core Writes

## Summary

This feature makes every core domain write in `apps/api` record an `AuditEntry` in the same transaction as the write:
- **The command layer.** `AuditRecorder` gains `audited(fn, entriesOf)`. It runs a write in one `txManager.run` and records the entries the write's result describes. The rule for every writer: a method that already owns a `txManager.run` calls `AuditRecorder.record` inside that callback, after its write; a method with no transaction wraps its write in `audited`.
- **The writers.** The 42 live core write routes record one entry per action under the route's catalog key (two for a `PATCH` that changes status and fields): tickets (create, field update, delete, assign), the six transitions and a `PATCH` that changes status, comments, ticket links, ticket labels, label definitions, projects, agents, roles, role bindings, project members, invites (create, resend, cancel, accept), registration and admin user create and update.
- **The summaries.** Each entry carries a short summary naming what changed (field names, a status move, an assignee), never a value a user typed and never a secret.

The entries are recorded in the service method the route calls, so the assistant tools and the system writers that call the same methods (the assistant tools built by `addCommentTool`, `createTicketsTool`, `updateTicketTool` and `linkTicketsTool`, and the fleet dispatch's `startForDispatch`) are recorded too, under their own action context.

This is the fourth of seven features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order (ruled 2026-10-24): context, context-guard, audit-entry, **audit-core**, audit-fleet, audit-integrations, web.

## Motivation

`permissions-p2-audit-entry` (PR #328, deployed `c22f3037`) delivered the `AuditEntry` table, `AuditRecorder` and `GET /api/audit`, and nothing calls the recorder yet: on koda-wk `GET /api/audit` returns an empty page. The design's inventory (`2026-10-18-permission-action-inventory.tsv`) found that most core writes record no actor at all: project CRUD, label definitions, ticket links, comment edits and deletes, invites resend and cancel, admin user writes, roles and bindings. Others record the wrong one (agent creation and key rotation record the new agent, not the admin who acted). None records the approval block or the on-behalf-of principal.

The core routes are the ones a human uses every day, so they come first. Fleet routes and system writers follow in `permissions-p2-audit-fleet`, and the remaining integrations, the assistant-only tools and the coverage guard in `permissions-p2-audit-integrations`.

**Rulings that bind this feature** (user, 2026-10-24):
- **P2 is seven features**, in order: context, context-guard, audit-entry, audit-core, audit-fleet, audit-integrations, web.
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to audit-integrations.** This feature does not add them.

The user skipped the design questions for this feature ("just skip questions"), so every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The command layer is `AuditRecorder.audited`, not `KodaDomainWriter`.** The design names "a generalised `apps/api/src/koda-domain-writer/`". `KodaDomainWriter`'s only production caller is `AgentsService.recordAgentAction`, and of its three call sites only `suggestTicket` (`GET /agents/:slug/pickup`, `agents.service.ts:316`) passes a project id, so its one live write is the `TICKET_SUGGESTED` agent event. Its methods also carry an access check and an outbox record that no core write needs. A two-argument method on the recorder every writer already needs is the smaller generalisation. `KodaDomainWriter` is left unchanged (see Out of Scope).
- **Record inside an existing transaction; wrap only when there is none.** A method that already owns a `txManager.run` (ticket create, update, delete, assign, the transitions, comment create, ticket label assign and remove, agent create, register, admin user create and update, invite create, invite accept, member add) calls `record` inside that callback. Wrapping it in an outer `audited` instead would break two things. `runWithTicketNumberRetry` re-runs a failed transaction, and a nested `run` that throws poisons the outer one (`PrismaTransactionManager.run`, SEC-16), so the retry could never succeed. And `MembershipService` defers cache invalidation to the outermost commit only inside `afterCommit` scopes.
- **`AuditLogModule` becomes `@Global()`.** Twelve feature modules need the recorder, and `PermissionsModule` is the precedent for a global cross-cutting module. `GlobalStubsModule` (`src/common/test-helpers/global-stubs.module.ts`) provides `mockAuditRecorder`, so module specs that import it keep compiling.
- **`AuditRecorder` is a required constructor dependency.** It is never `@Optional()`: an optional recorder skips the audit silently, the failure this phase exists to remove. `TicketTransitionsService` already documents the same rule for `PermissionService`. Its position is the same in every service: immediately before the first `@Optional()` parameter, or last when the constructor has none. `ProjectsService` is the one exception: its `@Optional()` `hybridRetrieverService` is followed by the required `access`, so `AuditRecorder` goes last, as the fifth parameter. TypeScript does not allow a required parameter after a `?` one, and one fixed rule keeps the positional `new` calls in specs predictable.
- **One entry per action, under the route's key.** The key is the route's `@Requires` key. Where a route takes one of several keys:
  - **Transitions** use `transitionKeyFor(from, to)`. `verify` on a `VERIFY_FIX` ticket is therefore `ticket.transition.verify-fix.approve`, and `verify-fix` is `.approve` or `.return` by target status.
  - **`close`** uses `ticket.transition.close`.
  - **Role bindings** use the most specific key `RoleAdminService.assertBindingKeys` (`role-admin.service.ts:336`) checks: `role.binding.owner` when the role key is `owner` (an owner binding is always global), else `role.binding.global` for a binding with no project, else `role.binding.manage`.
  - **Comment edit and delete, and ticket link remove,** use the route key (`comment.update`, `comment.delete`, `ticket.link.remove`) even when the service allowed the author through the ownership rule; the catalog has no separate `.own` key for them.
- **An empty field patch records nothing.** When `toUpdateData` yields no writable field (a `PATCH` of `{}`, or a status with only dropped keys), no `ticket.update` entry is recorded; the field update and `fieldPatch` paths skip `record` when `fieldsSummary(updateData)` is `undefined`.
- **A `PATCH` that changes status and fields records two entries, in one transaction.** The transition records its edge-key entry (`status: <FROM> -> <TO>`). The field patch `TicketsService.fieldPatch` builds already runs inside the transition's transaction, and it records a `ticket.update` entry with `fieldsSummary(updateData)` after its `updateTicket`. Each key then finds its own change, and `executeTransitionPublic`'s signature does not change. A `PATCH` with fields and no status records only `ticket.update`; a `PATCH` with a status and no fields records only the transition.
- **Every transition has an edge key.** Every pair `TRANSITION_RULES` accepts (`ticket-transitions.ts:14`) has a key in `EDGE_KEYS`, so the transition entry's key is `transitionKeyFor(from, to)`; `close` uses `ticket.transition.close`. There is no fallback key.
- **Flows that create a binding as part of a larger action record only the action.** Member add records `member.add`. Invite create for an existing user records `invite.create`, and invite accept records `invite.accept`. Register, admin user create and agent create record only their create key, not the baseline binding beside it. `MembershipService` itself records nothing.
- **Role-binding routes record inside the binding transaction.** `MembershipService.createBinding` and `removeBinding` gain an optional `onWritten` callback that runs inside their own `txManager.run`, after the insert or delete. `RoleAdminService` passes one that records the entry. Wrapping the call in an outer `audited` would put the concurrent-duplicate retry in `bindRole` (re-read the winner after a unique violation) inside an aborted transaction.
- **Writes that were two transactions become one.**
  - `AgentsService.updateCapabilities` (a `deleteMany` then a `createMany`) runs both writes inside `audited`, so a crash between them no longer leaves an agent with no capabilities.
  - `AgentsService.remove` runs the agent delete and `MembershipService.removeAllBindings` inside `membership.afterCommit(() => audit.audited(…))`, the pattern `ProjectMembersService.add` uses, so the binding cache is invalidated after the outer commit.
- **Only committed writes are recorded.** A refused request (401, 403, 404, 409, 400) writes nothing, so it records nothing. Writes that can find nothing to do record nothing:
  - the idempotent `POST …/links` that finds the link already present;
  - a `POST /role-bindings` whose binding already exists (`insertBinding` returns `changed: false`). Member add and invite create for an existing user refuse an existing member with a 409 under the members lock before `createBinding` runs (`project-members.service.ts:80-81`, `project-invites.service.ts:147`), so they record unconditionally after `createBinding` returns;
  - `updateRole` with an empty patch (it returns before writing, `role-admin.service.ts:177`);
  - `AuthService.register` when it returns `null` without creating a user (`auth.service.ts:94`).
- **A conflict found by the write is thrown inside `audited`.** `ProjectInvitesService.resend` and `cancel` move their "nothing rotated / nothing cancelled" 409 throw (`project-invites.service.ts:115`, `:128`; the status guards at `:108` and `:127` stay outside) inside `audited`'s `fn`, so `entriesOf` never runs for a write that did not happen. `entriesOf` may also return `[]`, which records nothing. Recording refusals is P3's (see Out of Scope).
- **Summaries name what changed, never values.**
  - `fieldsSummary(patch)` (new, `src/audit/audit-summary.ts`) returns `fields: <names>`: the own keys of `patch` whose value is not `undefined`, sorted and joined with `, `. It returns `undefined` when there are none.
  - A title, a description, a comment body, a label name, a project name, a password, an API key, an invite token and a CI webhook token never appear in a summary. The table below is the whole summary contract.
- **`projectId` is the project the row belongs to, or `null` for a global row.** Agents, users, roles and global bindings are `null`. `PATCH /projects/:slug/agents/:agentSlug` writes the global `Agent` row, so its entry has `projectId` `null`, like `PATCH /agents/:slug`. A project's own create, update and delete entries carry the project's id.

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| ticket create | `ticket.create` | `ticket` | ticket id | project id | `created <REF>` (e.g. `created SB-12`) |
| ticket field update | `ticket.update` | `ticket` | ticket id | project id | `fieldsSummary(updateData)` (e.g. `fields: priority, title`) |
| ticket delete | `ticket.delete` | `ticket` | ticket id | project id | `deleted <REF>` |
| ticket assign | `ticket.assign` | `ticket` | ticket id | project id | `assignee: USER <id>`, `assignee: AGENT <id>` or `assignee: none` |
| transition (route, `PATCH` status, dispatch start) | `transitionKeyFor(from, to)`; `close` uses `ticket.transition.close` | `ticket` | ticket id | project id | `status: <FROM> -> <TO>` |
| field patch of a `PATCH` that also changes status | `ticket.update` | `ticket` | ticket id | project id | `fieldsSummary(updateData)` |
| comment create | `comment.create` | `comment` | comment id | project id | `on <REF>` |
| comment update | `comment.update` | `comment` | comment id | project id | `edited` |
| comment delete | `comment.delete` | `comment` | comment id | project id | `deleted` |
| ticket link add | `ticket.link.add` | `ticket-link` | link id | project id | `on <REF>` |
| ticket link remove | `ticket.link.remove` | `ticket-link` | link id | project id | `from <REF>` |
| ticket label assign | `ticket.label.assign` | `ticket` | ticket id | project id | `label <labelId> added` |
| ticket label remove | `ticket.label.remove` | `ticket` | ticket id | project id | `label <labelId> removed` |
| label create / update / delete | `label.create` / `label.update` / `label.delete` | `label` | label id | project id | `created` / `fieldsSummary(dto)` / `deleted` |
| project create / update / delete | `project.create` / `project.update` / `project.delete` | `project` | project id | project id | `created <KEY>` / `fieldsSummary(dto)` / `deleted <KEY>` |
| agent create | `agent.create` | `agent` | agent id | `null` | `created <slug>` |
| agent update (both routes) | `agent.update` | `agent` | agent id | `null` | `fieldsSummary` of the whitelisted update object the service builds (the `data` object, `agents.service.ts:211-216`), not the raw DTO |
| agent capabilities | `agent.capabilities.update` | `agent` | agent id | `null` | `capabilities: <count>` |
| agent delete | `agent.delete` | `agent` | agent id | `null` | `deleted <slug>` |
| agent key rotate | `agent.key.rotate` | `agent` | agent id | `null` | `key rotated` |
| role create / update / delete | `role.manage` | `role` | role id | `null` | `created <key>` / `fieldsSummary(input)` / `deleted <key>` |
| role binding create | binding key (see calls) | `role-binding` | binding id | binding project id or `null` | `<roleKey> to <PRINCIPAL_TYPE> <principalId>` |
| role binding remove | binding key (from the stored binding) | `role-binding` | binding id | binding project id or `null` | `<roleKey> from <PRINCIPAL_TYPE> <principalId>` |
| member add | `member.add` | `role-binding` | binding id | project id | `<roleKey> to <PRINCIPAL_TYPE> <principalId>` |
| invite create, existing user | `invite.create` | `role-binding` | binding id | project id | `<roleKey> to USER <userId>` |
| invite create, new address | `invite.create` | `project-invite` | invite id | project id | `<roleKey> invited` |
| invite resend | `invite.resend` | `project-invite` | invite id | project id | `resent` |
| invite cancel | `invite.cancel` | `project-invite` | invite id | project id | `cancelled` |
| invite accept | `invite.accept` | `project-invite` | invite id | invite project id | `accepted by USER <userId>` |
| register | `auth.register` | `user` | user id | `null` | `registered` |
| admin user create | `user.create` | `user` | user id | `null` | `created` |
| admin user update | `user.update` | `user` | user id | `null` | `fieldsSummary(patch)` |

`<REF>` is the ticket ref (`<project key>-<number>`). `fieldsSummary` returns `undefined` for an empty patch, and the entry is then recorded with no summary. The table never lists a value from a request body: the names it prints are ids, keys, refs, slugs, role keys and statuses.

### The command layer (US-001)

`AuditRecorder` (`src/audit/audit-recorder.service.ts`) gains one method:

```typescript
export type AuditEntriesOf<T> = (result: T) => AuditRecordInput | readonly AuditRecordInput[];

/**
 * Runs `fn` in one transaction and records the entries its result describes, in that transaction.
 * For a write that owns no transaction of its own; a method that already runs `txManager.run`
 * calls `record` inside that callback instead.
 */
async audited<T>(fn: () => Promise<T>, entriesOf: AuditEntriesOf<T>): Promise<T> {
  return this.txManager.run(async () => {
    const result = await fn();
    const entries = entriesOf(result);
    for (const entry of Array.isArray(entries) ? entries : [entries]) await this.record(entry);
    return result;
  });
}
```

- `audited` runs `fn` before it calls `entriesOf`, so the entry can name an id the write created.
- When `fn` rejects, no entry is recorded and the rejection propagates.
- When `entriesOf` returns `[]`, nothing is recorded and `audited` resolves to `fn`'s value.
- When `record` rejects (an unknown key, a storage failure), the transaction rolls back, so the write does not commit either.
- Nested in an open transaction, `txManager.run` joins it, so `audited` inside a caller's transaction records in that transaction.

`src/audit/audit-summary.ts`:

```typescript
/** `fields: a, b` for the own keys of `patch` whose value is not undefined, sorted; undefined when none. Never values. */
export function fieldsSummary(patch: object): string | undefined;
```

`AuditLogModule` gains `@Global()`. `GlobalStubsModule` gains `mockAuditRecorder`, exported, and provides it for `AuditRecorder`:
- `record` is a `vi.fn` resolving `undefined`.
- `audited` is a `vi.fn` implemented as `(fn) => fn()`.

### The writers (US-002 to US-008)

Each service below injects `AuditRecorder` as `private readonly audit: AuditRecorder` and records per the contract table. The integration point of each write:

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-002 | `TicketsService.create` | `runWithTicketNumberRetry` callback, `tickets.service.ts:119` | `record` after `recordTicketEvent`, inside the callback |
| US-002 | `TicketsService.applyUpdate` (field path) | `txManager.run`, `:358` | `record` inside |
| US-002 | `TicketsService.softDelete` | `txManager.run`, `:393` | `record` inside |
| US-002 | `TicketsService.assign` | `txManager.run`, `:431` | `record` inside, after the write |
| US-003 | `TicketTransitionsService.executeTransitionInternal` | `txManager.run`, `ticket-transitions.service.ts:660` | `record` inside, after the status event; this covers `verify`, `start`, `fix`, `verifyFix`, `reject`, `executeTransitionPublic` (the `PATCH` status path) and `startForDispatch` |
| US-003 | `TicketTransitionsService.close` | `txManager.run`, `:488` | `record` inside |
| US-003 | `TicketsService.fieldPatch` (the closure passed to `executeTransitionPublic`) | runs inside the transition's `txManager.run` | `record` `ticket.update` after `updateTicket` |
| US-004 | `CommentsService.create` | `txManager.run`, `comments.service.ts:142` | `record` inside |
| US-004 | `CommentsService.update`, `delete` | one write each, no transaction | wrap the write in `audited` |
| US-004 | `TicketLinksService.create`, `remove` | one write each, no transaction | wrap the write in `audited`; the idempotent existing-link return of `create` stays outside and records nothing. The private `resolveTicket` (`ticket-links.service.ts:26`) returns `{ id, projectId }` today; it also returns `ref` (`<project key>-<ticket number>`; on the CUID path the number comes from `PrismaTicketLinkRepository.findTicketById`, which also selects `number`) for the summary |
| US-004 | `LabelsService.assignToTicket`, `removeFromTicket` | `repo.runInTransaction` (= `txManager.run`), `labels.service.ts:119`, `:172` | `record` inside |
| US-005 | `LabelsService.create`, `update`, `delete` | one write each, no transaction | wrap the write in `audited` |
| US-005 | `ProjectsService.create`, `update`, `softDelete` | one write each, no transaction | wrap the write in `audited`; `softDelete`'s cache clearing stays after the commit |
| US-006 | `AgentsService.generateApiKey` (create branch) | `afterCommit` at `agents.service.ts:114`, `txManager.run` at `:115` | `record` inside the run |
| US-006 | `AgentsService.generateApiKey` (rotate branch, reached through `rotateApiKey`) | one write, no transaction | wrap in `audited`, key `agent.key.rotate` |
| US-006 | `AgentsService.update` | one write, no transaction | wrap in `audited` |
| US-006 | `AgentsService.updateCapabilities` | two writes, no transaction | both inside one `audited` |
| US-006 | `AgentsService.remove` | delete, then `removeAllBindings` in its own transaction | both inside `membership.afterCommit(() => audit.audited(…))` |
| US-007 | `RoleAdminService.createRole`, `updateRole`, `deleteRole` | one write each, no transaction | wrap the write in `audited`, inside the existing `try` so its unique, foreign-key and not-found mapping still sees the error; `permissionCache.invalidate()` stays after `audited` resolves |
| US-007 | `RoleAdminService.createBinding`, `removeBinding` | `MembershipService.bindRole` / `removeBinding` run their own `txManager.run` | pass `onWritten`, which calls `record` inside that transaction |
| US-007 | `ProjectMembersService.add` | `afterCommit(txManager.run)`, `project-members.service.ts:79` | `record` inside the run, after `createBinding` returns |
| US-008 | `ProjectInvitesService.create` | existing user: `txManager.run` `:143`; new address: `txManager.run` `:184` | `record` inside each |
| US-008 | `ProjectInvitesService.resend`, `cancel` | one write each, no transaction | wrap the write and its 409 check in `audited`; the resend email stays after the commit |
| US-008 | `InviteAcceptanceService.accept` | `afterCommit(txManager.run)`, `invite-acceptance.service.ts:69` | `record` inside, after the binding |
| US-008 | `AuthService.register` | `afterCommit(txManager.run)`, `auth.service.ts:87` | `record` inside, only on the path that created a user |
| US-008 | `UsersAdminService.create`, `update` | `afterCommit(txManager.run)`, `users-admin.service.ts:51`, `:80` | `record` inside each |

`MembershipService` (US-007):
- **Baseline:** `createBinding(input, by)` and `removeBinding(id, options)`, where `RemoveBindingOptions` is `{ lastProjectAdminOverride?: boolean }`.
- **Target:** `createBinding(input, by, onWritten?: (binding: RoleBindingView) => Promise<void>)` and `RemoveBindingOptions` adds `onWritten?: (binding: RoleBindingView) => Promise<void>`.
- `onWritten` runs inside the binding's `txManager.run`, after the insert (`insertBinding`) or the delete, with the binding's view. Every existing caller passes none and behaves as before.
- `createBinding` calls `onWritten` only when the insert happened (`outcome.changed` is true). It is not called when `insertBinding` found the binding already present (`changed: false`, `membership.service.ts:290`), nor on the concurrent-duplicate path (`bindRole` returns the winner it re-read, `:190`), because this call wrote nothing.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `audited`: `fn` rejects | no entry recorded; the rejection propagates | US-001 |
| `audited`: `record` rejects (unknown key, storage failure) | the transaction rolls back; the write is not committed; the rejection propagates | US-001 |
| a write route refuses (401, 403, 404, 409, 400) before writing | no `AuditEntry` row | US-002 to US-008 |
| a transition loses its status race (409 from `updateTicketStatusIf`) | no `AuditEntry` row (the transaction rolled back) | US-003 |
| `runWithTicketNumberRetry` retries after a number conflict | the failed attempt's entry rolled back with it; exactly one entry for the created ticket | US-002 |
| `POST …/links` for a link that already exists | 200, no write, no entry | US-004 |
| a binding insert loses the concurrent-duplicate race | the winner is returned; `onWritten` not called; no entry from this call | US-007 |
| a binding already exists (`insertBinding` returns `changed: false`) | the existing binding is returned; `onWritten` not called; no new entry | US-007 |
| `audited`: `entriesOf` returns `[]` | nothing recorded; `fn`'s value returned | US-001 |
| `resend` / `cancel` find nothing to rotate or cancel | the 409 is thrown inside `audited`; no entry | US-008 |
| `record` rejects inside `startForDispatch` | the transition rolls back and `FleetJobTicketEffects.onRunDispatched` (`fleet-job-ticket.effects.ts:42-47`) logs and swallows the error, as it does for any start failure today; the ticket stays unstarted | US-003 |
| `AgentsService.updateCapabilities`: the write or its `record` fails | `replaceCapabilities` and the entry roll back together; the agent keeps its old capabilities | US-006 |

### Integration

Verified at main `c22f3037`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input: AuditRecordInput)`, `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. It throws for a key outside the catalog and outside a transaction.
- `AuditEntry` model and `AuditLogService.list` — `src/audit/`.
- `PrismaTransactionManager.run` joins an open transaction and poisons it when a nested `run` throws — `@nathapp/nestjs-prisma` 4.2.3.
- `transitionKeyFor(from, to)` — `src/tickets/state-machine/transition-keys.ts:36`.
- `runWithTicketNumberRetry(txManager, fn)` — `src/common/utils/ticket-number-retry.ts`.
- `MembershipService.afterCommit(fn)` and `AfterCommitService` — `src/permissions/membership.service.ts`, `src/permissions/after-commit.service.ts`.
- `RoleAdminService.assertBindingKeys` (the binding key rule) — `src/permissions/role-admin.service.ts:336`; `OWNER_ROLE_KEY` — `role-admin.service.ts:69`.
- `withTestActor(actor, fn)`, `fixtureDb(app)` — `test/helpers/action-context.ts`.
- `grantRole`, `grantBaseline` — `src/permissions/test-helpers/permission-fixtures.ts`.
- Route-test precedent: `test/integration/permissions/core-ticket-routes.integration.spec.ts`, `core-ticket-transitions.integration.spec.ts`, `core-comments-labels-watchers.integration.spec.ts`, `core-ticket-links.integration.spec.ts`, `core-project-routes.integration.spec.ts`, `core-agent-routes.integration.spec.ts`, `core-members-invites.integration.spec.ts`, `roles-api.integration.spec.ts`, `role-bindings-api.integration.spec.ts`, `test/integration/users/admin-users.integration.spec.ts`, `test/integration/auth/registration.integration.spec.ts`.

Changed (baseline → target):
- `AuditRecorder` — Baseline: `record` only. Target: `record` and `audited`.
- `AuditLogModule` — Baseline: a plain `@Module`. Target: `@Global() @Module`.
- `GlobalStubsModule` — Baseline: no `AuditRecorder` provider. Target: provides `mockAuditRecorder` for `AuditRecorder`.
- `MembershipService.createBinding` / `removeBinding` — see "The writers".
- The constructors of `TicketsService`, `TicketTransitionsService`, `CommentsService`, `TicketLinksService`, `LabelsService`, `ProjectsService`, `AgentsService`, `RoleAdminService`, `ProjectMembersService`, `ProjectInvitesService`, `InviteAcceptanceService`, `AuthService`, `UsersAdminService` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder` parameter before the first `@Optional()` parameter.

## Out of Scope

- Fleet routes and fleet system writers (jobs, threads, budgets, schedules, runners, repos, approvals, ingest, knowledge) are out of scope (feature `permissions-p2-audit-fleet`).
- VCS, CI webhook, RAG, memory, skills, notifications, webhooks, code-intel, outbox subscribers and the assistant/MCP tools that do not call a core service method are out of scope (feature `permissions-p2-audit-integrations`). Where a VCS or CI-webhook writer calls a core service method this feature audits (`TicketLinksService.create`, a transition), it is recorded under its system context, and the integrations feature owns the ACs for those callers.
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-integrations`).
- Auditing `POST /auth/login`, `/auth/refresh` and `/auth/logout` is out of scope; the coverage feature decides whether session writes are audited or allowlisted with a reason.
- Recording refused or failed attempts (403, 409, validation errors) is out of scope; only committed writes are recorded, and refusal records belong to P3's approval engine.
- Changing `KodaDomainWriter`, removing its unused methods, or auditing its one live write (the `TICKET_SUGGESTED` agent event of `GET /agents/:slug/pickup`) is out of scope; the command layer is `AuditRecorder.audited`, and pickup belongs to `permissions-p2-audit-fleet`.
- Auditing `SystemRoleSeeder`'s writes to `Role` rows is out of scope (a boot-time seeder writing through the repository, feature `permissions-p2-audit-integrations`).
- Auditing the baseline binding that register, admin user create, agent create and invite accept write next to their main row is out of scope; each records one entry for its action.
- Putting any request value (title, description, comment body, label or project name, password, API key, invite token, CI webhook token) into an audit summary is out of scope; summaries carry only the names, ids, refs, keys and statuses in the contract table.
- A before/after diff of values in `AuditEntry` is out of scope; the summary names the fields that changed, not their values.
- Changing `TicketEvent`, `TicketActivity`, `AgentEvent` or outbox payloads is out of scope; they keep their current shapes.
- Changing any route's status codes, response bodies or `@Requires` keys is out of scope; `openapi.json` does not change.
- The web Audit log page is out of scope (feature `permissions-p2-web`).
- US-003 only: a `comment.create` entry for the `Comment` row a comment-bearing transition (`verify`, `fix`, `reject`, `verify-fix`, `close`) writes is out of scope; the transition's entry covers its transaction.
- US-003 only: auditing the after-commit side effects of a transition (auto-index on `CLOSED`, PR creation on `VERIFIED`, webhook dispatch) is out of scope; the entry covers the transition's transaction.
- US-006 only: changing how `AgentsService` invalidates its auth cache is out of scope; it stays after the commit.

## Stories

1. **US-001: `AuditRecorder.audited`, `fieldsSummary` and global wiring** — `Workdir: apps/api` — No dependencies. The `audited` method, the `fieldsSummary` helper, `@Global()` on `AuditLogModule` and the `mockAuditRecorder` stub in `GlobalStubsModule`.
2. **US-002: Ticket create, field update, delete and assign are audited** — `Workdir: apps/api` — Depends on US-001. `TicketsService` records inside its four existing transactions.
3. **US-003: Ticket transitions are audited under their edge key** — `Workdir: apps/api` — Depends on US-002. `TicketTransitionsService.executeTransitionInternal` and `close` record under the edge key (`close` under its route key); a `PATCH` with status and fields also records `ticket.update` from `TicketsService.fieldPatch`.
4. **US-004: Comments, ticket links and ticket labels are audited** — `Workdir: apps/api` — Depends on US-001. `CommentsService`, `TicketLinksService` and the ticket-label half of `LabelsService`.
5. **US-005: Label definitions and projects are audited** — `Workdir: apps/api` — Depends on US-004. The label-definition half of `LabelsService` and `ProjectsService`.
6. **US-006: Agent writes are audited and made atomic** — `Workdir: apps/api` — Depends on US-001. `AgentsService` create, update (both routes), capabilities, delete and key rotation.
7. **US-007: Roles, role bindings and member add are audited** — `Workdir: apps/api` — Depends on US-001. `RoleAdminService`, the `onWritten` callback on `MembershipService`, and `ProjectMembersService.add`.
8. **US-008: Invites, registration and admin user writes are audited** — `Workdir: apps/api` — Depends on US-007. `ProjectInvitesService`, `InviteAcceptanceService`, `AuthService.register` and `UsersAdminService`.

Eight stories, one capability: every story wires the same recorder into a different set of core services, and none is useful as a separate PR. US-003 follows US-002 and US-005 follows US-004 because they share a service file; US-008 follows US-007 because invite create and accept call `MembershipService` beside the callback US-007 adds.

### Context Files

**US-001**
- `apps/api/src/audit/audit-recorder.service.ts`
- `apps/api/src/audit/audit-log.module.ts`
- `apps/api/src/common/test-helpers/global-stubs.module.ts`
- `apps/api/src/permissions/permissions.module.ts`
- `apps/api/test/integration/audit/audit-recorder.rollback.integration.spec.ts`

**US-002**
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/common/utils/ticket-number-retry.ts`
- `apps/api/src/audit/audit-summary.ts` — created by US-001
- `apps/api/test/integration/permissions/core-ticket-routes.integration.spec.ts`
- `apps/api/test/helpers/action-context.ts`

**US-003**
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- `apps/api/src/tickets/state-machine/transition-keys.ts`
- `apps/api/src/tickets/tickets.service.ts`
- `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- `apps/api/test/integration/permissions/core-ticket-transitions.integration.spec.ts`

**US-004**
- `apps/api/src/comments/comments.service.ts`
- `apps/api/src/ticket-links/ticket-links.service.ts`
- `apps/api/src/ticket-links/prisma-ticket-link.repository.ts`
- `apps/api/src/labels/labels.service.ts`
- `apps/api/test/integration/permissions/core-ticket-links.integration.spec.ts`

**US-005**
- `apps/api/src/labels/labels.service.ts`
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/audit/audit-summary.ts` — created by US-001
- `apps/api/test/integration/permissions/core-project-routes.integration.spec.ts`

**US-006**
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/prisma-agent.repository.ts`
- `apps/api/src/projects/projects.controller.ts`
- `apps/api/src/permissions/membership.service.ts`
- `apps/api/test/integration/permissions/core-agent-routes.integration.spec.ts`

**US-007**
- `apps/api/src/permissions/role-admin.service.ts`
- `apps/api/src/permissions/membership.service.ts`
- `apps/api/src/projects/members/project-members.service.ts`
- `apps/api/test/integration/permissions/role-bindings-api.integration.spec.ts`
- `apps/api/test/integration/permissions/roles-api.integration.spec.ts`

**US-008**
- `apps/api/src/projects/invites/project-invites.service.ts`
- `apps/api/src/projects/invites/invite-acceptance.service.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/users/users-admin.service.ts`
- `apps/api/test/integration/permissions/core-members-invites.integration.spec.ts`

### Creates

**US-001**
- `apps/api/src/audit/audit-summary.ts`
- `apps/api/src/audit/audit-summary.spec.ts`
- `apps/api/src/audit/audit-recorder.audited.spec.ts`
- `apps/api/test/integration/audit/audit-recorder.audited.integration.spec.ts`

**US-002**
- `apps/api/test/integration/audit/audit-core-tickets.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-core-transitions.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-core-comments-links-labels.integration.spec.ts`

**US-005**
- `apps/api/test/integration/audit/audit-core-labels-projects.integration.spec.ts`

**US-006**
- `apps/api/test/integration/audit/audit-core-agents.integration.spec.ts`

**US-007**
- `apps/api/test/integration/audit/audit-core-roles-bindings.integration.spec.ts`
- `apps/api/src/permissions/membership.service.on-written.spec.ts`

**US-008**
- `apps/api/test/integration/audit/audit-core-invites-users.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/audit/audit-recorder.service.ts` — gains the audited method; record is unchanged.
- `apps/api/src/audit/audit-log.module.ts` — gains @Global(); its providers and exports are unchanged.
- `apps/api/src/audit/audit-log.module.spec.ts` — holds US-001's global-module AC (a consumer module resolves the real AuditRecorder without importing AuditLogModule); its existing provider and export assertions are kept.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — gains the exported mockAuditRecorder (record resolves undefined, audited runs its fn) and provides it for AuditRecorder; every existing stub is unchanged.

**US-002**
- `apps/api/src/tickets/tickets.service.ts` — injects AuditRecorder and records inside the create, field-update, delete and assign transactions; no existing behaviour or return value changes.
- `apps/api/src/tickets/tickets.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder from global-stubs.module.ts; the existing assertions are kept.
- `apps/api/test/integration/agent-permissions/tickets-agent-permissions.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (mockAuditRecorder from global-stubs.module.ts), because its stub transaction manager reports isInTransaction false and the real recorder would refuse; its assertions are unchanged.
- `apps/api/test/integration/outbox/producer-atomicity.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so TicketsService and TicketTransitionsService resolve without AuditController's guard dependencies; its row-count assertions are unchanged.
- `apps/api/test/integration/tickets/ticket-tenancy.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (mockAuditRecorder from global-stubs.module.ts), because its stub transaction manager reports isInTransaction false and the real recorder would refuse; its assertions are unchanged.
- `apps/api/test/integration/tickets/tickets-status-update.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (mockAuditRecorder from global-stubs.module.ts), because its stub transaction manager reports isInTransaction false and the real recorder would refuse; its assertions are unchanged.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — its direct new TicketsService(...) and new TicketTransitionsService(...) calls pass mockAuditRecorder in the new constructor position (immediately before the first @Optional() parameter); its assertions are unchanged.

**US-003**
- `apps/api/src/tickets/tickets.service.ts` — fieldPatch's closure records a ticket.update entry with fieldsSummary(updateData) after updateTicket, inside the transition's transaction; update's call to executeTransitionPublic is unchanged.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` — injects AuditRecorder before the first @Optional() parameter and records inside executeTransitionInternal's and close's transactions; no existing behaviour or return value changes.
- `apps/api/src/tickets/state-machine/ticket-transitions.service.spec.ts` — its TestingModule or direct construction gains AuditRecorder (mockAuditRecorder) in the new constructor position; the existing assertions are kept.
- `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts` — its direct new TicketTransitionsService(...) passes mockAuditRecorder in the new constructor position, ahead of the optional collaborators; the existing assertions are kept.
- `apps/api/test/integration/vcs/auto-create-pr-on-verified.integration.spec.ts` — its direct new TicketTransitionsService(...) passes an AuditRecorder in the new constructor position, ahead of the optional collaborators; the existing assertions are kept.
- `apps/api/test/integration/rag/rag-close-to-search.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (mockAuditRecorder from global-stubs.module.ts), because its stub transaction manager reports isInTransaction false and the real recorder would refuse; its assertions are unchanged.
- `apps/api/test/integration/tickets/ticket-transition-race.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so TicketTransitionsService resolves without AuditController's guard dependencies; its race assertions are unchanged.

**US-004**
- `apps/api/src/comments/comments.service.ts` — injects AuditRecorder, records inside create's transaction and wraps update and delete in audited; no existing behaviour or return value changes.
- `apps/api/src/comments/comments.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/ticket-links/ticket-links.service.ts` — injects AuditRecorder, wraps create's write and remove in audited, and the private resolveTicket also returns the ticket's KEY-N ref; the idempotent existing-link return and every response are unchanged.
- `apps/api/src/ticket-links/ticket-links.service.spec.ts` — its direct new TicketLinksService(...) passes mockAuditRecorder in the new constructor position, and its findTicketById mocks gain a number field; the existing assertions are kept.
- `apps/api/src/ticket-links/prisma-ticket-link.repository.ts` — findTicketById also selects number, and its return type widens to { id: string; number: number } | null, so resolveTicket can build the KEY-N ref on the CUID path; no other query changes.
- `apps/api/src/labels/labels.service.ts` — injects AuditRecorder and records inside assignToTicket's and removeFromTicket's transactions; no existing behaviour or return value changes.
- `apps/api/src/labels/labels.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/test/integration/agent-permissions/labels-agent-permissions.integration.spec.ts` — its TestingModule providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (mockAuditRecorder from global-stubs.module.ts), because its stub transaction manager reports isInTransaction false and the real recorder would refuse; its assertions are unchanged.

**US-005**
- `apps/api/src/labels/labels.service.ts` — wraps the create, update and delete label writes in audited; the ticket-label methods are as US-004 left them.
- `apps/api/src/projects/projects.service.ts` — injects AuditRecorder and wraps create, update and softDelete's writes in audited; softDelete's cache clearing stays after the commit.
- `apps/api/src/projects/projects.service.spec.ts` — its direct new ProjectsService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/test/unit/projects/projects-find-all-for-principal.spec.ts` — its direct new ProjectsService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/src/projects/projects-brief.routes.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder so ProjectsService resolves; the existing assertions are kept.
- `apps/api/test/unit/projects/projects-conflict-responses.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder so ProjectsService resolves; the existing assertions are kept.

**US-006**
- `apps/api/src/agents/agents.service.ts` — injects AuditRecorder, records inside create's transaction, wraps rotate, update and updateCapabilities in audited, and runs remove's delete and removeAllBindings in one afterCommit(audited) block; responses are unchanged.
- `apps/api/src/agents/agents.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; assertions that remove calls removeAllBindings after the delete are kept, and an assertion that the two run in separate transactions, if any, changes to one audited block.
- `apps/api/src/agents/agents-create.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/agents/agents-create.routes.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/agents/agents-pickup.routes.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.

**US-007**
- `apps/api/src/permissions/membership.service.ts` — createBinding and RemoveBindingOptions gain the optional onWritten callback, run inside the binding transaction only when a row was inserted or deleted; callers that pass none behave as before.
- `apps/api/src/permissions/role-admin.service.ts` — injects AuditRecorder, wraps createRole's, updateRole's (after its empty-patch return) and deleteRole's write in audited, and passes onWritten from createBinding and removeBinding; checks and responses are unchanged.
- `apps/api/src/permissions/role-admin.service.spec.ts` — its direct new RoleAdminService(...) passes mockAuditRecorder in the new constructor position; assertions on the arguments passed to membership.createBinding and membership.removeBinding accept the added onWritten callback; the rest are kept.
- `apps/api/src/permissions/role-admin.service.removal-override.spec.ts` — its direct new RoleAdminService(...) passes mockAuditRecorder; assertions on the options passed to membership.removeBinding accept the added onWritten field; the lastProjectAdminOverride assertions are kept.
- `apps/api/src/projects/members/project-members.service.ts` — injects AuditRecorder and records member.add inside add's transaction; no existing behaviour changes.
- `apps/api/src/projects/members/project-members.service.spec.ts` — its direct new ProjectMembersService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/src/projects/members/project-members.module.spec.ts` — its FakeGlobalsModule gains { provide: AuditRecorder, useValue: mockAuditRecorder } (exported) so the real ProjectMembersService resolves; the existing assertions are kept.
- `apps/api/src/permissions/permissions.module.spec.ts` — its PermissionStubsModule gains { provide: AuditRecorder, useValue: mockAuditRecorder } (exported) so the real RoleAdminService resolves; the existing assertions are kept.
- `apps/api/src/permissions/permissions-owner-bootstrap.spec.ts` — the stub module stubsFor builds gains { provide: AuditRecorder, useValue: mockAuditRecorder } (exported) so the real RoleAdminService resolves; the existing assertions are kept.

**US-008**
- `apps/api/src/projects/invites/project-invites.service.ts` — injects AuditRecorder, records inside both create transactions, and wraps resend's and cancel's write together with their 409 check in audited; emails stay after the commit and the responses are unchanged.
- `apps/api/src/projects/invites/project-invites.service.spec.ts` — its direct new ProjectInvitesService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/src/projects/invites/invite-acceptance.service.ts` — injects AuditRecorder and records invite.accept inside accept's transaction; no existing behaviour changes.
- `apps/api/src/projects/invites/invite-acceptance.service.spec.ts` — its direct new InviteAcceptanceService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/src/auth/auth.service.ts` — injects AuditRecorder and records auth.register inside register's transaction on the path that created a user; no existing behaviour changes.
- `apps/api/src/auth/auth.service.spec.ts` — its TestingModule providers gain AuditRecorder with mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/users/users-admin.service.ts` — injects AuditRecorder and records inside create's and update's transactions; no existing behaviour changes.
- `apps/api/src/users/users-admin.service.spec.ts` — its direct new UsersAdminService(...) passes mockAuditRecorder in the new constructor position; the existing assertions are kept.
- `apps/api/src/users/users.module.spec.ts` — its FakeGlobalsModule gains { provide: AuditRecorder, useValue: mockAuditRecorder } (exported) so the real UsersAdminService resolves; the existing assertions are kept.

### Seams

- US-002 to US-008 consume US-001's `AuditRecorder.audited` and `fieldsSummary`, and the existing `AuditRecorder.record`. Their integration ACs call the named REST route through the booted `AppModule` and assert the stored `AuditEntry` row (key, resource, project, actor, origin, summary), so they prove the route reaches the recorder through the real wiring rather than a stub.
- US-007's `onWritten` callback on `MembershipService.createBinding` and `removeBinding` is consumed by `RoleAdminService` in the same story. Its unit AC captures the callback passed to `membership.createBinding` and asserts it records the binding entry; its integration ACs prove the route reaches it.
- US-003's dispatch path is triggered through the existing fleet seam (`FleetJobTicketEffects` → `startForDispatch`); its AC asserts the stored entry's actor is the context the dispatch runs under.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database, create their fixtures with `fixtureDb(app)` and `grantRole` / `grantBaseline`, call the route over HTTP with a token for the acting principal, and read `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. Every fixture id is created by the spec itself, never a fixed string, so entries from other specs cannot collide. Transition routes that require a comment (`verify`, `fix`, `reject`, `verify-fix`) are called with a `body`; `verify-fix` approves with the query `?approve=true` and returns without it. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource returns an empty array.

### US-001: `AuditRecorder.audited`, `fieldsSummary` and global wiring

1. [unit] `AuditRecorder.audited(fn, entriesOf)` with a stub transaction manager whose `run` calls its callback and whose `isInTransaction` returns true calls `fn` once, then calls `entriesOf` with `fn`'s resolved value, then calls the stub storage's `record` once per entry `entriesOf` returned, and resolves to `fn`'s value.
2. [unit] When `fn` rejects with an error, `audited` rejects with that same error and neither `entriesOf` nor the storage's `record` is called.
3. [unit] With a stub transaction manager whose `isInTransaction` returns true only while its `run` callback executes, `audited` calls `txManager.run` exactly once and the storage's `record` is called while `isInTransaction` is true.
4. [integration] Inside `withTestActor({ type: 'USER', id: <user id> }, …)`, `app.get(AuditRecorder).audited` with a `fn` that creates a `Label` and an `entriesOf` naming key `label.create` and the label's id leaves one `Label` row and one `AuditEntry` row with `key` `label.create` and `resourceId` the label's id.
5. [integration] When `entriesOf` returns an entry with key `not.a.catalog.key`, `audited` rejects with `Error('unknown audit key: not.a.catalog.key')` and the `Label` row `fn` created is not in the database afterwards.
6. [integration] When `audited` is called inside an open `txManager.run` that then throws, neither the row `fn` wrote nor the `AuditEntry` remains (it joined the outer transaction).
7. [unit] `fieldsSummary({ title: 'x', priority: 'HIGH' })` returns `'fields: priority, title'`.
8. [unit] `fieldsSummary({ title: 'x', description: undefined })` returns `'fields: title'`, and `fieldsSummary({})` returns `undefined`.
9. [unit] `fieldsSummary({ title: 'secret-title' })` returns a string that does not include `secret-title`.
10. [unit] Compiling a `TestingModule` that imports `GlobalStubsModule` and provides a class whose constructor takes `AuditRecorder` resolves that class, and the injected recorder is `mockAuditRecorder`.
11. [unit] A `TestingModule` that imports `AuditLogModule`, a local `@Global()` stub module providing `PrismaService`, `TRANSACTION_MANAGER` and `PermissionService` (the last for `AuditController`'s `RequiresGuard`), and a second module that provides a class taking `AuditRecorder` without importing `AuditLogModule`, compiles and resolves that class with the real `AuditRecorder`, because `AuditLogModule` is global.
12. [unit] When `entriesOf` returns `[]`, `audited` resolves to `fn`'s value and the storage's `record` is not called.

### US-002: Ticket create, field update, delete and assign are audited

1. [integration] `POST /api/projects/:slug/tickets` as a user holding `ticket.create` returns 201 and leaves one entry for the new ticket's id with `key` `ticket.create`, `resourceType` `ticket`, `projectId` the project's id, `actorType` `USER`, `actorId` the user's id and `origin` `rest`.
2. [integration] That entry's `summary` is `created <ref>`, where `<ref>` is the ticket ref the response returns.
3. [integration] `POST /api/projects/:slug/tickets` as an agent holding `ticket.create` leaves an entry with `actorType` `AGENT` and `actorId` the agent's id.
4. [integration] `POST /api/projects/:slug/tickets` as a user without `ticket.create` returns 403 and leaves no `AuditEntry` row with `key` `ticket.create` and `projectId` the project's id.
5. [integration] `PATCH /api/projects/:slug/tickets/:ref` with body `{ title: 'New title', priority: 'HIGH' }` and no status returns 200 and leaves one entry for the ticket with `key` `ticket.update` and `summary` `fields: priority, title`.
6. [integration] The `ticket.update` entry left by `PATCH /api/projects/:slug/tickets/:ref` with body `{ title: 'New title' }` has a `summary` that does not include `New title`.
7. [integration] `DELETE /api/projects/:slug/tickets/:ref` returns the route's success status and leaves one entry for the ticket with `key` `ticket.delete` and `summary` `deleted <ref>`.
8. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ userId: <member id> }` leaves one entry for the ticket with `key` `ticket.assign` and `summary` `assignee: USER <member id>`.
9. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{ agentId: <rostered agent id> }` leaves an entry with `summary` `assignee: AGENT <agent id>`.
10. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with `{}` leaves an entry with `summary` `assignee: none`.
11. [integration] `POST /api/projects/:slug/tickets/:ref/assign` with both `userId` and `agentId` returns 400 and adds no `ticket.assign` entry for the ticket.
12. [unit] `TicketsService.create`, with a stub ticket repository whose first `createTicket` rejects with a `projectId, number` unique violation and whose second resolves, calls the recorder's `record` with key `ticket.create` only after the successful attempt, and `record` runs inside the transaction callback that created the ticket.

### US-003: Ticket transitions are audited under their edge key

1. [integration] `POST /api/projects/:slug/tickets/:ref/verify` on a `CREATED` ticket returns the route's success status and leaves one entry for the ticket with `key` `ticket.transition.verify` and `summary` `status: CREATED -> VERIFIED`.
2. [integration] `POST …/start` on a `VERIFIED` ticket leaves an entry with `key` `ticket.transition.start` and `summary` `status: VERIFIED -> IN_PROGRESS`.
3. [integration] `POST …/fix` on an `IN_PROGRESS` ticket leaves an entry with `key` `ticket.transition.fix` and `summary` `status: IN_PROGRESS -> VERIFY_FIX`.
4. [integration] `POST …/verify-fix?approve=true` with a `body` on a `VERIFY_FIX` ticket (target `CLOSED`) leaves an entry with `key` `ticket.transition.verify-fix.approve`.
5. [integration] `POST …/verify-fix` with a `body` and no `approve` query on a `VERIFY_FIX` ticket (target `IN_PROGRESS`) leaves an entry with `key` `ticket.transition.verify-fix.return`.
6. [integration] `POST …/verify` on a `VERIFY_FIX` ticket leaves an entry with `key` `ticket.transition.verify-fix.approve`, the edge key, not `ticket.transition.verify`.
7. [integration] `POST …/reject` on a `CREATED` ticket leaves an entry with `key` `ticket.transition.reject` and `summary` `status: CREATED -> REJECTED`.
8. [integration] `POST …/close` leaves one entry for the ticket with `key` `ticket.transition.close` and `summary` `status: <from> -> CLOSED`.
9. [integration] `PATCH /api/projects/:slug/tickets/:ref` with `{ status: 'IN_PROGRESS', priority: 'LOW' }` on a `VERIFIED` ticket leaves an entry for the ticket with `key` `ticket.transition.start` and `summary` `status: VERIFIED -> IN_PROGRESS`.
10. [integration] The same `PATCH` (`{ status: 'IN_PROGRESS', priority: 'LOW' }` on a `VERIFIED` ticket) also leaves exactly one entry for the ticket with `key` `ticket.update` and `summary` `fields: priority`, and exactly two entries for the ticket in total.
11. [integration] `POST …/verify` with a `body` on a `CREATED` ticket, while `PrismaTicketsRepository.updateTicketStatusIf` is spied to resolve `null` once (a lost status race), returns 409 and leaves no entry for the ticket and no new `Comment` row on it.
12. [integration] `POST …/fix` on a `CREATED` ticket (refused by the state machine) adds no entry for the ticket.
13. [integration] `startForDispatch` reached through `FleetJobTicketEffects`, run inside `runAsSystem('schedule', …)` on a `VERIFIED` ticket, leaves an entry with `key` `ticket.transition.start`, `actorType` `SYSTEM` and `actorId` `schedule`.
14. [integration] `FleetJobTicketEffects.onRunDispatched` for a `VERIFIED` ticket, while `app.get(AuditRecorder).record` is spied to reject, resolves without throwing, the ticket's status is still `VERIFIED`, and no entry exists for the ticket.

### US-004: Comments, ticket links and ticket labels are audited

1. [integration] `POST /api/projects/:slug/tickets/:ref/comments` with body `{ body: 'hello secret' }` returns 201 and leaves one entry for the new comment's id with `key` `comment.create`, `resourceType` `comment`, `projectId` the project's id and `summary` `on <ref>`.
2. [integration] The `comment.create` entry left by `POST /api/projects/:slug/tickets/:ref/comments` with body `{ body: 'hello secret' }` has a `summary` that does not include `hello secret`.
3. [integration] `PATCH /api/comments/:id` by the comment's author leaves one entry for the comment with `key` `comment.update` and `summary` `edited`.
4. [integration] `PATCH /api/comments/:id` by a member who is not the author and holds no override key returns 403 and adds no `comment.update` entry for the comment.
5. [integration] `DELETE /api/comments/:id` by the author leaves one entry for the comment with `key` `comment.delete` and `summary` `deleted`.
6. [unit] `CommentsService.update` with a stub recorder calls `audited` once, and the comment repository's `update` is called inside `audited`'s `fn`.
7. [integration] `POST /api/projects/:slug/tickets/:ref/links` with a new URL returns 201 and leaves one entry for the new link's id with `key` `ticket.link.add`, `resourceType` `ticket-link` and `summary` `on <ref>`.
8. [integration] Repeating that `POST` with the same URL returns 200 and leaves still exactly one `ticket.link.add` entry for that link.
9. [integration] `DELETE /api/projects/:slug/tickets/:ref/links/:linkId` leaves one entry for the link with `key` `ticket.link.remove` and `summary` `from <ref>`.
10. [integration] `POST /api/projects/:slug/tickets/:ref/labels` with `{ labelId }` leaves one entry for the ticket with `key` `ticket.label.assign` and `summary` `label <labelId> added`.
11. [integration] `DELETE /api/projects/:slug/tickets/:ref/labels/:labelId` leaves one entry for the ticket with `key` `ticket.label.remove` and `summary` `label <labelId> removed`.
12. [integration] `POST /api/projects/:slug/tickets/:ref/links` where `:ref` is the ticket's CUID id (not its `KEY-N` ref) leaves an entry whose `summary` is `on <KEY>-<number>`, the ticket's `KEY-N` ref.

### US-005: Label definitions and projects are audited

1. [integration] `POST /api/projects/:slug/labels` with `{ name: 'secret-name', color }` returns 201 and leaves one entry for the new label's id with `key` `label.create`, `resourceType` `label`, `projectId` the project's id and `summary` `created`.
2. [integration] `PATCH /api/projects/:slug/labels/:id` with `{ name: 'renamed' }` leaves one entry for the label with `key` `label.update` and `summary` `fields: name`.
3. [integration] `DELETE /api/projects/:slug/labels/:id` leaves one entry for the label with `key` `label.delete` and `summary` `deleted`.
4. [integration] The `label.create` entry left by `POST /api/projects/:slug/labels` with `{ name: 'secret-name' }` and the `label.update` entry left by `PATCH /api/projects/:slug/labels/:id` with `{ name: 'renamed' }` have summaries that include neither `secret-name` nor `renamed`.
5. [integration] `POST /api/projects` as a user holding `project.create` returns 201 and leaves one entry for the new project's id with `key` `project.create`, `resourceType` `project`, `projectId` the new project's id and `summary` `created <KEY>`.
6. [integration] `PATCH /api/projects/:slug` with `{ name: 'Renamed', description: 'd' }` leaves one entry for the project with `key` `project.update` and `summary` `fields: description, name`.
7. [integration] `PATCH /api/projects/:slug` with `{ ciWebhookToken: <a random token> }` leaves an entry with `summary` `fields: ciWebhookToken`, which does not include the token value.
8. [integration] `DELETE /api/projects/:slug` leaves one entry for the project with `key` `project.delete` and `summary` `deleted <KEY>`.
9. [integration] `DELETE /api/projects/:slug` as a member without `project.delete` returns 403 and adds no `project.delete` entry for the project.
10. [unit] `ProjectsService.softDelete` with a stub recorder whose `audited` runs its `fn` calls the RAG cache clearing after `audited` resolves, not inside its `fn`.

### US-006: Agent writes are audited and made atomic

1. [integration] `POST /api/agents` as a global admin returns the route's success status and leaves one entry for the new agent's id with `key` `agent.create`, `resourceType` `agent`, `projectId` `null`, `actorType` `USER`, `actorId` the admin's id and `summary` `created <slug>`.
2. [integration] The `agent.create` entry left by `POST /api/agents` has a `summary` that does not include the raw API key that response returns.
3. [integration] `POST /api/agents/:slug/rotate-key` leaves one entry for the agent with `key` `agent.key.rotate`, `actorId` the admin's id (not the agent's) and `summary` `key rotated`, and the `summary` does not include the new raw key.
4. [integration] `PATCH /api/agents/:slug` with `{ name: 'Renamed' }` leaves one entry for the agent with `key` `agent.update` and `summary` `fields: name`.
5. [integration] `PATCH /api/projects/:slug/agents/:agentSlug` that updates the agent leaves one entry for the agent with `key` `agent.update` and `projectId` `null`.
6. [integration] `PATCH /api/agents/:slug/update-capabilities` with three capabilities leaves one entry for the agent with `key` `agent.capabilities.update` and `summary` `capabilities: 3`.
7. [unit] `AgentsService.updateCapabilities` with a stub recorder whose `audited` runs its `fn` calls `audited` once, and the agent repository's `replaceCapabilities` is called inside that `fn`.
8. [integration] `PATCH /api/agents/:slug/update-capabilities` with three new capabilities, while `app.get(AuditRecorder).record` is spied to reject, returns an error status and leaves the agent's previous capabilities in the database.
9. [integration] `DELETE /api/agents/:slug` for an agent with a project binding and no open tickets leaves the agent and its bindings deleted and one entry for the agent with `key` `agent.delete` and `summary` `deleted <slug>`.
10. [unit] `AgentsService.remove` with stub collaborators calls `membership.afterCommit` once, and the agent delete and `membership.removeAllBindings` both run inside the one `audited` `fn` it wraps.
11. [integration] `DELETE /api/agents/:slug` as a user without `agent.delete` returns 403 and adds no `agent.delete` entry for the agent.

### US-007: Roles, role bindings and member add are audited

1. [integration] `POST /api/roles` as an owner returns 201 and leaves one entry for the new role's id with `key` `role.manage`, `resourceType` `role`, `projectId` `null` and `summary` `created <role key>`.
2. [integration] `PATCH /api/roles/:id` with `{ name: 'Renamed' }` on a custom (non-system) role created by the spec leaves one entry for the role with `key` `role.manage` and `summary` `fields: name`.
3. [integration] `DELETE /api/roles/:id` for an unbound role leaves one entry for the role with `key` `role.manage` and `summary` `deleted <role key>`.
4. [integration] `POST /api/role-bindings` binding a project role to a user in a project leaves one entry for the new binding's id with `key` `role.binding.manage`, `resourceType` `role-binding`, `projectId` that project's id and `summary` `<role key> to USER <user id>`.
5. [integration] `POST /api/role-bindings` binding a global role (`projectId` absent) leaves an entry with `key` `role.binding.global` and `projectId` `null`.
6. [integration] `POST /api/role-bindings` binding the `owner` role leaves an entry with `key` `role.binding.owner`.
7. [integration] `DELETE /api/role-bindings/:id` for a project binding leaves one entry for that binding id with `key` `role.binding.manage` and `summary` `<role key> from <PRINCIPAL_TYPE> <principal id>`.
8. [integration] `DELETE /api/role-bindings/:id` refused by the last-Project-Admin guard returns its error status and adds no entry for that binding id.
9. [unit] `RoleAdminService.createBinding` with stub collaborators passes a third argument to `membership.createBinding`; calling that captured callback with a binding view calls the recorder's `record` with the binding's id as `resourceId` and the binding key as `key`.
10. [unit] `MembershipService.createBinding(input, by, onWritten)` with a stub transaction manager and a stub binding repository whose `findExisting` returns null calls `onWritten` once, with the inserted binding's view, inside the `txManager.run` callback that inserted it.
11. [unit] `MembershipService.createBinding(input, by, onWritten)` when the binding repository's `findExisting` returns an existing row resolves to that row's view and does not call `onWritten`; on the concurrent-duplicate path (the insert rejects with a `principalId` unique violation and the winner is re-read) it also does not call `onWritten`.
12. [unit] `MembershipService.removeBinding(id, { onWritten })` calls `onWritten` once, with the deleted binding's view, inside the delete's `txManager.run` callback.
13. [integration] Repeating the same `POST /api/role-bindings` (same role, principal and project) after it succeeded returns the existing binding and leaves still exactly one entry for that binding id.
14. [integration] `POST /api/projects/:slug/members` returns 201 and leaves one entry with `key` `member.add`, `resourceType` `role-binding`, `resourceId` the created binding's id, `projectId` the project's id and `summary` `<role key> to <PRINCIPAL_TYPE> <principal id>`, and no `role.binding.manage` entry for that binding.

### US-008: Invites, registration and admin user writes are audited

1. [integration] `POST /api/projects/:slug/invites` for an address with no account returns 201 and leaves one entry for the new invite's id with `key` `invite.create`, `resourceType` `project-invite`, `projectId` the project's id and `summary` `<role key> invited`.
2. [integration] The `invite.create` entry left by `POST /api/projects/:slug/invites` for an address with no account has a `summary` that does not include the invited email address or the invite token.
3. [integration] `POST /api/projects/:slug/invites` for an address that has an account leaves one entry with `key` `invite.create`, `resourceType` `role-binding`, `resourceId` the created binding's id and `summary` `<role key> to USER <user id>`.
4. [integration] `POST /api/projects/:slug/invites/:id/resend` leaves one entry for the invite with `key` `invite.resend` and `summary` `resent`.
5. [integration] `DELETE /api/projects/:slug/invites/:id` leaves one entry for the invite with `key` `invite.cancel` and `summary` `cancelled`.
6. [unit] `ProjectInvitesService.resend` with a stub recorder whose `audited` runs its `fn` and a stub invite repository whose `rotate` resolves `null` rejects with a 409, and `cancel` with a stub `cancel` resolving `false` rejects with a 409; in both cases the throw happens inside `audited`'s `fn`, so `entriesOf` is not called.
7. [integration] `POST /api/invites/:token/accept` with a valid token returns the route's success status and leaves one entry for the invite with `key` `invite.accept`, `projectId` the invite's project id, `actorType` `SYSTEM`, `actorId` `anonymous` and `summary` `accepted by USER <new user id>`.
8. [integration] A replayed `POST /api/invites/:token/accept` for an already-accepted invite returns its error status and leaves still exactly one `invite.accept` entry for the invite.
9. [integration] `POST /api/auth/register` (registration open, a new email) returns the route's success status and leaves one entry for the new user's id with `key` `auth.register`, `resourceType` `user`, `projectId` `null`, `actorType` `SYSTEM`, `actorId` `anonymous` and `summary` `registered`.
10. [integration] `POST /api/admin/users` as a global admin returns 201 and leaves one entry for the new user's id with `key` `user.create`, `actorType` `USER`, `actorId` the admin's id and `summary` `created`.
11. [integration] `PATCH /api/admin/users/:id` with `{ disabled: true }` leaves one entry for the user with `key` `user.update` and `summary` `fields: disabled`.
12. [integration] The `auth.register` entry left by `POST /api/auth/register` and the `user.create` entry left by `POST /api/admin/users` each have a `summary` that does not include the password, email or name sent in that request body.
13. [integration] `POST /api/admin/users` as a user without `user.create` returns 403 and adds no `user.create` entry.
