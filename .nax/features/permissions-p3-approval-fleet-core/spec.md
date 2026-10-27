# SPEC: Permissions P3d-1 — Engine Support for Fleet Asks

## Summary

This feature extends the approval engine so the two fleet asks can move onto it in the next feature. Nothing in production switches here: `FleetApproval` and its routes keep working unchanged.
- **Two catalog keys.** `fleet.job.shell.escalate` (a running nax job asks to run a shell command outside its grants) and `fleet.budget.override` (a budget hard stop paused a scope). Both are approvable with the default `agent`. `fleet.budget.override` gets the floor `self`, because a decider must choose the new amount.
- **Developer decides bash asks.** The seeded Developer role gains `approval.decide@fleet.job.shell.escalate`, and a migration adds it to an existing database's stored Developer role.
- **Decisions can carry a choice.** A decision may carry `params` (a bash allow for this ask or for the whole job; a budget raise with its amount and the jobs to re-queue). An approval command validates them with an optional `parseDecision`. It may also act on a rejection in the decide transaction (`onReject`) and run follow-up work after its execution commits (`afterCommit`). `POST /approvals/:id/decisions` and the MCP tool `koda_decide_approval` accept `params`.
- **Asks raised by the system.** `ApprovalAskService.open` opens a request inside the caller's transaction for an ask raised by a system component (the runner relay, the budget evaluator), on behalf of a principal or of nobody. `ApprovalAskService.close` settles such a request as `cancelled` or `expired` with a reason (job ended, superseded, window reset, ...). The person a job was run for may decide its asks, as the thread's user may decide the assistant's writes.
- **The fleet link table.** `FleetApprovalAsk` holds what the fleet needs to find and update an ask: its kind, the job, lease and nax ask id (unique, so a re-reported ask is idempotent), the budget policy, how it was resolved and the delivery and re-queue outcome.

