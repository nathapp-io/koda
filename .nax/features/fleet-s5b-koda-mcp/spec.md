# SPEC: Fleet S5b-3 — Koda MCP Server for Agents

## Summary

S5b-1 and S5b-2 built a koda tool layer for the in-app assistant: 25 read and write tools in `AssistantToolRegistry`,
run by `AssistantToolExecutor` for a thread's creator, with writes proposed as `PendingAction`s that the creator
approves. This feature exposes the same layer to external agents (Claude Code, nax, Zed) over MCP, the last row of
the S5b umbrella (`docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` §10 row 7).

- An MCP client authenticates with an existing koda **agent API key** and calls `POST /api/mcp`. It sees the tool
  catalog as a WORKSPACE thread does: `koda_my_projects`, and every project tool with a `project` argument. Each call
  runs as that agent, with the agent's own project roster and CASL abilities, which is exactly what the same key can
  already do over REST and the koda CLI.
- The tool layer stops assuming a thread. A call has a **caller**: a principal (a user or an agent) and an origin (a
  thread, or MCP). The thread runner route and the MCP route are two adapters over one executor.
- Every assistant write is recorded as one **action** that names who acted and how it was approved. The record gains
  `actorType`/`actorId`, `origin`, `approvalMode` (`none` | `self` | `agent` | `human`) and `approverType`/`approverId`.
  The approval mode comes from one `ApprovalPolicy`: thread writes stay `human` (today's behaviour), and MCP agent
  writes are `none`, so they execute at once and are recorded `EXECUTED` or `FAILED`.
- The MCP endpoint uses the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/node`),
  which implements the stateless 2026-07-28 protocol and serves 2025-era clients through its stateless legacy fallback.

## Motivation

The umbrella's goal includes "the same tool layer is later exposed to external agents (Claude Code, nax, Zed) over
MCP" (S5b-R2). koda was built agent-first: agents hold API keys, sit on project rosters, and work tickets through the
koda CLI. An agent talking MCP today has no koda server to call, so it cannot use the cited, masked, fenced tool
results the in-app assistant gets.

The tool layer cannot serve such a call today, for three reasons:

- `AssistantToolExecutor.execute` resolves everything from `findCallContext(jobId)`
  (`apps/api/src/fleet/assistant/assistant-tool.executor.ts:147`), so a call with no THREAD job answers `not_found`.
- `ToolContext.actor` is a `UserPrincipal` and `ToolContext.threadId`/`jobId` are required
  (`assistant-tool.types.ts:7-17`), so a tool cannot run for an agent or outside a thread.
- `PendingAction.threadId`, `jobId` and `toolCallId` are required (`apps/api/prisma/schema.prisma:1114-1141`), and its
  `requestedById` means both "who asked" and "who the write ran as". An agent's write cannot be recorded, and no row
  says who approved it, as distinct from who acted.

Ruling (user, 2026-10-18): every action records the actor and the approval explicitly; which mode each tool uses is a
policy that later becomes configurable on the web (koda #301). This feature ships the record, the policy seam and the
two code defaults.

## Design

### Rulings that bind every story

User rulings, 2026-10-18 (recorded as S5b-3 rulings):

- **3-R1 Agent keys only.** MCP authenticates with the existing agent API key (`CombinedAuthGuard.tryApiKey`,
  `apps/api/src/auth/guards/combined-auth.guard.ts:75-101`). No personal access token and no new key type. A user JWT is
  refused on the MCP route; runner `kr_` keys are already refused on every non-runner route.
- **3-R2 One tool layer.** A call carries a `ToolCaller`: a principal and an origin. The executor, the permission
  check, the project scope, masking, fencing and the audit are the same code for both origins.
- **3-R3 The actor is the requesting principal.** An executed tool runs as whoever requested it: the thread's creator
  for a thread, the agent for MCP. An approver is never the actor.
- **3-R4 One action record for every assistant write.** The `PendingAction` table is generalised in place (its name is
  kept) with `actorType`, `actorId`, `origin`, `approvalMode`, `approverType` and `approverId`.
- **3-R5 Four approval modes.** `none` (no approval step, no approver), `self` (the actor approves its own action),
  `agent` (another agent approves) and `human` (a user approves).
- **3-R6 Code defaults.** `ApprovalPolicy` answers `human` for every thread write and `none` for every MCP write. No
  default answers `self` or `agent`; the web policy editor and an agent decide path are koda #301.
- **3-R7 MCP SDK v2.** `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1. Both ship CommonJS
  builds; a CommonJS `require()` of each was probed under Bun 1.4.3 and Node 22 on 2026-10-18 and resolves.

Drafting decisions (3-D*):

- **3-D1 Caller shape.** In `assistant-tool.types.ts`:

  ```ts
  export type ToolOrigin =
    | { kind: 'thread'; threadId: string; jobId: string; threadKind: ChatThreadKind; homeProject: { id: string; slug: string } }
    | { kind: 'mcp' };

  export interface ToolCaller {
    principal: UserPrincipal | AgentPrincipal;
    origin: ToolOrigin;
    /** A thread creator who is disabled is refused (today's rule); an agent caller is never disabled here. */
    disabled: boolean;
  }
  ```

  `ToolContext.actor` becomes `UserPrincipal | AgentPrincipal`, and `ToolContext.threadId` and `jobId` become
  `string | null` (null for an MCP call). `ToolContext` gains no other field.
- **3-D2 Executor entry points.** Two public entry points share one private run path:
  - `execute(call: ToolCall)` is the thread adapter and keeps today's front checks in today's order: the
    `(jobId, toolCallId)` replay, then the registry lookup, then `findCallContext(call.jobId)`. It then builds a thread
    caller from the context and hands it to the shared run path. `RunnerToolService.call` and every existing caller are
    unchanged.
  - `executeFor(caller: ToolCaller, call: { name: string; input: unknown }): Promise<ToolResult>` is the entry for a
    caller that is not a thread job (MCP). It looks the tool up (an unknown name throws `NotFoundAppException`, as
    `execute` does), skips the replay (MCP calls carry no tool-call id, 3-D5) and runs the shared path.
  - The shared path is today's scope, parse, permission, execute and audit, with the actor taken from the caller.
- **3-D3 Project scope by origin.** A thread origin keeps today's rules (REPO and PROJECT: the job's project, a
  `project` key refused; WORKSPACE: `project` required for project tools). An MCP origin follows the WORKSPACE rules:
  `koda_my_projects` takes no `project`, every other tool requires `project`, and the slug is resolved and checked with
  `ProjectAccessService.resolveMembership` for the caller's principal. For an agent that is its roster under the
  default `AGENT_PROJECT_SCOPING`; a slug the agent cannot reach answers `not_found: project`. With scoping turned off,
  `resolveMembership` admits an agent to every project, the same reach its key has over REST (deliberate parity).
  `koda_my_projects` over MCP runs with `ctx.projectId` and `ctx.projectSlug` both `''`; the tool reads neither.
- **3-D4 Permission.** Unchanged code: membership, then the tool's CASL tuple via `KodaCaslAbilityFactory.createForUser`,
  which accepts any principal. An agent holds agent CASL, so a tool whose tuple the agent lacks answers
  `forbidden: <tool> needs <action> <subject> on <slug>`. Every agent is refused the three fleet write tools (no agent
  holds `create` or `update` `FleetJob`), as the fleet REST routes refuse them. `koda_update_ticket`'s preview requires
  `transition Ticket` (`tools/update-ticket-tool.ts:127`), so an agent whose roles grant no transition is refused it, as
  the tool already behaves for every caller.
