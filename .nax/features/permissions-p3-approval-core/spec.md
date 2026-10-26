# SPEC: Permissions P3a — The Approval Engine Core

## Summary

This feature gives `apps/api` the approval engine that P3's later features plug into. Nothing in production is gated by it yet.
- **Catalog approval metadata.** Every catalog entry's `approval` block gets real values. Reads and low-risk keys are not approvable. Role and approval-policy keys get the floor `human`. Agent defaults follow risk: high gets `agent`, critical gets `human`, everything else `none`. `approval.decide` becomes scope `any`, so a global Owner or Admin can decide global requests.
- **Three tables.** `ApprovalPolicy` (web-editable policy rows, written here through a service only), `ApprovalRequest` (one gated write waiting for approval, with its frozen input) and `ApprovalDecision` (who approved or rejected it).
- **Policy resolution.** `ApprovalPolicyResolver.resolve` picks the most specific policy for a key, a project and a subject (user, agent or the thread assistant), falls back to the catalog default, and clamps the result up to the catalog floor.
- **Policy writes.** `ApprovalPolicyService` creates, updates and deletes policy rows. It validates patterns, floors, timeouts and the anti-escalation rule, and records an `approval.policy.manage` audit entry.
- **Decide eligibility.** A pure function `decideEligibility` applies the ladder `none < self < agent < human`, the actor's own tier, `approverMustHoldAction`, `requireDistinctApprover` and `approval.decide@<pattern>`.
- **The command registry and the gate.** A feature that wants a write gated registers a command (`parse` + `execute`) under its permission key. `ApprovalGate.gate(key, input, { projectId })` runs it at once when no approval is needed (or the actor is a human acting directly). Otherwise it opens an `ApprovalRequest` with the parsed input frozen.
- **Deciding and executing.** `ApprovalDecisionService.decide` records an approve or reject decision under a row lock and audits it as `approval.decide`. An approval then runs `ApprovalExecutionService.execute`, which re-checks the actor's permission and runs the command from the frozen input. The domain write and `status = executed` commit in one transaction.
- **Expiry.** `ApprovalRequestExpirySweeper` settles pending requests past `expiresAt`: it rejects them (status `expired`), or approves and executes them when the snapshot says `onTimeout: approve`.

This is the first of six features implementing phase P3 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§4 "Approval engine"). The order (ruled 2026-10-26): **approval-core**, approval-api, approval-assistant, approval-fleet, approval-gate, web.

## Motivation

P1 gave every action a permission key and P2 records who did it. P3 decides **who must approve** an action before it runs (design principle 4: permission and approval are separate). Today approval exists only in two hard-coded, per-domain forms:
- `PendingAction` for thread assistant writes, with a code-default mode from `approvalModeFor` in `apps/api/src/fleet/assistant/actions/approval-policy.ts` ("Nothing answers `self` or `agent` yet: the web policy editor and an agent decide path are koda #301").
- `FleetApproval` for runner bash escalations and budget overrides.

The catalog's `approval` block on every entry is still the P1 placeholder (`floor: 'none'`, `default: 'none'`, "Placeholder until phase P3 decides floors and defaults"). `ActionApproval` and the `AuditEntry` columns `requiredMode`, `satisfiedBy`, `approverType`, `approverId` and `approvalRequestId` exist since P2 but are always `NO_APPROVAL`.

The four later API features each need the same machinery: a policy model, resolution, decide rules, a request store and a way to run a write later. Building it once here, with no production caller, lets each of them migrate or gate one surface.