This is the first half of feature 4 of P3 in `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine", "Asks raised by runners and the system"). The P3 order (ruled 2026-10-26): approval-core, approval-api, approval-assistant, **approval-fleet**, approval-gate, web. Feature 4 was split on 2026-10-27 into this feature (`permissions-p3-approval-fleet-core`) and `permissions-p3-approval-fleet`, which switches the producers and readers and drops `FleetApproval`.

## Motivation

The engine shipped for writes a principal asks for: `ApprovalGate.gate` runs a registered command at once or opens a request, and a decision is approve or reject. The fleet asks do not fit that shape in four ways:
- **They are raised by the system, not by a principal.** A bash ask arrives in a runner report; a budget ask is opened by the budget evaluator when spend crosses a hard stop. Both are opened inside a transaction that already holds the job or budget policy lock (S1.5 lock order, `apps/api/src/fleet/approvals/domain/approval.domain.ts`). The gate refuses every `SYSTEM` actor except the assistant, opens its own transaction, and runs the command when no approval is needed.
- **A decision is more than approve or reject.** A bash ask is answered `allow`, `allow_for_job` or `deny` (`apps/api/src/fleet/approvals/bash-decision.ts`). A budget ask is answered `keep_paused` or `raise_budget_and_resume` with an `amountUsd` and the cancelled jobs to re-queue (`ApprovalsService.decide`).
- **A rejection has an effect.** A bash deny sends `APPROVAL_ANSWER` with choice `deny` to the runner. The engine's reject writes the decision and nothing else.
- **They close without a decision.** A bash ask closes when its job leaves `RUNNING`. A budget ask closes when a newer hard stop supersedes it, its policy is deleted, its window resets or an admin resumes from the budgets page. The engine knows only expiry and the actor's own cancel.

Building these four pieces first, with no production caller, lets `permissions-p3-approval-fleet` move both asks and drop `FleetApproval` without also changing the engine.

**Rulings that bind this feature** (user):
- 2026-10-26: P3 is six features in order; feature 4 moves `nax_bash_escalate` to `fleet.job.shell.escalate` and `budget_override_required` to `fleet.budget.override` and drops `FleetApproval`. The deferred run is the command registry.
- 2026-10-27: feature 4 is split in two, this one first. The `/fleet/approvals` routes, their DTO, the fleet webhooks and the fleet live events stay as adapters over the engine (in the next feature) until P3 web replaces the screens.
- 2026-10-27: Developer keeps deciding bash asks: the seeded Developer role swaps `fleet.approval.decide.bash` for `approval.decide@fleet.job.shell.escalate`. This feature adds the new entry; the next feature removes the old key.
- Design decision 2: no data is copied. Design decision 8: a human acting directly satisfies any mode.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Bash asks are high risk.** By the catalog's rules `fleet.job.shell.escalate` would be medium risk (its last segment is not `delete`/`remove` and no high-risk prefix matches), so its default would be `none` and every bash ask would be allowed with nobody asked. `fleet.job.shell.` joins `HIGH_RISK_PREFIXES`, which gives the default `agent`: an agent other than the job's own, or a human, decides, as today.
- **A key whose decision needs the decider's input has the floor `self`.** `fleet.budget.override` cannot run with nobody asked, because someone must choose the amount. A new `DECIDER_INPUT_KEYS` set in `catalog.ts` holds it, and `buildEntry` gives such a key the floor `self` (still `human` for a critical key). A policy can therefore never set it to `none`.
- **`fleet.budget.override` is scope `any`.** A global budget policy's ask has no project; a project or repo policy's ask has one. `fleet.job.shell.escalate` is scope `project`: every job has a project.
- **Only the two fleet asks may be opened this way.** `open` pins each component to its one key, so the re-check skip and the on-behalf-of eligibility below cannot reach any other command.
- **The floor `self` still lets an agent decide a budget ask.** A `type:AGENT` or pattern policy at `self` is satisfied by any agent holding the decide permission and the action key; that agent chooses the amount in its params. What the floor rules out is nobody deciding.
- **The ask's subject is the principal it is on behalf of, or the system.** A bash ask is on behalf of the job's requester (`requestedByType`/`requestedById`, a user or an agent). It resolves with that principal as subject, so a policy for an agent or a role applies to the jobs that principal runs. A budget ask has no one on behalf: it resolves with a new subject type `SYSTEM` (the component id), which matches project and pattern policies only, like the rank-3 rule today, and never a role, type or principal policy. `SYSTEM` is not a policy subject a write can name (`ApprovalPolicyInput` is unchanged).
- **The ask actor is the component, and `runner` is not a system writer id.** `SYSTEM_ACTOR_IDS` (`action-context.ts`) derives from `system.*` keys, so `runAsSystem('runner', ...)` throws; `open` and the execution build their contexts with `runWithActionContext` and never call it. The next feature must not either.
- **The ask actor is the component.** The request's actor is `SYSTEM/<component>`, `runner` for a bash ask and `budget` for a budget ask (design §4: "the actor is `system:budget`"). The design says a bash ask's actor is "the job's agent"; a job has no executing agent identity, so the job's requester is recorded as `onBehalfOf` instead.
- **The principal an ask is on behalf of counts as its own requester.** `decideEligibility` treats the on-behalf-of principal of any `SYSTEM` actor as it already treats the assistant's: a user contributes `human` and an agent `self`. A user deciding an ask of a job it requested is allowed (today's rule), and an agent deciding an ask of its own job contributes only `self`, which the default `agent` refuses (today's "no agent self-approval" ruling, US-006 of `permissions-p1d`).
- **An ask is never re-checked against its actor's key at execution.** The re-check guards a principal whose permission was revoked while its request waited. An ask was not chosen by a principal: the decider's eligibility at decide time is the authority, and the command checks its own state when it runs (the job still `RUNNING` on the same lease; the budget policy still paused). `ApprovalExecutionService` skips the key re-check for a `SYSTEM` actor other than the assistant.
- **No principal can cancel an ask.** `ApprovalDecisionService.cancel` compares the current actor with the requester, and a `SYSTEM` actor other than the assistant has no principal requester, so the cancel is refused (`ApprovalCancelForbiddenError`). This is today's code; an AC pins it.
- **An ask never approves on timeout.** Its deadline is the asker's: nax denies a bash ask itself at its deadline, and a budget pause outlives any timeout. `open` snapshots `onTimeout: 'reject'` whatever the policy says, and caps `expiresAt` at the caller's `deadline`.
- **An ask the policy resolves to `none` opens no request.** `open` answers `{ status: 'not-needed' }` with the parsed input and writes nothing; the caller answers the ask itself (a bash allow). This matches the gate, which runs a `none` command with no request row.
- **`open` and `close` join the caller's transaction and lock nothing themselves except the request row.** They do not call `txManager.run`: the fleet callers already hold the job or budget policy lock, and a nested `run` that throws poisons the outer transaction (the approval-assistant B1 finding, `PrismaTransactionManager`). A caller outside a transaction is a programming error and throws.
- **No de-duplication in `open`.** The gate looks for a pending duplicate by input hash; an ask's idempotency is the fleet's own key (job, lease epoch, nax ask id), held by the unique index on `FleetApprovalAsk`.
- **Decision params are parsed at decide time and again at execution.** `parseDecision(decision, params, input)` validates the decider's params under the request lock, after eligibility (a caller who may not decide gets 403 whatever it sends), and its output is stored frozen in `ApprovalDecision.params`. The execution re-parses the stored value, as it re-parses the frozen input: `parseDecision` must accept its own output.
- **A command without `parseDecision` refuses params.** A decision with `params` on such a request is refused (`ApprovalDecisionParamsInvalidError('not-accepted')`, 400) and nothing is written, so a client cannot believe a choice was honoured when it was ignored.
- **`params` is at most 4 096 characters of canonical JSON.** A larger value is refused with `ApprovalDecisionParamsInvalidError('too-large')` before `parseDecision` runs.
- **`onReject` runs inside the decide transaction.** A throw rolls the whole decision back: no decision row, the request stays `pending`, and the error reaches the caller. The command decides what a rejection whose target is gone means (the bash command answers nothing when the job has ended).
- **`afterCommit` runs after the execution transaction commits, and its failure changes nothing.** It is for follow-up writes that need their own transactions (the budget re-queue, plan D232). A throw is logged as a warning; the request stays `executed`. It does not run after a `failed` settle.
- **`ApprovalAskService` lives in `src/approvals/`; the link table lives in `src/fleet/approvals/`.** The engine stays fleet-agnostic: the link is a fleet row that references `ApprovalRequest`, as `AssistantActionRequest` does.
- **The link table is `FleetApprovalAsk`.** The name avoids `FleetApproval`, which the next feature drops. `FleetApprovalAsk.requestId` references `ApprovalRequest.id` with `onDelete: Cascade`; `jobId` and `budgetPolicyId` are plain strings, as on `FleetApproval`, so a deleted job or policy leaves the ask readable.
- **Developer now passes the plain `approval.decide` check in a project.** `PermissionService.can` grants `approval.decide` to any holder of an `approval.decide@<pattern>` entry (`holdsNarrowedDecide`), so Developer's project `approval.decide` cell in the role matrix flips from `not-granted` to `granted`. The routes that check it (`GET /approvals`, the decide route) are `enforcedBy: 'service'`, and `decideEligibility` still limits a Developer to `fleet.job.shell.escalate` requests. Its global cell stays `not-granted`.
- **The stored Developer role is patched by the migration.** `SystemRoleSeeder` restores only locked roles from the seed, and Developer is unlocked, so the seed change alone never reaches an existing database. The migration appends `approval.decide@fleet.job.shell.escalate` to the `developer` row's `permissions` when that row holds `fleet.approval.decide.bash` and does not hold the new entry. A Developer role an admin has already edited to drop bash deciding is left alone.

### Catalog keys (US-001)

`apps/api/src/permissions/catalog.ts`:
```ts
const NEW_KEY_SCOPES = {
  // ... existing ten keys unchanged ...
  'fleet.job.shell.escalate': 'project',
  'fleet.budget.override': 'any',
};
const HIGH_RISK_PREFIXES = [ /* existing */ 'fleet.job.shell.' ];
/** Keys whose decision needs the decider's input, so nobody-asked (`none`) cannot run them. */
const DECIDER_INPUT_KEYS: ReadonlySet<string> = new Set(['fleet.budget.override']);
// buildEntry:
floor: !approvable ? 'none' : risk === 'critical' ? 'human' : DECIDER_INPUT_KEYS.has(key) ? 'self' : 'none',
```

Derived entries (US-001 AC-1, AC-2):

| Key | scope | access | risk | approvable | floor | default |
|:--|:--|:--|:--|:--|:--|:--|
| `fleet.job.shell.escalate` | project | role | high | true | none | agent |
| `fleet.budget.override` | any | role | high | true | self | agent |

Both join `PENDING_SURFACE_KEYS`: no route, tool or system writer declares them until `permissions-p3-approval-fleet`. The header comment's "plus the nine keys the design adds" becomes "plus the keys the design adds (`NEW_KEY_SCOPES`)". `catalog.spec.ts` keeps its own copies of `NEW_KEY_SCOPES` and `HIGH_RISK_PREFIXES` and its own derivation, and gains the same two keys, the prefix and the floor rule. `role-matrix.spec.ts` AC-2's column count goes from 221 to 223 and the snapshot is regenerated.

Who holds them through existing entries (the role-matrix snapshot shows it): Owner and Admin through `*`; Project Admin through `*` (both fit a PROJECT role); Developer holds `fleet.job.shell.escalate` through `fleet.job.*` but not `fleet.budget.override`. No other seeded role holds either.

### Developer seed (US-002)

`apps/api/src/permissions/system-roles.ts`: the `developer` entries gain `'approval.decide@fleet.job.shell.escalate'` directly after `'fleet.approval.decide.bash'` (which stays until the next feature).

Migration `apps/api/prisma/migrations/20261106090000_approval_fleet_core/migration.sql` holds this statement. Whichever of US-002, US-003 and US-009 lands first creates the file and the others append their statements in landing order; any order is valid, since the three statements touch different tables:
```sql
UPDATE "Role"
SET "permissions" = "permissions" || '["approval.decide@fleet.job.shell.escalate"]'::jsonb, "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND "permissions" @> '["fleet.approval.decide.bash"]'::jsonb
  AND NOT "permissions" @> '["approval.decide@fleet.job.shell.escalate"]'::jsonb;