- **3-D5 Idempotency.** The thread origin keeps the `(jobId, toolCallId)` replay. An MCP call has no tool-call id: no
  replay, and every call is audited as its own `AssistantToolCall` row with `toolCallId` null.
- **3-D6 Origin-dependent tools.** Four tools read the thread or a user-only field today:
  - `koda_get_action`: a thread origin reads `findScopedById(id, projectId, threadId)` (today). An MCP origin reads
    `findScopedByActor(id, projectId, { type, id })`, so an agent sees only its own actions in that project.
    `getActionTool`'s dependency widens to `Pick<PendingActionRepository, 'findScopedById' | 'findScopedByActor'>`;
    the repository read itself is added by US-001.
  - `koda_add_memory`: a thread origin stores `sourceType: 'thread'`, `sourceId: threadId` (today); an MCP origin stores
    `sourceType: 'mcp'`, `sourceId: <actor id>`.
  - `koda_record_decision`: a thread origin passes `sourceId: thread:<threadId>` (today); an MCP origin passes
    `sourceId: mcp:<actor id>`.
  - `koda_list_approvals` reads `ctx.actor.projectRole` (`tools/fleet-tools.ts:247`); it narrows with
    `isAgentPrincipal(ctx.actor) ? null : ctx.actor.projectRole ?? null`, so an agent passes `role: null` and a user
    actor (including test fixtures built without `actorType`) keeps its project role.
- **3-D7 Action columns.** On `PendingAction`:

  | Column | Type | Meaning |
  |---|---|---|
  | `actorType` | `String`, `'user'` or `'agent'` | Who the write ran as |
  | `actorId` | `String` | `User.id` or `Agent.id` |
  | `origin` | `String @default("thread")`, `'thread'` or `'mcp'` | How the call arrived |
  | `approvalMode` | `String @default("human")`, one of the four modes | The policy answer for the call |
  | `approverType` | `String?`, `'user'` or `'agent'` | Who decided; null for `none` and for an expiry |
  | `approverId` | `String?` | The decider's id |

  `threadId`, `jobId`, `toolCallId` and `requestedById` become nullable, and the `thread` relation becomes optional (a
  thread-origin row is still deleted with its thread). `expiresAt` stays required: a direct action stores its
  `decidedAt` there, and it is never `PENDING`, so the expiry sweeper never selects it. `requestedById` and
  `decidedById` stay and are still written for thread-origin rows (expand step; the drop is a later contract step, see
  Out of Scope); an MCP-origin row leaves both null.
- **3-D8 Two record views.** `PendingActionRecord` stays the **thread-action** view: its `threadId`, `jobId`,
  `toolCallId` and `requestedById` stay `string`, and it gains `actorType`, `actorId`, `origin`, `approvalMode`,
  `approverType` and `approverId`. Every repository read that answers it (`findByCall`, `findById`, `findScopedById`,
  `findDue`, `lockById`, `resolve`) only ever matches thread-origin rows: PENDING, decidable and thread-scoped actions
  are thread actions by construction. The mapper throws on a thread field that is null in such a row. A direct action
  is written through `insertDirect` and read back through `findScopedByActor`, which answers an `ActionStatusView`
  (`id`, `tool`, `status`, `createdAt`, `decidedAt`, `result`), the fields `koda_get_action` prints.
- **3-D9 Thread action writes.** `NewPendingAction`, `ProposeInput` and `AssistantActionService.propose` are unchanged.
  `PrismaPendingActionRepository.insert` derives the actor fields of a thread proposal itself: `actorType 'user'`,
  `actorId` = `requestedById`, `origin 'thread'`, `approvalMode 'human'`. `resolve`, when the resolution carries
  `decidedById`, also writes `approverType 'user'` and `approverId` = `decidedById`; an expiry carries none and writes
  neither. `AssistantActionDecisions` is unchanged.
- **3-D10 Audit columns.** On `AssistantToolCall`: `jobId`, `threadId`, `toolCallId` and `projectId` become nullable
  (the `job` relation optional), and `actorType`/`actorId` are added. `projectId` is null for a call that resolves no
  project: `koda_my_projects`, `invalid_input: project` and `not_found: project`. The unique `(jobId, toolCallId)`
  stays; Postgres treats nulls as distinct, so MCP rows never collide.