**Rulings that bind this feature** (user, 2026-10-26):
- **P3 is six features**, in order: approval-core (this), approval-api (routes, policy CRUD, MCP `koda_decide_approval`, live events, CLI), approval-assistant (`PendingAction` → `ApprovalRequest`, closes #301), approval-fleet (`FleetApproval` → `ApprovalRequest`), approval-gate (agent REST/CLI writes on approvable keys wait), web.
- **This feature's scope:** the `ApprovalRequest`/`ApprovalDecision` tables, the `ApprovalPolicy` table with most-specific resolution clamped to catalog floors, the defaults, the satisfaction rules, timeout handling and the audit fields. Nothing is gated yet.
- **The deferred run is a command registry.** Each approvable key registers an executor (a parser for the validated input plus the service call). A caller runs `gate(key, input, …)`. If approval is needed the caller gets a pending request; on approval the engine re-checks permission and runs the executor, with `status = executed` in the same transaction. The assistant's tool executors become registry entries in approval-assistant, so one mechanism serves REST, MCP and threads.

Design decisions 3, 4, 5, 6 and 8 (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` § Decisions) also bind it: `approverMustHoldAction` defaults to true; Project Admin edits project policies; a timeout rejects and auto-approve is allowed only when the floor is `none`; `requiredApprovals` is in the model with only `1` allowed; a human acting directly satisfies any mode; the thread's on-behalf-of user may approve the assistant's write; `requireDistinctApprover` defaults to false.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **Defaults live in the catalog, not in seeded rows.** Design §8 says the seed "also creates the default policies". Resolution step 6 already falls back to the catalog default, so a seeded row would duplicate it and be indistinguishable from an admin's override. The policy table starts empty, and the web page (P3 web) shows the catalog default next to any override.
- **The assistant is its own policy subject.** A thread assistant write (actor `SYSTEM/assistant` on behalf of a user) resolves as subject `ASSISTANT`. It matches only policies whose `principalType` is `ASSISTANT`, and its catalog default is `human` for every approvable key (today's behaviour). Pattern-only policies (no subject) apply to `USER` and `AGENT` subjects only, so an admin lowering `ticket.delete` for everyone does not silently remove the thread confirm step.
- **Equal-specificity ties take the strictest mode.** A subject with two roles that both have a project-level role policy for the same pattern gets the stricter of the two.
- **Policy settings are snapshotted onto the request.** `requiredMode`, `onTimeout`, `approverMustHoldAction`, `requireDistinctApprover` and `expiresAt` are copied at open time. A later policy edit does not change a pending request.
- **The decide permission becomes scope `any`.** `approval.decide` is `project` today, so no GLOBAL role can hold it and a request with no project (a global key) has no possible decider. As `any`, the Owner and Admin `*` grant it globally. Project roles keep it as before.
- **The actor's own tier is `self`.** An agent actor confirming its own request contributes `self`. A human decider contributes `human`, and an agent decider other than the actor contributes `agent`. The thread's on-behalf-of user contributes `human`.
- **Deciding needs a principal.** A decide whose current actor is `SYSTEM` or `RUNNER` is refused. Only the expiry sweeper settles requests as the system.
- **Rejecting needs the same eligibility as approving.** Anyone who could not approve a request cannot reject it either. The actor withdrawing its own request is a cancel, which arrives with the API feature.
- **Decide and execute are separate transactions.** The decision (approve) commits first, then execution runs in its own transaction with `status = executed`. A failing execution therefore leaves the approval on record and marks the request `failed` instead of losing the decision.
- **A decide past `expiresAt` is refused and changes nothing.** The sweeper settles it. This keeps one code path for timeouts, including `onTimeout: approve`.
- **The re-check at execution is the permission key only.** The actor (or, for the assistant, the on-behalf-of user) must still hold the key or its `.own` form at the request's scope. Revocation in koda is deleting or unbinding a principal (P1 ruling 2026-10-20: agent status is liveness, not access), which this check catches. Row-level ownership and domain rules are the command's own business when it runs.
- **Re-gating the same input is idempotent.** A gate call whose actor, key, project and input hash match a still-pending, unexpired request returns that request instead of opening a second one, so an agent that retries does not flood the inbox. Two identical gate calls racing each other may still open two requests (see Out of Scope).
- **A human acting directly is never held, whatever the policy flags.** Decision 8 says a human acting directly satisfies any mode, so the gate runs a `USER` actor's command at once even under a policy with `requireDistinctApprover: true`. That flag applies to decisions on requests (an agent confirming its own `self` request), not to a human's own write.
- **Opening a request and settling its status are bookkeeping, not audit entries.** The `ApprovalRequest` row is itself the record of the ask, as `assistant.action-proposal` is today. The decision records `approval.decide` and the expiry records `system.approval.expire`. The command's own write records its domain key, carrying the approval block. Two new reason ids are added to `BOOKKEEPING_REASONS`: `approval.request-open` and `approval.request-settle`.
- **The default timeout is 24 hours.** A policy with no `timeoutSec`, and the catalog default, give `expiresAt = now + 86 400 s` (`DEFAULT_APPROVAL_TIMEOUT_SEC`). A policy's `timeoutSec` is between 60 and 2 592 000 (30 days).
- **The expiry sweeper reuses the fleet approval sweep settings** (`FLEET_CFG.sweepEnabled`, `approvalSweepMs`) and the existing system key `system.approval.expire`. Two `@SystemWriter` classes may share a key (`permission-contract.ts` dedupes by class). The fleet sweeper that also declares it goes away in approval-fleet.
- **The new module is `ApprovalEngineModule` in `src/approvals/`.** The names avoid the existing `ApprovalsModule` and `ApprovalExpirySweeper` (`src/fleet/approvals/approvals.module.ts`, `src/fleet/approvals/approval-expiry-sweeper.ts`), which approval-fleet removes.
- **No foreign keys except decision → request.** Like `AuditEntry`, a policy or request stores project, role and principal ids as plain strings. A request must outlive a deleted project or agent so the audit trail can still cite it, and a policy naming a deleted role simply matches nobody. `ApprovalDecision.requestId` references `ApprovalRequest.id` with `onDelete: Cascade`.

### Catalog approval metadata (US-001)

`apps/api/src/permissions/catalog.ts` replaces the placeholder in `buildEntry`.

Baseline (only to locate the code; this is not the interface to implement):
```ts
approval: { approvable: access === 'role' && risk !== 'low', floor: 'none', default: 'none' },
```

Target:
```ts
/** Reads are never approvable (design §4 "Reads are not approvable"). */
const approvable = access === 'role' && risk !== 'low' && !isReadKey(key);   // isReadKey: a local helper, the key's last segment is 'read'
approval: {
  approvable,
  floor: approvable && risk === 'critical' ? 'human' : 'none',
  default: !approvable ? 'none' : risk === 'critical' ? 'human' : risk === 'high' ? 'agent' : 'none',
},
```

`isReadKey` is defined in `catalog.ts` itself (as `classifyRisk` inlines the same last-segment logic); importing `entry-matcher.ts`'s private helper would be circular. `risk === 'critical'` is exactly the `role.*` and `approval.policy.*` keys (`classifyRisk`), so the floor rule reads "role, binding and policy keys: floor `human`". `role.read` and `approval.policy.read` are critical but reads, so they are not approvable and keep floor `none`. `default` is the mode for an `AGENT` subject. A `USER` subject has the same default, but a human acting directly always satisfies it (see the gate). The `ASSISTANT` default is the constant `ASSISTANT_DEFAULT_MODE = 'human'` in the resolver, not a catalog field.

`NEW_KEY_SCOPES['approval.decide']` changes from `'project'` to `'any'`.

`PermissionCatalogEntry.approval`'s comment "Placeholder until phase P3 decides floors and defaults." becomes "Floor: the lowest mode any policy may set. Default: the mode for an AGENT subject when no policy matches."

### The tables (US-002)

`apps/api/prisma/schema.prisma` gains, with migration `prisma/migrations/20261104090000_approval_engine/migration.sql`:

```prisma
/// Permissions P3a: one approval policy. `selector` is unique: "<projectId|*>|<permissionPattern>|<subject>",
/// where subject is "all", "type:<USER|AGENT|ASSISTANT>", "role:<roleId>" or "principal:<USER|AGENT>:<id>".
/// No foreign keys: a policy naming a deleted project, role or principal matches nobody.
model ApprovalPolicy {
  id                      String   @id @default(cuid())
  selector                String   @unique
  projectId               String?
  permissionPattern       String   // an exact catalog key, or "<prefix>.*"
  principalType           String?  // USER | AGENT | ASSISTANT
  roleId                  String?
  principalId             String?
  mode                    String   // none | self | agent | human
  timeoutSec              Int?
  onTimeout               String   @default("reject") // reject | approve
  requiredApprovals       Int      @default(1)
  approverMustHoldAction  Boolean  @default(true)
  requireDistinctApprover Boolean  @default(false)
  updatedByType           String
  updatedById             String
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  @@index([projectId])
  @@index([roleId])
}

/// Permissions P3a: one gated write waiting for (or past) approval. `input` is the command's parsed input, frozen.
model ApprovalRequest {
  id                      String    @id @default(cuid())
  permissionKey           String
  projectId               String?
  actorType               String    // USER | AGENT | SYSTEM
  actorId                 String
  onBehalfOfType          String?
  onBehalfOfId            String?
  origin                  String    // rest | mcp | thread | runner | system
  correlationId           String
  input                   Json
  inputHash               String    // sha256 hex of the canonical JSON of input
  requiredMode            String
  policyId                String?
  onTimeout               String
  approverMustHoldAction  Boolean
  requireDistinctApprover Boolean
  status                  String    @default("pending") // pending | approved | rejected | expired | cancelled | executed | failed
  satisfiedBy             String?
  approverType            String?
  approverId              String?
  expiresAt               DateTime
  decidedAt               DateTime?
  settledAt               DateTime?
  result                  Json?
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @updatedAt

  decisions ApprovalDecision[]

  @@index([status, expiresAt])
  @@index([projectId, status, createdAt])
  @@index([actorType, actorId, onBehalfOfId, permissionKey, inputHash, status])
}

model ApprovalDecision {
  id          String          @id @default(cuid())
  requestId   String
  deciderType String          // USER | AGENT
  deciderId   String
  decision    String          // approve | reject
  comment     String?
  decidedAt   DateTime        @default(now())
  request     ApprovalRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  @@index([requestId])
  @@index([deciderId, decidedAt])
}
```

The migration is hand-written in the style of `20261103090000_audit_entry` (tables, then indexes, then the one foreign key) and must match `prisma migrate diff` from the previous schema. Run `bun run db:generate` after the schema edit, because `src/generated/prisma/` is gitignored.

**Domain files.** `src/approvals/domain/approval.domain.ts` defines:
```ts
export type ApprovalSubjectType = 'USER' | 'AGENT' | 'ASSISTANT';
export type ApprovalPolicyViolation =
  'pattern' | 'subject' | 'mode' | 'below-floor' | 'timeout' | 'timeout-approve' | 'required-approvals';
export type EligibilityRefusal =
  | 'not-a-principal' | 'assistant-cannot-decide' | 'distinct-approver-required'
  | 'missing-decide-permission' | 'missing-action-permission' | 'tier-too-low';
export interface ApprovalPolicyInput {
  projectId: string | null;
  permissionPattern: string;
  appliesTo: { kind: 'all' }
    | { kind: 'type'; principalType: ApprovalSubjectType }
    | { kind: 'role'; roleId: string }
    | { kind: 'principal'; principalType: 'USER' | 'AGENT'; principalId: string };
  mode: ApprovalMode;
  timeoutSec?: number | null;
  onTimeout?: 'reject' | 'approve';
  requiredApprovals?: number;
  approverMustHoldAction?: boolean;
  requireDistinctApprover?: boolean;
}
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed' | 'failed';
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 86_400;
export const APPROVAL_POLICY_REPOSITORY = Symbol('APPROVAL_POLICY_REPOSITORY');
export const APPROVAL_REQUEST_REPOSITORY = Symbol('APPROVAL_REQUEST_REPOSITORY');

export interface ApprovalPolicyRecord {
  id: string; selector: string; projectId: string | null; permissionPattern: string;
  principalType: ApprovalSubjectType | null; roleId: string | null; principalId: string | null;
  mode: ApprovalMode; timeoutSec: number | null; onTimeout: 'reject' | 'approve'; requiredApprovals: number;
  approverMustHoldAction: boolean; requireDistinctApprover: boolean;
  updatedByType: string; updatedById: string; createdAt: Date; updatedAt: Date;
}

export interface ApprovalRequestRecord {
  id: string; permissionKey: string; projectId: string | null;
  actor: { type: 'USER' | 'AGENT' | 'SYSTEM'; id: string };
  onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;
  origin: ActionOrigin; correlationId: string; input: unknown; inputHash: string;
  requiredMode: ApprovalMode; policyId: string | null; onTimeout: 'reject' | 'approve';
  approverMustHoldAction: boolean; requireDistinctApprover: boolean; status: ApprovalRequestStatus;
  satisfiedBy: ApprovalMode | null; approverType: 'USER' | 'AGENT' | null; approverId: string | null;
  expiresAt: Date; decidedAt: Date | null; settledAt: Date | null; result: unknown; createdAt: Date;
}

export interface ApprovalDecisionRecord {
  id: string; requestId: string; deciderType: 'USER' | 'AGENT'; deciderId: string;
  decision: 'approve' | 'reject'; comment: string | null; decidedAt: Date;
}
```

`src/approvals/domain/approval.errors.ts` holds the domain errors. Each extends `Error`, sets `name` to its class name and restores its prototype, as `UnauditedWriteError` does (`src/action-context/audit-coverage.ts`):
```ts
export class InvalidApprovalPolicyError extends Error { constructor(readonly violation: ApprovalPolicyViolation) }
export class ApprovalPolicyConflictError extends Error { constructor(readonly selector: string) }
export class ApprovalPolicyNotFoundError extends Error { constructor(readonly id: string) }
export class ApprovalPolicySelfApplicationError extends Error { constructor(readonly policySelector: string) }
export class UnregisteredApprovalCommandError extends Error { constructor(readonly key: string) }
export class ApprovalRequestNotFoundError extends Error { constructor(readonly id: string) }
export class ApprovalRequestNotPendingError extends Error { constructor(readonly status: ApprovalRequestStatus) }
export class ApprovalRequestExpiredError extends Error { constructor(readonly id: string) }
export class ApprovalDecideForbiddenError extends Error { constructor(readonly reason: EligibilityRefusal) }
```
`ApprovalPolicyViolation` and `EligibilityRefusal` are declared in `approval.domain.ts` so the errors file depends on nothing but the domain.

`src/approvals/domain/approval-mode.ts` holds the ladder:
```ts
export const APPROVAL_MODE_RANK: Readonly<Record<ApprovalMode, number>> = { none: 0, self: 1, agent: 2, human: 3 };
export function modeAtLeast(mode: ApprovalMode, required: ApprovalMode): boolean;   // rank(mode) >= rank(required)
export function strictestMode(...modes: ApprovalMode[]): ApprovalMode;               // highest rank; 'none' for no input
```

**Repositories.** Both extend `AbstractPrismaRepository`, as `.nax/rules/api-repositories.md` requires.
- `PrismaApprovalPolicyRepository` (`src/approvals/prisma-approval-policy.repository.ts`) has `findCandidates(permissionKey, projectId)`. It returns every policy whose `projectId` is `projectId` or null, filtered in code to patterns that match the key: the exact key, or `<prefix>.*` where the key starts with `<prefix>.` (the dot included, so `ti.*` does not match `ticket.delete`). The query takes at most `MAX_POLICY_CANDIDATES = 500` rows and logs a `warn` when it hits the cap. It also has `findBySelector(selector)` and `findPage(filter, page)`, where `filter` is `{ projectId?: string | null; permissionPattern?: string }`.
- `PrismaApprovalRequestRepository` (`src/approvals/prisma-approval-request.repository.ts`) has:
  - `lockById(id)`: `SELECT … FOR UPDATE`, then `findById`, as in `PrismaApprovalRepository.lockById`.
  - `findPendingDuplicate({ actorType, actorId, onBehalfOfType, onBehalfOfId, permissionKey, projectId, inputHash }, now)`: status `pending`, `expiresAt > now`, and the on-behalf-of pair equal (both null counts as equal).
  - `findDue(now, limit)`: pending with `expiresAt <= now`, oldest `expiresAt` first.
  - `transition(id, from, patch)`: `updateMany` where `id` and `status = from`, returning the updated record or null when no row matched.
  - `createDecision(input)`.
  - `findDecisions(requestId)`: at most 50 rows, oldest first.

### Policy resolution (US-003)

`src/approvals/approval-policy.resolver.ts`:

```ts
export interface ApprovalSubject { type: ApprovalSubjectType; id: string }   // ASSISTANT id is 'assistant'
export interface ResolvedApproval {
  mode: ApprovalMode;
  floor: ApprovalMode;
  policy: ApprovalPolicyRecord | null;
  source: 'not-approvable' | 'policy' | 'default';
}
export const ASSISTANT_DEFAULT_MODE: ApprovalMode = 'human';

@Injectable()
export class ApprovalPolicyResolver {
  resolve(input: { key: string; projectId: string | null; subject: ApprovalSubject }): Promise<ResolvedApproval>;
}
```

Order of evaluation, first match wins:
1. **Unknown or not approvable.** `findCatalogEntry(key)` undefined throws `Error('unknown permission key: <key>')`. An entry with `approval.approvable === false` returns `{ mode: 'none', floor: 'none', policy: null, source: 'not-approvable' }` without reading policies.
2. **Candidates.** `findCandidates(key, projectId)`, kept only when the policy's subject applies:
   - **principal**: `principalId` set. It applies when `principalType` and `principalId` equal the subject's.
   - **role**: `roleId` set. It applies when the subject is `USER` or `AGENT` and `roleId` is among `PermissionService.roleIdsAt(subject, scope)`.
   - **type**: only `principalType` set. It applies when `principalType` equals the subject type.
   - **all**: none set. It applies to `USER` and `AGENT` subjects only.
3. **Tiers.** Candidates rank by tier: project principal, project role, project type, project all, then global principal, global role, global type, global all. The first non-empty tier is kept.
4. **Pattern specificity.** Within that tier, an exact key beats a wildcard and a longer prefix beats a shorter one. The most specific pattern's candidates are kept.
5. **Ties.** Among what remains (only role policies can tie, through several roles), the policy with the strictest `mode` wins; on equal mode, the smallest `id`.
6. **No candidate.** The mode is `ASSISTANT_DEFAULT_MODE` for an `ASSISTANT` subject, else `entry.approval.default`, with `policy: null` and `source: 'default'`.
7. **Clamp.** The returned `mode` is `strictestMode(chosen, entry.approval.floor)`, and `floor` is `entry.approval.floor`.

`scope` is `{ projectId }` when `projectId` is set, else `'global'`.

`PermissionService` gains `roleIdsAt(principal: PrincipalRef, scope: PermissionScope): Promise<string[]>`. It reads `findEffectiveBindings(principal, projectId)`, keeps the rows `appliesIn(row, projectId)` accepts (the same filter `computeKeys` uses) and returns their distinct `binding.roleId`, ascending.

### Policy writes (US-004, US-005)

`src/approvals/approval-policy.service.ts`:

`ApprovalPolicyInput` is declared in `domain/approval.domain.ts` (US-002), so the validation and the service both import it from the domain.

```ts
@Injectable()
export class ApprovalPolicyService {
  create(input: ApprovalPolicyInput): Promise<ApprovalPolicyRecord>;
  update(id: string, patch: Partial<Omit<ApprovalPolicyInput, 'projectId' | 'permissionPattern' | 'appliesTo'>>): Promise<ApprovalPolicyRecord>;
  remove(id: string): Promise<void>;
  list(filter: { projectId?: string | null; permissionPattern?: string }, page: { current: number; size: number }): Promise<ApprovalPolicyRecord[]>;
}
```

`projectId`, `permissionPattern` and `appliesTo` are a policy's identity (its `selector`) and cannot be patched. To retarget a policy, delete it and create a new one.

**Validation (US-004)** lives in `src/approvals/approval-policy.validation.ts`:
```ts
// ApprovalPolicyInput and ApprovalPolicyViolation are imported from domain/approval.domain.ts.
/** Applies the defaults (timeoutSec null, onTimeout 'reject', requiredApprovals 1) and returns the first violation. */
export function validateApprovalPolicy(input: ApprovalPolicyInput): ApprovalPolicyViolation | null;
/** "<projectId|*>|<permissionPattern>|<subject>", the ApprovalPolicy.selector of the input. */
export function policySelector(input: Pick<ApprovalPolicyInput, 'projectId' | 'permissionPattern' | 'appliesTo'>): string;
```
The service throws `InvalidApprovalPolicyError(violation)` for the first violation, checked in this order:
1. `pattern`: the pattern is neither an approvable catalog key nor `<prefix>.*` where at least one approvable catalog key starts with `<prefix>.` (the dot included, as in `findCandidates`).
2. `subject`: `appliesTo.kind === 'principal'` with an empty `principalId`, or `'role'` with an empty `roleId`.
3. `mode`: `mode` is not one of the four modes.
4. `below-floor`: `mode` ranks below the pattern's floor. The floor is the strictest `approval.floor` over every approvable key the pattern matches.
5. `timeout`: `timeoutSec` is set and is not an integer in 60…2 592 000.
6. `timeout-approve`: `onTimeout === 'approve'` while the pattern's floor is not `none`.
7. `required-approvals`: `requiredApprovals` is not `1`.

**Writes (US-005).** `create`, `update` and `remove` each run in one `txManager.run`:
- The writer is the current context's actor. `updatedByType` and `updatedById` take its `type` and `id`.
- `create` builds `selector` with `policySelector(input)` and throws `ApprovalPolicyConflictError` when `findBySelector` finds a row. Checks run in this order: validation, anti-escalation, then the selector conflict.
- `update` re-validates the merged row. `update` and `remove` throw `ApprovalPolicyNotFoundError` for an unknown id.
- Each write records an `AuditRecorder.record` entry with key `approval.policy.manage`, `resourceType` `'approval-policy'`, the policy id, the policy's `projectId`, and summary `created <pattern> <mode>`, `updated <names of the fields whose value differs from the stored row, comma-separated>` or `deleted <pattern>`.
- **Anti-escalation** (design §7 "Agents may never change roles, bindings or policies that apply to them"): when the current actor is an `AGENT`, a create, update or remove whose policy row would apply to that agent throws `ApprovalPolicySelfApplicationError` before anything is written. A policy row applies to the agent when its subject is `all`, `type:AGENT`, `principal:AGENT:<agent id>`, or `role:<id>` where:
  - for a project policy, `id` is among `roleIdsAt(agent, { projectId })`;
  - for a global policy (`projectId` null), `id` is the role of **any** binding the agent holds, in any project or globally, through `PermissionService.roleIdsAnywhere(agent)`. A global role policy is resolved in every project where the agent holds the role, so checking only global bindings would let an agent lower its own requirement.

  Users are not restricted by this rule. `PermissionService` gains `roleIdsAnywhere(principal: PrincipalRef): Promise<string[]>`, the distinct `binding.roleId` of `findPrincipalBindings(principal)`, ascending.

### Decide eligibility (US-006)

`src/approvals/approval-eligibility.ts`, a pure function:

```ts
// EligibilityRefusal is imported from domain/approval.domain.ts.
export interface DeciderRef { type: 'USER' | 'AGENT' | 'SYSTEM' | 'RUNNER'; id: string }
export type Eligibility = { ok: true; satisfiedBy: ApprovalMode } | { ok: false; reason: EligibilityRefusal };

export function decideEligibility(
  request: Pick<ApprovalRequestRecord, 'permissionKey' | 'actor' | 'onBehalfOf' | 'requiredMode' | 'approverMustHoldAction' | 'requireDistinctApprover'>,
  decider: DeciderRef,
  deciderKeys: ReadonlySet<string>,          // the decider's effective keys at the request's scope
): Eligibility;
```

The rules apply in this order. The first refusal is returned.
1. `decider.type` is `SYSTEM` or `RUNNER`: `not-a-principal`.
2. `isActor` means the decider equals `request.actor`. `isOnBehalf` means the decider equals `request.onBehalfOf`, and `request.actor` is `SYSTEM/assistant`.
3. `request.requireDistinctApprover && isActor`: `distinct-approver-required`.
4. **Holds the action.** For the actor or the on-behalf-of user, it means `deciderKeys` has `permissionKey` or `permissionKey + '.own'` (their own request). For any other decider it means `deciderKeys` has `permissionKey` itself, since `X.own` allows `X` only on rows the holder created and the request's row is not theirs. When `isActor` or `isOnBehalf`, or `request.approverMustHoldAction` is true, a decider that does not hold the action gets `missing-action-permission`.
5. When neither `isActor` nor `isOnBehalf`, the decider needs the decide permission: `deciderKeys` has `approval.decide`, or an `approval.decide@<pattern>` whose pattern is the key itself or a `<prefix>.*` the key starts with. Otherwise `missing-decide-permission`.
6. **Contributed tier.** `isActor` contributes `self`. `isOnBehalf` contributes `human`. Otherwise a `USER` contributes `human` and an `AGENT` contributes `agent`. When `modeAtLeast(contributed, request.requiredMode)` is false, the result is `tier-too-low`.
7. Otherwise `{ ok: true, satisfiedBy: contributed }`.

`assistant-cannot-decide` covers a decider equal to `SYSTEM/assistant`, which step 1 already refuses as `not-a-principal`. It is kept in the type for the API feature's error mapping, but `decideEligibility` never returns it.

### The command registry and the gate (US-007 to US-009)

`src/approvals/approval-command.registry.ts`:

```ts
export interface ApprovalCommand<TInput = unknown, TResult = unknown> {
  key: string;                                   // a catalog key with approval.approvable === true
  parse(input: unknown): TInput;                 // validates; the returned value must be JSON-serialisable, and parse must accept its own output (execution re-parses the frozen input)
  execute(input: TInput): Promise<TResult>;      // runs under the caller's (or the request's) action context
  toResult?(result: TResult): unknown;           // what ApprovalRequest.result stores; omitted means null
}

@Injectable()
export class ApprovalCommandRegistry {
  register(command: ApprovalCommand): void;      // throws on an unknown or non-approvable key ('approval command key is not approvable: <key>') or a second registration ('approval command already registered: <key>')
  get(key: string): ApprovalCommand | undefined;
}
```

`canonicalJson(value: unknown): string` (`src/approvals/canonical-json.ts`) serialises a JSON value with object keys sorted recursively, array order kept, and no whitespace.

Owning modules register their commands in `onModuleInit`. This feature registers none in production. Tests register a command under an approvable key.

`src/approvals/approval-gate.service.ts`:

```ts
export type GateOutcome<TResult> =
  | { status: 'executed'; result: TResult; approval: ActionApproval }
  | { status: 'pending'; request: ApprovalRequestRecord };

@Injectable()
export class ApprovalGate {
  gate<TResult>(key: string, input: unknown, opts: { projectId: string | null }, now?: Date): Promise<GateOutcome<TResult>>;
}
```

`gate` runs these steps in order:
1. `registry.get(key)`. When missing, throw `UnregisteredApprovalCommandError(key)`.
2. `currentContext()`. When there is no context, throw `Error('approval gate needs an action context')`.
3. **Subject.** Actor `USER` becomes `USER`. `AGENT` becomes `AGENT`. `SYSTEM/assistant` with an `onBehalfOf` becomes `ASSISTANT` (id `'assistant'`). Any other actor throws `Error('approval gate cannot gate actor <type>/<id>')`.
4. `parsed = command.parse(input)`. A parse error propagates, and nothing is written. A `parsed` of `undefined` or `null` throws `Error('approval command parse returned no input: <key>')`.
4a. **Scope.** When the key's catalog scope is `project` and `projectId` is null, throw `Error('approval gate needs a project for key <key>')`.
5. `resolved = resolver.resolve({ key, projectId, subject })`.
6. **Run now.** The two cases are checked in this order. First, when `resolved.mode === 'none'` (for any subject), `command.execute(parsed)` runs inside `runWithActionContext({ ...context, approval: { requiredMode: 'none', satisfiedBy: 'none' } }, …)`. Otherwise, when the subject is `USER` (a human acting directly, decision 8), it runs with `approval: { requiredMode: resolved.mode, satisfiedBy: 'human', approverType: 'USER', approverId: actor.id }`. Either way the gate returns `{ status: 'executed', result, approval }`.
7. **Wait** (US-009). Otherwise:
   - `inputHash` is the SHA-256 hex of `canonicalJson(parsed)`: keys sorted recursively, no whitespace, a JSON round-trip of the parsed value.
   - When `findPendingDuplicate` finds a request (same actor, same on-behalf-of principal, key, project and hash, still pending and unexpired), that request is returned.
   - Otherwise one `ApprovalRequest` is created inside `bookkeeping('approval.request-open', …)` and `txManager.run`, with:
     - `status` `pending` and `requiredMode` `resolved.mode`, plus `policyId` from `resolved.policy`;
     - `onTimeout`, `approverMustHoldAction` and `requireDistinctApprover` from the policy, or `'reject'`/`true`/`false` when there is no policy;
     - `expiresAt` = `now` + (`policy.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC`) seconds;
     - actor, on-behalf-of, origin and correlation id copied from the context, and `input` = the JSON round-trip of `parsed`.
   - It returns `{ status: 'pending', request }`.

### Deciding (US-010)

`src/approvals/approval-decision.service.ts`:

```ts
@Injectable()
export class ApprovalDecisionService {
  decide(requestId: string, decision: 'approve' | 'reject', comment: string | null, now?: Date): Promise<ApprovalRequestRecord>;
}
```

The decider is the current context's actor. The decision itself runs in one `txManager.run`:
1. `lockById(requestId)`. When missing, throw `ApprovalRequestNotFoundError`.
2. A status other than `pending` throws `ApprovalRequestNotPendingError(status)`. An `expiresAt <= now` throws `ApprovalRequestExpiredError`. Nothing is written in either case.
3. `keys = PermissionService.effectiveKeys(decider, projectId ? { projectId } : 'global')` for a `USER`/`AGENT` decider; an empty set otherwise.
4. `decideEligibility(request, decider, keys)`. A refusal throws `ApprovalDecideForbiddenError(reason)`.
5. `createDecision({ requestId, deciderType, deciderId, decision, comment })`.
6. `transition(id, 'pending', …)` sets `status` to `approved` or `rejected`, with `decidedAt` = `now`. For an approve it also sets `satisfiedBy` and `approverType`/`approverId` = the decider.
7. Inside `runWithActionContext({ ...context, approval: { requiredMode, satisfiedBy, approverType, approverId, requestId } }, …)` it records `AuditRecorder.record` with key `approval.decide`, `resourceType` `'approval-request'`, the request id, its `projectId`, and summary `approved <permissionKey>` or `rejected <permissionKey>`. A reject records `satisfiedBy` `'none'` and no approver.

After that transaction commits, an approve calls `ApprovalExecutionService.execute(requestId)` and returns its result. A reject returns the rejected request.

### Executing (US-011)

`src/approvals/approval-execution.service.ts`:

```ts
@Injectable()
export class ApprovalExecutionService {
  execute(requestId: string, now?: Date): Promise<ApprovalRequestRecord>;
}
```

It runs these steps in order:
1. `findById`. A request whose status is not `approved` throws `ApprovalRequestNotPendingError(status)`.
2. Pre-checks. The first failing one settles the request as `failed`, with `result` `{ error: <code> }`, through `transition(id, 'approved', { status: 'failed', settledAt, result })` inside `bookkeeping('approval.request-settle', …)`, and returns it:
   - `no-command`: `registry.get(permissionKey)` is undefined.
   - `input-hash-mismatch`: the SHA-256 of `canonicalJson(request.input)` differs from `inputHash`.
   - `permission-revoked`: the re-check principal (the on-behalf-of principal when the actor is `SYSTEM/assistant`, else the actor) has neither `permissionKey` nor `permissionKey + '.own'` in `effectiveKeys(principal, scope)`.
   - `invalid-input`: `command.parse(request.input)` throws.
3. **Run.** One `txManager.run`, inside `runWithActionContext`. It first takes `lockById(id)` and re-reads the status; when it is no longer `approved` (a concurrent `execute` got there first), it throws `ApprovalRequestNotPendingError(status)` and the command does not run.
   - The context carries the request's actor, on-behalf-of, origin and correlation id, and `approval: { requiredMode, satisfiedBy, approverType, approverId, requestId }`.
   - `result = await command.execute(parsed)`.
   - `transition(id, 'approved', { status: 'executed', settledAt: now, result: command.toResult?.(result) ?? null })` runs inside `bookkeeping('approval.request-settle', …)`.
4. **Failure.** When step 3 throws anything other than that `ApprovalRequestNotPendingError`, its transaction rolls back. A second transaction, inside `bookkeeping('approval.request-settle', …)`, settles the request as `failed` through `transition(id, 'approved', …)`, with `result` `{ error: 'execution-failed', name: <error.name> }`, and returns it. The error is logged at `warn` with the request id and is not rethrown.

### Expiry (US-012)

`src/approvals/approval-request-expiry.sweeper.ts`: `@Injectable() @SystemWriter('system.approval.expire') export class ApprovalRequestExpirySweeper implements OnModuleInit, OnModuleDestroy`, in the shape of `PendingActionExpirySweeper`:
- `onModuleInit` starts an unref'd `setInterval` of `FLEET_CFG.approvalSweepMs` when `FLEET_CFG.sweepEnabled`, and `onModuleDestroy` clears it.
- `tick(now = new Date()): Promise<{ expired: number; approved: number; failed: number }>` runs `runAsSystemWriter(this, …)` over `findDue(now, MAX_PER_TICK)` (`MAX_PER_TICK = 100`).
- Each due request gets its own `txManager.run`: `lockById`; skip it when it is no longer `pending` or no longer due.
  - `onTimeout === 'reject'`: transition to `expired` (`settledAt` = `now`) and record `system.approval.expire` with `resourceType` `'approval-request'` and summary `expired <permissionKey>`.
  - `onTimeout === 'approve'`: transition to `approved` (`decidedAt` = `now`, `satisfiedBy` `'none'`, no approver) and record `system.approval.expire` with summary `approved on timeout <permissionKey>`. After the commit, it calls `ApprovalExecutionService.execute(id)`.
- `approved` counts requests moved to `approved` on timeout, whatever their execution then ends as (`executed` or `failed`).
- An error on one request adds 1 to `failed`, is logged at `warn`, and the loop continues.

`ApprovalEngineModule` (`src/approvals/approval-engine.module.ts`) provides the two repositories behind their tokens, the resolver, both services, the registry, the gate, the execution service and the sweeper. It exports `ApprovalGate`, `ApprovalCommandRegistry`, `ApprovalDecisionService`, `ApprovalExecutionService` and `ApprovalPolicyService`. `AppModule` imports it (US-002).

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| Unknown key passed to `resolve` | Throws `Error('unknown permission key: <key>')`. | US-003 |
| Gate called with an unregistered key | Throws `UnregisteredApprovalCommandError`; nothing written. | US-008 |
| Gate called with no action context | Throws `Error('approval gate needs an action context')`. | US-008 |
| Gate called by a runner or a non-assistant system actor | Throws `Error('approval gate cannot gate actor <type>/<id>')`. | US-008 |
| Command `parse` throws at gate time | The error propagates; no request row. | US-009 |
| Command `parse` returns `undefined` or `null` | Throws `Error('approval command parse returned no input: <key>')`; nothing written. | US-008 |
| Project-scoped key gated with a null project | Throws `Error('approval gate needs a project for key <key>')`. | US-008 |
| Two concurrent `execute` calls on one approved request | The row lock serialises them; the second throws `ApprovalRequestNotPendingError` and the command runs once. | US-011 |
| Decide on an unknown id | `ApprovalRequestNotFoundError`. | US-010 |
| Decide on a request that is not pending | `ApprovalRequestNotPendingError(status)`; nothing written. | US-010 |
| Decide past `expiresAt` | `ApprovalRequestExpiredError`; nothing written. | US-010 |
| Decider not eligible | `ApprovalDecideForbiddenError(reason)`; nothing written. | US-010 |
| Two decides race on one request | The row lock serialises them; the second sees a non-pending status and throws `ApprovalRequestNotPendingError`. | US-010 |
| No command registered at execution | Request `failed`, `result.error` `no-command`. | US-011 |
| Frozen input altered after open | Request `failed`, `result.error` `input-hash-mismatch`. | US-011 |
| Actor lost the key before execution | Request `failed`, `result.error` `permission-revoked`; the command does not run. | US-011 |
| Frozen input no longer parses | Request `failed`, `result.error` `invalid-input`. | US-011 |
| Command throws while executing | Domain write rolled back; request `failed` with `execution-failed`; not rethrown. | US-011 |
| Invalid policy input | `InvalidApprovalPolicyError(violation)`; nothing written. | US-004, US-005 |
| Duplicate policy selector | `ApprovalPolicyConflictError`. | US-005 |
| Update or remove of an unknown policy | `ApprovalPolicyNotFoundError`. | US-005 |
| Agent writing a policy that applies to itself | `ApprovalPolicySelfApplicationError`; nothing written. | US-005 |
| One request fails during a sweep | Counted in `failed`, logged, the loop continues. | US-012 |

### Integration

Symbols this feature reads (verified on `main` at `ee3f4f3b`):
- `PermissionService.can`, `effectiveKeys(principal: PrincipalRef, scope: PermissionScope)` and the module-private helper `appliesIn(row, projectId)`: `src/permissions/permission.service.ts`. `PermissionsModule` is `@Global()` and exports `PermissionService`.
- `PrismaRoleBindingRepository.findEffectiveBindings(principal, projectId): Promise<BindingWithRole[]>`, where `BindingWithRole` is `{ binding: RoleBindingDomain; roleKey; roleScope; rolePermissions }` and `RoleBindingDomain.roleId` is the role id: `src/permissions/prisma-role-binding.repository.ts`, `src/permissions/permissions.types.ts`.
- `findCatalogEntry`, `PERMISSION_CATALOG`, `PermissionCatalogEntry`, `ApprovalMode`: `src/permissions/catalog.ts`.
- `currentContext`, `runWithActionContext`, `runAsSystemWriter`, `ActionApproval`, `ActionOrigin`, `NO_APPROVAL`: `src/action-context/action-context.ts`.
- `bookkeeping(reason, fn)`, `BOOKKEEPING_REASONS`: `src/action-context/audit-coverage.ts`, `src/action-context/audit-coverage.reasons.ts`.
- `AuditRecorder.record(input)` (must run inside a transaction): `src/audit/audit-recorder.service.ts`. `AuditLogModule` is `@Global()`.
- `SystemWriter`: `src/permissions/system-writer.decorator.ts`. The key `system.approval.expire` exists in the catalog.
- `FLEET_CFG` and `IFleetConfig.sweepEnabled`/`approvalSweepMs`: `src/config/fleet.config.ts`.
- Patterns to mirror: `PendingActionExpirySweeper` (`src/fleet/assistant/actions/pending-action-expiry.sweeper.ts`) for the sweeper, and `PrismaApprovalRepository.lockById` (`src/fleet/approvals/prisma-approval.repository.ts`) for the row lock.
- Test helpers: `withTestActor(actor, fn)` and `fixtureDb(app)` (`test/helpers/action-context.ts`); `grantRole`, `grantBaseline` (`src/permissions/test-helpers/permission-fixtures.ts`); `scratchSchemaBefore`, `applyMigration` (`test/helpers/migration-schema.ts`).

Symbols this feature changes (the baseline only locates the code and is never the interface to implement):
- `buildEntry`'s `approval` block in `src/permissions/catalog.ts`. Baseline: `{ approvable: access === 'role' && risk !== 'low', floor: 'none', default: 'none' }`. Target: as in "Catalog approval metadata" above.
- `NEW_KEY_SCOPES['approval.decide']`. Baseline: `'project'`. Target: `'any'`.
- `PermissionService`. Baseline: no `roleIdsAt`, no `roleIdsAnywhere`. Target: gains `roleIdsAt(principal: PrincipalRef, scope: PermissionScope): Promise<string[]>` (US-003) and `roleIdsAnywhere(principal: PrincipalRef): Promise<string[]>` (US-005).
- `PrismaRoleBindingRepository.findPrincipalBindings(principal): Promise<BindingWithRole[]>` (`src/permissions/prisma-role-binding.repository.ts`) is read by `roleIdsAnywhere`.
- `BOOKKEEPING_REASONS`. Baseline: no `approval.*` ids. Target: gains `'approval.request-open'` ("An approval request opened by the gate; the decision records `approval.decide`.") and `'approval.request-settle'` ("An approval request's terminal status and result; the command records its own key and the expiry records `system.approval.expire`.").

## Out of Scope

- REST routes, query DTOs, the MCP tool `koda_decide_approval`, CLI commands, live events and notifications for approvals and policies are the `permissions-p3-approval-api` feature; this feature exposes services only, and `approval.decide`, `approval.policy.read` and `approval.policy.manage` stay in `PENDING_SURFACE_KEYS`.
- Cancelling a request (the actor withdrawing it, or a job ending) has no service method here; `permissions-p3-approval-api` and `permissions-p3-approval-fleet` add it with their own audit keys.
- Moving thread and MCP assistant writes from `PendingAction` onto `ApprovalRequest`, replacing `approvalModeFor`, dropping `PendingAction`, and closing #301 are `permissions-p3-approval-assistant`.
- Moving bash escalations and budget overrides from `FleetApproval` onto `ApprovalRequest` (`fleet.job.shell.escalate`, `fleet.budget.override`) and dropping `FleetApproval` and its sweeper are `permissions-p3-approval-fleet`.
- Registering commands for agent REST/CLI writes, the 202 response shape, and the `ticket.transition.verify-fix.approve` rule (mode `agent` when the caller is also the actor of the ticket's latest fix) are `permissions-p3-approval-gate`.
- Redacting or encrypting secrets in frozen input is deferred to `permissions-p3-approval-gate`, which must not register a command whose parsed input carries a credential (for example a VCS connection token) without deciding how it is stored; no production command is registered here.
- The policy pages and the unified inbox are the `permissions-p3-web` feature.
- `requiredApprovals` above 1 is refused by validation (decision 6); counting several decisions is not built.
- Seeded default policy rows are not created: catalog defaults stand in for them (designer's call above).
- US-011 only: an agent's status (`PAUSED`, `OFFLINE`) is not checked at execution, because P1 ruled that status is liveness, not access; revocation is unbinding or deleting the agent, which the key re-check catches.
- US-011 only: a commit failure after the command's callback succeeded is not retried; the request stays `approved` and is reported by the transaction error.
- `ApprovalPolicyService` and `ApprovalDecisionService` check no route permission (`approval.policy.manage`, the decide route's key); those checks belong to the routes `permissions-p3-approval-api` adds. The service-level rules here are policy validity, anti-escalation and decide eligibility.
- US-009 only: two identical `gate` calls running concurrently may each open a pending request, because the duplicate check is check-then-insert with no unique index; each request is then decided independently. Sequential retries are deduplicated.
- US-011 only: a request left `approved` because the process stopped between the decide commit and `execute` is not recovered here; `permissions-p3-approval-api` adds a retry path.
- US-005 only: a `roleId` or `principalId` in a policy is not checked for existence; a policy naming a missing role or principal matches nobody.
- US-012 only: the sweep is not distributed-safe beyond the per-request row lock; koda runs one API instance.

## Stories

1. **US-001: Catalog approval metadata** — `Workdir: apps/api` — No dependencies. `buildEntry`'s approvable, floor and default rule; `approval.decide` scope `any`; the catalog derivation test and role-matrix snapshot updated.
2. **US-002: The approval tables, repositories and module** — `Workdir: apps/api` — Depends on US-001. Prisma models and migration, the domain file, the mode ladder, both repositories behind their tokens, `ApprovalEngineModule` and its import into `AppModule`.
3. **US-003: Policy resolution** — `Workdir: apps/api` — Depends on US-002. `PermissionService.roleIdsAt` and `ApprovalPolicyResolver.resolve`.
4. **US-004: Policy validation** — `Workdir: apps/api` — Depends on US-002. `validateApprovalPolicy` and `policySelector`.
5. **US-005: Policy writes** — `Workdir: apps/api` — Depends on US-003, US-004. `ApprovalPolicyService` create, update, remove and list, with the audit entry and the anti-escalation rule.
6. **US-006: Decide eligibility** — `Workdir: apps/api` — Depends on US-002. The pure `decideEligibility` function.
7. **US-007: The command registry and canonical JSON** — `Workdir: apps/api` — Depends on US-002. `ApprovalCommandRegistry` (register and get, with its three refusals) and `canonicalJson`.
8. **US-008: The gate: refusals and running now** — `Workdir: apps/api` — Depends on US-003, US-007. `ApprovalGate.gate` steps 1–6: the refusals, the scope guard, and running the command at once for mode `none` or a human actor.
9. **US-009: The gate: opening a pending request** — `Workdir: apps/api` — Depends on US-008. Gate step 7: the frozen input and hash, de-duplication, the snapshot, and the `approval.request-open` bookkeeping reason.
10. **US-010: Deciding a request** — `Workdir: apps/api` — Depends on US-006, US-009. `ApprovalDecisionService.decide` with the row lock, the decision row and the `approval.decide` audit entry.
11. **US-011: Executing an approved request** — `Workdir: apps/api` — Depends on US-009, US-010. `ApprovalExecutionService.execute` with the pre-checks, the run transaction and the `approval.request-settle` bookkeeping reason; `decide` calls it after an approve.
12. **US-012: The expiry sweeper** — `Workdir: apps/api` — Depends on US-011. `ApprovalRequestExpirySweeper` and its registration in `ApprovalEngineModule`.

This is twelve stories for one capability, the approval engine, whose scope the user ruled on 2026-10-26 as P3's first feature. The policy stories (US-003 to US-005) and the request stories (US-006 to US-012) are not separable, because the gate resolves through the policies.

### Context Files

**US-001**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/permissions/catalog.spec.ts`
- `apps/api/src/permissions/role-matrix.spec.ts`
- `apps/api/src/permissions/system-roles.ts`

**US-002**
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20261103090000_audit_entry/migration.sql`
- `apps/api/src/audit/prisma-audit-entry.repository.ts`
- `apps/api/src/fleet/approvals/prisma-approval.repository.ts`
- `apps/api/test/helpers/migration-schema.ts`

**US-003**
- `apps/api/src/permissions/permission.service.ts`
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides ApprovalPolicyResolver)
- `apps/api/src/permissions/prisma-role-binding.repository.ts`
- `apps/api/src/approvals/domain/approval.domain.ts` — created by US-002
- `apps/api/src/approvals/prisma-approval-policy.repository.ts` — created by US-002

**US-004**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/approvals/domain/approval.domain.ts` — created by US-002
- `apps/api/src/approvals/domain/approval-mode.ts` — created by US-002

**US-005**
- `apps/api/src/approvals/approval-policy.validation.ts` — created by US-004
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides and exports ApprovalPolicyService)
- `apps/api/src/approvals/prisma-approval-policy.repository.ts` — created by US-002
- `apps/api/src/audit/audit-recorder.service.ts`
- `apps/api/test/helpers/action-context.ts`

**US-006**
- `apps/api/src/approvals/domain/approval.domain.ts` — created by US-002
- `apps/api/src/approvals/domain/approval-mode.ts` — created by US-002
- `apps/api/src/permissions/entry-matcher.ts`

**US-007**
- `apps/api/src/permissions/catalog.ts`
- `apps/api/src/approvals/approval-engine.module.spec.ts` — created by US-002, extended here
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides and exports ApprovalCommandRegistry)