```

Baseline (to locate the migration convention only): `apps/api/prisma/migrations/20261105090100_drop_pending_action/migration.sql`.

### Decision params (US-003, US-004, US-005)

`apps/api/src/approvals/approval-command.registry.ts`:
```ts
export interface ApprovalCommand<TInput = unknown, TResult = unknown, TDecision = unknown> {
  key: string;
  parse(input: unknown): TInput;
  /**
   * Validates a decider's params for this request. Absent: a decision may carry no params. The
   * returned value must be JSON-serialisable, and `parseDecision` must accept its own output: the
   * execution re-parses the value stored on the approving decision. Throws to refuse.
   */
  parseDecision?(decision: 'approve' | 'reject', params: unknown, input: TInput): TDecision;
  /** Runs inside the decide transaction after a principal's reject is recorded; a throw rolls it back. */
  onReject?(input: TInput, decision: TDecision | undefined): Promise<void>;
  /** `decision` is the approving decision's parsed params, or undefined when none were parsed. */
  execute(input: TInput, decision?: TDecision): Promise<TResult>;
  toResult?(result: TResult): unknown;
  /** Runs after the execution transaction committed, under the request's context; a throw is logged only. */
  afterCommit?(input: TInput, decision: TDecision | undefined, result: TResult): Promise<void>;
}
```

`ApprovalDecisionRecord` gains `params: unknown` (null when none). `NewApprovalDecision` becomes `Omit<ApprovalDecisionRecord, 'id' | 'decidedAt' | 'comment' | 'params'> & { comment?: string | null; decidedAt?: Date; params?: unknown }`, so existing `createDecision` calls without `params` still type-check. `createDecision` maps a `params` that is null or undefined to `Prisma.DbNull` (a plain `null` is refused by Prisma on a `Json?` column, as `toPersistenceUpdate` already handles for `input` and `result`) and passes any other value as `Prisma.InputJsonValue`; `decisionToDomain` maps a database NULL to `params: null`. `apps/api/prisma/schema.prisma` `ApprovalDecision` gains `params Json?`, in the migration as `ALTER TABLE "ApprovalDecision" ADD COLUMN "params" JSONB;`.

`ApprovalDecisionService.decide(requestId, decision, comment, now = new Date(), params?: unknown)`. The new parameter goes last, so every existing call (`decide(id, decision, comment)` and `decide(id, decision, null, now)`) is unchanged. A `params` of `null` is treated as absent (`undefined`) at the start of `decide`. Inside `record`, in this order after the eligibility check and before `createDecision`:
1. `command = registry.get(request.permissionKey)`; when the command has `parseDecision` or `onReject`, `parsedInput = command.parse(request.input)` once (a throw becomes `ApprovalDecisionParamsInvalidError('invalid')`). This refusal applies to a reject without params too, on purpose: the input was frozen from `parse`'s own output, so a parse that now throws means the command changed incompatibly, and the request is left to expire rather than settled by a decision the command cannot act on.
2. When `params !== undefined` and the command is absent or has no `parseDecision`: throw `ApprovalDecisionParamsInvalidError('not-accepted')`.
3. When `params !== undefined` and `canonicalJson(params).length > 4096`: throw `ApprovalDecisionParamsInvalidError('too-large')`.
4. When the command has `parseDecision`: `parsed = command.parseDecision(decision, params, parsedInput)`; a throw becomes `ApprovalDecisionParamsInvalidError('invalid')`.
5. `createDecision({ ..., params: parsed === undefined ? null : freezeApprovalInput(parsed) })`.
6. After the status transition and the `approval.decide` audit entry, on `reject` with `command?.onReject`: `await command.onReject(parsedInput, parsed)` under the same decide context (approval block included). `onReject` runs under the request row lock: it should write rows (a runner command row, as the fleet's `APPROVAL_ANSWER` is) and never do network I/O, which a rollback cannot undo.

`ApprovalDecisionService` gains the constructor parameter `registry: ApprovalCommandRegistry` as its last parameter (after `events`).

`ApprovalExecutionService`:
- The precheck gains a step after the input parse: when the command has `parseDecision`, it loads the request's decisions (`findDecisions`), takes the last one whose `decision` is `approve` (none after a timeout approval), and re-parses: `command.parseDecision('approve', stored?.params ?? undefined, parsed)`. A throw settles the request `failed` with `result: { error: 'invalid-decision' }`. `PrecheckFailure` gains `'invalid-decision'` and `Prechecked`'s ok branch gains `decision: unknown`.
- `run` calls `command.execute(parsed, decision)`.
- After `withCommittedEffects(...)` returns an `executed` record and the command has `afterCommit` (guaranteed after commit only when `execute` owns the transaction scope; inside an outer `withCommittedEffects` owner, such as the assistant executor's, it runs when that owner's callback returns), it awaits `command.afterCommit(parsed, decision, result)` inside a try/catch; a throw logs `approval request <id> after-commit failed: <message>` at warn and the settled record is still returned.

`apps/api/src/approvals/domain/approval.errors.ts` gains:
```ts
export type DecisionParamsRefusal = 'not-accepted' | 'too-large' | 'invalid';
export class ApprovalDecisionParamsInvalidError extends Error {
  constructor(readonly reason: DecisionParamsRefusal) { /* name + prototype as the others */ }
}
```
`rethrowApprovalError` maps it to `new ValidationAppException({ reason: error.reason }, 'approvals.invalidDecisionParams')`. `apps/api/src/i18n/en/approvals.json` and `zh/approvals.json` gain `invalidDecisionParams` with keys `"400"` and `"-2"`: `"Invalid decision params: {reason}"` / `"无效的决定参数：{reason}"`.

**REST and MCP (US-005).** `DecideApprovalRequestDto` gains:
```ts
@ApiPropertyOptional({ type: Object, description: 'The decider\'s choice, when the action asks for one' })
@IsOptional() @IsObject()
params?: Record<string, unknown>;
```
`ApprovalRequestsController.decide` passes it: `this.decisions.decide(id, dto.decision, dto.comment ?? null, undefined, dto.params)`. `ApprovalDecisionDto` gains `@ApiProperty({ type: Object, nullable: true }) params!: unknown;`, mapped from `record.params`. The MCP tool `koda_decide_approval` adds `params: { type: 'object' }` to its input schema's properties and `'params'` to its allowed argument names; a present `params` that is not a plain object answers `invalid_input: params`. With `params` absent it calls `decide(args.id, args.decision, comment)` exactly as today; with it, `decide(args.id, args.decision, comment, undefined, args.params)`. `openapi.json` is regenerated with `bun run api:export-spec` (repo root) after this story.

### Asks (US-006, US-007, US-008, US-010)

`apps/api/src/approvals/approval-ask.service.ts` (new), provided and exported by `ApprovalEngineModule`:
```ts
export interface OpenAsk {
  key: string;                                         // a registered command's key
  projectId: string | null;
  component: string;                                   // the SYSTEM actor id: 'runner' | 'budget'
  onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;
  origin: 'runner' | 'system';
  input: unknown;                                      // parsed with the command's `parse`
  deadline: Date | null;                               // caps expiresAt
}
export type AskOutcome<TInput = unknown> =
  | { status: 'not-needed'; input: TInput }
  | { status: 'pending'; request: ApprovalRequestRecord };