- **3-D11 Migration.** `apps/api/prisma/migrations/20261025090000_assistant_action_actor/migration.sql` adds the
  columns, relaxes the nullability and backfills existing rows:
  - `PendingAction`: `actorType = 'user'`, `actorId = "requestedById"`, `origin = 'thread'`, `approvalMode = 'human'`;
    where `"decidedById"` is not null, `approverType = 'user'` and `approverId = "decidedById"`.
  - `AssistantToolCall`: `actorType = 'user'` and `actorId` = the `requestedById` of the row's `FleetJob`
    (`AssistantToolCall.jobId` cascades from `FleetJob`, so every existing row has its job; a thread is not used,
    because a deleted thread leaves its job's audit rows behind).
  - Then `PendingAction.actorType`, `PendingAction.actorId`, `AssistantToolCall.actorType` and
    `AssistantToolCall.actorId` are set NOT NULL.
  - No SQL comment or string contains a `;` (the test helper `migrationStatements` splits on it).
- **3-D12 Approval check reads the action's actor.** `AssistantToolExecutor.checkAction` and `executeAction` resolve the
  requester from `action.actorType`/`action.actorId` through `findUserActor(userId): Promise<{ id: string; email:
  string; role: string; disabled: boolean } | null>` on `AssistantToolCallRepository`, not from
  `findCallContext(action.jobId)`. An action whose `actorType` is not `'user'` answers `forbidden` without a read (no
  default produces one; koda #301).
- **3-D13 Approval policy.** `apps/api/src/fleet/assistant/actions/approval-policy.ts`:

  ```ts
  export const APPROVAL_MODES = ['none', 'self', 'agent', 'human'] as const;
  export type ApprovalMode = (typeof APPROVAL_MODES)[number];
  /** 3-R6: the code defaults; koda #301 replaces the source, not the call sites. */
  export function approvalModeFor(origin: ToolOrigin, tool: string): ApprovalMode {
    return origin.kind === 'thread' ? 'human' : 'none';
  }
  ```

  The executor calls it once per write call, after the permission check and before the preview.
- **3-D14 Direct action record.** `ActionProposer` (the executor's late-bound port, 2a-D1) gains
  `recordDirect(input: DirectActionInput): Promise<{ actionId: string }>`, implemented by `AssistantActionService`.
  `DirectActionInput` (in `pending-action.domain.ts`) carries `projectId`, `tool`, `input`, `preview`, `actorType`,
  `actorId`, `origin`, `status` (`EXECUTED` or `FAILED`), `result` and `now`. `recordDirect` calls the repository's
  `insertDirect` once: a single insert of the terminal row with `approvalMode 'none'`, no approver, no `approvalId`,
  thread, job, tool-call id, `requestedById` or `decidedById`, `decidedAt` and `expiresAt` = `now`. No PENDING row ever
  exists for a direct action, and no `FleetApproval` is opened.
- **3-D15 The `none` path in the executor.** For a write tool whose mode is `none`, the executor:
  1. runs the tool's `preview` (its refusals stay `invalid_input`/`forbidden`/`not_found`, record no action and skip
     the execute);
  2. runs the tool's `execute` as the caller;
  3. masks the outcome text with `maskSecrets` and caps it at `RESULT_CAP_BYTES` minus 64 bytes, so the action
     suffix always fits: `EXECUTED` with the execute text, or `FAILED` with the `ToolActionError` text, `not_found`, or
     `error: <tool> failed` (the mapping `executeAction` uses);
  4. calls `recordDirect` with that status and text;
  5. answers `<text>\naction <actionId>`, with `isError` false for `EXECUTED` and true for `FAILED`. The audit row's
     `outcome` is `ok` for `EXECUTED`, `not_found` for a `not_found` failure and `error` for any other failure.
  - If `recordDirect` throws after the tool's write, the executor logs the error and answers
    `error: <tool> failed (the change was made but its action was not recorded)` with `isError` true; the tool's write
    stands.
  - Modes `self` and `agent` are not served: the executor answers `error: <tool> failed`, logs it, and records no
    action. Mode `human` for an MCP origin is likewise refused (only a thread can hold a proposal).
- **3-D16 MCP catalog.** `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` exports
  `mcpToolDescriptors(): readonly KodaToolDescriptor[]`: the WORKSPACE projection
  (`kodaToolDescriptorsFor('WORKSPACE')`), in its order, with the description of each tool named in `MCP_DESCRIPTIONS`
  replaced. `MCP_DESCRIPTIONS` holds one description for each of the nine write tools and for `koda_get_action`: the
  thread wording ("only after the user approves it … do not call this tool again") is false over MCP. Each write
  description says the call "runs at once as the calling agent" and that the answer ends with the action id. In every
  MCP description, the WORKSPACE sentence `In a workspace thread, name the project with \`project\` (a slug
  koda_my_projects lists).` is replaced by `Name the project with \`project\` (a slug koda_my_projects lists).`, which
  is true outside a thread. Input schemas are not changed.
- **3-D17 MCP results.** `toMcpToolResult(result: ToolResult)` answers
  `{ content: [{ type: 'text', text: result.content }], isError: result.isError }`.
- **3-D18 MCP route.** `apps/api/src/fleet/assistant/mcp/mcp.controller.ts`, in `AssistantModule`:
  - `@Post('mcp')`, `@Get('mcp')` and `@Delete('mcp')` under the global `api` prefix, all forwarded to one handler.
    `@Throttle({ default: { limit: 120, ttl: 60_000 } })`. `@ApiExcludeController()` keeps the route out of
    `openapi.json` (precedent `fleet/repo-config/fleet-config-test-hooks.controller.ts`): MCP is a JSON-RPC protocol
    endpoint, not a REST contract. For the same reason it writes the SDK's `Response` directly instead of
    `JsonResponse.Ok`, with an inline comment saying so (`.nax/rules/api-controllers.md`).
  - Refusals before the handler, in order: `mcpEnabled` false answers 409 `mcp.disabled`; a principal that is not an
    agent answers 403 `mcp.agentOnly`. The guard has already answered 401 for no or a bad bearer.
  - The MCP handler is created once, in the controller's constructor:
    `createMcpHandler(factory, { responseMode: 'json' })` (default `legacy: 'stateless'`). Each request is converted
    with `toWebRequest(req.raw, body)`, passed as `handler.fetch(request, { authInfo })` where `authInfo.extra.principal`
    is the agent principal, and the `Response` status, headers and body are written to the Fastify reply.
  - `mcp/mcp-server.factory.ts` exports two functions:
    - `kodaMcpToolRegistrations(executor: Pick<AssistantToolExecutor, 'executeFor'>, principal: AgentPrincipal):
      McpToolRegistration[]`, one `{ name, description, inputSchema, handler }` per `mcpToolDescriptors()` entry, in
      order. Each `handler(input)` calls `executor.executeFor({ principal, origin: { kind: 'mcp' }, disabled: false },
      { name, input })` and answers `toMcpToolResult(...)`; if `executeFor` throws, it logs the error and answers
      `toMcpToolResult({ content: 'error: <name> failed', isError: true })`.
    - `createKodaMcpServer(registrations: McpToolRegistration[]): McpServer` builds
      `McpServer({ name: 'koda', version: '1' })` and calls `registerTool(name, { description, inputSchema }, handler)`
      for each, the schema wrapped with the SDK's JSON Schema adapter (for example `fromJsonSchema`).
    - The handler factory passed to `createMcpHandler` reads the agent principal from the request's `authInfo` and
      answers `createKodaMcpServer(kodaMcpToolRegistrations(executor, principal))`.
  - No Host or Origin validation: the route requires a bearer key, and koda-wk binds behind its own proxy.
- **3-D19 Config.** A new `apps/api/src/config/mcp.config.ts`: `mcpConfig = registerAs('mcp', ...)` answering
  `IMcpConfig { mcpEnabled: boolean }` from `MCP_ENABLED` (`'true'` turns it on, anything else keeps it off).
  `AssistantModule` imports `ConfigModule.forFeature(mcpConfig)`, and `McpController` injects it with
  `@Inject(mcpConfig.KEY) cfg: ConfigType<typeof mcpConfig>`. It is not added to `ConfigBridgeModule` or the root
  `load` list, and `IFleetConfig` is unchanged.
- **3-D20 Dependencies.** `@modelcontextprotocol/server@2.3.1` and `@modelcontextprotocol/node@2.1.1` are added to
  `apps/api/package.json` dependencies on the spec branch before the run (Out of Scope); US-007 imports them.

### Integration

Read-only — the feature calls these as they are:

- `CombinedAuthGuard` (`apps/api/src/auth/guards/combined-auth.guard.ts`): `tryApiKey` resolves an agent key to an
  `AgentPrincipal` on any guarded route; OFFLINE agents are refused, PAUSED agents authenticate.
- `isAgentPrincipal(principal: KodaPrincipal): principal is AgentPrincipal`
  (`apps/api/src/auth/principal/koda-principal.types.ts:44`).
- `ProjectAccessService.findProjectIdBySlug(slug): Promise<string>` and
  `resolveMembership(projectId, principal: KodaPrincipal): Promise<string | null>`
  (`apps/api/src/projects/project-access.service.ts`); an agent on the roster answers `null`, off it throws
  `ForbiddenAppException`.
- `KodaCaslAbilityFactory.createForUser(principal: IPrincipal)`; `getPermissions` gives agents `agentPermissions`
  (`apps/api/src/auth/casl/koda-casl-ability.factory.ts`).
- `kodaToolDescriptorsFor(kind: ChatThreadKind)` and `withProjectArgument(d)`
  (`apps/api/src/fleet/assistant/koda-tool-descriptors.ts:704-724`).
- `AssistantActionService.propose`, `AssistantActionDecisions`, `PendingActionExpirySweeper` and
  `PrismaChatThreadRepository.pendingActions` — unchanged; they only ever see thread-origin rows (3-D8).
- `ToolResult`, `ToolInputError`, `ToolForbiddenError`, `ToolActionError` (`assistant-tool.types.ts`); `capText`,
  `maskSecrets`, `fenceData` (`assistant-tool-safety.ts`); `RESULT_CAP_BYTES` (`assistant-tool.executor.ts:19`).
- `seedFleetHttpWorld`, `seedFleetHttpAgent` and `seedThreadJobFor` (`apps/api/test/helpers/fleet-fixtures.ts` and
  the fleet integration helpers); `migrationsBefore`, `applyMigration` and the scratch-schema helper
  (`apps/api/test/helpers/migration-schema.ts`), as used by
  `apps/api/test/integration/outbox/outbox-migration.integration.spec.ts`.
- SDK v2: `createMcpHandler(factory, { responseMode, legacy })` answering `{ fetch, close }`, `McpServer`,
  `fromJsonSchema(schema)` (`@modelcontextprotocol/server`); `toWebRequest(req, parsedBody)`
  (`@modelcontextprotocol/node`). A tool handler reads auth through `ctx.http?.authInfo`.

Changed — the baseline exists only to locate the code; the target is the interface to implement:

- `ToolContext` (`assistant-tool.types.ts`)
  - Baseline: `actor: UserPrincipal; threadId: string; jobId: string`.
  - Target: `actor: UserPrincipal | AgentPrincipal; threadId: string | null; jobId: string | null`; the other fields
    unchanged. New exports `ToolOrigin` and `ToolCaller` (3-D1).
- `AssistantToolExecutor` (`assistant-tool.executor.ts`)
  - Baseline: `execute(call: ToolCall)` replays, looks the tool up, reads `findCallContext(call.jobId)` and runs;
    `checkAction`/`executeAction` read the requester from `findCallContext(action.jobId)`; every write proposes.
  - Target: `execute(call: ToolCall)` keeps its front checks and hands a thread caller to the shared path;
    `executeFor(caller: ToolCaller, call: { name: string; input: unknown })` is the non-thread entry (3-D2).
    `checkAction`/`executeAction` read the actor through `findUserActor` (3-D12). The write path consults
    `approvalModeFor` and serves `human` (propose) and `none` (3-D15).
- `AssistantToolCallRecord` and `AssistantToolCallRepository` (`assistant-tool-call.domain.ts`)
  - Baseline: `jobId`, `threadId`, `toolCallId`, `projectId` are `string`; no actor; no `findUserActor`.
  - Target: those four are `string | null`; adds `actorType: 'user' | 'agent'` and `actorId: string`; the repository
    adds `findUserActor(userId: string)` (3-D10, 3-D12).
- `PendingActionRecord`, `ActionProposer` and `PendingActionRepository` (`actions/pending-action.domain.ts`)
  - Baseline: the record has no actor or approval fields; the port has `propose` only; the repository has no
    `findScopedByActor` or `insertDirect`.
  - Target: the record adds `actorType`, `actorId`, `origin`, `approvalMode`, `approverType`, `approverId` (its thread
    fields stay `string`, 3-D8); new `ActionStatusView` and `DirectActionInput`; the port adds `recordDirect`; the
    repository adds `findScopedByActor(id, projectId, actor: { type: 'user' | 'agent'; id: string }):
    Promise<ActionStatusView | null>` and `insertDirect(input: DirectActionInput): Promise<{ id: string }>`.
- `AssistantActionService` (`actions/assistant-action.service.ts`)
  - Baseline: implements `propose` only.
  - Target: also implements `recordDirect` (3-D14).

### Failure Handling

| Case | Behaviour |
|---|---|
| `MCP_ENABLED` not `true` | 409 `mcp.disabled` on every MCP method |
| No bearer, or an unknown or OFFLINE agent key | 401 from the existing guard |
| A user JWT on the MCP route | 403 `mcp.agentOnly` |
| `project` missing or malformed on a project tool | `invalid_input: project`, `isError: true`; audit row with null `projectId` |
| A project the agent is not rostered on, or an unknown slug | `not_found: project`, `isError: true`; nothing written |
| An agent calls a tool whose CASL tuple it lacks | `forbidden: <tool> needs <action> <subject> on <slug>`, `isError: true`; no action |
| A write tool's preview refuses | `invalid_input: <reason>` / `forbidden: …` / `not_found`; no action recorded, no execute |
| A `none`-mode execute throws `ToolActionError` | action `FAILED` with its text; answer `<text>\naction <id>`, `isError: true` |
| A `none`-mode execute throws `NotFoundAppException` | action `FAILED` with `not_found`; `isError: true` |
| A `none`-mode execute throws anything else | action `FAILED` with `error: <tool> failed`, stack logged; `isError: true` |
| `recordDirect` throws after the tool's write | `error: <tool> failed (the change was made but its action was not recorded)`, logged; `isError: true` |
| The policy answers `self` or `agent`, or `human` for an MCP origin | `error: <tool> failed`, logged; no action recorded |
| `koda_get_action` for another agent's or another project's action | `not_found` |
| An approval check for an action whose actor is not a user | `forbidden` (the approve writes nothing) |
| HTTP GET or DELETE on `/api/mcp` (enabled, agent key) | 405 from the SDK's stateless legacy handling |
| `executeFor` throws inside an MCP tool handler (unknown tool, a database error) | `error: <tool> failed`, `isError: true`, logged |

## Out of Scope

- A personal access token or any user-scoped key; MCP authenticates with agent API keys only (3-R1).
- User JWT callers on the MCP route; they are refused with `mcp.agentOnly` (3-R1).
- A web editor or store for the approval policy, per-project or per-agent modes, and an agent-facing decide path for
  `agent` mode (koda #301).
- Serving the `self` and `agent` approval modes; the policy never answers them here, and the executor refuses them.
- Dropping `PendingAction.requestedById` and `PendingAction.decidedById`. This feature still writes them for thread
  rows; the contract step that drops them follows after this feature is deployed.
- Renaming the `PendingAction` table or its model.
- Changing the approval payload key `requestedById` that the web reads (`apps/web/lib/fleet-approvals.ts`).
- Any web change: thread actions render as today, and MCP actions never reach the inbox (mode `none`).
- Changes to the runner, the fleet protocol, the ASSIGN tool descriptors or `FLEET_PROTOCOL_VERSION`.
- Deriving tool descriptions from the approval mode; the MCP descriptions are a fixed map until koda #301.
- Granting agents `FleetJob` or other new abilities; agents keep the agent CASL they have over REST.
- Idempotent replay of an MCP tool call; MCP calls carry no tool-call id (3-D5).
- MCP resources, prompts, completions, `subscriptions/listen`, tasks, elicitation and sampling.
- OAuth protected-resource metadata or any MCP authorization-server flow.
- Host-header or Origin validation on the MCP route (3-D18).
- A per-agent cap on actions; `none`-mode actions are never pending, and the per-thread cap is unchanged.
- Adding `@modelcontextprotocol/server@2.3.1` and `@modelcontextprotocol/node@2.1.1` to `apps/api/package.json` and
  the lockfile; this is done on the spec branch before `nax run`, not by a story.
- Notifications for `none`-mode actions; no approval is requested, so `fleet_approval_requested` is not enqueued.
- An `openapi.json` change; the MCP controller is excluded from the spec (3-D18).
- US-002 only: the WORKSPACE-thread and REPO-thread project rules are unchanged and are covered by the existing
  executor specs; this feature adds no AC for them.
- US-005 only: a preview refusal by `ToolForbiddenError` or `NotFoundAppException`, an execute that throws
  `NotFoundAppException` or an unexpected error, and the policy answering `agent` or `human` for an MCP origin follow
  the Failure Handling mappings through the code paths the pinned cases use; this feature adds no AC for each of them.
- US-005 only: `koda_get_action` for an action of another project answers `not_found` through the same scoped read the
  other-agent case pins; this feature adds no AC for it.
- US-007 only: a PAUSED agent authenticates and an unknown or OFFLINE key answers 401, as the existing guard does
  today; this feature adds no AC for agent status or a bad key beyond the missing-bearer case.
- US-007 only: `DELETE /api/mcp` answers 405 through the same SDK path as `GET`; the 409 `mcp.disabled` answer is the
  same controller check for every method; the 120-per-minute throttle (tracked per client IP, so agents behind one
  proxy share it), the JSON response mode, the handler being built once and the `error: <tool> failed` answer for a
  throwing `executeFor` carry no AC of their own.

## Stories

1. **US-001: Actor model schema and persistence** — `Workdir: apps/api` — No dependencies.
2. **US-002: Tool caller and origin-aware tools** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Approval check reads the action's actor** — `Workdir: apps/api` — Depends on US-002.
4. **US-004: Approval policy and the direct action record** — `Workdir: apps/api` — Depends on US-003.
5. **US-005: The `none` path in the executor** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: MCP tool catalog** — `Workdir: apps/api` — No dependencies.
7. **US-007: MCP route** — `Workdir: apps/api` — Depends on US-005, US-006.

- US-001 lands the schema, the migration and every persistence consequence of it in one story, so the story passes
  the `type-check` and `build` gates on its own: both domain record types, both Prisma repositories (mappers, writers,
  the `insert` and `resolve` actor derivation, `findUserActor`, `findScopedByActor`), and the executor's audit-row
  literal (`actorType 'user'`, `actorId` = the thread creator). Thread behaviour is unchanged.
- US-002 reshapes the executor and `ToolContext` for a caller and makes the four origin-dependent tools work with no
  thread. US-003 moves the approval check onto the action's actor. US-004 adds the policy and the direct-action record.
  US-005 wires the `none` path into the executor. US-006 is the MCP projection, independent of the executor. US-007
  wires the route.
- US-001, US-002, US-003 and US-005 run one after another because each edits `assistant-tool.executor.ts`; US-001 and
  US-004 both edit the pending-action domain and repository.
- Integration tests follow the fixtures of `test/integration/fleet/assistant-actions-decide.integration.spec.ts`:
  `seedFleetHttpWorld` (project `web` with repository `acme/app`, foreign project `ops`), DEVELOPER `dev`, a RUNNING
  REPO THREAD job from `seedThreadJobFor`, `FLEET_THREADS_ENABLED=true` before boot. Agent-caller tests also create
  agent `claude` with `seedFleetHttpAgent` (`test/helpers/fleet-fixtures.ts`, a real API key) and an `AgentProject`
  row for `web` only, so `claude` reaches `web` and not `ops` under the default `AGENT_PROJECT_SCOPING`.
- US-007 integration tests boot the app with `MCP_ENABLED=true` (and one test without it).
- Each test reads only what it wrote, and the tests pass in any order (`.nax/rules/api-test-isolation.md`).
- The tests need the compose test DB (`bun run test:db:up`).
- US-001 changes the Prisma schema; no story changes a REST DTO or adds a REST contract, so none regenerates
  `openapi.json`.

### Context Files

**US-001**

- `apps/api/prisma/schema.prisma` — `PendingAction` (1114-1141) and `AssistantToolCall` (1090-1109)
- `apps/api/test/helpers/migration-schema.ts` — `migrationsBefore`, `applyMigration`, scratch schema
- `apps/api/test/integration/outbox/outbox-migration.integration.spec.ts` — the backfill test pattern
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts` — the unchanged decide path that calls `resolve`
- `apps/api/test/integration/fleet/assistant-actions-decide.integration.spec.ts` — propose and decide fixtures

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolContext`, `AssistantTool`
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `execute`, `run`, `runInNamedProject`, `execTool`
- `apps/api/src/projects/project-context.ts` — `withProjectRole`, which passes an agent through unchanged
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `findScopedByActor`, `ActionStatusView` (from US-001)
- `apps/api/test/helpers/fleet-fixtures.ts` — `seedFleetHttpWorld`, `seedFleetHttpAgent`

**US-003**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `checkAction`, `executeAction`, `actionScope`
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `findUserActor` (from US-001)
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `PendingActionRecord` actor fields (from US-001)

**US-004**

- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `ActionProposer`, the repository interface
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — `propose`, where `recordDirect` goes
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — `insert`, where `insertDirect` goes
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolOrigin`, created by US-002

**US-005**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `proposeWrite`, `executeAction`, the write path
- `apps/api/src/fleet/assistant/actions/approval-policy.ts` — created by US-004; `approvalModeFor`
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `addCommentTool`, the write tool the tests drive
- `apps/api/test/integration/fleet/assistant-tool-executor.integration.spec.ts` — executor-level DB fixtures

**US-006**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `kodaToolDescriptorsFor`, `withProjectArgument`, the write descriptors
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the WORKSPACE projection tests to mirror
- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolResult`

**US-007**

- `apps/api/src/fleet/assistant/runner-tool.controller.ts` — a guarded controller in this module to mirror
- `apps/api/src/fleet/assistant/assistant.module.ts` — controllers, providers and imports
- `apps/api/src/config/fleet.config.ts` — the `registerAs` config pattern to mirror
- `apps/api/src/fleet/repo-config/fleet-config-test-hooks.controller.ts` — `@ApiExcludeController()` precedent
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — created by US-006; `mcpToolDescriptors`, `toMcpToolResult`

### Creates

**US-001**

- `apps/api/prisma/migrations/20261025090000_assistant_action_actor/migration.sql` — the columns, nullability and backfill (3-D11)
- `apps/api/test/integration/fleet/assistant-action-actor-migration.integration.spec.ts` — the backfill and schema tests
- `apps/api/test/integration/fleet/assistant-action-actor.integration.spec.ts` — thread action actor, approver and repository-read tests

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.executor.caller.spec.ts` — `executeFor` and the thread adapter unit tests
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — unit tests of the four origin-dependent tools with no thread
- `apps/api/test/integration/fleet/assistant-executor-caller.integration.spec.ts` — agent-caller tests over the real DB

**US-003**

- `apps/api/src/fleet/assistant/assistant-tool.executor.actor.spec.ts` — `checkAction`/`executeAction` actor tests

**US-004**

- `apps/api/src/fleet/assistant/actions/approval-policy.ts` — `APPROVAL_MODES`, `ApprovalMode`, `approvalModeFor`
- `apps/api/src/fleet/assistant/actions/approval-policy.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/assistant-direct-action-record.integration.spec.ts` — `recordDirect` over the real DB

**US-005**

- `apps/api/src/fleet/assistant/assistant-tool.executor.direct.spec.ts` — the `none` path unit tests
- `apps/api/test/integration/fleet/assistant-direct-action.integration.spec.ts` — the `none` path over the real DB

**US-006**

- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `MCP_DESCRIPTIONS`, `mcpToolDescriptors`, `toMcpToolResult`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — its unit tests

**US-007**

- `apps/api/src/config/mcp.config.ts` — `mcpConfig`, `IMcpConfig` (3-D19)
- `apps/api/src/fleet/assistant/mcp/mcp.controller.ts` — `McpController` (3-D18)
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.ts` — `kodaMcpToolRegistrations`, `createKodaMcpServer`, `McpToolRegistration`
- `apps/api/src/fleet/assistant/mcp/mcp-server.factory.spec.ts` — its unit tests
- `apps/api/test/integration/fleet/mcp-route.integration.spec.ts` — route tests with real agent keys
- `apps/api/src/i18n/en/mcp.json` — the `disabled` (409) and `agentOnly` (403) messages
- `apps/api/src/i18n/zh/mcp.json` — the same keys in Chinese

### Modifies

**US-001**

- `apps/api/prisma/schema.prisma` — `PendingAction` gains `actorType`, `actorId`, `origin` (default `thread`), `approvalMode` (default `human`), `approverType?`, `approverId?`; `threadId`, `jobId`, `toolCallId` and `requestedById` become optional and the `thread` relation optional; `AssistantToolCall` gains `actorType` and `actorId`, and `jobId`, `threadId`, `toolCallId` and `projectId` become optional with the `job` relation optional (3-D7, 3-D10). Every other model unchanged.
- `apps/api/test/integration/fleet/assistant-action-delivery.integration.spec.ts` — its seed helper's `prisma.pendingAction.create` call (line 89) adds `actorType: 'user'` and `actorId` equal to the seed's `requestedById`, because both columns become required; no assertion changes.
- `apps/api/test/integration/fleet/assistant-action-send-delivery.integration.spec.ts` — its seed helper's `prisma.pendingAction.create` call (line 108) adds `actorType: 'user'` and `actorId` equal to the seed's `requestedById`, because both columns become required; no assertion changes.
- `apps/api/src/fleet/assistant/assistant-tool-call.domain.ts` — `AssistantToolCallRecord` gains `actorType`/`actorId`, and `jobId`, `threadId`, `toolCallId`, `projectId` become nullable (3-D10); `AssistantToolCallRepository` gains `findUserActor(userId)` (3-D12).
- `apps/api/src/fleet/assistant/prisma-assistant-tool-call.repository.ts` — `toPersistenceCreate`/`toDomain` carry the actor columns and the nullable fields; implements `findUserActor` (id, email, role, disabled of the user; null when absent); `findByCall` and `findCallContext` unchanged.
- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — `PendingActionRecord` gains `actorType`, `actorId`, `origin`, `approvalMode`, `approverType`, `approverId` (thread fields stay `string`, 3-D8); adds `ActionStatusView`; `PendingActionRepository` gains `findScopedByActor`. `NewPendingAction`, `ProposeInput` and `ActionResolution` unchanged.
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — `insert` derives the thread actor fields and `resolve` writes the approver when `decidedById` is given (3-D9); the mapper reads the new columns and throws on a null thread field of a row it maps; implements `findScopedByActor` (the id, in the project, with the given actor; null otherwise).
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the audit-row literal in `execute` gains `actorType: 'user'` and `actorId` = the thread creator's id; nothing else changes in this story.

**US-002**

- `apps/api/src/fleet/assistant/assistant-tool.types.ts` — `ToolContext.actor` widens to `UserPrincipal | AgentPrincipal`, `threadId`/`jobId` to `string | null`; adds `ToolOrigin` and `ToolCaller` (3-D1). `AssistantTool` and the error classes unchanged.
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — adds `executeFor`; `execute` keeps its front checks and hands a thread caller to the shared path; the MCP origin follows the WORKSPACE project rules (3-D2, 3-D3); the audit row takes its actor from the caller and a null `projectId` when no project resolved; `ToolScope` and the principal casts widen to the union.
- `apps/api/src/fleet/assistant/tools/action-tools.ts` — `getActionTool`'s dependency widens to `findScopedById | findScopedByActor`, and a call with `ctx.threadId` null reads `findScopedByActor` with `{ type: ctx.actor.actorType, id: ctx.actor.id }` and prints from an `ActionStatusView` (3-D6); thread behaviour unchanged.
- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — stores `sourceType: 'mcp'` and `sourceId: ctx.actor.id` when `ctx.threadId` is null (3-D6); thread behaviour unchanged.
- `apps/api/src/fleet/assistant/tools/record-decision-tool.ts` — passes `sourceId: mcp:<ctx.actor.id>` when `ctx.threadId` is null (3-D6); thread behaviour unchanged.
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts` — `koda_list_approvals` narrows with `isAgentPrincipal` and passes `role: null` for an agent actor (3-D6); user behaviour unchanged.

**US-003**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `checkAction`/`executeAction` resolve the actor with `findUserActor(action.actorId)` and refuse a non-user actor (3-D12).
- `apps/api/src/fleet/assistant/assistant-tool.executor.spec.ts` — the `checkAction`/`executeAction` tests stub `findUserActor` with the same user their `findCallContext` stub carries today, and their action fixtures gain `actorType: 'user'` and `actorId` equal to that user; no expected outcome changes.
- `apps/api/src/fleet/assistant/actions/action-result-masking.spec.ts` — its repository stub gains `findUserActor` answering the same user its `findCallContext` stub carries, and `approvedAction()` gains `actorType: 'user'` and `actorId` equal to that user, because `executeAction` now reads the actor from the action; no expected outcome changes.
- `apps/api/src/fleet/assistant/write-tool-errors.spec.ts` — its repository stub gains `findUserActor` answering the same user its `findCallContext` stub carries, and its approved-action fixture gains `actorType: 'user'` and `actorId` equal to that user, for the same reason; no expected outcome changes.
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.spec.ts` — the stubs behind its real executor gain `findUserActor` answering the requester, and its action fixtures gain `actorType: 'user'` and `actorId` equal to the requester, for the same reason; no expected outcome changes.

**US-004**

- `apps/api/src/fleet/assistant/actions/pending-action.domain.ts` — adds `DirectActionInput`; `ActionProposer` gains `recordDirect`; `PendingActionRepository` gains `insertDirect` (3-D14).
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts` — implements `insertDirect` as one `create` of the terminal row (3-D14).
- `apps/api/src/fleet/assistant/actions/assistant-action.service.ts` — implements `recordDirect` (3-D14); `propose` unchanged.

**US-005**

- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the write path calls `approvalModeFor`; `human` keeps `proposeWrite` for a thread origin, `none` takes the direct path, and the other answers refuse (3-D13, 3-D15).

**US-006**

None. The story only creates the catalog module and its spec; it reads the descriptors without changing them.

**US-007**

- `apps/api/src/fleet/assistant/assistant.module.ts` — imports gain `ConfigModule.forFeature(mcpConfig)` (3-D19); controllers gain `McpController`.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — gains a test that `McpController` resolves in the compiled module; existing tests unchanged.

### Seams

- **US-001 → US-002, US-003.** `findScopedByActor` and `findUserActor` are added by US-001 and first called by US-002
  (`koda_get_action` with no thread) and US-003 (`checkAction`); each consumer has a unit AC asserting the call and its
  arguments, and US-001 pins the reads themselves against the real DB.
- **US-002 → US-005, US-007.** `executeFor` with an MCP caller is the entry the direct path and the route use.
  US-007's integration test spies on `AssistantToolExecutor.executeFor` while sending `tools/call` to `POST /api/mcp`
  and asserts the caller it received.
- **US-004 → US-005.** `recordDirect` is reached only through the executor's `none` path; US-005's unit tests stub it
  and assert its arguments, and US-005's integration test reads the row it stored.
- **US-005 → US-007.** US-007's write test proves the end-to-end answer ends with `action <id>` and that the stored
  action has `approvalMode 'none'`.
- **US-006 → US-007.** `mcpToolDescriptors` is what `tools/list` answers; US-007's integration test compares the
  route's tool names with it, and a unit AC compares `kodaMcpToolRegistrations` names with it.

## Acceptance Criteria

### US-001: Actor model schema and persistence (`Workdir: apps/api`)

1. [integration] In a scratch schema migrated with every migration before `20261025090000_assistant_action_actor`, a `PendingAction` row with `requestedById` `u1`, then the `20261025090000_assistant_action_actor` migration applied, reads back `actorType` `user` and `actorId` `u1`.
2. [integration] That migrated row reads back `origin` `thread` and `approvalMode` `human`.
3. [integration] A `PendingAction` row with `decidedById` `u2` before the migration reads back `approverType` `user` and `approverId` `u2` after it.
4. [integration] A `PendingAction` row with `decidedById` null before the migration reads back `approverType` null and `approverId` null after it.
5. [integration] An `AssistantToolCall` row whose `FleetJob` has `requestedById` `u1`, inserted before the migration, reads back `actorType` `user` and `actorId` `u1` after it.
6. [integration] An `AssistantToolCall` row whose `threadId` names no existing `ChatThread` (the thread was deleted), inserted before the migration, reads back `actorId` equal to its job's `requestedById` after it, and the migration completes.
7. [integration] On the pushed test schema, `prisma.pendingAction.create` with `threadId`, `jobId`, `toolCallId` and `requestedById` null, `actorType` `agent`, `origin` `mcp` and `approvalMode` `none` succeeds.
8. [integration] `prisma.assistantToolCall.create` with `jobId`, `threadId`, `toolCallId` and `projectId` null and `actorType` `agent` succeeds.
9. [integration] `POST /fleet/runner/jobs/:jobId/tools/koda_add_comment?leaseEpoch=<n>` from the runner holding `dev`'s RUNNING REPO THREAD job, with `{ ref: <a ticket of web>, body: 'x' }`, stores a `PendingAction` whose `actorType` is `user`, `actorId` is `dev`'s id, `origin` is `thread` and `approvalMode` is `human`.
10. [integration] The `AssistantToolCall` row stored for that route call has `actorType` `user` and `actorId` equal to `dev`'s id.
11. [integration] After `dev` approves that action at `POST /projects/web/fleet/approvals/:approvalId/decide` with `{ decision: 'approve' }`, the action has `approverType` `user` and `approverId` equal to `dev`'s id.
12. [integration] After `dev` rejects another such action with `{ decision: 'reject' }`, it has status `REJECTED`, `approverType` `user` and `approverId` equal to `dev`'s id.
13. [integration] An action expired by `PendingActionExpirySweeper` has status `EXPIRED`, `approverType` null and `approverId` null.
14. [integration] `findUserActor` on the tool-call repository answers the user's `id`, `email`, `role` and `disabled` for an existing user, and `null` for an unknown id.
15. [integration] The pending-action repository's `findScopedByActor` answers a view of an action stored with that project and actor, and `null` for the same id asked with another agent's id.

### US-002: Tool caller and origin-aware tools (`Workdir: apps/api`)

1. [unit] `AssistantToolExecutor.execute` with a thread `ToolCall` runs the tool with `ctx.actor.id` equal to the thread creator's id and `ctx.threadId`/`ctx.jobId` equal to the thread and job of `findCallContext`.
2. [unit] `execute` with a `(jobId, toolCallId)` that `findByCall` already holds answers the stored result without calling `findCallContext` (today's order).
3. [unit] `executeFor` with an MCP caller for agent `claude` running `koda_get_ticket` with `{ project: 'web', ref: 'WEB-1' }`, when `resolveMembership` answers `null`, calls the tool's `execute` with `ctx.actor.id` equal to `claude`'s id.
4. [unit] In that call, the tool's `execute` receives `ctx.projectSlug` `web`, `ctx.threadId` `null` and `ctx.jobId` `null`.
5. [unit] `executeFor` with an MCP caller for `koda_get_ticket` and no `project` key answers content `invalid_input: project` with `isError` true.
6. [unit] `executeFor` with an MCP caller for `koda_my_projects` and no `project` key calls the tool's `execute` with `ctx.projectId` `''`.
7. [unit] `executeFor` with an MCP caller records one `AssistantToolCall` whose `actorType` is `agent`, `actorId` the agent's id, and `jobId`, `threadId` and `toolCallId` null, and never calls `findByCall`.
8. [unit] `executeFor` with an MCP caller for `koda_get_ticket` and no `project` key records an `AssistantToolCall` whose `projectId` is null.
9. [unit] `getActionTool(...).execute` with `ctx.threadId` null and an agent actor calls `findScopedByActor` with the id, `ctx.projectId` and `{ type: 'agent', id: ctx.actor.id }`.
10. [unit] `addMemoryTool(...).execute` with `ctx.threadId` null passes `sourceType` `mcp` and `sourceId` equal to `ctx.actor.id` to the memory upsert.
11. [unit] `recordDecisionTool(...).execute` with `ctx.threadId` null passes `sourceId` equal to `mcp:` followed by `ctx.actor.id` to `recordDecision`.
12. [unit] `koda_list_approvals` executed with an agent actor passes an approval route whose `role` is `null`, and with a user actor whose `projectRole` is `DEVELOPER` passes `role` `DEVELOPER`.
13. [integration] `AssistantToolExecutor.executeFor` with an MCP caller for agent `claude` (rostered on `web` only) running `koda_search_tickets` with `project` `web` answers `isError` false and content naming a ticket of `web`.
14. [integration] The same caller running `koda_search_tickets` with `project` `ops` answers content `not_found: project`.
15. [integration] The `AssistantToolCall` row stored for the `web` call has `actorType` `agent`, `actorId` equal to `claude`'s id, and `jobId` null.

### US-003: Approval check reads the action's actor (`Workdir: apps/api`)

1. [unit] `AssistantToolExecutor.checkAction` for an action with `actorType` `user` and `actorId` `u1` calls `findUserActor` with `u1` and does not call `findCallContext`.
2. [unit] `checkAction` for an action whose `findUserActor` answer is a disabled user answers `forbidden`.
3. [unit] `checkAction` for an action with `actorType` `agent` answers `forbidden` without calling `findUserActor`.
4. [unit] `executeAction` for an action with `actorType` `user` runs the tool's `execute` with `ctx.actor.id` equal to the action's `actorId`.
5. [integration] After `dev` approves a `koda_add_comment` action proposed from `dev`'s REPO THREAD job, the comment exists on the ticket and the action's status is `EXECUTED`.

### US-004: Approval policy and the direct action record (`Workdir: apps/api`)

1. [unit] `APPROVAL_MODES` equals `['none', 'self', 'agent', 'human']`.
2. [unit] `approvalModeFor({ kind: 'thread', threadId: 't1', jobId: 'j1', threadKind: 'REPO', homeProject: { id: 'p1', slug: 'web' } }, 'koda_add_comment')` returns `human`.
3. [unit] `approvalModeFor({ kind: 'mcp' }, 'koda_add_comment')` returns `none`.
4. [integration] `AssistantActionService.recordDirect` with status `EXECUTED`, actor agent `claude`, origin `mcp` and result `done` answers an `actionId` naming a stored `PendingAction` with status `EXECUTED` and result `done`.
5. [integration] That stored row has `actorType` `agent`, `actorId` equal to `claude`'s id, `origin` `mcp` and `approvalMode` `none`.
6. [integration] That stored row has `approverType`, `approverId`, `approvalId`, `threadId`, `jobId`, `toolCallId`, `requestedById` and `decidedById` all null.
7. [integration] That stored row has `decidedAt` and `expiresAt` both equal to the `now` passed in.
8. [integration] `recordDirect` opens no `FleetApproval`: no approval row's payload names the new action id.
9. [integration] `recordDirect` with status `FAILED` and result `not_found` stores a row with status `FAILED` and result `not_found`.
10. [integration] `PendingActionExpirySweeper` run with a clock a day after the `now` of a `recordDirect` row leaves that row's status unchanged.

### US-005: The `none` path in the executor (`Workdir: apps/api`)

1. [unit] `executeFor` with an MCP caller for a write tool calls the tool's `execute` once and does not call the action proposer's `propose`.
2. [unit] When that write tool's `execute` answers `comment c1 added to WEB-1 /web/tickets/WEB-1` and `recordDirect` answers action id `a1`, the result content is `comment c1 added to WEB-1 /web/tickets/WEB-1\naction a1` with `isError` false.
3. [unit] When that write tool's `execute` throws `new ToolActionError('dispatch refused: open PR on WEB-1')`, `recordDirect` receives status `FAILED` and result `dispatch refused: open PR on WEB-1`, and the answer has `isError` true.
4. [unit] When that write tool's `preview` throws `new ToolInputError('ref')`, the answer is `invalid_input: ref`, and neither the tool's `execute` nor `recordDirect` is called.
5. [unit] When `approvalModeFor` answers `self`, `executeFor` answers content `error: koda_add_comment failed` and calls neither `execute` nor `recordDirect`.
6. [unit] `recordDirect` receives `actorType` `agent`, `actorId` equal to the caller's agent id, `origin` `mcp` and the preview text the tool's `preview` answered.
7. [unit] When the tool's `execute` answers a text containing `ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `recordDirect` receives a result with that token masked.
8. [unit] When the tool's `execute` answers a 20000-byte text, the answer content ends with `\naction a1` and is at most `RESULT_CAP_BYTES` bytes long.
9. [unit] When `recordDirect` throws after the tool's `execute` succeeded, the answer is `error: koda_add_comment failed (the change was made but its action was not recorded)` with `isError` true.
10. [unit] The audit row of an `EXECUTED` direct call has `outcome` `ok` and `isError` false.
11. [unit] The audit row of a direct call whose `execute` threw `ToolActionError` has `outcome` `error` and `isError` true.
12. [integration] `executeFor` with an MCP caller for agent `claude` (rostered on `web`) running `koda_add_comment` with `{ project: 'web', ref: <a ticket of web>, body: 'from mcp' }` creates a `Comment` on that ticket whose `authorAgentId` is `claude`'s id.
13. [integration] That call stores one `PendingAction` with status `EXECUTED`, `actorType` `agent`, `actorId` `claude`'s id, `origin` `mcp` and `approvalMode` `none`.
14. [integration] `executeFor` with an MCP caller for `claude` running `koda_add_comment` with `{ project: 'ops', ... }` answers `not_found: project`, creates no `Comment` on `ops`, and stores no `PendingAction` in `ops`.
15. [integration] `executeFor` with an MCP caller for a second agent rostered on `web`, running `koda_get_action` with the id of `claude`'s stored action, answers content `not_found`.

### US-006: MCP tool catalog (`Workdir: apps/api`)

1. [unit] `mcpToolDescriptors().map((d) => d.name)` equals `kodaToolDescriptorsFor('WORKSPACE').map((d) => d.name)`.
2. [unit] `mcpToolDescriptors()[0].name` is `koda_my_projects`.
3. [unit] Every `mcpToolDescriptors()` entry other than `koda_my_projects` has `inputSchema.required[0]` equal to `project`.
4. [unit] For every name, the `inputSchema` of the `mcpToolDescriptors()` entry deep-equals the `inputSchema` of the `kodaToolDescriptorsFor('WORKSPACE')` entry with the same name.
5. [unit] The keys of `MCP_DESCRIPTIONS`, as a set, equal `koda_get_action`, `koda_add_comment`, `koda_create_tickets`, `koda_update_ticket`, `koda_link_tickets`, `koda_add_memory`, `koda_record_decision`, `koda_dispatch_job`, `koda_requeue_job` and `koda_cancel_job`.
6. [unit] No `mcpToolDescriptors()` entry's `description` contains `only after the user approves`.
7. [unit] Every `mcpToolDescriptors()` entry for one of the nine write tools has a `description` containing `runs at once as the calling agent`.
8. [unit] Every `mcpToolDescriptors()` entry other than `koda_my_projects` has a `description` containing `Name the project with \`project\`` and none contains `In a workspace thread`.
9. [unit] The `koda_search_tickets` entry of `mcpToolDescriptors()` has a `description` that starts with the `description` of `koda_search_tickets` in `KODA_TOOL_DESCRIPTORS`.
10. [unit] Every `mcpToolDescriptors()` description is at most 2000 characters long.
11. [unit] `toMcpToolResult({ content: 'x', isError: false })` deep-equals `{ content: [{ type: 'text', text: 'x' }], isError: false }`.
12. [unit] `toMcpToolResult({ content: 'not_found', isError: true })` answers `isError` true with the single text `not_found`.

### US-007: MCP route (`Workdir: apps/api`)

1. [integration] With `MCP_ENABLED` unset, `POST /api/mcp` with `claude`'s agent key and a `tools/list` request answers HTTP 409.
2. [integration] With `MCP_ENABLED=true`, `POST /api/mcp` with a user's JWT bearer answers HTTP 403.
3. [integration] With `MCP_ENABLED=true`, `POST /api/mcp` with no `Authorization` header answers HTTP 401.
4. [integration] With `MCP_ENABLED=true`, a JSON-RPC `initialize` request (`protocolVersion` `2025-11-25`) with `claude`'s key answers HTTP 200 with `result.serverInfo.name` `koda`.
5. [integration] A `tools/list` request with `claude`'s key answers tool names equal to `mcpToolDescriptors().map((d) => d.name)`.
6. [integration] A `tools/call` for `koda_search_tickets` with `{ project: 'web' }` and `claude`'s key (rostered on `web`) answers `result.isError` false and text naming a ticket of `web`.
7. [integration] A `tools/call` for `koda_search_tickets` with `{ project: 'ops' }` answers `result.isError` true and text `not_found: project`.
8. [integration] A `tools/call` for `koda_add_comment` with `{ project: 'web', ref: <a ticket of web>, body: 'via mcp' }` answers text ending `action <id>`, where `<id>` names a stored `PendingAction` with `approvalMode` `none`.
9. [integration] After that call, the ticket has a `Comment` with body `via mcp` and `authorAgentId` equal to `claude`'s id.
10. [integration] A `tools/call` for `koda_dispatch_job` with `{ project: 'web', repo: 'acme/app', command: 'RUN', feature: <a feature no other test uses>, maxCostUsd: 0.5 }` answers `result.isError` true and text `forbidden: koda_dispatch_job needs create FleetJob on web`.
11. [integration] After that call, no `FleetJob` with that feature exists and no `PendingAction` names `koda_dispatch_job` for `claude`.
12. [integration] While a `tools/call` for `koda_get_ticket` is sent to `POST /api/mcp` with `claude`'s key, a spy on `AssistantToolExecutor.executeFor` receives a caller whose `principal.id` is `claude`'s id and whose `origin` is `{ kind: 'mcp' }`.
13. [integration] `GET /api/mcp` with `claude`'s key and `MCP_ENABLED=true` answers HTTP 405.
14. [unit] In `assistant.module.spec.ts`, the compiled `AssistantModule` resolves `McpController`.
15. [unit] `kodaMcpToolRegistrations(stubExecutor, principal).map((r) => r.name)` equals `mcpToolDescriptors().map((d) => d.name)`.