**US-008**
- `apps/api/src/approvals/approval-policy.resolver.ts` — created by US-003
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides and exports ApprovalGate)
- `apps/api/src/approvals/approval-command.registry.ts` — created by US-007
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — created by US-007
- `apps/api/src/action-context/action-context.ts`

**US-009**
- `apps/api/src/approvals/approval-gate.service.ts` — created by US-008, extended here (step 7)
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — created by US-002
- `apps/api/src/approvals/canonical-json.ts` — created by US-007
- `apps/api/src/approvals/test-helpers/approval-fixtures.ts` — created by US-002
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — created by US-007

**US-010**
- `apps/api/src/approvals/approval-eligibility.ts` — created by US-006
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides and exports ApprovalDecisionService)
- `apps/api/src/approvals/prisma-approval-request.repository.ts` — created by US-002
- `apps/api/src/approvals/test-helpers/approval-fixtures.ts` — created by US-002
- `apps/api/src/approvals/test-helpers/test-approval-command.ts` — created by US-007

**US-011**
- `apps/api/src/approvals/approval-decision.service.ts` — created by US-010, extended here (decide calls ApprovalExecutionService.execute after an approve commits and returns its record)
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides and exports ApprovalExecutionService)
- `apps/api/src/approvals/approval-decision.service.spec.ts` — created by US-010, extended here (its direct construction gains an ApprovalExecutionService stub; AC expectations unchanged)
- `apps/api/src/approvals/approval-command.registry.ts` — created by US-007
- `apps/api/src/approvals/canonical-json.ts` — created by US-007