@Injectable()
export class ApprovalAskService {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    @Inject(ApprovalPolicyResolver) private readonly resolver: Pick<ApprovalPolicyResolver, 'resolve'>,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly requests: Pick<PrismaApprovalRequestRepository, 'create' | 'lockById' | 'transition'>,
    private readonly events: ApprovalRequestEvents,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}
  /** Inside the caller's transaction. */
  open<TInput>(ask: OpenAsk, now?: Date): Promise<AskOutcome<TInput>>;
  /** Inside the caller's transaction; null when the request is gone or not pending. */
  close(requestId: string, close: { status: 'cancelled' | 'expired'; reason: string }, now?: Date): Promise<ApprovalRequestRecord | null>;
}
```

`open` steps:
1. `txManager.isInTransaction()` is false: throw `Error('approval ask needs the caller\'s transaction')`.
2. Unknown command: `UnregisteredApprovalCommandError(key)`. The key must be the one `ASK_KEYS_BY_COMPONENT` (a constant in the service: `{ runner: 'fleet.job.shell.escalate', budget: 'fleet.budget.override' }`) gives for `component`; any other pair (the assistant, an empty component, `runner` with `ticket.delete`) throws `Error('approval ask key <key> is not raised by <component>')`, so a system-raised request, which skips the key re-check, exists only for the two fleet asks. A project-scope catalog key with `projectId === null`: `Error('approval ask needs a project for key <key>')`.
3. `parsed = command.parse(input)` (a throw propagates).
4. `subject = onBehalfOf ?? { type: 'SYSTEM', id: component }`; `resolved = await resolver.resolve({ key, projectId, subject })`.
5. `resolved.mode === 'none'`: answer `{ status: 'not-needed', input: parsed }`; nothing is written.
6. Otherwise, as bookkeeping `approval.request-open`, create the request: actor `{ type: 'SYSTEM', id: component }`, `onBehalfOf`, `origin`, `correlationId` = the current context's or a new UUID, `input = freezeApprovalInput(parsed)` and its `inputHash`, `requiredMode = resolved.mode`, `policyId`, `onTimeout: 'reject'`, `approverMustHoldAction` and `requireDistinctApprover` from the policy (true and false without one), `expiresAt = min(now + (policy?.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC) s, deadline)`, with `DEFAULT_APPROVAL_TIMEOUT_SEC` from `apps/api/src/approvals/domain/approval.domain.ts` (86 400; not the fleet protocol's 600). A `deadline` at or before `now` still opens the request, with `expiresAt = deadline`; the engine's sweeper expires it on its next tick (the fleet caller decides whether to open such an ask at all). Record the request event in the same transaction and answer `{ status: 'pending', request }`.

`close` steps: no transaction → the step-1 error. `lockById`; null or `status !== 'pending'` → null. The request's actor is not `SYSTEM` or is `SYSTEM/assistant` → `Error('approval ask close: not an ask')`. `reason` empty or longer than 64 characters → `Error('approval ask close: invalid reason')`. As bookkeeping `approval.request-settle`: `transition(id, 'pending', { status, settledAt: now, result: { closedBy: reason } })`, record the event, answer the record. A lost transition under the lock throws `ApprovalRequestNotPendingError`.

**Resolver (US-010).** `ApprovalSubject.type` widens to `ApprovalSubjectType | 'SYSTEM'`. For a `SYSTEM` subject `resolve` reads no role ids (as for `ASSISTANT`), `applicableSubjectRank` answers null for a role, type or principal policy and 3 for a pattern-only policy, and the fallback is `entry.approval.default`.

**Eligibility and execution (US-007).** `decideEligibility`: `isOnBehalf = request.actor.type === 'SYSTEM' && isSamePrincipal(decider, request.onBehalfOf)` (replacing the assistant-only comparison). `ApprovalExecutionService.recheckPrincipal` answers a new `'skip'` for a `SYSTEM` actor other than `assistant`, and `stillHoldsKey` answers true for it.

### The fleet link table (US-009)

`apps/api/prisma/schema.prisma`, in the same migration:
```prisma
/// Permissions P3d-1: the fleet's row for one ask on the approval engine. jobId and budgetPolicyId have no
/// foreign key (a deleted job or policy leaves the ask readable).
model FleetApprovalAsk {
  requestId      String    @id
  kind           String    // bash | budget
  projectId      String?
  jobId          String?
  leaseEpoch     Int?
  naxAskId       String?
  budgetPolicyId String?
  resolvedBy     String?   // user | timeout | job_ended | superseded | manual_resume | window_reset | policy_deleted
  outcome        Json?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  request        ApprovalRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, naxAskId])
  @@index([jobId])
  @@index([budgetPolicyId])
}
```
`ApprovalRequest` gains `fleetAsk FleetApprovalAsk?`.

`apps/api/src/fleet/approvals/domain/fleet-approval-ask.domain.ts` (new):
```ts
export type FleetAskKind = 'bash' | 'budget';
export interface FleetApprovalAskRecord {
  requestId: string; kind: FleetAskKind; projectId: string | null; jobId: string | null; leaseEpoch: number | null;
  naxAskId: string | null; budgetPolicyId: string | null; resolvedBy: ApprovalResolvedBy | null;
  outcome: Record<string, unknown> | null; createdAt: Date; updatedAt: Date;
}
export type NewFleetApprovalAsk = Pick<FleetApprovalAskRecord, 'requestId' | 'kind' | 'projectId'>
  & Partial<Pick<FleetApprovalAskRecord, 'jobId' | 'leaseEpoch' | 'naxAskId' | 'budgetPolicyId'>>;
/** A link joined with its request's status. */
export interface FleetAskWithStatus { ask: FleetApprovalAskRecord; status: ApprovalRequestStatus }
export const FLEET_APPROVAL_ASK_REPOSITORY = Symbol('FLEET_APPROVAL_ASK_REPOSITORY');
/** The `take` bound of `findPendingForJob` (`.nax/rules/api-data.md`: every findMany is bounded). */
export const MAX_PENDING_ASKS_PER_JOB = 100;
export interface IFleetApprovalAskRepository {
  insert(data: NewFleetApprovalAsk): Promise<FleetApprovalAskRecord>;
  findByRequest(requestId: string): Promise<FleetApprovalAskRecord | null>;
  /** S1.5 2a: a re-reported ask is the same ask. */
  findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetAskWithStatus | null>;
  /** SELECT ... FOR UPDATE on the link row, inside txManager.run. */
  lockByRequest(requestId: string): Promise<FleetApprovalAskRecord | null>;
  /** Links whose request is pending, oldest request first, at most MAX_PENDING_ASKS_PER_JOB (100). */
  findPendingForJob(jobId: string): Promise<FleetApprovalAskRecord[]>;
  findPendingForPolicy(budgetPolicyId: string): Promise<FleetApprovalAskRecord | null>;
  setResolvedBy(requestId: string, resolvedBy: ApprovalResolvedBy): Promise<FleetApprovalAskRecord>;
  /** Replaces the outcome. */
  setOutcome(requestId: string, outcome: Record<string, unknown>): Promise<FleetApprovalAskRecord>;
}
```
`ApprovalResolvedBy` is imported from the existing `approval.domain.ts` (which the next feature trims, keeping the type). `PrismaFleetApprovalAskRepository` (new, `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts`) extends `AbstractPrismaRepository` and is provided by `ApprovalStoreModule` behind `FLEET_APPROVAL_ASK_REPOSITORY`. The token is never exported (`.nax/rules/api-data.md` "Repositories are module-private"; the existing `APPROVAL_REPOSITORY` export goes away with `FleetApproval` in the next feature). The module's public contract is a new service, `FleetApprovalAskStore` (`apps/api/src/fleet/approvals/fleet-approval-ask.store.ts`), which injects the token and offers the same eight methods with the same signatures, each delegating to the repository; `ApprovalStoreModule` provides and exports it. `ApprovalStoreModule` is the module budgets and jobs import without a cycle (plan D226); `ApprovalsModule` imports both and could not be imported by them.

The migration's DDL for the table:
```sql
CREATE TABLE "FleetApprovalAsk" (
  "requestId" TEXT NOT NULL, "kind" TEXT NOT NULL, "projectId" TEXT, "jobId" TEXT, "leaseEpoch" INTEGER,
  "naxAskId" TEXT, "budgetPolicyId" TEXT, "resolvedBy" TEXT, "outcome" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FleetApprovalAsk_pkey" PRIMARY KEY ("requestId")
);
CREATE UNIQUE INDEX "FleetApprovalAsk_jobId_leaseEpoch_naxAskId_key" ON "FleetApprovalAsk"("jobId", "leaseEpoch", "naxAskId");
CREATE INDEX "FleetApprovalAsk_jobId_idx" ON "FleetApprovalAsk"("jobId");
CREATE INDEX "FleetApprovalAsk_budgetPolicyId_idx" ON "FleetApprovalAsk"("budgetPolicyId");
ALTER TABLE "FleetApprovalAsk" ADD CONSTRAINT "FleetApprovalAsk_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```
Postgres treats NULLs as distinct, so the unique index de-duplicates only bash links (all three columns set); budget links have null job columns and are never de-duplicated by it. After the schema change, `prisma migrate diff` from the migrations to the schema must be empty.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| Decision `params` on a command with no `parseDecision`, or with no registered command | `ApprovalDecisionParamsInvalidError('not-accepted')`, 400 `approvals.invalidDecisionParams`; nothing written | US-003, US-005 |
| `params` over 4 096 characters of canonical JSON | `ApprovalDecisionParamsInvalidError('too-large')`, 400; nothing written | US-003 |
| `parseDecision` (or the input re-parse before it) throws at decide | `ApprovalDecisionParamsInvalidError('invalid')`, 400; nothing written | US-003 |
| A decider who may not decide sends bad params | 403 `approvals.decideForbidden`; params never read | US-003 |
| `onReject` throws | The decide rolls back (no decision row, request `pending`); the error propagates | US-003 |
| Stored decision params fail `parseDecision` at execution | Request settled `failed`, `result: { error: 'invalid-decision' }`; command not run | US-004 |
| `afterCommit` throws | Warn logged; request stays `executed`; the call answers the executed record | US-004 |
| MCP `params` not a plain object | `invalid_input: params`; nothing decided | US-005 |
| `open` or `close` outside a transaction | `Error`; nothing written | US-006, US-008 |
| `open` with an unregistered key | `UnregisteredApprovalCommandError` | US-006 |
| `open` with a key its component does not raise (`assistant`, empty, or a non-fleet key) | `Error`; nothing written | US-006 |
| `open` for a project-scope key with no project | `Error`; nothing written | US-006 |
| `open` input refused by `parse` | The parse error propagates; nothing written | US-006 |
| A principal cancels an ask | `ApprovalCancelForbiddenError`, 403 `approvals.cancelForbidden` | US-007 |
| `close` on a request that is gone or not pending | Answers null; nothing written | US-008 |
| `close` on a request that is not an ask | `Error`; nothing written | US-008 |
| `close` with an empty or over-64-character reason | `Error`; nothing written | US-008 |
| A second link for the same job, lease epoch and nax ask id | Unique violation from `insert` | US-009 |

