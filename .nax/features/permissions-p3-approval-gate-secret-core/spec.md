# SPEC: Permissions P3e-7 — Redeemable Approvals for Secret-Bearing Writes, Piloted on Agent Keys and Admin User Create

## Summary

This feature starts the `gate-secret` rollout. It gives the approval engine a **redeem** mode and gates three secret-bearing REST routes with it: `POST /agents`, `POST /agents/:slug/rotate-key` and `POST /admin/users`.

A redeem request differs from every request 5a to 5d-2 opened:
- **The stored input carries no secret.** A redeem command may declare `redact(input)`. The gate stores the redacted input in `ApprovalRequest.input` and hashes that. A request body's secret (the new user's `password`) never reaches the database, and the deciders never see it.
- **Approving does not execute it.** The request stays `approved`. Its `expiresAt` restarts: the deadline is the approval time plus the request's own timeout.
- **The requester redeems it.** The requester repeats the same call with the header `X-Koda-Approval-Request: <request id>`. The engine checks the redacted body against the stored hash, runs the command inside that call, and answers the command's raw result. A one-time secret (an agent's API key) goes straight back to the caller. `ApprovalRequest.result` stores only the `toResult` projection, which drops the secret.
- **An unredeemed approval expires.** The expiry sweeper settles an `approved` redeem request whose `expiresAt` passed as `expired`, and the stale-approved retry never re-executes one.

Nothing waits under the shipped defaults: `agent.create`, `agent.key.rotate` and `user.create` are `medium` with catalog default `none`. A request waits only when an approval policy names the key, and a human caller always executes at once.

After this feature the contract counts 118 gated routes (115 + 3). The allowlist (`PENDING_GATE_ROUTES`) and `SECRET_GATE_ROUTES` hold the 8 remaining secret routes, all under `gate-secret`.

This is feature 6a of P3 in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). Feature 6b (`permissions-p3-approval-gate-secret-routes`) gates the other 8 routes and the `PATCH /projects/:slug` CI-token change with the same mode.

## Motivation

5a to 5d-2 gated 115 routes. The 11 routes left on `PENDING_GATE_ROUTES` take or return a secret. Gating them like the others would leak it:
- a deferred request stores its body in `ApprovalRequest.input`, and its answer in `ApprovalRequest.result`;
- `GET /api/approvals/:id` shows both to the requester and to every principal who may decide the request.

So `POST /admin/users` under a wait policy would store the temporary password in plain JSON, and `POST /agents` would store the new API key. That is why 5b and 5c-2 left them out.