**US-012**
- `apps/api/src/approvals/approval-execution.service.ts` — created by US-011
- `apps/api/src/approvals/approval-engine.module.ts` — created by US-002, extended here (provides ApprovalRequestExpirySweeper)
- `apps/api/src/approvals/approval-engine.module.spec.ts` — created by US-002, extended here
- `apps/api/src/fleet/assistant/actions/pending-action-expiry.sweeper.ts`
- `apps/api/src/config/fleet.config.ts`

### Creates

**US-002**
- `apps/api/prisma/migrations/20261104090000_approval_engine/migration.sql`
- `apps/api/src/approvals/domain/approval.domain.ts`
- `apps/api/src/approvals/domain/approval-mode.ts`
- `apps/api/src/approvals/domain/approval-mode.spec.ts`
- `apps/api/src/approvals/domain/approval.errors.ts`
- `apps/api/src/approvals/approval-engine.module.spec.ts`
- `apps/api/src/approvals/test-helpers/approval-fixtures.ts`
- `apps/api/src/approvals/prisma-approval-policy.repository.ts`
- `apps/api/src/approvals/prisma-approval-request.repository.ts`
- `apps/api/src/approvals/approval-engine.module.ts`
- `apps/api/test/integration/approvals/approval-repositories.integration.spec.ts`