### Integration

- **Callers:** none in production. `permissions-p3-approval-fleet` registers the two commands and calls `open`, `close` and the link repository from the runner relay, the budget evaluator, sweeper and service, and the job transitions.
- **Existing flows unchanged:** the gate, the assistant's commands (no `parseDecision`, `onReject` or `afterCommit`), `FleetApproval` and `/fleet/approvals`. An assistant decision with no `params` stores `params: null`.
- **Outbox:** a request opened or closed by `ApprovalAskService` records `approval_request_changed`, so the live subscriber and `ApprovalRequestedSubscriber` see it. With no production caller nothing new is emitted here; the next feature decides the notification overlap with `fleet_approval_requested`.

## Out of Scope

- Switching any producer or reader to the engine, registering the two fleet commands, the adapters over `/fleet/approvals`, and dropping `FleetApproval`, `ApprovalCloser`, `ApprovalExpirySweeper` and the `fleet.approval.decide.*` keys: `permissions-p3-approval-fleet`.
- Removing `fleet.approval.decide.bash` from the Developer seed: `permissions-p3-approval-fleet`.
- The web inbox deciding fleet asks with params: P3 web.
- `SYSTEM` as a policy subject a write can name.
- De-duplicating identical asks across fleet keys: the fleet's unique link index does it per bash ask.
- Showing decision params in the CLI (`koda approvals show` prints them as part of the detail JSON already; no new formatting).
- Re-checking the asker's key at execution (designer call above).
- How the bash `onReject` answers the runner: it writes the `APPROVAL_ANSWER` command row in the decide transaction and wakes the runner after commit (`committedEffect`), in `permissions-p3-approval-fleet`.

## Stories

1. **US-001: The two fleet ask keys** — `Workdir: apps/api` — No dependencies. `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`, `DECIDER_INPUT_KEYS` and the floor rule in `catalog.ts`; both keys in `PENDING_SURFACE_KEYS`; the catalog spec's mirror; the role-matrix column count and snapshot.
2. **US-002: Developer decides bash asks** — `Workdir: apps/api` — Depends on US-001. The Developer seed entry, the migration statement that patches a stored Developer role, and the regenerated role-matrix snapshot.
3. **US-003: Decision params and rejection effects at decide** — `Workdir: apps/api` — No dependencies. `ApprovalDecision.params`, the command hooks `parseDecision` and `onReject`, `ApprovalDecisionParamsInvalidError` and its HTTP mapping and messages, and `ApprovalDecisionService.decide`'s new `params` and `registry`.
4. **US-004: Decision params and follow-up at execution** — `Workdir: apps/api` — Depends on US-003. The precheck's decision re-parse, `execute(input, decision)` and `afterCommit` in `ApprovalExecutionService`.
5. **US-005: Params on the decide route and the MCP tool** — `Workdir: apps/api` — Depends on US-003. `DecideApprovalRequestDto.params`, `ApprovalDecisionDto.params`, `koda_decide_approval`'s `params`, and `openapi.json`.
6. **US-006: Opening an ask** — `Workdir: apps/api` — Depends on US-001, US-010. `ApprovalAskService.open` with its component-to-key pinning, and the module wiring.
7. **US-007: Deciding and executing an ask** — `Workdir: apps/api` — Depends on US-002, US-004, US-006, US-010. On-behalf-of eligibility for any `SYSTEM` actor, no key re-check for an ask, and no principal cancel.
8. **US-008: Closing an ask** — `Workdir: apps/api` — Depends on US-006. `ApprovalAskService.close`.
9. **US-009: The fleet link table** — `Workdir: apps/api` — No dependencies. `FleetApprovalAsk`, its domain module, `PrismaFleetApprovalAskRepository` behind its module-private token, and the exported `FleetApprovalAskStore` service in `ApprovalStoreModule`.
10. **US-010: The SYSTEM subject in the resolver** — `Workdir: apps/api` — No dependencies. `ApprovalSubject.type` widened with `SYSTEM`, which matches pattern-only policies and never role, type or principal policies.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`, `buildEntry`, `PENDING_SURFACE_KEYS`
- `apps/api/src/permissions/catalog.spec.ts` — the mirrored derivation
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending`
- `apps/api/src/permissions/role-matrix.spec.ts` — column count, snapshot regeneration

**US-002**
- `apps/api/src/permissions/system-roles.ts` — the `developer` entries
- `apps/api/src/permissions/system-role.seeder.ts` — why the stored role needs the migration
- `apps/api/src/permissions/entry-matcher.ts` — `approval.decide@<pattern>` validation
- `apps/api/prisma/migrations/20261105090100_drop_pending_action/migration.sql` — migration convention

**US-003**
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand`
- `apps/api/src/approvals/approval-decision.service.ts` — `decide`, `record`
- `apps/api/src/approvals/domain/approval.domain.ts`, `apps/api/src/approvals/domain/approval.errors.ts`
- `apps/api/src/approvals/approval-http-errors.ts` — error mapping
- `apps/api/src/approvals/approval-input.ts`, `apps/api/src/approvals/canonical-json.ts`
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — the test command to extend with a `parseDecision`

**US-004**
- `apps/api/src/approvals/approval-execution.service.ts` — `precheck`, `run`
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `findDecisions`

**US-005**
- `apps/api/src/approvals/dto/decide-approval-request.dto.ts`, `apps/api/src/approvals/dto/approval-request.dto.ts`
- `apps/api/src/approvals/approval-requests.controller.ts`
- `apps/api/src/approvals/mcp/approval-mcp-tools.ts`

**US-006**
- `apps/api/src/approvals/approval-gate.service.ts` — `openRequest` and `newRequest`, the pattern to follow
- `apps/api/src/approvals/approval-engine.module.ts`
- `apps/api/src/action-context/audit-coverage.ts` — `bookkeeping`

**US-007**
- `apps/api/src/approvals/approval-eligibility.ts`
- `apps/api/src/approvals/approval-execution.service.ts` — `recheckPrincipal`, `stillHoldsKey`
- `apps/api/src/approvals/approval-decision.service.ts` — `cancel`

**US-008**
- the ask service US-006 creates — `open`'s transaction check and request shape
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts` — the settle pattern

**US-009**
- `apps/api/prisma/schema.prisma` — `FleetApproval`, `AssistantActionRequest`
- `apps/api/src/fleet/assistant/requests/prisma-assistant-action-request.repository.ts` — a link repository on the engine
- `apps/api/src/fleet/approvals/approval-store.module.ts` — where the repository is provided
- `.nax/rules/api-data.md`

**US-010**
- `apps/api/src/approvals/approval-policy.resolver.ts` — `applicableSubjectRank`

### Creates