**Rulings that bind this feature** (user, 2026-10-29):
- The mechanism is **redeem**: secret fields are removed from the stored input; approval leaves the request approved without executing it; the requester re-sends the same call with the approval id and the full body; it executes in that call, the one-time secret is answered directly, and the stored result has it redacted. No secret reaches the database and no new key is introduced. The rejected alternatives: sealing secrets under a new key, and making the routes non-deferrable.
- `gate-secret` is two features. This feature (6a) carries the engine mode and the agent create, agent rotate-key and admin user create pilots. 6b carries the remaining 8 routes, the `PATCH /projects/:slug` CI-token fold-in, and empties the allowlist.
- The redeem window is the request's own ask timeout: on approval `expiresAt` becomes the decision time plus the request's original `expiresAt − createdAt`. There is no new setting or column for it.
- The story list (7 stories) below.
- Designer calls accepted with the story list: the approval id travels in a header, not the body; a human caller executes at once and never opens a request, as today; a retry without the header after approval opens a new request and the approved one expires; cancelling an approved, unredeemed request is out of scope.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The redeem flag is a column.** `ApprovalRequest.redeem BOOLEAN NOT NULL DEFAULT false` (migration `20261109090000_approval_request_redeem`). The sweeper's due scan and the stale-approved retry are SQL queries, and the command registry is not visible to them. On the domain record the flag is optional, `redeem?: true`, like `variant`: absent means false, so the many in-memory `ApprovalRequestRecord` fixtures stay valid.
- **`ApprovalExecutionService.execute` is the one choke point for approve paths.** Five callers execute a request after approving it (the decide route, `ApprovalDecisionService.decide`, `ApprovalRouteCommands`' deferred decision, the fleet `ApprovalsService` and `FleetApprovalRouteCommands`), plus the sweeper. `execute` answers a redeem request unchanged, after its `approved` check, and runs nothing. None of those callers changes. The decide route therefore answers the request with status `approved`.
- **Redemption is a separate method**, `ApprovalExecutionService.redeem(requestId, call, now?)`. It reuses `run` and `executeOnce` (the serialised slot, the row lock, `lockProjectSlug`, `prepare`, `withExecution`, the settle and the follow-up). It does not reuse `precheck`, because it parses the re-sent body, not the stored one.
- **Redeem checks, in order:**
  1. the request exists, its actor is the caller's actor and it has no on-behalf-of principal. Otherwise `ApprovalRequestNotFoundError`, so a request that is not the caller's reads as missing.
  2. the request has `redeem: true` and the caller's key, variant and project are the request's. Otherwise `ApprovalRedeemMismatchError` (new).
  3. the status is `approved`. Otherwise `ApprovalRequestNotPendingError(status)`.
  4. `expiresAt` is later than `now`. Otherwise `ApprovalRequestExpiredError`.
  5. the command is still registered for the pair. Otherwise `ApprovalRedeemMismatchError`.
  6. `command.parse(input)` succeeds; its own error (a 400) propagates.
  7. `approvalInputHash(freezeApprovalInput(redact(parsed)))` equals `inputHash`. Otherwise `ApprovalRedeemMismatchError`, and nothing runs.
- **No extra key re-check before the redemption.** `ApprovalRouteGate.run` checks that the caller holds the key in the same call, just before `redeem`, and the caller is the request's actor (check 1). `executeOnce`'s existing post-`prepare` re-check still runs for a command with a `prepare` (the user create), as for any execution.
- **A failed redemption answers the command's own error.** When `prepare` or the command throws, the request settles `failed` (`{ error: 'execution-failed', name }`, as today), and `redeem` rejects with the original error instance. The caller sees the same answer an immediate call gives (409 `agents` for a taken slug). `executeOnce` reports the error it caught; `execute` keeps ignoring it.
- **The redemption runs in the request's context**, `requestContext(request)`, as an approved execution does. So its audit entries carry the approval (required mode, satisfied by, approver, request id).
- **The approval id header is read with Nest's `@Headers(APPROVAL_REDEEM_HEADER)`.** `APPROVAL_REDEEM_HEADER = 'x-koda-approval-request'` (lower case, as Fastify and Express present header names). There is no format check: an unknown value reads as a missing request (404). An empty value is treated as absent: `ApprovalRouteGate.run` takes the redeem branch only for a non-empty `redeem`.
- **`toDomain` destructures `redeem` out of the row** with the other renamed columns and spreads `redeem: true` back only when the column is true, so a row read back never carries `redeem: false`.
- **The registry's parse contract is scoped.** The `ApprovalCommand.parse` doc comment ("an approved request re-parses the input frozen when it was opened") gains: a redeem command's stored input is redacted and is never re-parsed; `precheck` and `parseFrozenInput` are never reached for a redeem row (its command has no `parseDecision` or `onReject`).
- **`@ApprovalGated({ redeem: true })` documents the header** with `@ApiHeader({ name: 'X-Koda-Approval-Request', required: false, description })`. `@ApprovalGated()` with no options is unchanged.
- **Agent cache eviction moves after commit.** `AgentsService.generateApiKey` evicts the agent's auth cache (`invalidateByTag`) inline today, on both create and rotate. Inside a deferred execution, that eviction would run before the commit, and a concurrent auth read could re-cache the old key hash for one TTL. Both branches use the existing `invalidateAfterCommit(agentId)`. With no scope open, it runs at once, as today.
- **The admin user create hashes outside the transaction.** `UsersAdminService.prepareCreate(dto)` (new) normalises the email, refuses a taken one (409 `users`) and runs `bcrypt.hash`. It answers a callback that writes the user, its baseline binding and the audit entry. `create(dto)` becomes `(await this.prepareCreate(dto))()`. The command's `prepare` uses `prepareCreate`, so bcrypt (cost 12) never runs inside the execution transaction. The callback keeps today's unique-violation catch (409 `users`), so a concurrent create of the same email is still refused.
- **The rotate route reads its target first**, as 5c-2's `agent.delete` does: `findBySlug(slug)` before the gate (404 `agents` as today), and the input carries `{ slug, agentId }`. The command rotates `agentId`, so a slug reused after the request opened is not rotated.
- **Each pilot story removes its own rows** from `PENDING_GATE_ROUTES` and `SECRET_GATE_ROUTES`. US-006 sets the exact counts to its own state (117 gated routes, 9 allowlist rows); US-007 sets them to 118 and 8.

### The redeem lifecycle

```
agent:  POST /api/agents {name, slug}                     -> 202 { id: r1, status: pending, redeem: true }
human:  POST /api/approvals/r1/decisions {approve}         -> 200 { status: approved, expiresAt: decidedAt + (expiresAt - createdAt) }
agent:  POST /api/agents {name, slug}
        X-Koda-Approval-Request: r1                        -> 201 { apiKey: <raw>, agent }
stored: input { agent: {name, slug} }, result { agent }    (no apiKey anywhere in the row)
sweep:  an approved redeem request past expiresAt          -> expired
```

### Worked skeletons

The command contract (`approval-command.registry.ts`), and the `routeCommand` pass-through:

```ts
export interface ApprovalRedeem<TInput> {
  /** The stored, hashed form of the parsed input; absent stores it whole. Never throws for parse's output. */
  redact?(input: TInput): unknown;
}
export interface ApprovalCommand<TInput = unknown, TResult = unknown, TDecision = unknown> {
  // ... existing members ...
  /** Present: an approval only releases the request; the requester redeems it with the full input. */
  redeem?: ApprovalRedeem<TInput>;
}
```

The gate's open step (`ApprovalGate.openRequest`), for a redeem command:

```ts
const stored = redeemStored(command, opened.parsed); // throws when a declared redact answers null or undefined
const input = freezeApprovalInput(stored);
const inputHash = approvalInputHash(input);
// newRequest(...) gains `redeem: command.redeem !== undefined`, written as `redeem: true` or left absent
```

The route gate's redeem branch (`ApprovalRouteGate.run`, after the actor and key checks it makes today):

```ts
if (call.redeem !== undefined) {
  try {
    const { request, result } = await this.execution.redeem(call.redeem, { key, variant, projectId, input });
    return { status: 'executed', result: result as TResult, approval: approvalOf(request) };
  } catch (error) { rethrowApprovalError(error); }
}
return this.gate.gate<TResult>(key, input, { projectId, variant });
```

`redeemStored(command, parsed)` (exported from `approval-gate.service.ts`) answers `parsed` when the command declares no `redact`, else `redact(parsed)`; a declared `redact` that answers `null` or `undefined` throws `Error('approval redeem redact returned no input: <key>')`, so a broken redaction never falls back to storing the secret. The gate and `redeem` both use it.

`approvalOf(request)` is the `ActionApproval` that `requestContext` builds (required mode, satisfied by, approver, request id); the helper is exported from `approval-execution.service.ts` for this use.

The redeem method (`ApprovalExecutionService`):

```ts
async redeem(requestId: string, call: RedeemCall, now: Date = new Date()): Promise<{ request: ApprovalRequestRecord; result: unknown }> {
  const request = await this.requests.findById(requestId);
  const actor = currentContext()?.actor;
  if (!request || actor === undefined || request.actor.type !== actor.type || request.actor.id !== actor.id || request.onBehalfOf !== null) {
    throw new ApprovalRequestNotFoundError(requestId);
  }
  if (request.redeem !== true || request.permissionKey !== call.key || (request.variant ?? null) !== (call.variant ?? null) || request.projectId !== call.projectId) {
    throw new ApprovalRedeemMismatchError(requestId);
  }
  if (request.status !== 'approved') throw new ApprovalRequestNotPendingError(request.status);
  if (request.expiresAt.getTime() <= now.getTime()) throw new ApprovalRequestExpiredError(requestId);
  const command = this.registry.get(request.permissionKey, request.variant);
  if (command?.redeem === undefined) throw new ApprovalRedeemMismatchError(requestId);
  const parsed = command.parse(call.input);
  const stored = redeemStored(command, parsed);
  if (approvalInputHash(stored) !== request.inputHash) throw new ApprovalRedeemMismatchError(requestId);
  return runWithActionContext(requestContext(request), () => this.runRedeem(request, command, parsed, now));
}
```

`run` is refactored to answer `{ settled, raw?, failure? }`; `execute` maps that back to `settled`, as today. `runRedeem` goes through the same `run` (its serialised slot and its `approved` re-read) and `executeOnce`. Both of `executeOnce`'s catch sites (a rejecting `prepare`, and a callback that threw) now also answer the error they caught as `failure: { error }`. If `settled.status === 'executed'`, it answers `{ request: settled, result: raw.result }` after the follow-up. Otherwise it rethrows `failure.error` when there is one, and throws `ApprovalRequestNotPendingError(settled.status)` when there is none.

The approve step (`ApprovalDecisionService.recordDecision`, the `approved` transition patch), and the sweeper's timeout approve (`ApprovalRequestExpirySweeper.settleOne`):

```ts
// Redeem requests restart their clock at approval: the window is the request's own ask timeout.
const redeemWindow = request.redeem === true ? { expiresAt: new Date(now.getTime() + (request.expiresAt.getTime() - request.createdAt.getTime())) } : {};
```

The default ask timeout is `DEFAULT_APPROVAL_TIMEOUT_SEC` (86,400 s), so a request opened under a policy with no `timeoutSec` can be redeemed for 24 hours after approval.

The sweeper's due scan (`PrismaApprovalRequestRepository.findDue`) widens its status condition. The two fleet `NOT EXISTS` clauses stay:

```sql
WHERE (r."status" = 'pending' OR (r."status" = 'approved' AND r."redeem")) AND r."expiresAt" <= ${now}
```

`settleOne` takes a locked `approved` redeem row past its `expiresAt` to `expired`, regardless of its `onTimeout` (the `onTimeout: 'approve'` branch applies only to `pending` rows), (`transition(id, 'approved', { status: 'expired', settledAt: now })`). It records its event and the audit entry `system.approval.expire` with summary `redeem expired <permissionKey>`. It calls no `canSettleTimeout`, because a redeem request has no fleet link. `findStaleApproved` gains `redeem: false` in its `where`.

### The gated routes

| Story | Route | Key | Scope | Variant | Input | `redact` | Run | `toResult` |
|:--|:--|:--|:--|:--|:--|:--|:--|:--|
| US-006 | `POST /agents` | `agent.create` | null | `rest:agents.create` | `{ agent: parseBody(CreateAgentDto, …) }` | none (stored whole) | `agents.generateApiKey(input.agent)` | `({ agent }) => ({ agent })` |
| US-006 | `POST /agents/:slug/rotate-key` | `agent.key.rotate` | null | `rest:agents.rotate-key` | `{ slug, agentId }` (target read first) | none | `agents.generateApiKey(input.agentId)` | `({ agent }) => ({ agent })` |
| US-007 | `POST /admin/users` | `user.create` | null | `rest:admin-users.create` | `{ user: parseBody(CreateUserDto, …) }` | `({ user }) => ({ user: { email: user.email, name: user.name } })` | `prepare`: `users.prepareCreate(input.user)`; run: `users.create(input.user)` | `(result) => result` |

The handlers keep their `@Requires`, `@HttpCode`, `@Throttle` and `@ApiResponse`s, gain `@ApprovalGated({ redeem: true })` and an `@Headers(APPROVAL_REDEEM_HEADER) redeem?: string` parameter (last), and have this shape:

```ts
const outcome = await this.routeGate.run<{ apiKey: string; agent: AgentResponseDto }>({
  key: 'agent.create', variant: AGENT_ROUTE_VARIANTS.create, projectId: null, input: { agent: createAgentDto }, redeem,
});
if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
return JsonResponse.Ok(outcome.result);
```

`AgentsController`'s public test seams `createAgent` and `rotateKey` stay as they are; the HTTP handlers stop calling them, as `update` and `remove` stopped calling theirs in 5c-2.

### Shared names

| Name | Where | What |
|:--|:--|:--|
| `ApprovalRedeem`, `ApprovalCommand.redeem` | `approvals/approval-command.registry.ts` | new (US-001) |
| `RouteCommandSpec.redeem` | `approvals/route/route-command.ts` | new, passed through by `routeCommand` (US-001) |
| `ApprovalRequestRecord.redeem?: true` | `approvals/domain/approval.domain.ts` | new (US-001) |
| `ApprovalRedeemMismatchError` | `approvals/domain/approval.errors.ts` | new (US-004); `rethrowApprovalError` maps it to 409 `approvals.redeemMismatch` |
| `RedeemCall`, `ApprovalExecutionService.redeem`, `approvalOf` | `approvals/approval-execution.service.ts` | new (US-004) |
| `RouteGateCall.redeem?: string` | `approvals/route/approval-route-gate.ts` | new (US-004) |
| `APPROVAL_REDEEM_HEADER`, `ApprovalGated(options?: { redeem?: boolean })` | `approvals/route/approval-gated.decorator.ts` | new constant and option (US-005) |
| `ApprovalRequestSummaryDto.redeem: boolean` | `approvals/dto/approval-request.dto.ts` | new (US-005) |
| `AGENT_ROUTE_VARIANTS.create`, `.rotateKey` | `agents/agent-route.commands.ts` | new (US-006) |
| `USER_ROUTE_VARIANTS.create`, `UsersAdminService.prepareCreate` | `users/user-route.commands.ts`, `users/users-admin.service.ts` | new (US-007) |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| An agent under no policy (the shipped default) | Executes at once with the full body, no `ApprovalRequest` row | US-001 |
| A human under a policy for the key | Executes at once, no request | US-006, US-007 |
| Two waiting calls whose bodies differ only in a redacted field | The second answers the first's pending request (the hash covers the redacted input) | US-001 |
| Approving a redeem request | Status `approved`, nothing runs, `expiresAt` restarts | US-002 |
| `onTimeout: 'approve'` on a redeem request | Status `approved` by the timeout, nothing runs, `expiresAt` restarts | US-002 |
| The stale-approved retry | Never selects a redeem request | US-002 |
| An approved redeem request past `expiresAt` | The sweeper settles it `expired`, with an audit entry | US-003 |
| A redeem whose request was redeemed meanwhile, at sweep time | The sweeper leaves it (status no longer `approved`) | US-003 |
| A redeem header naming another principal's request, or no request | 404 `approvals.requestNotFound` | US-004, US-006 |
| A redeem header on a request for another key, variant or project, or a non-redeem request | 409 `approvals.redeemMismatch` | US-004 |
| A redeem before approval | 409 `approvals.notPending` with `status: 'pending'` | US-004, US-006 |
| A redeem of a request already redeemed, rejected, cancelled or failed | 409 `approvals.notPending` with that status | US-004, US-006 |
| A redeem after the window, before the sweeper ran | 409 `approvals.expired` | US-004 |
| A redeem of a request the sweeper expired | 409 `approvals.notPending` with `status: 'expired'` | US-006 |
| A human caller sending the redeem header | 404 `approvals.requestNotFound` (a human never owns a request) | US-004 |
| A redeem whose re-sent body fails `parse` | The parse error (400); the request stays `approved` and nothing runs | US-004 |
| A rotation redeemed after its target was deleted and the slug reused | 409 `approvals.redeemMismatch`; the new agent's key is unchanged | US-006 |
| A redeem whose body differs in a non-redacted field | 409 `approvals.redeemMismatch`; nothing runs | US-004, US-006, US-007 |
| A redeem whose body differs only in a redacted field (another password) | Executes with the re-sent value | US-007 |
| A redeem whose `prepare` or command throws (a taken email, a taken slug) | Request `failed`; the caller gets the command's own error | US-004 |
| A `redact` that answers `null` or `undefined` | The gate and `redeem` throw; nothing is stored or run | US-001 |
| A redeem by a caller who lost the key | 403 `permissions` from the guard or the route gate; the request stays `approved` | US-004 |

### Integration

**Read-only, verified:**
- `ApprovalGate.gate` and `openRequest` (`approval-gate.service.ts`): a USER actor executes at once under any mode; mode `none` executes at once; otherwise `findPendingDuplicate` then `create` under `bookkeeping('approval.request-open')`.
- `ApprovalRouteGate.run` (`route/approval-route-gate.ts`): refuses a RUNNER (403 `permissions`), checks `canHoldKey` unless `keyCheck: false`, then calls `gate.gate`.
- `ApprovalExecutionService.run`, `executeOnce`, `followUp`, `serialised`, `settle`, `requestContext`; `freezeApprovalInput`, `approvalInputHash` (`approval-input.ts`).
- `ApprovalDecisionService.recordDecision` (the `approved` transition) and `decide` (`decision === 'approve' ? this.execution.execute(requestId) : decided`).
- `ApprovalRequestExpirySweeper.settleDue`, `settleOne`, `retryStale`; `PrismaApprovalRequestRepository.findDue`, `findStaleApproved`, `transition`, `toDomain`, `toPersistenceCreate`.
- `rethrowApprovalError` (`approval-http-errors.ts`); `ConflictAppException` (`common/exceptions/conflict-app.exception.ts`).
- `AgentsService.generateApiKey` (both overloads), `rotateApiKey`, `findBySlug`, `invalidateAfterCommit` (private), `AfterCommitService.defer` / `.scope`.
- `UsersAdminService.create`; `AgentRouteCommands`, `UserRouteCommands` (their `onModuleInit` registrations).
- Test helpers: `seedWaitPolicy`, `grantKeys` (`src/approvals/test-helpers/approval-fixtures.ts`); `seedFleetHttpWorld`, `seedFleetHttpAgent` (`test/helpers/fleet-fixtures.ts`); `bootHttpApp`, `data`, `resetThrottle` (`test/helpers/http-app.ts`); `fixtureDb`; `resetDb`; the structure of `test/integration/agents/gated-agent-routes.integration.spec.ts`.

**Changed** (the baseline only locates the code; implement the target):

| Symbol | Baseline | Target |
|:--|:--|:--|
| `ApprovalRequest` (Prisma model) | no `redeem` column | `redeem Boolean @default(false)` |
| `ApprovalRequestRecord` | no `redeem` | `redeem?: true` |
| `PrismaApprovalRequestRepository.toDomain` / `toPersistenceCreate` | ignore `redeem` | read `redeem: true` only when the column is true; write `record.redeem === true` |
| `PrismaApprovalRequestRepository.findDue` | `status = 'pending'` | `status = 'pending' OR (status = 'approved' AND redeem)` |
| `PrismaApprovalRequestRepository.findStaleApproved` | every approved row decided before `before` | the same, `redeem: false` |
| `ApprovalGate.openRequest` / `newRequest` | stores and hashes the parsed input | a redeem command's redacted input, and `redeem: true` |
| `ApprovalExecutionService.execute` | runs every approved request | answers a redeem request unchanged |
| `ApprovalExecutionService.executeOnce` | `{ settled, raw? }` | `{ settled, raw?, failure?: { error } }` |
| `ApprovalDecisionService.recordDecision` | approve patch `{ status, decidedAt, satisfiedBy, approverType, approverId }` | plus `expiresAt` for a redeem request |
| `ApprovalRequestExpirySweeper.settleOne` | only `pending` rows | also `approved` redeem rows; timeout approve restarts a redeem request's `expiresAt` |
| `RouteGateCall` / `ApprovalRouteGate.run` | always `gate.gate` | the redeem branch when `redeem` is set |
| `ApprovalGated()` | no options | `ApprovalGated(options?: { redeem?: boolean })` |
| `ApprovalRequestSummaryDto` | no `redeem` | `redeem: boolean` |
| `AgentsService.generateApiKey` | inline `invalidateByTag` | `invalidateAfterCommit` |
| `UsersAdminService.create` | hashes, then writes | `(await this.prepareCreate(dto))()` |
| `AgentsController.generateApiKey`, `.rotateApiKey`; `AdminUsersController.create` | call the service | run the route gate |
| `PENDING_GATE_ROUTES`, `SECRET_GATE_ROUTES` | 11 rows each | 8 rows each |

## Out of Scope

- The other 8 secret routes (`POST /fleet/enrollments`, VCS create, update and webhook-secret rotate, webhook create and update, invite create and resend) and the `PATCH /projects/:slug` CI-token change: feature 6b.
- Cancelling an approved, unredeemed request: it expires on its own (ruling 2026-10-29); `POST /approvals/:id/cancel` keeps refusing a non-pending request.
- A redeem request reached by a non-REST origin: these three keys have no MCP, assistant or fleet command, so only the REST route opens or redeems one.
- A redeem request opened by the assistant (an on-behalf-of request): check 1 refuses it as missing; no assistant tool opens one.
- A configurable redeem window, or a policy field for it: the window is the request's own ask timeout (ruling 2026-10-29).
- Validating the header's format: an unknown or malformed value reads as a missing request.
- A second key re-check inside the redemption: the route gate checks the key in the same call (Design).
- Notifying the requester that an approval is ready to redeem beyond the request events that exist today (`approval_request_changed`).
- Changing any catalog default: these three keys stay `none`.
- Regenerating `apps/cli/src/generated` for the new 202 responses and header: only `openapi.json` is regenerated, as in 5c-2 to 5d-2.
- Any change to `apps/web` or `apps/cli`.
- `AgentsController`'s public test seams `createAgent` and `rotateKey`: they keep calling the service directly.
- Moving `recordAgentAction` after commit: it writes nothing without a project id, and these routes pass none.
- `endpoint.e2e.spec.ts` coverage for the redeem routes: the integration files below cover them over the booted app.
- US-004 only: an ApprovalRedeemMismatchError for a command unregistered after approval (check 5), and redeemStored throwing inside redeem for a redact that answers nothing: both paths reuse code US-001 and US-004 pin elsewhere, and no registered command reaches them.
- US-004 only: re-checking `expiresAt` under the row lock. The window is checked before the serialised slot and `prepare`, so a redemption queued behind another or slowed by `prepare` may commit shortly after `expiresAt` (accepted).
- US-004 only: the redeem path's per-API-instance serialisation (`serialised`) is the guard against two concurrent redemptions on one instance; across instances, the row lock and the `approved` re-check inside the transaction refuse the second, as for `execute`.

## Stories

1. **US-001: Redeem command contract, redacted storage and the `redeem` column** — `Workdir: apps/api` — No dependencies.
2. **US-002: Approval releases a redeem request without executing it** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: The sweeper expires unredeemed approvals** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: The redeem path through the route gate** — `Workdir: apps/api` — Depends on US-002.
5. **US-005: The `redeem` flag in the request DTO and the documented header** — `Workdir: apps/api` — Depends on US-001.
6. **US-006: Gated agent create and key rotation, redeemed by the requester** — `Workdir: apps/api` — Depends on US-003, US-004, US-005.
7. **US-007: Gated admin user create with the password redacted, and the contract counts** — `Workdir: apps/api` — Depends on US-006.

### Context Files

**US-001**
- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/approvals/approval-command.registry.ts`
- `apps/api/src/approvals/route/route-command.ts`
- `apps/api/src/approvals/prisma-approval-request.repository.ts`
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts`

**US-002**
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/src/approvals/approval-decision.service.ts`
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts`
- `apps/api/src/approvals/approval-execution.service.spec.ts`

**US-003**
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts`
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts`
- `apps/api/test/integration/approvals/approval-expiry.integration.spec.ts`

**US-004**
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/src/approvals/route/approval-route-gate.ts`
- `apps/api/src/approvals/approval-http-errors.ts`
- `apps/api/src/approvals/route/approval-route-gate.spec.ts`

**US-005**
- `apps/api/src/approvals/dto/approval-request.dto.ts`
- `apps/api/src/approvals/route/approval-gated.decorator.ts`
- `apps/api/src/approvals/route/approval-gated.decorator.spec.ts`

**US-006**
- `apps/api/src/agents/agents.service.ts`
- `apps/api/src/agents/agent-route.commands.ts`
- `apps/api/test/integration/agents/gated-agent-routes.integration.spec.ts`
- `apps/api/test/helpers/fleet-fixtures.ts`

**US-007**
- `apps/api/src/users/users-admin.service.ts`
- `apps/api/src/users/user-route.commands.ts`
- `apps/api/src/permissions/test-helpers/permission-contract.ts`
- `apps/api/scripts/export-spec.cjs`

### Creates

**US-001**
- `apps/api/prisma/migrations/20261109090000_approval_request_redeem/migration.sql`

**US-002**

None: US-002 only changes existing files.

**US-003**

None: US-003 only changes existing files.

**US-004**

None: US-004 only changes existing files.

**US-005**

None: US-005 only changes existing files.

**US-006**
- `apps/api/test/integration/agents/gated-agent-key-routes.integration.spec.ts`

**US-007**
- `apps/api/test/integration/users/gated-admin-user-create.integration.spec.ts`

### Modifies

Engine unit specs build `ApprovalRequestRecord` literals without `redeem`. The flag is optional, so those fixtures compile and keep their meaning (a non-redeem request). No existing integration or e2e test opens a request on these three routes, so none changes behaviour. With no policy, a gated route executes at once and its audit entry still records mode `none`.

**US-001**
- `apps/api/prisma/schema.prisma` — `ApprovalRequest` gains `redeem Boolean @default(false)`
- `apps/api/src/approvals/domain/approval.domain.ts` — `ApprovalRequestRecord` gains `redeem?: true`
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalRedeem` and `ApprovalCommand.redeem`; the `parse` doc comment is scoped to non-redeem commands
- `apps/api/src/approvals/route/route-command.ts` — `RouteCommandSpec.redeem`; `routeCommand` copies it onto the command
- `apps/api/src/approvals/route/route-command.spec.ts` — the redeem pass-through cases
- `apps/api/src/approvals/approval-gate.service.ts` — `redeemStored`; a redeem command's request stores and hashes the redacted input and carries `redeem: true`
- `apps/api/src/approvals/approval-gate.service.spec.ts` — the redeem open cases; existing assertions still hold
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `toDomain` and `toPersistenceCreate` map `redeem`
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts` — the `redeem` round-trip cases

**US-002**
- `apps/api/src/approvals/approval-execution.service.ts` — `execute` answers a redeem request unchanged
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the redeem no-op case; existing assertions still hold
- `apps/api/src/approvals/approval-decision.service.ts` — the approve patch restarts a redeem request's `expiresAt`
- `apps/api/src/approvals/approval-decision.service.spec.ts` — the redeem approve cases
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — the timeout approve restarts a redeem request's `expiresAt`
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts` — the redeem timeout-approve case
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `findStaleApproved` excludes redeem rows
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts` — the `findStaleApproved` redeem case

**US-003**
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `findDue` also selects approved redeem rows past `expiresAt`
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — `settleOne` expires an approved redeem row
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts` — the unredeemed-expiry cases; existing assertions still hold
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts` — the `findDue` redeem cases

**US-004**
- `apps/api/src/approvals/domain/approval.errors.ts` — `ApprovalRedeemMismatchError`
- `apps/api/src/approvals/approval-http-errors.ts` — maps it to 409 `approvals.redeemMismatch`
- `apps/api/src/approvals/approval-http.spec.ts` — the mapping case
- `apps/api/src/approvals/approval-execution.service.ts` — `redeem`, `RedeemCall`, `approvalOf`; `run` answers `{ settled, raw?, failure? }`; `executeOnce` reports its caught error; imports `currentContext`, `approvalInputHash` and `ApprovalRequestExpiredError`
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the redeem cases; existing assertions still hold
- `apps/api/src/approvals/route/approval-route-gate.ts` — `RouteGateCall.redeem`; the constructor gains `ApprovalExecutionService` (last); the redeem branch
- `apps/api/src/approvals/route/approval-route-gate.spec.ts` — every construction passes an `ApprovalExecutionService` double as the 3rd argument; the redeem branch cases
- `apps/api/src/i18n/en/approvals.json` — the `redeemMismatch` message (409)
- `apps/api/src/i18n/zh/approvals.json` — the `redeemMismatch` message (409)

**US-005**
- `apps/api/src/approvals/dto/approval-request.dto.ts` — `redeem` declared on `ApprovalRequestFields` (so both the summary and the detail DTO document it), mapped in `ApprovalRequestSummaryDto.from`
- `apps/api/src/approvals/approval-http.spec.ts` — the "serializes exactly the summary allowlist and non-null dates" case's expected object gains `redeem: false`; the US-005 DTO cases (AC-1 to AC-3) live here
- `apps/api/src/approvals/route/approval-gated.decorator.ts` — `APPROVAL_REDEEM_HEADER`; the `redeem` option documents the header
- `apps/api/src/approvals/route/approval-gated.decorator.spec.ts` — the header cases; existing assertions still hold

US-005 and US-006 change the documented API (the `redeem` field, the 202s and the header), but `openapi.json` is regenerated once, in US-007: the OpenAPI contract specs read the committed file, so regenerating earlier would break their 115-operation case before US-007 updates it.

**US-006**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /agents and POST /agents/:slug/rotate-key from both `SECRET_GATE_ROUTES` and the assignments
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the "US-001 AC-1: explicitly lists exactly the 11 secret-bearing routes" case lists the 9 left (title follows); the "US-001 AC-1/2: assigns every explicit secret route to gate-secret" case drops its rotate-key line; the "US-009 AC-3: pending gate assignments contain exactly the 11 secret routes" case asserts size 9 and nine `gate-secret` values (title follows; US-007 makes it 8)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the "US-009 AC-1: collects exactly 115 gated routes over the booted app" case asserts exactly 117 (title follows); US-007 makes it 118
- `apps/api/src/agents/agent-route.commands.ts` — `create` and `rotateKey` variants and their redeem commands
- `apps/api/src/agents/agent-route.commands.spec.ts` — the registration and command cases
- `apps/api/src/agents/agents.controller.ts` — `generateApiKey` and `rotateApiKey` gated with `@ApprovalGated({ redeem: true })` and the header parameter
- `apps/api/src/agents/agents.service.ts` — both `generateApiKey` branches evict through `invalidateAfterCommit`
- `apps/api/src/agents/agents.service.spec.ts` — the deferred-eviction cases; existing `invalidateByTag` assertions still hold (no scope is open there)
- `apps/api/src/agents/agents-create.routes.spec.ts` — the `ApprovalRouteGate` double's `run` answers `{ status: 'executed', result: await <the testing module's AgentsService>.generateApiKey(call.input.agent) }` for `agent.create`, so every HTTP assertion in the file still holds
- `apps/api/src/agents/agent-create-canonical-dto.routes.spec.ts` — the same ApprovalRouteGate double change as the agents-create routes spec, so its HTTP assertions still hold
- `apps/api/src/agents/agents.controller.spec.ts` — the handler cases for `generateApiKey` and `rotateApiKey` assert the `ApprovalRouteGate.run` call; the `createAgent` and `rotateKey` seam cases are unchanged

**US-007**
- `apps/api/src/permissions/pending-gate-routes.ts` — drops POST /admin/users from both `SECRET_GATE_ROUTES` and the assignments
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — the explicit-list case (titled "explicitly lists exactly the 9 secret-bearing routes" after US-006) lists the 8 remaining routes, and the size case asserts 8 (titles follow); the "US-001: classifies admin user creation as a secret-gated route" case is deleted (its row leaves)
- `apps/api/test/integration/permissions/permission-contract.integration.spec.ts` — the gated-route count is exactly 118
- `apps/api/src/approvals/approval-openapi.contract.spec.ts` — `gatedOperations` gains the 3 operations; the "US-009 AC-5: 202 responses exist on exactly the 115 gated operations" case's title and `toHaveLength(115)` become 118; the "AC-6: secret agent creation has no 202 response" case is deleted (US-007 AC-14 replaces it)
- `openapi.json` — regenerated: the 3 operations list 202 and the header parameter
- `apps/api/src/users/user-route.commands.ts` — the `create` variant and its redeem command
- `apps/api/src/users/user-route.commands.spec.ts` — the registration and command cases
- `apps/api/src/users/users-admin.service.ts` — `prepareCreate`; `create` runs it
- `apps/api/src/users/users-admin.service.spec.ts` — the `prepareCreate` cases; existing `create` assertions still hold
- `apps/api/src/users/admin-users.controller.ts` — `create` gated with `@ApprovalGated({ redeem: true })` and the header parameter
- `apps/api/src/users/admin-users.controller.spec.ts` — the gated create case

### Seams

- 5a to 5d-2 → US-001 to US-007: `ApprovalRouteGate`, `@ApprovalGated()`, `ApprovalPending`, `routeCommand` (with `prepare`, `toResult`), `parseRouteInput`, `parseBody`, `seedWaitPolicy`, `grantKeys`.
- US-001 → US-002 to US-004: the `redeem` column and `ApprovalCommand.redeem`. US-002 AC-1 and US-004 AC-5 read the flag; US-004 AC-9 reads `command.redeem`.
- US-002 → US-006: an approve on the decide route leaves a redeem request `approved`. US-006 AC-2 crosses the real decide route.
- US-003 → US-006: the sweeper expires an approved redeem request. US-006 AC-12 ticks the real sweeper.
- US-004 → US-006, US-007: `ApprovalRouteGate.run({ redeem })` → `ApprovalExecutionService.redeem`. US-006 AC-3 and US-007 AC-3 cross the booted route with the header.
- US-005 → US-006, US-007: `@ApprovalGated({ redeem: true })` and `APPROVAL_REDEEM_HEADER`. US-007 AC-14 reads the regenerated `openapi.json`.
- US-006 → US-007: the allowlist and contract counts. US-007 restores them exactly.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. HTTP fixtures follow `test/integration/agents/gated-agent-routes.integration.spec.ts`:
- `seedFleetHttpWorld` gives the Owner (`root`) token, and `seedFleetHttpAgent` gives an agent and its API key. Each agent holds only the global `grantKeys` bindings its story names, followed by `PermissionCache.invalidate()`.
- "Under a wait policy" means `seedWaitPolicy(db, <the route's key>, null)` ran in that test. Each file deletes every `ApprovalPolicy`, `ApprovalDecision` and `ApprovalRequest` row in `beforeEach`, and calls `resetThrottle(app)` there (the agent routes are throttled at 10 per minute).
- "Approving" means `POST /api/approvals/:id/decisions` `{ decision: 'approve' }` with the root token. "Answers 202" means the response status is 202 and `data` is the pending request summary. "Redeeming R" means repeating the call that opened R with the header `X-Koda-Approval-Request: <R's id>`.
- Unit tests of the engine follow `approval-execution.service.spec.ts`, `approval-decision.service.spec.ts` and `approval-request-expiry.sweeper.spec.ts`: an in-memory request repository double, and a registry holding a test command. "A redeem command" is `{ key: 'agent.create', variant: 'rest:test.redeem', parse: (input) => input, execute, redeem: { redact: ({ name }) => ({ name }) } }`.

"Answers 409 with key `approvals.X`" means the response status and `res.body.message` equal the catalog text, asserted with the file-local `message(<unprefixed key>, <status>, <args>)` helper over `src/i18n/en/approvals.json`, as `test/integration/approvals/approval-cancel.integration.spec.ts` does (`message('redeemMismatch', '409')` for `approvals.redeemMismatch`). The sweeper is `app.get(ApprovalRequestExpirySweeper, { strict: false })` (provided, not exported, by `ApprovalEngineModule`).

Each AC is its own test with its own rows, per `.nax/rules/api-test-isolation.md`. Slugs and emails are unique per test. "Approving AC-n's request" means the test repeats AC-n's call and approves the request it opened. Each AC pins one behaviour; a tail such as "and writes no `ApprovalRequest` row" is part of the behaviour it follows (sizing ruling 2026-10-26: specs plan at their bullet counts). Every prototype stub and spy is restored in `afterEach` (`vi.restoreAllMocks()`).

### US-001: Redeem command contract, redacted storage and the `redeem` column

- AC-1 [unit] `ApprovalGate.gate('agent.create', { name: 'a', secret: 's' }, { projectId: null, variant: 'rest:test.redeem' })` for an AGENT actor under a policy of mode `agent`, with the redeem command registered, calls the repository's `create` with a record whose `input` is `{ name: 'a' }`, whose `inputHash` equals `approvalInputHash({ name: 'a' })` and whose `redeem` is `true`.
- AC-2 [unit] Two such gate calls with inputs `{ name: 'a', secret: 's1' }` and `{ name: 'a', secret: 's2' }` call `findPendingDuplicate` with the same `inputHash` both times.
- AC-3 [unit] The same gate call with a command that has no `redeem` stores the input `{ name: 'a', secret: 's' }` whole, and the created record has no `redeem` property.
- AC-4 [unit] A redeem command with `redeem: {}` (no `redact`) stores the input `{ name: 'a', secret: 's' }` whole, and the created record's `redeem` is `true`.
- AC-5 [unit] Under mode `none`, `ApprovalGate.gate` with the redeem command calls its `execute` with `{ name: 'a', secret: 's' }` and creates no request.
- AC-6 [integration] `PrismaApprovalRequestRepository.create` of a record with `redeem: true` is read back by `findById` with `redeem` `true`, and its `ApprovalRequest` row's `redeem` column is `true`.
- AC-7 [integration] `create` of a record without `redeem` is read back by `findById` with no `redeem` property, and its row's `redeem` column is `false`.
- AC-8 [unit] `routeCommand({ key, variant, parse, run, redeem: { redact } }, loader)` answers a command whose `redeem.redact` is that `redact`, and `routeCommand` of a spec with no `redeem` answers a command whose `redeem` is undefined.
- AC-9 [unit] `ApprovalGate.gate` with a redeem command whose `redact` answers `undefined` throws an `Error` whose message names `agent.create`, and never calls the repository's `create`.

### US-002: Approval releases a redeem request without executing it

- AC-1 [unit] `ApprovalExecutionService.execute(id)` on an `approved` request with `redeem: true` answers that request unchanged, and calls neither the command's `execute` nor `prepare` nor the repository's `transition`.
- AC-2 [unit] `ApprovalDecisionService.recordDecision(id, 'approve', null, T+100s)` on a pending redeem request created at T with `expiresAt` T+600s calls `transition(id, 'pending', …)` with `status: 'approved'` and `expiresAt` T+700s.
- AC-3 [unit] The same approve of a pending request without `redeem` calls `transition` with a patch that has no `expiresAt`.
- AC-4 [unit] `ApprovalDecisionService.decide(id, 'approve', …)` on a redeem request answers the request with status `approved`, and the command's `execute` is never called.
- AC-5 [unit] `ApprovalRequestExpirySweeper.tick(T+600s)` on a due pending redeem request created at T with `onTimeout: 'approve'` and `expiresAt` T+600s transitions it with `status: 'approved'`, `satisfiedBy: 'none'` and `expiresAt` T+1200s, and the command's `execute` is never called.
- AC-6 [integration] `findStaleApproved(before, 100)` answers an `approved` row without `redeem` decided before `before`, and does not answer an `approved` row with `redeem: true` decided before `before`.

### US-003: The sweeper expires unredeemed approvals

- AC-1 [integration] `findDue(now, 100)` answers an `approved` row with `redeem: true` and `expiresAt` before `now`.
- AC-2 [integration] `findDue(now, 100)` answers neither an `approved` row without `redeem` and `expiresAt` before `now`, nor an `approved` redeem row whose `expiresAt` is after `now`.
- AC-3 [unit] `tick(now)` with a due `approved` redeem request whose `onTimeout` is `'approve'` calls `transition(id, 'approved', { status: 'expired', settledAt: now })`, answers `{ expired: 1, approved: 0, failed: 0 }`, and never calls `execution.execute`.
- AC-4 [unit] That tick records the audit entry with key `system.approval.expire`, `resourceId` the request id and summary `redeem expired agent.create`.
- AC-5 [unit] That tick calls `events.record` with the expired request.
- AC-6 [unit] `tick(now)` with a due redeem request whose locked row is `executed` (redeemed meanwhile) makes no transition and answers `{ expired: 0, approved: 0, failed: 0 }`.

### US-004: The redeem path through the route gate

The execution unit tests open each request through the in-memory repository double as `approved`, `redeem: true`, actor `AGENT`/`a1`, key `agent.create`, variant `rest:test.redeem`, project null, `inputHash` `approvalInputHash({ name: 'a' })`, and run `redeem` inside an action context whose actor is `AGENT`/`a1`, unless the AC says otherwise.

- AC-1 [unit] `ApprovalRouteGate.run({ key: 'agent.create', variant: 'rest:test.redeem', projectId: null, input: { name: 'a' }, redeem: 'r1' })` for an AGENT holding the key calls `execution.redeem('r1', { key: 'agent.create', variant: 'rest:test.redeem', projectId: null, input: { name: 'a' } })`, never calls `gate.gate`, and answers `{ status: 'executed', result, approval }` with the redeem's result and `approval` equal to `approvalOf` of the redeem's request.
- AC-2 [unit] The same call without `redeem`, and the same call with `redeem: ''`, each call `gate.gate` and never call `execution.redeem`.
- AC-3 [unit] The same call with `redeem: 'r1'` for an AGENT whose `canHoldKey` answers false throws `ForbiddenAppException` with key `permissions` and never calls `execution.redeem`.
- AC-4 [unit] `redeem('r1', …)` in a context whose actor is `AGENT`/`a2`, and in one whose actor is `USER`/`u1`, each throw `ApprovalRequestNotFoundError`.
- AC-5 [unit] `redeem` of an `approved` request without `redeem` throws `ApprovalRedeemMismatchError`.
- AC-6 [unit] `redeem` with a call whose variant is `rest:other`, with one whose key is `agent.key.rotate`, and with one whose project is `p1`, each throw `ApprovalRedeemMismatchError`.
- AC-7 [unit] `redeem` of a redeem request whose status is `pending`, and of one whose status is `executed`, each throw `ApprovalRequestNotPendingError` carrying that status.
- AC-8 [unit] `redeem` at `now` of a request whose `expiresAt` equals `now` throws `ApprovalRequestExpiredError`.
- AC-9 [unit] `redeem` with input `{ name: 'b', secret: 's' }` throws `ApprovalRedeemMismatchError` and never calls the command's `execute`.
- AC-10 [unit] `redeem` with input `{ name: 'a', secret: 's' }` calls the command's `execute` with `{ name: 'a', secret: 's' }`, transitions the request to `executed` with `result` equal to the command's `toResult` of the raw result, and answers `{ request, result }` whose `result` is the raw result.
- AC-11 [unit] `redeem` whose command's `execute` rejects with a `ConflictAppException` settles the request `failed` and rejects with that same exception instance.
- AC-12 [unit] `redeem` whose command's `parse` throws a `ValidationAppException` rejects with that exception, never calls the command's `execute`, and leaves the request `approved` (no `transition`).
- AC-13 [unit] `redeem` with a command declaring `afterCommit` calls it once with the raw result after the request is `executed`.
- AC-14 [unit] `rethrowApprovalError(new ApprovalRedeemMismatchError('r1'))` throws a `ConflictAppException` with key `approvals.redeemMismatch`.
- AC-15 [unit] `redeem` with a command whose `prepare` rejects with a `ConflictAppException` settles the request `failed`, rejects with that same exception instance, and never calls the command's `execute`.

### US-005: The `redeem` flag in the request DTO and the documented header

- AC-1 [unit] `ApprovalRequestSummaryDto.from(record)` of a record with `redeem: true` answers `redeem` `true`.
- AC-2 [unit] `ApprovalRequestSummaryDto.from(record)` of a record without `redeem` answers `redeem` `false`.
- AC-3 [unit] `ApprovalRequestDto.from({ request, decisions: [] })` of a redeem request answers `redeem` `true` and `input` the request's stored (redacted) input.
- AC-4 [unit] A handler decorated with `@ApprovalGated({ redeem: true })` carries swagger header metadata with name `X-Koda-Approval-Request` and `required: false`.
- AC-5 [unit] A handler decorated with `@ApprovalGated()` carries no swagger header metadata.
- AC-6 [unit] A handler decorated with `@ApprovalGated({ redeem: true })` carries `APPROVAL_GATED_METADATA` `true`, the `ApprovalPendingFilter`, and a documented 202 response.
- AC-7 [unit] `APPROVAL_REDEEM_HEADER` is the string `x-koda-approval-request`.

### US-006: Gated agent create and key rotation, redeemed by the requester

The requesting agent holds global `agent.create` and `agent.key.rotate`. A create body is `{ name: <unique>, slug: <unique> }`. A rotation target is an agent seeded by `seedFleetHttpAgent` in the test, whose key the test keeps.

- AC-1 [integration] `POST /api/agents` with a create body by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'agent.create', projectId: null, redeem: true }`, and no `Agent` with that slug exists.
- AC-2 [integration] Approving AC-1's request answers 200 with `data.status` `approved`, no `Agent` with that slug exists, and the request's `expiresAt` is later than it was before the approval.
- AC-3 [integration] Redeeming AC-2's approved request answers 201 with `data.agent.slug` the body's slug and `data.apiKey` a 64-character hex string, and the request's row has status `executed`.
- AC-4 [integration] After AC-3, the request row's `result` has `agent.slug` the body's slug and no `apiKey` property, and its `input` is `{ agent: <the create body> }`.
- AC-5 [integration] `GET /api/agents/me` with the `apiKey` AC-3 answered returns 200 with `data.slug` the body's slug.
- AC-6 [integration] Redeeming an approved create request with a body whose `name` differs answers 409 with key `approvals.redeemMismatch`, and no `Agent` with that slug exists.
- AC-7 [integration] Redeeming an approved create request a second time answers 409 with key `approvals.notPending`.
- AC-8 [integration] Redeeming an approved create request with the key of a second agent that also holds global `agent.create` answers 404 with key `approvals.requestNotFound`.
- AC-9 [integration] Redeeming a create request before it is approved answers 409 with key `approvals.notPending` and `status` `pending` in the error data.
- AC-10 [integration] Redeeming an approved `POST /api/agents/<target>/rotate-key` request by the agent answers 200 with a new `data.apiKey`; afterwards `GET /api/agents/me` answers 200 with that new key and 401 with the target's seeded key.
- AC-11 [integration] An approved rotate request for target A, redeemed after the test deleted A and created agent B with A's slug (root token), answers 409 with key `approvals.redeemMismatch`, and B's `apiKeyHash` is unchanged.
- AC-12 [integration] An approved create request whose `expiresAt` the test set one second in the past is `expired` after `app.get(ApprovalRequestExpirySweeper, { strict: false }).tick()`, and redeeming it answers 409 with key `approvals.notPending` and `status` `expired`.
- AC-13 [integration] `POST /api/agents` with the root token under a wait policy answers 201 with a `data.apiKey`, and writes no `ApprovalRequest` row.
- AC-14 [unit] Inside `AfterCommitService.scope`, `AgentsService.generateApiKey('a1')` (rotation) and `generateApiKey(dto)` (creation) each call `invalidateByTag` for their agent only after the scope's callback has returned.
- AC-15 [unit] `AgentsController.generateApiKey(dto, principal, 'r1')` calls `routeGate.run` with `{ key: 'agent.create', variant: 'rest:agents.create', projectId: null, input: { agent: dto }, redeem: 'r1' }` and answers the executed result.

### US-007: Gated admin user create with the password redacted, and the contract counts

The requesting agent holds global `user.create`. A create body is `{ email: <unique>, name: 'New User', password: 'StrongPass123!' }`.

- AC-1 [integration] `POST /api/admin/users` with a create body by the agent under a wait policy answers 202 with `data` matching `{ permissionKey: 'user.create', projectId: null, redeem: true }`, and no `User` with that email exists.
- AC-2 [integration] `GET /api/approvals/<AC-1's request>` with the root token answers `data.input` `{ user: { email: <the email>, name: 'New User' } }`, with no `password` anywhere in it.
- AC-3 [integration] Approving AC-1's request and redeeming it with the same body answers 201 with `data.email` the body's email, the request's row has status `executed`, and the string `StrongPass123!` appears in neither the row's `input` nor its `result` nor any `AuditEntry` row's `summary`.
- AC-4 [integration] `POST /api/auth/login` with that email and `StrongPass123!` after AC-3 answers 200.
- AC-5 [integration] Redeeming an approved create request with the same email and name and the password `OtherPass456!` answers 201, and `POST /api/auth/login` with `OtherPass456!` answers 200.
- AC-6 [integration] Redeeming an approved create request with a different email answers 409 with key `approvals.redeemMismatch`, and no `User` with either email exists.
- AC-7 [integration] `POST /api/admin/users` with the root token under a wait policy answers 201 and writes no `ApprovalRequest` row.
- AC-8 [unit] `UsersAdminService.prepareCreate(dto)` for an email the repository already holds throws `ConflictAppException` with key `users` and never calls `bcrypt.hash`.
- AC-9 [unit] `prepareCreate(dto)` resolves after calling `bcrypt.hash(dto.password, 12)` once and before any `usersRepo.createUser` call; its callback calls `createUser` with that hash as `passwordHash`.
- AC-10 [unit] After `onModuleInit`, the registry answers `user.create` for `rest:admin-users.create`, with a `prepare` and a `redeem`, and its `redeem.redact` of `{ user: { email: 'e@x.test', name: 'N', password: 'p' } }` answers `{ user: { email: 'e@x.test', name: 'N' } }`.
- AC-11 [unit] `AdminUsersController.create(dto, 'r1')` calls `routeGate.run` with `{ key: 'user.create', variant: 'rest:admin-users.create', projectId: null, input: { user: dto }, redeem: 'r1' }`.
- AC-12 [integration] Over the booted app, the collected routes contain exactly 118 gated routes, and `findContractViolations` reports no violation.
- AC-13 [unit] `PENDING_GATE_ROUTES` holds exactly 8 entries, all `gate-secret`, and its keys equal `SECRET_GATE_ROUTES`: `POST /fleet/enrollments`, `POST /projects/:slug/vcs`, `PATCH /projects/:slug/vcs`, `POST /projects/:slug/vcs/webhook-secret/rotate`, `POST /projects/:slug/webhooks`, `PATCH /projects/:slug/webhooks/:id`, `POST /projects/:slug/invites`, `POST /projects/:slug/invites/:id/resend`.
- AC-14 [unit] `openapi.json`'s `post /api/agents`, `post /api/agents/{slug}/rotate-key` and `post /api/admin/users` operations each have a `202` response and a header parameter named `X-Koda-Approval-Request`.
- AC-15 [unit] The operations of `openapi.json` with a `202` response are exactly the 118 gated ones.

Verification note: `openapi.json` is regenerated with `bun run api:export-spec` (repo root); `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint` pass. AC-14 and AC-15 live in `src/approvals/approval-openapi.contract.spec.ts`; AC-13 in `src/permissions/test-helpers/permission-contract.spec.ts`.