**US-003**
- `apps/api/src/approvals/approval-policy.resolver.ts`
- `apps/api/src/approvals/approval-policy.resolver.spec.ts`

**US-004**
- `apps/api/src/approvals/approval-policy.validation.ts`
- `apps/api/src/approvals/approval-policy.validation.spec.ts`

**US-005**
- `apps/api/src/approvals/approval-policy.service.ts`
- `apps/api/test/integration/approvals/approval-policy-writes.integration.spec.ts`

**US-006**
- `apps/api/src/approvals/approval-eligibility.ts`
- `apps/api/src/approvals/approval-eligibility.spec.ts`

**US-007**
- `apps/api/src/approvals/approval-command.registry.ts`
- `apps/api/src/approvals/approval-command.registry.spec.ts`
- `apps/api/src/approvals/test-helpers/test-approval-command.ts`
- `apps/api/src/approvals/canonical-json.ts`
- `apps/api/src/approvals/canonical-json.spec.ts`

**US-008**
- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/approvals/approval-gate.service.spec.ts`
- `apps/api/test/integration/approvals/approval-gate.integration.spec.ts`

**US-009**
- `apps/api/test/integration/approvals/approval-gate-pending.integration.spec.ts`

**US-010**
- `apps/api/src/approvals/approval-decision.service.ts`
- `apps/api/src/approvals/approval-decision.service.spec.ts`
- `apps/api/test/integration/approvals/approval-decide.integration.spec.ts`

**US-011**
- `apps/api/src/approvals/approval-execution.service.ts`
- `apps/api/test/integration/approvals/approval-execute.integration.spec.ts`

**US-012**
- `apps/api/src/approvals/approval-request-expiry.sweeper.ts`
- `apps/api/src/approvals/approval-request-expiry.sweeper.spec.ts`
- `apps/api/test/integration/approvals/approval-expiry.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/permissions/catalog.ts` — buildEntry's approval block takes the approvable, floor and default rule of this spec, its comment drops "Placeholder until phase P3", and NEW_KEY_SCOPES['approval.decide'] becomes 'any'; no key is added or removed.
- `apps/api/src/permissions/catalog.spec.ts` — its expected scope map sets 'approval.decide' to 'any', and its derive() helper computes approval with the same approvable, floor and default rule; the mismatch assertion over every key is kept.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — in every role's row, the global cell of 'approval.decide' changes from "no-project" to a decision: "granted" for owner and admin (through '*'), "not-granted" for the other nine roles; regenerated with the role-matrix spec's update mode, and no other cell changes.

**US-002**
- `apps/api/prisma/schema.prisma` — gains the ApprovalPolicy, ApprovalRequest and ApprovalDecision models; no existing model changes.
- `apps/api/src/app.module.ts` — imports ApprovalEngineModule; no other import changes.

**US-003**
- `apps/api/src/permissions/permission.service.ts` — gains the public method roleIdsAt(principal, scope); can, effectiveKeys and the other methods are unchanged.
- `apps/api/src/permissions/permission.service.spec.ts` — gains roleIdsAt cases; existing cases keep their expectations.

**US-004**
None. The story creates its files; no existing assertion pins their absence.

**US-005**
- `apps/api/src/permissions/permission.service.ts` — gains the public method roleIdsAnywhere(principal); the methods US-003 left are unchanged.

**US-006**
None. The story creates a pure module and its spec; no existing assertion changes.

**US-007**
None. The story creates its files and extends approval-engine.module.ts, which US-002 creates in this feature (listed under Context Files).

**US-008**
None. The story creates the gate files and extends approval-engine.module.ts, which US-002 creates in this feature (listed under Context Files).

**US-009**
- `apps/api/src/action-context/audit-coverage.reasons.ts` — BOOKKEEPING_REASONS gains 'approval.request-open' with the sentence in this spec; no existing reason changes.
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — any assertion that lists every reason id or counts them gains 'approval.request-open'; the per-reason behaviour assertions are kept.

**US-010**
None. The story extends approval-engine.module.ts, which US-002 creates in this feature (listed under Context Files).

**US-011**
- `apps/api/src/action-context/audit-coverage.reasons.ts` — BOOKKEEPING_REASONS gains 'approval.request-settle' with the sentence in this spec; no existing reason changes.
- `apps/api/src/action-context/audit-coverage.bookkeeping.spec.ts` — any assertion that lists every reason id or counts them gains 'approval.request-settle'; the per-reason behaviour assertions are kept.

**US-012**
None. The story extends approval-engine.module.ts, which US-002 creates in this feature (listed under Context Files).

### Seams

- US-003 consumes `PermissionService.roleIdsAt`, which it adds. Its resolver ACs stub `roleIdsAt`, assert the role-tier choice and assert the arguments it is called with; US-009 has the integration AC that goes through the real resolver, `findCandidates` and `roleIdsAt` with a role policy.
- US-005 consumes US-004's `validateApprovalPolicy` and US-003's `roleIdsAt`. Its integration ACs call `ApprovalPolicyService.create` and assert the refusal or the stored row.
- US-008 consumes US-007's `ApprovalCommandRegistry.get` and US-003's `ApprovalPolicyResolver.resolve`. A unit AC stubs `resolve` and asserts the gate passes the key, the project and the subject derived from the context.
- US-010 consumes US-006's `decideEligibility`. A unit AC mocks the `approval-eligibility` module, calls `decide`, and asserts the call arguments and the refusal it maps.
- US-011's `execute` is called by US-010's `decide` after an approve. An integration AC approves a request through `decide` and asserts the registered command ran.
- US-012 calls US-011's `execute` for an `onTimeout: approve` request. An integration AC runs `tick` and asserts the command ran.
- No production module registers a command or calls `ApprovalGate.gate`, `decide` or the policy service in this feature. Their first callers arrive in approval-api, approval-assistant, approval-fleet and approval-gate (see Out of Scope). The integration ACs register a test command under the approvable key `label.delete` (catalog risk `high`, default `agent`) and run the engine through `app.get(…)` inside `withTestActor`.
- **Test fixtures.** Two helpers are created for the integration specs:
  - `grantKeys(db, principal, entries, projectId)` (`src/approvals/test-helpers/approval-fixtures.ts`, US-002) creates a `Role` row with key `test-<random>` and exactly `entries` (validated with `expandEntries`) and binds the principal to it: a PROJECT-scope role bound in `projectId`, or, with `projectId` null, a GLOBAL-scope role bound globally. `grantRole` only binds seeded roles, and no seeded role holds `label.delete` without `*`.
  - `configurableTestCommand(key)` (`src/approvals/test-helpers/test-approval-command.ts`, US-007) returns `{ command, state, reset }`. `command.parse` accepts an object with string values and returns a copy; `command.execute` pushes the input onto `state.calls` and returns `'done'`. The `state` fields, all off after `reset()`:
    - `parseThrows`: every `parse` throws `TypeError('test parse refused')`.
    - `parseThrowsAfter: n`: `parse` calls after the n-th throw (so `1` lets the gate's parse pass and fails the execution's re-parse).
    - `parseReturnsUndefined`: `parse` returns `undefined`.
    - `executeThrows`: `execute` throws `Error('boom')` after its other effects.
    - `writeLabel: { projectId, name }`: `execute` first creates that `Label` row through Prisma.
    - `recordAudit`: `execute` records `AuditRecorder.record({ key, resourceType: 'test', resourceId: 'test' })` inside the ambient transaction.
    - `toResult`: when set, used as the command's `toResult`. Each spec file registers one such command per key in `beforeAll` and calls `reset()` in `beforeEach`, because the registry is a singleton that refuses a second registration.
  - Each case uses fresh principals, so no principal's effective keys are cached from an earlier case.

## Acceptance Criteria

### US-001: Catalog approval metadata

1. [unit] `findCatalogEntry('ticket.delete').approval` equals `{ approvable: true, floor: 'none', default: 'agent' }`.
2. [unit] `findCatalogEntry('role.manage').approval` equals `{ approvable: true, floor: 'human', default: 'human' }`.
3. [unit] `findCatalogEntry('approval.policy.manage').approval` equals `{ approvable: true, floor: 'human', default: 'human' }`.
4. [unit] `findCatalogEntry('role.read').approval` equals `{ approvable: false, floor: 'none', default: 'none' }`.
5. [unit] `findCatalogEntry('ticket.create').approval` equals `{ approvable: true, floor: 'none', default: 'none' }` (risk `medium`).
6. [unit] `findCatalogEntry('ticket.read').approval.approvable` is false (risk `low`).
7. [unit] `findCatalogEntry('session.login').approval.approvable` is false (access `public`).
8. [unit] Every catalog entry with `approval.approvable === false` has `approval.floor` `'none'` and `approval.default` `'none'`.
9. [unit] Every catalog entry with `approval.floor === 'human'` has a key starting with `role.` or `approval.policy.`.
10. [unit] `findCatalogEntry('approval.decide').scope` is `'any'`.
11. [unit] `expandEntries(['*'], 'GLOBAL')` contains `approval.decide`.
12. [unit] `expandEntries(['approval.decide'], 'PROJECT')` contains `approval.decide`.

### US-002: The approval tables, repositories and module

Repository cases boot `AppModule`, read the repositories with `app.get(APPROVAL_POLICY_REPOSITORY, { strict: false })` and `app.get(APPROVAL_REQUEST_REPOSITORY, { strict: false })`, and run every write inside `withTestActor({ type: 'USER', id: <a user id> }, …)`.

1. [integration] After `applyMigration` of `20261104090000_approval_engine` on a scratch schema from `scratchSchemaBefore(…, '20261104090000_approval_engine')`, the schema has tables `ApprovalPolicy`, `ApprovalRequest` and `ApprovalDecision` with the columns of their models, and a unique index on `ApprovalPolicy.selector`.
2. [integration] Creating two `ApprovalPolicy` rows with the same `selector` through the Prisma model API (`approvalPolicy.create`) fails with an error that `isUniqueViolation(error, 'selector')` recognises.
3. [integration] On that scratch schema, deleting an `ApprovalRequest` row also deletes its `ApprovalDecision` rows.
4. [integration] `findCandidates('ticket.delete', 'p1')` over policies with patterns `ticket.delete`, `ticket.*`, `ti.*`, `ticket.update` and `comment.*` and project `p1`, `p2` or null returns exactly the `ticket.delete` and `ticket.*` rows whose project is `p1` or null.
5. [integration] `findPendingDuplicate(match, now)` with an actor, on-behalf-of, key, project and hash equal to a `pending` request expiring after `now` returns that request, and returns null when the only match has status `rejected`, `expiresAt <= now`, or a different `onBehalfOfId`.
6. [integration] `findDue(now, 10)` over pending requests expiring 1 s before `now`, at `now` and 1 s after `now`, plus an `approved` request expiring before `now`, returns the first two, oldest `expiresAt` first.
7. [integration] `transition(id, 'pending', { status: 'approved' })` on a pending request returns the updated record with status `approved`.
8. [integration] `transition(id, 'pending', { status: 'rejected' })` on a request already `approved` returns null and leaves its status `approved`.
9. [integration] `createDecision` followed by `findDecisions(requestId)` returns the decision with the input's `deciderType`, `deciderId`, `decision` and `comment`.
10. [integration] Inside `txManager.run`, `lockById(id)` returns the request record, and returns null for an id that does not exist.
11. [unit] `modeAtLeast('agent', 'self')` is true, `modeAtLeast('self', 'agent')` is false and `modeAtLeast('none', 'none')` is true.
12. [unit] `strictestMode('self', 'human', 'none')` is `'human'`, and `strictestMode()` is `'none'`.
13. [integration] After `grantKeys(db, agent, ['label.delete'], projectId)`, `PermissionService.effectiveKeys(agent, { projectId })` contains `label.delete` and not `label.update`, and after `grantKeys(db, agent2, ['role.manage'], null)`, `effectiveKeys(agent2, 'global')` contains `role.manage`.
14. [unit] Compiling `ApprovalEngineModule` with every provider it needs from outside the module overridden by a stub resolves `APPROVAL_POLICY_REPOSITORY` to the module's `PrismaApprovalPolicyRepository` and `APPROVAL_REQUEST_REPOSITORY` to its `PrismaApprovalRequestRepository`.
15. [integration] Booting `AppModule` and calling `app.get(APPROVAL_REQUEST_REPOSITORY, { strict: false })` returns a `PrismaApprovalRequestRepository` instance.

### US-003: Policy resolution

Resolver unit cases build `ApprovalPolicyResolver` with a stub policy repository whose `findCandidates` returns the listed rows, and a stub `PermissionService` whose `roleIdsAt` returns `['r1']` unless stated. The subject is `{ type: 'AGENT', id: 'a1' }` and the key is `ticket.delete` (floor `none`, default `agent`) unless stated.

1. [unit] `resolve` with no candidates returns `{ mode: 'agent', floor: 'none', policy: null, source: 'default' }`.
2. [unit] `resolve` with key `ticket.read` returns `source` `'not-approvable'` and mode `'none'`, and `findCandidates` is not called.
3. [unit] `resolve` with key `no.such.key` rejects with `Error` whose message is `unknown permission key: no.such.key`.
4. [unit] With a global `principal:AGENT:a1` policy of mode `none` and a project-`p1` `all` policy of mode `human`, `resolve` for project `p1` returns mode `human` (project tiers precede global tiers).
5. [unit] With project-`p1` policies `principal:AGENT:a1` mode `self`, `role:r1` mode `human`, `type:AGENT` mode `human` and `all` mode `human`, `resolve` for `p1` returns mode `self` and the principal policy.
6. [unit] With project-`p1` policies `role:r1` mode `none` and `type:AGENT` mode `human`, `resolve` for `p1` returns mode `none`.
7. [unit] With project-`p1` policies `role:r2` mode `none` and `type:AGENT` mode `human`, while `roleIdsAt` returns `['r1']`, `resolve` returns mode `human`.
8. [unit] With global `all` policies for patterns `ticket.*` mode `none` and `ticket.delete` mode `human`, `resolve` returns mode `human` (an exact key beats a wildcard).
9. [unit] With global `all` policies for patterns `ticket.*` mode `human` and `ticket.label.*` mode `none`, `resolve` for key `ticket.label.remove` returns mode `none` (a longer prefix beats a shorter one).
10. [unit] With project-`p1` policies `role:r1` mode `self` and `role:r2` mode `human`, while `roleIdsAt` returns `['r1', 'r2']`, `resolve` returns mode `human`.
11. [unit] With a global `all` policy of mode `none` on key `role.manage` (floor `human`), `resolve` returns mode `human` and `floor` `human`.
12. [unit] For subject `{ type: 'ASSISTANT', id: 'assistant' }`, with a global `all` policy of mode `none` and no `type:ASSISTANT` policy, `resolve` returns mode `human` and `source` `'default'`.
13. [unit] For subject `{ type: 'ASSISTANT', id: 'assistant' }` with a global `type:ASSISTANT` policy of mode `none`, `resolve` returns mode `none`.
14. [unit] Over the in-memory permission store, `PermissionService.roleIdsAt({ type: 'AGENT', id }, { projectId })` for an agent with a `developer` binding in that project and a global `agent` binding returns exactly the ids of `developer` and `agent`, ascending.
15. [unit] `resolve` with project `p1` calls `roleIdsAt` with `(subject, { projectId: 'p1' })`, and with project null calls it with `(subject, 'global')`.

### US-004: Policy validation

Cases call `validateApprovalPolicy` with a base input of project null, pattern `ticket.delete`, subject `{ kind: 'all' }`, mode `agent`, `timeoutSec` null, `onTimeout` `reject` and `requiredApprovals` 1, changed as stated.

1. [unit] The base input returns null.
2. [unit] Pattern `ticket.read` returns `'pattern'` (a non-approvable key).
3. [unit] Pattern `ti.*` returns `'pattern'` (no approvable key starts with `ti.`).
4. [unit] Pattern `*` returns `'pattern'`.
5. [unit] Subject `{ kind: 'principal', principalType: 'AGENT', principalId: '' }` returns `'subject'`.
6. [unit] Mode `sometimes` returns `'mode'`.
7. [unit] Pattern `role.manage` with mode `agent` returns `'below-floor'`.
8. [unit] Pattern `role.*` with mode `human` returns null.
9. [unit] `timeoutSec` 59 returns `'timeout'`.
10. [unit] `timeoutSec` 60 returns null.
11. [unit] `timeoutSec` 2 592 001 returns `'timeout'`.
12. [unit] Pattern `role.manage`, mode `human` and `onTimeout` `approve` returns `'timeout-approve'`.
13. [unit] `onTimeout` `approve` with the base pattern returns null.
14. [unit] `requiredApprovals` 2 returns `'required-approvals'`.
15. [unit] `policySelector` of project `p1`, pattern `ticket.*` and subject `{ kind: 'principal', principalType: 'AGENT', principalId: 'a1' }` returns `p1|ticket.*|principal:AGENT:a1`.

### US-005: Policy writes

Cases boot `AppModule`, call `app.get(ApprovalPolicyService, { strict: false })` inside `withTestActor`, and read `AuditEntry` rows through `fixtureDb(app)`. Every `ApprovalPolicy` row is deleted in `beforeEach`. Unless stated, the input is project null, pattern `ticket.delete`, subject `all` and mode `human`.

1. [integration] `create` with project null, pattern `ticket.delete`, subject `all` and mode `human`, as `USER/u1`, returns a policy whose `selector` is `*|ticket.delete|all`, `updatedByType` is `USER` and `updatedById` is `u1`.
2. [integration] That `create` leaves one `AuditEntry` with key `approval.policy.manage`, `resourceType` `approval-policy`, the policy's id and summary `created ticket.delete human`.
3. [integration] A second `create` with the same project, pattern and subject rejects with `ApprovalPolicyConflictError`, and the policy count stays 1.
4. [integration] `create` with pattern `role.manage` and mode `none` rejects with `InvalidApprovalPolicyError` whose violation is `below-floor`, and no policy or audit row is written.
5. [integration] `update(id, { mode: 'self', timeoutSec: 600 })` returns the policy with mode `self` and `timeoutSec` 600, and records an entry with summary `updated mode,timeoutSec`.
6. [integration] `update(id, { onTimeout: 'approve' })` on a `role.*` policy rejects with `InvalidApprovalPolicyError` whose violation is `timeout-approve`, and the stored row is unchanged.
7. [integration] `remove(id)` deletes the row and records an entry with summary `deleted ticket.delete`.
8. [integration] `update('missing', { mode: 'none' })` and `remove('missing')` each reject with `ApprovalPolicyNotFoundError`.
9. [integration] As `AGENT/a1`, `create` with subject `{ kind: 'principal', principalType: 'AGENT', principalId: a1 }` rejects with `ApprovalPolicySelfApplicationError`, and no row is written.
10. [integration] As `AGENT/a1`, `create` with subject `all` rejects with `ApprovalPolicySelfApplicationError`.
11. [integration] As `AGENT/a1` holding a `developer` binding in project `p1`, `create` in `p1` with subject `role:<developer id>` rejects with `ApprovalPolicySelfApplicationError`.
12. [integration] As `AGENT/a1` holding `developer` in project `p1` only, `create` of a global policy (project null) with subject `role:<developer id>` rejects with `ApprovalPolicySelfApplicationError`.
13. [integration] As `AGENT/a1`, `create` with subject `{ kind: 'type', principalType: 'USER' }` succeeds.
14. [integration] As `AGENT/a1`, `remove` of a policy whose subject is `type:AGENT` rejects with `ApprovalPolicySelfApplicationError`, and the row remains.
15. [integration] `list({ projectId: 'p1' }, { current: 1, size: 20 })` over policies in `p1`, `p2` and global returns exactly the `p1` rows.

### US-006: Decide eligibility

Cases call `decideEligibility` with a request for key `label.delete`, actor `AGENT/a1`, no on-behalf-of, `requiredMode` `agent`, `approverMustHoldAction` true and `requireDistinctApprover` false, changed as stated.

1. [unit] Decider `USER/u1` holding `approval.decide` and `label.delete` returns `{ ok: true, satisfiedBy: 'human' }`.
2. [unit] Decider `AGENT/a2` holding `approval.decide` and `label.delete` returns `{ ok: true, satisfiedBy: 'agent' }`.
3. [unit] Decider `AGENT/a1` (the actor) holding `label.delete` with `requiredMode` `agent` returns `{ ok: false, reason: 'tier-too-low' }`.
4. [unit] Decider `AGENT/a1` holding `label.delete` with `requiredMode` `self` returns `{ ok: true, satisfiedBy: 'self' }`, without holding `approval.decide`.
5. [unit] Decider `AGENT/a2` holding `approval.decide` and `label.delete` with `requiredMode` `human` returns `{ ok: false, reason: 'tier-too-low' }`.
6. [unit] Decider `USER/u1` holding `label.delete` only returns `{ ok: false, reason: 'missing-decide-permission' }`.
7. [unit] Decider `USER/u1` holding `approval.decide@label.*` and `label.delete` returns `{ ok: true, satisfiedBy: 'human' }`.
8. [unit] Decider `USER/u1` holding `approval.decide@ticket.*` and `label.delete` returns `{ ok: false, reason: 'missing-decide-permission' }`.
9. [unit] Decider `USER/u1` holding `approval.decide` only returns `{ ok: false, reason: 'missing-action-permission' }`.
10. [unit] With `approverMustHoldAction` false, decider `USER/u1` holding `approval.decide` only returns `{ ok: true, satisfiedBy: 'human' }`.
11. [unit] With `requireDistinctApprover` true and `requiredMode` `self`, decider `AGENT/a1` (the actor) holding `label.delete` returns `{ ok: false, reason: 'distinct-approver-required' }`.
12. [unit] With actor `SYSTEM/assistant`, on-behalf-of `USER/u9` and `requiredMode` `human`, decider `USER/u9` holding `label.delete` only returns `{ ok: true, satisfiedBy: 'human' }`.
13. [unit] Decider `SYSTEM/expiry` returns `{ ok: false, reason: 'not-a-principal' }`.
14. [unit] Decider `USER/u1` holding `approval.decide` and `label.delete.own` returns `{ ok: false, reason: 'missing-action-permission' }`.
15. [unit] Decider `AGENT/a1` (the actor) holding `label.delete.own` with `requiredMode` `self` returns `{ ok: true, satisfiedBy: 'self' }`.

### US-007: The command registry and canonical JSON

Registry cases build `ApprovalCommandRegistry` directly.

1. [unit] `register` of a command with key `label.delete`, followed by `get('label.delete')`, returns that command.
2. [unit] `get('label.delete')` on an empty registry returns undefined.
3. [unit] `register` of a command with key `ticket.read` throws `Error` whose message is `approval command key is not approvable: ticket.read`.
4. [unit] `register` of a command with key `no.such.key` throws `Error` whose message is `approval command key is not approvable: no.such.key`.
5. [unit] `register` of a second command with key `label.delete` throws `Error` whose message is `approval command already registered: label.delete`.
6. [unit] `canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })` returns `{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}`.
7. [unit] `canonicalJson([2, 1])` returns `[2,1]` (array order is kept).
8. [unit] Compiling `ApprovalEngineModule` with every provider it needs from outside the module overridden by a stub resolves `ApprovalCommandRegistry` to the same instance on every `get`.
9. [unit] `configurableTestCommand('label.delete')` with `parseThrowsAfter` 1 parses `{ labelId: 'l1' }` once, then throws `TypeError` on the second `parse`; after `reset()`, `parse` succeeds again and `state.calls` is empty.

### US-008: The gate: refusals and running now

Gate integration cases register `configurableTestCommand('label.delete')` once per file (its `parse` accepts `{ labelId: string }`, its `execute` records the input and returns `'done'`) and run `gate` inside `withTestActor`. Unit cases build `ApprovalGate` directly with a stub resolver, a stub request repository and a registry holding that command, except where stated. Assistant cases run inside `runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf, origin: 'thread' }, …)`, since `withTestActor` takes no on-behalf-of.

1. [unit] `gate('label.delete', …)` with an empty registry rejects with `UnregisteredApprovalCommandError`.
2. [unit] `gate` outside any action context rejects with `Error` whose message is `approval gate needs an action context`.
3. [unit] `gate` as actor `RUNNER/r1` rejects with `Error` whose message is `approval gate cannot gate actor RUNNER/r1`.
4. [unit] With a stub resolver, `gate('label.delete', { labelId: 'l1' }, { projectId: 'p1' })` as `SYSTEM/assistant` on behalf of `USER/u9` calls `resolve` with `{ key: 'label.delete', projectId: 'p1', subject: { type: 'ASSISTANT', id: 'assistant' } }`.
5. [integration] As `USER/u1`, `gate('label.delete', { labelId: 'l1' }, { projectId })` runs the command once and returns `{ status: 'executed', result: 'done' }` with approval `{ requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: u1 }`, and no `ApprovalRequest` row exists.
6. [integration] As `AGENT/a1` with a project `all` policy of mode `none` on `label.delete`, `gate` runs the command once and returns approval `{ requiredMode: 'none', satisfiedBy: 'none' }`.
7. [integration] As `USER/u1` with a project `all` policy of mode `none` on `label.delete`, `gate` returns approval `{ requiredMode: 'none', satisfiedBy: 'none' }` with no approver.
8. [unit] `gate('label.delete', { labelId: 'l1' }, { projectId: null })` as `AGENT/a1` rejects with `Error` whose message is `approval gate needs a project for key label.delete`, and the resolver is not called.
9. [integration] As `USER/u1` with a project policy of mode `human` and `requireDistinctApprover: true` on `label.delete`, `gate` runs the command once and returns approval `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: u1 }`.
10. [unit] `gate` with a command whose `parse` returns `undefined` rejects with `Error` whose message is `approval command parse returned no input: label.delete`, and nothing is written.
11. [unit] `gate` as `SYSTEM/assistant` with no `onBehalfOf` rejects with `Error` whose message is `approval gate cannot gate actor SYSTEM/assistant`.

### US-009: The gate: opening a pending request

Gate integration cases register `configurableTestCommand('label.delete')` once per file (its `parse` accepts `{ labelId: string }`, its `execute` records the input and returns `'done'`) and run `gate` inside `withTestActor`. Unit cases build `ApprovalGate` directly with a stub resolver, a stub request repository and a registry holding that command, except where stated. Assistant cases run inside `runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf, origin: 'thread' }, …)`. A second `configurableTestCommand('role.manage')` is registered for the global-key case.

1. [integration] As `AGENT/a1` with no policy, `gate` does not run the command and returns `{ status: 'pending' }` with a request whose `status` is `pending`, `requiredMode` is `agent`, `input` is `{ labelId: 'l1' }` and `actor` is `AGENT/a1`.
2. [integration] That pending request has `expiresAt` 86 400 s after the `now` passed to `gate`, `onTimeout` `reject`, `approverMustHoldAction` true and `requireDistinctApprover` false.
3. [integration] With a project policy of mode `self`, `timeoutSec` 600 and `requireDistinctApprover` true, the pending request has `requiredMode` `self`, `expiresAt` 600 s after `now`, `requireDistinctApprover` true and that policy's id as `policyId`.
4. [integration] A second `gate` as `AGENT/a1` with input `{ labelId: 'l1' }` returns the same request id, and only one `ApprovalRequest` row exists.
5. [integration] A `gate` whose command `parse` throws `TypeError` rejects with that `TypeError`, and no `ApprovalRequest` row exists.
6. [integration] A pending `gate` call under an open audit coverage scope (`runInAuditScope`) settles without an `UnauditedWriteError`.
7. [integration] As `SYSTEM/assistant`, a `gate` on behalf of `USER/u8` and one on behalf of `USER/u9`, with the same input, open two different pending requests.
8. [integration] As `AGENT/a1` given `role.manage` globally (`grantKeys` with project null), `gate('role.manage', { roleId: 'r1' }, { projectId: null })` returns a pending request with `projectId` null and `requiredMode` `human`.
9. [integration] As `AGENT/a1` holding `developer` in the project, with a project policy `role:<developer id>` of mode `none` on `label.delete`, `gate` runs the command at once (the real resolver and `PermissionService.roleIdsAt` choose the role policy).

### US-010: Deciding a request

Cases open a pending `label.delete` request as `AGENT/a1`, given `label.delete` in the project with `grantKeys`, through `gate` and the file's `configurableTestCommand`. They then decide inside `withTestActor` as the stated decider. "Holding `approval.decide` and `label.delete`" means a `project-admin` binding in the project (`grantRole`); "holding only X" means `grantKeys` with exactly X. No AC here asserts the status after an approve, because US-011 makes `decide` execute approved requests.

1. [integration] `decide(id, 'reject', 'no')` as a user holding `approval.decide` and `label.delete` in the project returns the request with status `rejected`, and the command has not run.
2. [integration] That reject leaves one `ApprovalDecision` with decider `USER/<id>`, decision `reject` and comment `no`.
3. [integration] That reject leaves one `AuditEntry` with key `approval.decide`, `resourceType` `approval-request`, `resourceId` the request id, summary `rejected label.delete`, `satisfiedBy` `none` and `approvalRequestId` the request id.
4. [integration] `decide(id, 'approve', null)` as a user holding `approval.decide` and `label.delete` leaves an `AuditEntry` with key `approval.decide`, `requiredMode` `agent`, `satisfiedBy` `human`, `approverType` `USER` and `approverId` the user's id.
5. [integration] `decide(id, 'approve', null)` as `AGENT/a1` (the actor) holding `label.delete` rejects with `ApprovalDecideForbiddenError` whose reason is `tier-too-low`, and no `ApprovalDecision` row exists.
6. [integration] `decide` as a user holding only `label.delete` rejects with `ApprovalDecideForbiddenError` whose reason is `missing-decide-permission`.
7. [integration] `decide` as a user given `label.delete` in the request's project (`grantKeys`) and an `approver` binding only in a different project rejects with `ApprovalDecideForbiddenError` whose reason is `missing-decide-permission`.
8. [integration] `decide` on a request already `rejected` rejects with `ApprovalRequestNotPendingError`, and the decision count stays 1.
9. [integration] `decide` with `now` 1 ms past `expiresAt` rejects with `ApprovalRequestExpiredError`, and the request stays `pending` with no decision row.
10. [integration] `decide('missing', 'approve', null)` rejects with `ApprovalRequestNotFoundError`.
11. [integration] Two concurrent `decide(id, 'approve', null)` calls by two eligible users settle with exactly one fulfilled and one rejected with `ApprovalRequestNotPendingError`, and exactly one `ApprovalDecision` row exists.
12. [integration] On a pending `role.manage` request with project null (opened by `AGENT/a1` given `role.manage` globally), `decide(id, 'approve', null)` as a user with a global `admin` binding does not reject, and leaves one `ApprovalDecision` whose decider is that user.
13. [integration] On that `role.manage` request, `decide` as a user with a `project-admin` binding in one project only rejects with `ApprovalDecideForbiddenError` whose reason is `missing-action-permission`.
14. [unit] With the `approval-eligibility` module mocked so `decideEligibility` returns `{ ok: false, reason: 'tier-too-low' }`, and stub repositories and `PermissionService`, `decide(id, 'approve', null)` as `USER/u1` rejects with `ApprovalDecideForbiddenError` whose reason is `tier-too-low`, after calling `decideEligibility` once with the locked request, `{ type: 'USER', id: 'u1' }` and the set `effectiveKeys` returned for the request's project.
15. [unit] `decide` with the current actor `SYSTEM/approval` rejects with `ApprovalDecideForbiddenError` whose reason is `not-a-principal`.

### US-011: Executing an approved request

Cases open a pending `label.delete` request as `AGENT/a1`, given `label.delete` in the project with `grantKeys`, through `gate` and the file's `configurableTestCommand`, then approve it through `decide` as a `project-admin` user unless stated. `AGENT/a1`'s effective keys are not read before the approve.

1. [integration] `decide(id, 'approve', null)` runs the test command once with input `{ labelId: 'l1' }` and returns the request with status `executed` and `settledAt` set.
2. [integration] While the command runs, `currentContext()` reports actor `AGENT/a1` and approval `{ requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: <decider id>, requestId: <id> }`.
3. [integration] When the command records `AuditRecorder.record` with key `label.delete`, the stored entry has actor `AGENT/a1`, `satisfiedBy` `human` and `approvalRequestId` the request id.
4. [integration] With a command whose `toResult` returns `{ deleted: 1 }`, the executed request's `result` is `{ deleted: 1 }`.
5. [integration] With a command whose `execute` writes a `Label` row and then throws `Error('boom')`, `decide` returns the request with status `failed` and `result` `{ error: 'execution-failed', name: 'Error' }`, and the `Label` row does not exist.
6. [integration] After `revokeProjectRoles` removes `AGENT/a1`'s binding between open and approve, `decide` returns status `failed` with `result.error` `permission-revoked`, and the command has not run.
7. [integration] With the request's `input` changed in the database to `{ labelId: 'l2' }` before approve, `decide` returns status `failed` with `result.error` `input-hash-mismatch`, and the command has not run.
8. [integration] An `ApprovalExecutionService` built directly over an empty `ApprovalCommandRegistry` and the real repositories, given a request moved to `approved` through the request repository's `transition`, returns status `failed` with `result.error` `no-command` from `execute`.
9. [integration] With a command whose `parse` succeeds at gate time and throws on its second call, approving the request returns status `failed` with `result.error` `invalid-input`, and the command's `execute` has not run.
10. [integration] For a request opened as `SYSTEM/assistant` on behalf of `USER/u9`, where `u9` holds `label.delete` and approves it, execution runs the command, and the re-check reads `u9`'s keys.
11. [integration] `execute` of a request whose status is `rejected` rejects with `ApprovalRequestNotPendingError`.
12. [integration] `execute` of a request already `executed` rejects with `ApprovalRequestNotPendingError`, and the command runs no second time.
13. [integration] Calling `execute` directly inside `runInAuditScope` on a request moved to `approved` through the repository's `transition`, once with a command that succeeds without recording an audit entry and once with a command that throws, settles it `executed` and then `failed` without an `UnauditedWriteError`.
14. [integration] A pending `role.manage` request with project null, opened by `AGENT/a1` given `role.manage` globally and approved by a user with a global `admin` binding, runs its command and ends `executed`.
15. [integration] Two concurrent `execute(id)` calls on one approved request run the command exactly once; one returns status `executed` and the other rejects with `ApprovalRequestNotPendingError`.

### US-012: The expiry sweeper

Cases open pending `label.delete` requests through `gate` as `AGENT/a1`, which holds `label.delete` in the project, build or fetch `ApprovalRequestExpirySweeper`, and call `tick(now)` with `now` past their `expiresAt`.

1. [integration] `tick` on a due request whose `onTimeout` is `reject` returns `{ expired: 1, approved: 0, failed: 0 }` and leaves the request `expired` with `settledAt` equal to `now`.
2. [integration] That expiry leaves one `AuditEntry` with key `system.approval.expire`, actor `SYSTEM/approval`, `resourceType` `approval-request` and summary `expired label.delete`.
3. [integration] `tick` on a due request opened under a policy with `onTimeout` `approve` returns `{ expired: 0, approved: 1, failed: 0 }`, runs the test command once, and leaves the request `executed` with `satisfiedBy` `none`.
4. [integration] That timeout approval leaves an `AuditEntry` with key `system.approval.expire` and summary `approved on timeout label.delete`.
5. [integration] `tick` with `now` before every request's `expiresAt` returns `{ expired: 0, approved: 0, failed: 0 }` and changes no row.
6. [integration] `tick` does not touch a request whose status is already `rejected`, even when its `expiresAt` is past.
7. [integration] With `findDue` returning two requests and the first `lockById` throwing, `tick` returns `failed: 1` and still expires the second request.
8. [integration] With 101 due requests, one `tick` expires exactly 100.
9. [unit] With `sweepEnabled` false, `onModuleInit` starts no interval, and `tick` is never called within `approvalSweepMs`.
10. [unit] Compiling `ApprovalEngineModule` with every provider it needs from outside the module overridden by a stub resolves `ApprovalRequestExpirySweeper`, and the class's `@SystemWriter` key is `system.approval.expire`.
11. [unit] A test module that imports `ApprovalEngineModule` (with the same stubs) and declares a provider injecting `ApprovalGate`, `ApprovalDecisionService`, `ApprovalExecutionService`, `ApprovalPolicyService` and `ApprovalCommandRegistry` compiles, which proves the five are exported.