- `apps/api/prisma/migrations/20261106090000_approval_fleet_core/migration.sql` — US-002 (the role patch), US-003 (the `params` column), US-009 (the table), appended in landing order
- `apps/api/src/approvals/approval-ask.service.ts` — US-006, US-008
- `apps/api/src/approvals/approval-ask.service.spec.ts` — US-006, US-008
- `apps/api/test/integration/approvals/approval-ask.integration.spec.ts` — US-006, US-007, US-008
- `apps/api/test/integration/approvals/approval-decision-params.integration.spec.ts` — US-003, US-004, US-005
- `apps/api/test/integration/permissions/developer-bash-decide-migration.integration.spec.ts` — US-002
- `apps/api/src/fleet/approvals/domain/fleet-approval-ask.domain.ts` — US-009
- `apps/api/src/fleet/approvals/prisma-fleet-approval-ask.repository.ts` — US-009
- `apps/api/src/fleet/approvals/fleet-approval-ask.store.ts` — US-009
- `apps/api/test/integration/fleet/fleet-approval-ask.repository.integration.spec.ts` — US-009

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.ts` — the two keys, the prefix, `DECIDER_INPUT_KEYS`, the floor rule, `PENDING_SURFACE_KEYS`, the header comment
- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES` and derivation gain the same keys, prefix and floor rule
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — `expectedPending` gains the two keys
- `apps/api/src/permissions/role-matrix.spec.ts` — AC-2's cell count goes from 221 to 223
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated by running the role-matrix spec with vitest's `-u` flag from apps/api; gains the two key columns

**US-002**
- `apps/api/src/permissions/system-roles.ts` — the `developer` entries gain `approval.decide@fleet.job.shell.escalate`
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — regenerated as in US-001; Developer's project `approval.decide` cell becomes `granted`
- `apps/api/src/permissions/role-matrix.spec.ts` — AC-13's `projectDecide.developer` pin becomes `granted`

**US-003**
- `apps/api/prisma/schema.prisma` — `ApprovalDecision.params Json?`
- `apps/api/src/approvals/approval-command.registry.ts` — `ApprovalCommand` gains `parseDecision`, `onReject`, `afterCommit` and the `decision` argument of `execute`
- `apps/api/src/approvals/approval-decision.service.ts` — `decide`'s `params`, the params steps in `record`, `onReject`, the `registry` constructor parameter
- `apps/api/src/approvals/approval-decision.service.spec.ts` — the constructor gains `registry`; the reject AC's exact `createDecision` call gains `params: null`
- `apps/api/src/approvals/domain/approval.domain.ts` — `ApprovalDecisionRecord.params`
- `apps/api/src/approvals/domain/approval.errors.ts` — `DecisionParamsRefusal` and `ApprovalDecisionParamsInvalidError`
- `apps/api/src/approvals/approval-http-errors.ts` — maps the new error to 400
- `apps/api/src/approvals/approval-http.spec.ts` — the decision literal gains `params: null`
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — `NewApprovalDecision` omits and re-adds `params` as optional; `createDecision` maps null/undefined `params` to `Prisma.DbNull`; `decisionToDomain` maps `params`
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — an option to build the test command with `parseDecision` and `onReject`
- `apps/api/src/i18n/en/approvals.json` — `invalidDecisionParams`
- `apps/api/src/i18n/zh/approvals.json` — `invalidDecisionParams`

**US-004**
- `apps/api/src/approvals/approval-execution.service.ts` — the decision re-parse, `execute(input, decision)`, `afterCommit`
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the request repository double gains `findDecisions`
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — records the `decision` `execute` received and takes an optional `afterCommit`

**US-005**
- `apps/api/src/approvals/dto/decide-approval-request.dto.ts` — `params`
- `apps/api/src/approvals/dto/approval-request.dto.ts` — `ApprovalDecisionDto.params`
- `apps/api/src/approvals/approval-http.spec.ts` — `ApprovalDecisionDto.from` output gains `params: null`
- `apps/api/src/approvals/approval-requests.controller.ts` — passes `dto.params` to `decide`
- `apps/api/src/approvals/mcp/approval-mcp-tools.ts` — the decide tool's `params`
- `apps/api/src/approvals/mcp/approval-mcp-tools.spec.ts` — the decide tool's input schema gains `params`
- `openapi.json` — regenerated with bun run api:export-spec from the repo root; the decide body and the decision DTO gain `params`, and no other operation changes

**US-006**
- `apps/api/src/approvals/approval-engine.module.ts` — provides and exports `ApprovalAskService`
- `apps/api/src/approvals/approval-engine.module.spec.ts` — the module test resolves `ApprovalAskService`

**US-007**
- `apps/api/src/approvals/approval-eligibility.ts` — on-behalf-of for any `SYSTEM` actor
- `apps/api/src/approvals/approval-eligibility.spec.ts` — the ask cases
- `apps/api/src/approvals/approval-execution.service.ts` — `recheckPrincipal` answers `'skip'` for an ask
- `apps/api/src/approvals/approval-execution.service.spec.ts` — the ask and assistant re-check cases

**US-009**
- `apps/api/prisma/schema.prisma` — `FleetApprovalAsk` and `ApprovalRequest.fleetAsk`
- `apps/api/src/fleet/approvals/approval-store.module.ts` — provides the repository behind its token and provides and exports `FleetApprovalAskStore`
- `apps/api/src/fleet/approvals/approval-store.module.spec.ts` — a consumer module importing `ApprovalStoreModule` injects `FleetApprovalAskStore`

**US-010**
- `apps/api/src/approvals/approval-policy.resolver.ts` — the `SYSTEM` subject
- `apps/api/src/approvals/approval-policy.resolver.spec.ts` — the `SYSTEM` subject cases

US-008 changes only `approval-ask.service.ts` and its spec, which US-006 creates (listed under Creates). `approval-repositories.integration.spec.ts` needs no change: `params` stays optional on `NewApprovalDecision`. The migration file is created by whichever of US-002, US-003 and US-009 lands first and extended by the others (listed under Creates).

### Seams

- US-001 → US-002: `approval.decide@fleet.job.shell.escalate` validates only once `fleet.job.shell.escalate` is in the catalog; US-002 AC-1 expands the Developer entries with it.
- US-003 → US-004, US-005: the stored `ApprovalDecision.params`. US-004 AC-1 decides with params and asserts the command executed with them; US-005 AC-1 posts params through the route.
- US-010 → US-006: the widened `ApprovalSubject.type` that `open` passes for a budget ask.
- US-002 → US-007: AC-6's Developer decider holds `approval.decide@fleet.job.shell.escalate` through the seed.
- US-010 → US-007: a budget ask resolves with the `SYSTEM` subject; US-007 AC-4 opens one through `open` with no stubbed resolver.
- US-006 → US-007, US-008: `ApprovalAskService.open`. US-007 and US-008 open their requests through it and then decide or close them.
- US-009 → `permissions-p3-approval-fleet`: `FleetApprovalAskStore`. No story here writes a link outside its own tests.

## Acceptance Criteria

Integration tests run with `bun run test:db:up` in `apps/api` first. Unit tests use the existing `test-approval-command.ts` helper or a command literal registered in a fresh `ApprovalCommandRegistry`.

### US-001: The two fleet ask keys

- AC-1 [unit] `findCatalogEntry('fleet.job.shell.escalate')` answers `{ scope: 'project', access: 'role', risk: 'high', approval: { approvable: true, floor: 'none', default: 'agent' } }` (as a `toMatchObject`).
- AC-2 [unit] `findCatalogEntry('fleet.budget.override')` answers `{ scope: 'any', access: 'role', risk: 'high', approval: { approvable: true, floor: 'self', default: 'agent' } }` (as a `toMatchObject`).
- AC-3 [unit] (regression pin) `findCatalogEntry('fleet.budget.read')` still answers `approval.approvable` false.
- AC-4 [unit] (regression pin) `findCatalogEntry('fleet.budget.update').approval.floor` is still `'none'`.
- AC-5 [unit] `PENDING_SURFACE_KEYS` equals the set `fleet.approval.decide.assistant`, `member.remove`, `fleet.job.shell.escalate`, `fleet.budget.override`.
- AC-6 [unit] The catalog spec's derivation test finds no mismatch for any catalog key, with `fleet.job.shell.` in its high-risk prefixes and the `self` floor for `fleet.budget.override` in its derivation.
- AC-7 [unit] Every role-matrix row has 223 cells.
- AC-8 [unit] In the regenerated role matrix, Developer's cell for `fleet.job.shell.escalate` in project `p1` is allowed.
- AC-9 [unit] Developer's cell for `fleet.budget.override` in project `p1` is denied.
- AC-10 [unit] Project Admin's cell for `fleet.budget.override` in project `p1` is allowed.
- AC-11 [unit] Viewer's cell for `fleet.job.shell.escalate` in project `p1` is denied.

### US-002: Developer decides bash asks

- AC-1 [unit] `SYSTEM_ROLES`' `developer` entries contain `'approval.decide@fleet.job.shell.escalate'`, and `expandEntries` of them does not throw.
- AC-2 [unit] `developer`'s entries still contain `'fleet.approval.decide.bash'`.
- AC-3 [unit] `expandEntries(<developer entries>, 'PROJECT')` contains `'approval.decide@fleet.job.shell.escalate'`.
- AC-4 [integration] A `developer` role row whose `permissions` is the seed without `'approval.decide@fleet.job.shell.escalate'`, after the migration's `UPDATE` statement is executed with `$executeRawUnsafe`, holds the entry exactly once at the end of its array.
- AC-5 [integration] Running the statement a second time leaves the row's `permissions` unchanged.
- AC-6 [integration] A `developer` row whose `permissions` lacks `'fleet.approval.decide.bash'` is unchanged by the statement.
- AC-7 [integration] A role row with key `reviewer` holding `'fleet.approval.decide.bash'` is unchanged by the statement.
- AC-8 [unit] In the role matrix, Developer's `approval.decide` cell in project `p1` is `granted`.
- AC-9 [unit] Developer's global `approval.decide` cell stays `not-granted`.

Verification note: the AC-4..7 statement is read from the migration file at test time (the test locates `20261106090000_approval_fleet_core/migration.sql` and extracts the `UPDATE "Role"` statement), so the test and the shipped SQL cannot drift.

### US-003: Decision params and rejection effects at decide

- AC-1 [integration] After migrations, an `ApprovalDecision` created through `createDecision` with `params: { remember: true }` is answered by `findDecisions` with `params` equal to `{ remember: true }`.
- AC-2 [integration] `decide(id, 'reject', null)` with no params on a request whose command has no `parseDecision` succeeds, the stored row's `params` column is SQL NULL, and `findDecisions` answers `params: null`.
- AC-3 [unit] `decide(id, 'approve', null, now, { remember: true })` on a request whose command has `parseDecision` returning `{ remember: true }` calls `createDecision` with `params: { remember: true }`.
- AC-4 [unit] `decide(id, 'reject', 'no', now, null)` on a command with no `parseDecision` is not refused and calls `createDecision` with `params: null`.
- AC-5 [unit] `decide(id, 'approve', null, now, { a: 1 })` on a command with no `parseDecision` rejects with `ApprovalDecisionParamsInvalidError` whose `reason` is `'not-accepted'`, and `createDecision` is not called.
- AC-6 [unit] Params whose canonical JSON is 4 097 characters reject with reason `'too-large'` before `parseDecision` is called.
- AC-7 [unit] A `parseDecision` that throws makes `decide` reject with reason `'invalid'`, and `transition` is not called.
- AC-8 [unit] A decider refused by eligibility, sending params, gets `ApprovalDecideForbiddenError` and `parseDecision` is not called.
- AC-9 [unit] `parseDecision` receives `('approve', params, <the command's parse of the request input>)`.
- AC-10 [unit] On `reject`, `onReject` is called once with the parsed input and the parsed params, after `transition` and before the transaction callback returns.
- AC-11 [unit] On `reject` for a command with `onReject` and no `parseDecision`, `onReject` is called with the command's parse of the request input and `undefined`.
- AC-12 [integration] An `onReject` that throws leaves the request `pending` and no `ApprovalDecision` row for it, and `decide` rejects with that error.
- AC-13 [unit] `rethrowApprovalError(new ApprovalDecisionParamsInvalidError('invalid'))` throws a `ValidationAppException` with prefix `approvals.invalidDecisionParams` and args `{ reason: 'invalid' }`.
- AC-14 [unit] `en/approvals.json` defines `invalidDecisionParams` with keys `"400"` and `"-2"`.
- AC-15 [unit] `zh/approvals.json` defines `invalidDecisionParams` with keys `"400"` and `"-2"`.

### US-004: Decision params and follow-up at execution

- AC-1 [integration] A request approved with params `{ remember: true }` executes its command with `decision` equal to `{ remember: true }`.
- AC-2 [unit] A command with `parseDecision` executing a request approved without params receives the value `parseDecision('approve', undefined, input)` returned.
- AC-3 [unit] The precheck calls `parseDecision('approve', { remember: true }, input)` when the request's only decision is an `approve` storing `{ remember: true }`.
- AC-4 [unit] A stored params value that `parseDecision` refuses at execution settles the request `failed` with `result` `{ error: 'invalid-decision' }`, and `execute` is not called.
- AC-5 [unit] A command with no `parseDecision` is executed with `decision` undefined, and `findDecisions` is not called.
- AC-6 [unit] After an `executed` settle, `afterCommit` is called once with the parsed input, the parsed decision and the command's raw result.
- AC-7 [unit] `afterCommit` is called after the transaction callback has returned (its call order is after `txManager.run` resolved).
- AC-8 [unit] An `afterCommit` that throws leaves the answered record `executed`, and the logger's `warn` is called with a message starting `approval request <id> after-commit failed:`.
- AC-9 [unit] A command whose `execute` throws (request settled `failed`) never has `afterCommit` called.

### US-005: Params on the decide route and the MCP tool

- AC-1 [integration] `POST /approvals/:id/decisions` with body `{ decision: 'approve', params: { remember: true } }` by an eligible decider answers 200, and the request's decision row stores `params` `{ remember: true }`.
- AC-2 [integration] The same route with `params: { a: 1 }` on a request whose command has no `parseDecision` answers 400 with the `invalidDecisionParams` message containing `not-accepted`.
- AC-3 [integration] `params: 'x'` (not an object) answers 400 from validation, and no decision row exists.
- AC-4 [integration] `GET /approvals/:id` of a request decided with params answers `decisions[0].params` equal to `{ remember: true }`.
- AC-5 [unit] `ApprovalDecisionDto.from` of a record with `params: null` answers `params: null`.
- AC-6 [unit] `koda_decide_approval`'s input schema's `properties.params` equals `{ type: 'object' }`, and `required` is still `['id', 'decision']`.
- AC-7 [unit] Calling the tool with `{ id: 'r1', decision: 'approve' }` calls `decide` with exactly `('r1', 'approve', null)`.
- AC-8 [unit] Calling it with `{ id: 'r1', decision: 'approve', params: { remember: true } }` calls `decide` with `('r1', 'approve', null, undefined, { remember: true })`.
- AC-9 [unit] Calling it with `params: []` answers `invalid_input: params`, and `decide` is not called.

### US-006: Opening an ask

- AC-1 [integration] Inside `txManager.run`, `open({ key: 'fleet.job.shell.escalate', projectId: P, component: 'runner', onBehalfOf: { type: 'USER', id: U }, origin: 'runner', input, deadline: null })` for a registered test command answers `status: 'pending'`, and the stored request's actor is `SYSTEM/runner`.
- AC-2 [integration] That stored request matches `{ onBehalfOf: { type: 'USER', id: U }, origin: 'runner', requiredMode: 'agent' }`.
- AC-3 [integration] The stored request's `onTimeout` is `'reject'` when the matching policy for the key has `onTimeout: 'approve'` and mode `agent`.
- AC-4 [unit] With no policy and a `deadline` 60 s after `now`, `expiresAt` is `now + 60 s`.
- AC-5 [unit] With a policy `timeoutSec: 120` and a `deadline` 600 s after `now`, `expiresAt` is `now + 120 s`.
- AC-6 [unit] With no policy and `deadline: null`, `expiresAt` is `now + 86 400 s`.
- AC-7 [unit] A `deadline` 1 s before `now` opens a pending request whose `expiresAt` equals that deadline.
- AC-8 [unit] A resolver answering `none` makes `open` answer `{ status: 'not-needed', input: <parsed> }`, and `create` and `events.record` are not called.
- AC-9 [unit] With `onBehalfOf: null`, `component: 'budget'` and key `fleet.budget.override`, the resolver is called with subject `{ type: 'SYSTEM', id: 'budget' }`.
- AC-10 [unit] With `onBehalfOf: { type: 'AGENT', id: 'a1' }`, the resolver is called with subject `{ type: 'AGENT', id: 'a1' }`.
- AC-11 [unit] `open` outside a transaction rejects with an `Error` whose message is `approval ask needs the caller's transaction`, and `create` is not called.
- AC-12 [unit] `open` with key `fleet.job.shell.escalate` and no command registered for it rejects with `UnregisteredApprovalCommandError`.
- AC-13 [unit] `open` with component `runner` and a registered command on `ticket.delete` rejects with an `Error`, and the resolver is not called.
- AC-14 [unit] `open` for `fleet.job.shell.escalate` with `projectId: null` rejects with an `Error`, and the resolver is not called.
- AC-15 [unit] An input the command's `parse` refuses makes `open` reject with that parse error, and the resolver and `create` are not called.

Verification note: `approval-engine.module.spec.ts` resolves `ApprovalAskService` from a module importing `ApprovalEngineModule` (its wiring check, as for the other exported services).

### US-007: Deciding and executing an ask

- AC-1 [unit] `decideEligibility` for a request with actor `SYSTEM/runner`, `onBehalfOf` `USER/u1`, `requiredMode: 'agent'`, decided by `USER/u1` holding the action key only, answers `{ ok: true, satisfiedBy: 'human' }`.
- AC-2 [unit] The same request (no policy, so `requireDistinctApprover` false) decided by `AGENT/a1` when `onBehalfOf` is `AGENT/a1` and the agent holds the action key and `approval.decide` answers `{ ok: false, reason: 'tier-too-low' }`.
- AC-3 [unit] The same request decided by `AGENT/a2` (not the on-behalf-of agent) holding the action key and `approval.decide@fleet.job.shell.escalate` answers `{ ok: true, satisfiedBy: 'agent' }`.
- AC-4 [integration] A budget-key ask opened with `open` (component `budget`, no `onBehalfOf`, project P, no policy), decided `approve` by a user holding `fleet.budget.override` in P but neither decide form, is refused with `ApprovalDecideForbiddenError` reason `missing-decide-permission`.
- AC-5 [unit] (regression pin) The assistant cases of `approval-eligibility.spec.ts` pass unchanged.
- AC-6 [integration] A bash-key ask opened with `open` on behalf of a Developer-bound user, decided `approve` by another Developer-bound user, is `executed`, and the command ran once.
- AC-7 [integration] An ask on behalf of user `u1` whose `RoleBinding` rows were all deleted after `open` still executes after an eligible decider approves it (no `permission-revoked`).
- AC-8 [unit] `ApprovalExecutionService.execute` of an approved request with actor `SYSTEM/runner` does not call `effectiveKeys`.
- AC-9 [unit] (regression pin) An approved assistant request (actor `SYSTEM/assistant`) whose on-behalf-of user lacks the key still settles `failed` with `{ error: 'permission-revoked' }`.
- AC-10 [integration] (regression pin, in `approval-ask.integration.spec.ts`) `ApprovalDecisionService.cancel` of a pending ask, called as the on-behalf-of user, rejects with `ApprovalCancelForbiddenError`, and the request stays `pending`.

### US-008: Closing an ask

- AC-1 [integration] Inside `txManager.run`, `close(id, { status: 'cancelled', reason: 'job_ended' })` of a pending ask answers the request with `status: 'cancelled'`.
- AC-2 [integration] That closed request's `settledAt` equals `now` and its `result` is `{ closedBy: 'job_ended' }`.
- AC-3 [integration] `close(id, { status: 'expired', reason: 'timeout' })` answers `status: 'expired'`.
- AC-4 [integration] Closing records one `approval_request_changed` outbox row whose `metadata.eventId` is `<id>:cancelled`.
- AC-5 [integration] Closing writes no `AuditEntry` row.
- AC-6 [unit] `close` of a request id for which `lockById` answers null answers null, and `transition` is not called.
- AC-7 [unit] `close` of an `executed` request answers null, and `transition` is not called.
- AC-8 [unit] `close` of a request with actor `SYSTEM/assistant` rejects with an `Error`, and `transition` is not called.
- AC-9 [unit] `close` of a request with actor `AGENT/a1` rejects with an `Error`.
- AC-10 [unit] `close` with reason `''` rejects with an `Error`.
- AC-11 [unit] `close` with a 65-character reason rejects with an `Error`.
- AC-12 [unit] A `transition` answering null under the lock makes `close` reject with `ApprovalRequestNotPendingError`.
- AC-13 [unit] `close` outside a transaction rejects with the same `Error` as US-006 AC-11.

### US-009: The fleet link table

- AC-1 [integration] After migrations, `insert({ requestId, kind: 'bash', projectId: P, jobId: J, leaseEpoch: 2, naxAskId: 'ask-1' })` then `findByRequest(requestId)` answers those values with null `budgetPolicyId`, `resolvedBy` and `outcome`.
- AC-2 [integration] `findByAsk(J, 2, 'ask-1')` answers that link with its request's `status`.
- AC-3 [integration] `findByAsk(J, 3, 'ask-1')` answers null.
- AC-4 [integration] A second `insert` with the same job, lease epoch and nax ask id for another request rejects with a Prisma error whose `code` is `P2002`.
- AC-5 [integration] `findPendingForJob(J)` answers the two links of `J` whose requests are `pending`, oldest request first (the query's `take` is `MAX_PENDING_ASKS_PER_JOB`), and leaves out a link of `J` whose request is `cancelled` and a pending link of another job.
- AC-6 [integration] `findPendingForPolicy(B)` answers the link with `budgetPolicyId: B` whose request is `pending` and null when its only link's request is `expired`.
- AC-7 [integration] Inside a transaction, `lockByRequest(requestId)` answers the link row, and null for a request with no link.
- AC-8 [integration] `setResolvedBy(requestId, 'job_ended')` then `findByRequest` answers `resolvedBy` `'job_ended'`.
- AC-9 [integration] `setOutcome(requestId, { delivery: { result: 'ok' } })` then `setOutcome(requestId, { requeueResults: [] })` leaves `outcome` equal to `{ requeueResults: [] }`.
- AC-10 [integration] Deleting the `ApprovalRequest` deletes its link row.
- AC-11 [unit] A throwaway consumer module importing `ApprovalStoreModule` gets a `FleetApprovalAskStore` injected, and `ApprovalStoreModule`'s `exports` metadata does not contain `FLEET_APPROVAL_ASK_REPOSITORY`.

### US-010: The SYSTEM subject in the resolver

- AC-1 [unit] `resolve({ key: 'fleet.budget.override', projectId: P, subject: { type: 'SYSTEM', id: 'budget' } })` answers the mode of a project pattern-only policy for the key.
- AC-2 [unit] For that subject, a project role policy for the key is ignored (with only that policy present, the answer's `source` is `default`).
- AC-3 [unit] For that subject, a project `type:AGENT` policy for the key is ignored.
- AC-4 [unit] For that subject, a project `principal:AGENT:budget` policy for the key is ignored.
- AC-5 [unit] With no policy, the answer is the catalog default `agent`.
- AC-6 [unit] `roleIdsAt` is not called for a `SYSTEM` subject.
- AC-7 [unit] (regression pin) The resolver's existing `USER`, `AGENT` and `ASSISTANT` cases pass unchanged.

Verification note: `bun run db:generate` (repo root) runs after the schema change; `bun run --cwd apps/api type-check` passes.
