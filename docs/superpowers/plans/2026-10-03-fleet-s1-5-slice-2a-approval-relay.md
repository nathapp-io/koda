# Fleet S1.5 Slice 2a — Approval Relay and Protocol v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nax job dispatched with `bashMode: gated|escalate` raises bash approval asks through a runner-hosted
webhook receiver. The runner relays each ask to koda as an `approval_request` sync event, koda stores it as a
`nax_bash_escalate` approval, a DEVELOPER+ decides it over the API or CLI, and the decision goes back down as an
`APPROVAL_ANSWER` command that the runner POSTs, signed, to nax's callback. Every lost, late or failed path ends in a
deny. API, protocol, runner and CLI only; the bash web panel is slice 2b.

**Architecture:** Protocol v2 adds one event type, one command type, one capability and two ASSIGN fields; the server
accepts v1 and v2. On the server, `ApprovalCloser` gains job-keyed methods (`openBash`, `closeForJob`, `expire`) used
by the report processor (ask in), `JobTransitionsService` (job leaves RUNNING), `ApprovalsService.decide` (answer out)
and a new 15 s `ApprovalExpirySweeper`. Every bash path locks the `FleetJob` row before the approval row. On the
runner, an `ApprovalRelay` owns one loopback `ApprovalReceiver` (`Bun.serve`) per non-raw job, journals its port,
secret and pending asks, writes the nax interaction overlay into the per-job profile, and answers nax's callback when
the command arrives.

**Tech Stack:** NestJS + Prisma 6 (PostgreSQL) + Jest (API); commander 12 + Jest (CLI); Bun + `bun:sqlite` +
`bun:test` (runner); shared types in `packages/fleet-protocol`.

**Spec:** `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` §1.1-§1.3, §1.4 (bash rules), §1.6,
§1.7, §2.1-§2.5 (bash parts), §3, §4, §6 (bash rows), §7 (2a tests), §8 slice 2a. Rulings A1, A3, A5, A6, A7, A8.
Slice 1a plan (D226-D238) and 1b plan (D239-D254) for the code this builds on.

## Global Constraints

- Protocol: `FLEET_PROTOCOL_VERSION = 2` in `packages/fleet-protocol`; the API's own
  `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2]`. Deploy order: server first (a v2 runner against a v1-only server gets
  426 and stops).
- `bashMode`: `raw | gated | escalate`; PLAN jobs stay `raw` (400 `fleet.dispatchInput`). `approvalTimeoutSec`: integer
  30..3600, default 600, stored for every job and schedule, used only for non-raw jobs.
- Ask payload caps: `command` at most **12 KiB UTF-8** (`12_288` bytes), prefix kept and `commandTruncated: true` on
  overflow; `rawDetail` the same cap and flag; every other string field at most 2000 chars; `options` a non-empty
  subset of `allow`, `allow-remember`, `deny` that contains `deny`. The server's sync parser refuses the **whole sync**
  (400) when any event payload's `JSON.stringify` exceeds 16 KiB, so the **runner** guarantees it: it caps the short
  fields at 500 chars and shrinks `command`/`rawDetail` until the JSON-encoded payload fits (Task 13).
- `APPROVAL_ANSWER` payload `{ approvalId, naxAskId, choice: 'allow' | 'allow-remember' | 'deny' }`. Ack details
  (rejected): `ask_not_pending`, `job_not_running`, `callback_failed:<status>` where `<status>` is the HTTP status,
  `timeout` or `error`. The ack is stored on the approval as `outcome.delivery = { result, detail, at }`.
- **Lock order (bash):** `FleetJob` row first, then the `FleetApproval` row. Budget paths keep policy-then-approval.
- Nothing ever turns a failure into an allow: a malformed ask, an unknown id, a failed callback and a timeout all end
  in nax's deny.
- Webhooks: `fleet.approval.requested` / `fleet.approval.resolved` for pending-born bash approvals with a project
  (always, a job has a project). No command text, no `rawDetail`, no `request:` text in webhooks or activity (A8).
- Activity payload keys never match `/token|secret|key|password|credential/i`; `naxAskId` is fine, a key named
  `secret` is not.
- Runner profile overlay holds the receiver secret: the profile and its temp file are written with mode `0600`.
- The receiver binds `127.0.0.1` only, verifies `X-Nax-Signature` (hex HMAC-SHA256 of the raw body) in constant time
  (401), caps bodies at 64 KiB (413), and answers nax within its 30 s POST timeout (it never waits for a human).
- API tests: `cd apps/api && bun run test:scoped <paths>` (integration specs need `bun run test:db:up`). Never
  `bun run test:unit -- <path>` and never bare `bun test` at the repo root. Runner: `cd apps/runner && bun run test`
  (unit), `bun run test:integration` (needs the test DB too). CLI: `cd apps/cli && bun run test -- <path>`. Web:
  `cd apps/web && bun run test -- <path>`.
- `bun run generate` (repo root) needs `apps/api/.env`; commit `openapi.json` only (`apps/cli/src/generated` is
  gitignored).
- Integration files log in over HTTP in `beforeAll` (login throttle 5/min). A whole file failing in under a millisecond
  with only a `loginToken` frame is the local throttle cascade: wait a minute and rerun that file alone.
- No emojis in source; no `console.log` in API or runner `src` (the fake-nax fixture may print).
- **`apps/api` compiles with `strictNullChecks: false`** (`packages/typescript-config/nestjs.json`): a check on a boolean
  discriminant such as `r.ok` does **not** narrow a union. Discriminate result unions with `'ask' in r` / `'reason' in r`
  (as `sync.service.ts` already does). The runner and CLI are strict; `r.ok` narrows there.
- Every snippet below names the real fields and helpers of the file it edits. Where a step says "the spec's existing
  X", X exists under that name; if a name in a snippet does not exist, that is a plan defect: stop and report it.

## Decisions

Numbered from D255 (slice 1b ended at D254).

| # | Decision | Why |
|:--|:--|:--|
| D255 | **Spec correction:** nax's `request:` line is masked and capped at 200 chars (`askSummary`, nax v0.83.2 `src/tools/ask-request.ts:38-51`: "Mask the FULL line, then cut"), and it may span several lines because it embeds the command. The runner does not strip it from `rawDetail`; the parsed payload simply has no field for it. Spec §1.2 and §4.3 are updated in Task 19. | Verified in source; the spec's "unmasked" claim came from the `summary` docstring in `permissions/types.ts`, which describes a different field. |
| D256 | `detail` parser: take `stage:`, `reason:`, `runs in:` from the last three lines (each single-line); the head before them must start with a fence line. Split candidates are every `\n` + fence + `\n` that is followed by an optional `N secret value(s) masked; ...` line and then `request: `. Let `recon` = `` `${tool} command=${command}` `` (`tool` = request text up to its first space). A candidate is **consistent** when the request text is shorter than 200 chars and equals `recon.trim()` exactly, or is exactly 200 chars and `recon` starts with it (nax cut it). Exactly one consistent candidate gives a parsed ask; zero or several, a command-less detail, or a missing tail line give an unparsed ask (`rawDetail`). Exact equality makes a fake split impossible unless nax itself cut the summary. An unparsed detail with no fence whose `request:` text is 200+ chars is flagged `commandTruncated` (a cut Write/Edit path must not be approvable). | Fixture (c) shows a command may contain fences and the request text repeats the command over several lines; a crafted command could fake a second split, and ambiguity must never pick one silently. |
| D257 | `deadlineAt = createdAt + timeout` from nax's request (both ms). nax starts its own timer later (after its POST returns), so koda's deadline is never later than nax's. | The conservative direction: koda may expire an ask nax would still accept, never the reverse. |
| D258 | The runner reports `approvals: { relay: true }` only when nax's version parses at least **0.83.0** (first release with `allow-remember` gated on a remember sink, #2252; the escalate out-of-bounds refusal #2250 is in 0.82.2). The runner's existing floor `MIN_NAX_VERSION = 0.83.1` is already above it, so in practice every probing runner reports it; the check documents the floor. **Static capability mode never offers the relay** (`runner-config.ts` `parseCapabilities` keeps only the six S1 keys): fail-closed, accepted for 2a. | Spec §8 "to verify in the 2a plan"; verified across tags v0.82.0..v0.83.2 and main `a755a5464`. |
| D259 | `detail` format is identical in released v0.83.2 (`bcfcddb01`) and nax main (`a755a5464`): the builder (`interaction/ask-link-session.ts:163-202`), `InteractionRequest`, the webhook POST, callback server and response schema differ only in import paths. Fixtures are captured from both and are byte-identical. | Spec §8 "to verify in the 2a plan". Note: `c6ab5d52c` (cited in the spec as 0.83.2) is 151 commits after the tag; the spec line is corrected in Task 19. |
| D260 | `ApprovalActor.type` widens to `'USER' \| 'SYSTEM' \| 'RUNNER'`. A runner-raised ask is recorded as `{ type: 'RUNNER', id: runnerId, responsibleUserId: job.requestedById }`; job-end and timeout closes use `jobSystemActor(job)` = `{ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: job.requestedById }`. | `FleetActorType` already has RUNNER; activity needs a responsible user. |
| D261 | An ask born closed (job not RUNNING or `raw`: `cancelled`/`job_ended`; deadline already past: `expired`/`timeout`) gets one activity row and a live event, but **no webhook**. | Nobody can act on it; a requested+resolved webhook pair for a dead ask is noise. |
| D262 | `recordResolved` maps `expired` to activity `approval.expired` (spec §2.5); `cancelled` stays `approval.cancelled`. | 1a mapped both to `approval.cancelled`; no `expired` row existed before 2a. |
| D263 | `JobTransitionsService.apply` calls `ApprovalCloser.closeForJob` and withdraws unacked `APPROVAL_ANSWER` commands whenever `before.state === 'RUNNING' && after.state !== 'RUNNING'`. A new repository filter `withdrawPendingCommands(jobId, now, { types })` withdraws only that type, because RUNNING -> UPLOADING must not withdraw anything else. | Every exit from RUNNING (UPLOADING, runner CANCELLED, server CRASHED) goes through `apply` (`record` is also called by placement for ASSIGN, so it stays unchanged); a requeue starts from a terminal state, already closed. |
| D264 | `JobTransitionsService.apply` returns `approvalLive: LiveFleetApprovalEvent[]` beside `live`. Publishers: `SyncService` (report outcomes and acks) and `FleetSweeper`. The other `apply` callers never move a job out of RUNNING and ignore the field. | The bus has no after-commit hook; live events are built in the transaction and published after it, as everywhere else. |
| D265 | Bash decide is one transaction that returns a discriminated result; when the approval turns out expired (or its job left RUNNING), the transaction resolves it and **commits**, and the 409 is thrown after commit. | A throw inside `txManager.run` rolls back, which would leave the expired row pending. |
| D266 | Bash decide permission: admin route, or project role `ADMIN` or `DEVELOPER` (`mayDecideBash`). | Spec §1.7, A6. |
| D267 | `allow` and `allow_for_job` are refused (400 `fleet.approvalDecisionInvalid`) when `payload.commandTruncated` is true; the runner sets that flag when either `command` or `rawDetail` was cut. `allow_for_job` also needs `allow-remember` in `payload.options`. | Spec §1.3; a human never approves text they could not see. |
| D268 | `APPROVAL_ANSWER` acks store `outcome.delivery`; no live event (not a status change) and no job transition. A stale-fence ack is acked `stale` like every other command. | Spec §3; live events are for status changes (§2.5). |
| D269 | A malformed `approval_request` payload goes down the existing `job.event_rejected` path (warn + activity, event acked). nax then times out and denies. | Same contract as every other bad event; the sync is not rejected. |
| D270 | Placement: `PlacementJob.bashMode`; `capabilityMisfit` returns `approvals_relay` first when `bashMode !== 'raw'` and the runner lacks `approvals.relay`. It is in `PERMANENT_MISFITS` (pinned dispatch 422). | Spec §3; success criterion 5. |
| D271 | `parseCapabilitiesCore` accepts `approvals` only as exactly `{ relay: true }` (anything else fails `approvals`, like every other capability field) and returns it only when present. | Capabilities are strict everywhere else; a silent drop would hide a runner bug. |
| D272 | `FleetJobDto` gains `approvalTimeoutSec` and `pendingApprovals`. List pages run one grouped count over the page's job ids (`countPendingByJob`); `get`, `cancel` and `requeue` count one id; `dispatch` returns 0. `FleetJobDto.from(r, pendingApprovals = 0)`. | Spec §1.6; the `sumCostBySchedule` pattern. |
| D273 | Runner: `HostExecutor.prepare` opens the relay (before `writeJobProfile`, which needs its port and secret) for non-raw jobs; `cleanup` closes it; `JobExecutor.resumeApprovals(job)` re-binds it on a READOPT `watch`, next to `resumeCredentials`. A failed re-bind is a lifecycle `error` and the run is still watched (asks then time out and deny). | Spec §4.1, §4.5; mirrors D90 for credentials. |
| D274 | The receiver accepts a request only when `callbackUrl` is exactly `http://127.0.0.1:<port>/nax/interact/<id>` with `<id>` (any characters except `/?#` and whitespace, at most 200; nax does not URL-encode ids, and story-derived ids such as `ix-US-001-size-gate` must pass) equal to the request `id`; otherwise 400 (nax's POST fails, so nax denies). | The runner POSTs a signed answer to that URL; it must never be steered elsewhere. |
| D275 | Profile overlay: `execution.bashApproval`, `execution.approvalTimeout` (ms), `interaction.plugin = "webhook"`, `interaction.config = { url, secret, requireSecret: true, callbackPort: 0 }`, `interaction.triggers` with the nine `TriggerName`s set to `false`. | Spec §4.1, A1; `interaction.config` deep-merges key-wise over the repo's config, so `callbackPort: 0` overrides a repo-pinned port. |
| D276 | `APPROVAL_ANSWER` is handled inline in the command loop with a 10 s callback deadline. nax asks serially per run, so there is at most one answer per job in flight; a slow nax callback delays that sync's other commands by at most 10 s per answering job. Known window: if the daemon dies after nax accepted the POST but before the command is recorded, the re-sent command acks `ask_not_pending` and the approval shows delivery `rejected` although nax got the answer (never an allow nax did not get). | Accepted; no queueing machinery for one rare command. |
| D277 | **Spec amendment (A1):** two nax prompts are not trigger-guarded and fire whenever a chain exists (nax v0.83.2 `precheck-runner.ts:139` story-size gate, `run-setup-init.ts:227` paused stories). Headless runs today never prompt (flagged stories run; paused stories stay paused). To keep that, a non-approval request is answered at once on its callback, with a lifecycle `info`: id `^ix-.+-size-gate$` -> `{ action: "approve" }`; id `^ix-.+-paused-resume$` -> `{ action: "choose", value: "keep" }`; anything else (a trigger, which A1 disables, or an unverified ACP-bridge/auth prompt) -> `{ action: "skip" }` with a lifecycle `warn`. The receiver returns 200. | Verified in source; the spec's blanket `skip` would permanently skip paused stories and silently skip flagged ones. |
| D278 | Journal tables `approval_receivers (job_id, lease_epoch, port, secret, created_at)` PK `(job_id, lease_epoch)` and `pending_asks (job_id, lease_epoch, nax_ask_id, callback_url, deadline_at, created_at)` PK `(job_id, lease_epoch, nax_ask_id)`. Daemon start deletes rows of jobs that are not active. | Spec §4.1, §4.5; the journal file is already mode 0600 (SEC-1). |
| D279 | The schedule template gains `bashMode` and `approvalTimeoutSec`, validated through `normalizeDispatch` (RUN), copied by `toDispatchDto`. | Spec §1.6. |
| D280 | CLI `koda fleet approval decide` accepts `allow`, `allow_for_job`, `deny` too; `show` prints the bash payload fields (command, root, stage, story, reason, rule, options, `rawDetail` when unparsed). | Spec §2.5; the CLI is the only decide surface until 2b. |
| D281 | Web in 2a: `MisfitReason` gets `approvals_relay` (types, en/zh labels, parity list) and `fleet-types.ts` widens `bashMode` and adds `approvalTimeoutSec` and `pendingApprovals`. No new UI. | The misfit parity spec and type-check need them; the panel is 2b. |
| D284 | The relay secret sits in the 0600 job profile and the 0600 journal; anything running as the runner user (including the agent's own granted Bash) could read it and the pending ask id and forge an answer. Accepted: the runner user is the trust boundary for every runner secret already (git credentials, API key). | Threat-model note; no mitigation in 2a. |
| D285 | Relay state is **per (jobId, leaseEpoch)** everywhere: `close(jobId, leaseEpoch)`, `deleteApprovalState(jobId, leaseEpoch)`, journal `abandon`/`prune` per epoch, and a new `JobExecutor.releaseApprovals(job)` called in `JobRun.abandonCleanup` next to `releaseCredentials` (before the higher-epoch early return). | A stale epoch's abandon must not kill a live requeued epoch's receiver (mirrors D90 credentials). |
| D286 | `ApprovalRelay.open` on a re-prepare re-binds the stored port; if that port is taken it binds a fresh port and secret and overwrites the row (nax was not spawned yet, so nothing holds the old address). Only `resume` (a live nax) must keep the stored port. `insertPendingAsk` returns whether it inserted; a re-sent nax POST appends no second event. | Review findings: a reprepare must not fail the job on EADDRINUSE; no duplicate events. |
| D287 | No CLI `--bash-mode` / `--approval-timeout` on `koda fleet dispatch` or `schedule` in 2a: a gated/escalate job is dispatched over the API (or the 2b web form). `decide` refuses `amountUsd`/`requeueJobIds` on a bash approval (400 `fleet.approvalInput`). | Keeps 2a scope; budget-only fields must not be silently ignored. |
| D282 | The fake nax gains an `ask` scenario (a separate fixture module) that POSTs a real-shaped, signed ask to the profile's webhook URL, serves its own signed callback, records the answer to `<outputDir>/fake-ask.json`, and then completes. | Spec §7 runner integration; lets the real-API world prove the whole loop. |
| D283 | The ask payload has **no `rule`** field: nax prints `reason: ${req.reason ?? req.rule}` on one line, so the two cannot be told apart. `storyId` and `featureName` come from nax's top-level request fields; `stage` comes from the detail's `stage:` line (nax's real policy stage; the top-level field defaults to `execution`), falling back to the top-level field when unparsed; `root`, `reason`, `maskedCount` and the command come from `detail`. Spec §1.2, §3 and §5 are updated in Task 19. | Verified in `ask-link-session.ts:181-193`; the top-level fields are typed, the text is not. |

## Review Focus

1. A command containing a fence and a fake `request: Bash command=` line: the parser returns unparsed (raw) rather
   than a wrong command, and a decide `allow` still works on the raw text only when it was not cut. (Task 13 "spoofed
   split".)
2. A decide that races the expiry sweeper or the job leaving RUNNING: exactly one terminal status, a late decide gets
   409 and leaves the row `expired` / `job_ended` (not pending). (Task 8 "expired at decide commits".)
3. Daemon restart while an ask is pending: after READOPT the same port and secret answer, and the decision reaches
   nax; if the port is taken, a lifecycle error and nax's timeout deny. (Task 16 "resume re-binds".)
4. An `APPROVAL_ANSWER` re-sent after the runner already answered (ack lost): acked from the applied-command record,
   nax is not POSTed twice. (Task 17 "re-sent answer".)
5. A non-raw dispatch pinned to a runner without the relay is 422 `approvals_relay`; an unpinned one waits QUEUED with
   that misfit rather than running raw. (Task 3 "pinned 422" and Task 11 "unpinned waits".)
6. A relayed run whose PRD has a size-flagged or a paused story: the story runs (flagged) or stays paused (paused)
   exactly as a headless run does, never silently skipped (D277). (Task 15 "size gate and paused prompts".)

## File Map

**packages/fleet-protocol**
- Modify `src/index.ts`: version 2, `BashMode`, `RunnerCapabilities.approvals`, `approval_request` event and payload,
  `APPROVAL_ANSWER` command and payload, `AssignPayload` fields, `APPROVAL_*` caps.

**apps/api**
- Modify `src/fleet/common/protocol.ts` (+spec): supported `[1, 2]`, local cap constants.
- Modify `src/fleet/common/capabilities-core.ts` (+spec): `approvals`.
- Modify `src/common/enums.ts`: `FleetCommandType.APPROVAL_ANSWER`.
- Modify `prisma/schema.prisma`; create `prisma/migrations/20261003150000_fleet_approval_relay/migration.sql`.
- Modify jobs: `domain/fleet-job.domain.ts`, `dispatch-input.ts`, `assign-payload.ts`, `dto/dispatch-fleet-job.dto.ts`,
  `dto/fleet-job.dto.ts`, `placement-rules.ts`, `placement.service.ts`, `fleet-jobs.service.ts`,
  `prisma-fleet-job.repository.ts`, `job-transitions.service.ts`, `fleet-jobs.module.ts`.
- Modify schedules: `domain/schedule.domain.ts`, `dto/*.ts`, `schedules.service.ts`, `schedule-template.ts`,
  `prisma-schedule.repository.ts`.
- Modify approvals: `domain/approval.domain.ts`, `prisma-approval.repository.ts`, `approval-closer.ts`,
  `approvals.service.ts`, `approvals.module.ts`; create `approval-expiry-sweeper.ts`, `bash-decision.ts`.
- Modify sync: `sync-request.parser.ts`, `event-payloads.ts`, `job-report.processor.ts`, `command-ack.processor.ts`,
  `sync.service.ts`, `fleet-sweeper.ts`, `sync.module.ts`; create `approval-request-payload.ts`.
- Tests: unit specs beside each file; integration `test/integration/fleet/fleet-approval-relay.integration.spec.ts`.

**apps/cli**: modify `src/commands/fleet-approval.ts` (+spec).

**apps/web**: modify `lib/fleet-types.ts`, `i18n/locales/{en,zh}.json`, `tests/i18n/fleet-locale-parity.spec.ts`.

**apps/runner**
- Modify `src/supervisor/assign-parser.ts`, `src/capabilities/nax-probe.ts`, `src/executor/job-profile.ts`,
  `src/executor/host-executor.ts`, `src/executor/job-executor.ts`, `src/supervisor/job-run.ts`,
  `src/supervisor/job-events.ts`, `src/supervisor/command-handler.ts`, `src/journal/{schema,journal,types}.ts`,
  `src/daemon/daemon.ts`, `test/helpers/{assign,fake-executor}.ts`.
- Create `src/approvals/detail-parser.ts`, `src/approvals/ask-payload.ts`, `src/approvals/approval-receiver.ts`,
  `src/approvals/nax-callback.ts`, `src/approvals/approval-relay.ts`, `src/approvals/nax-triggers.ts` (each with a spec),
  `test/fixtures/nax-asks/*.json`, `test/fixtures/fake-nax-ask.ts`,
  `test/integration/approval-relay.integration.spec.ts`.

---

### Task 1: Protocol v2 types, supported versions, capability and command enum

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts`
- Modify: `apps/api/src/fleet/common/protocol.ts:38-46`
- Modify: `apps/api/src/fleet/common/protocol.spec.ts`
- Modify: `apps/api/src/fleet/common/capabilities-core.ts:79-110`
- Modify: `apps/api/src/fleet/common/capabilities.spec.ts` (the `parseCapabilitiesCore` describe at the bottom; its
  valid fixture is named `valid`)
- Modify: `apps/api/src/common/enums.ts:139` (`FleetCommandType`)
- Modify: `apps/api/prisma/schema.prisma` (`FleetCommand.type` comment only)

**Interfaces:**
- Produces (package, used by every later task):
  - `FLEET_PROTOCOL_VERSION = 2`
  - `type BashMode = 'raw' | 'gated' | 'escalate'`
  - `type ApprovalOption = 'allow' | 'allow-remember' | 'deny'`
  - `const APPROVAL_TEXT_MAX_BYTES = 12_288`
  - `interface ApprovalRequestEventPayload { naxAskId: string; deadlineAt: string; command: string; commandTruncated: boolean; maskedCount: number; root: string; stage: string; storyId: string | null; featureName: string; reason: string; options: ApprovalOption[]; rawDetail?: string }`
  - `interface ApprovalAnswerPayload { approvalId: string; naxAskId: string; choice: ApprovalOption }`
  - `RunnerCapabilities.approvals?: { relay: true }`
  - `RunnerEventType` gains `'approval_request'`; `FleetCommandTypeName` gains `'APPROVAL_ANSWER'`.
- Produces (API): `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2]`, `APPROVAL_TEXT_MAX_BYTES`,
  `DEFAULT_APPROVAL_TIMEOUT_SEC = 600`, `FleetCommandType.APPROVAL_ANSWER`.
- Note: `AssignPayload` changes in Task 2, together with both of its parsers.

- [ ] **Step 1: Write the failing API tests**

In `apps/api/src/fleet/common/protocol.spec.ts`, change the `isSupportedProtocolVersion` table and the command parity
record, and add the cap parity test:

```ts
import { APPROVAL_TEXT_MAX_BYTES as PACKAGE_APPROVAL_TEXT_MAX_BYTES } from '@nathapp/fleet-protocol';
import { APPROVAL_TEXT_MAX_BYTES, DEFAULT_APPROVAL_TIMEOUT_SEC } from './protocol';

it.each([[1, true], [2, true], [0, false], [3, false], ['2', false], [1.5, false], [undefined, false]])(
  'isSupportedProtocolVersion(%p) is %p', (value, expected) => {
    expect(isSupportedProtocolVersion(value)).toBe(expected);
  },
);

it('keeps the local approval text cap equal to the package (the API image does not ship the package)', () => {
  expect(APPROVAL_TEXT_MAX_BYTES).toBe(PACKAGE_APPROVAL_TEXT_MAX_BYTES);
  expect(DEFAULT_APPROVAL_TIMEOUT_SEC).toBe(600);
});
```

and in the existing command parity block:

```ts
const commands: Record<FleetCommandTypeName, true> = { ASSIGN: true, CANCEL: true, READOPT: true, ABANDON: true, APPROVAL_ANSWER: true };
```

In the `parseCapabilitiesCore` spec add:

```ts
describe('approvals (S1.5 §3, plan D271)', () => {
  it('keeps { relay: true }', () => {
    expect(parseCapabilitiesCore({ ...valid, approvals: { relay: true } }).approvals).toEqual({ relay: true });
  });
  it('omits approvals when absent', () => {
    expect(parseCapabilitiesCore(valid)).not.toHaveProperty('approvals');
  });
  it.each([[{ relay: false }], [{ relay: 'yes' }], [{ relay: true, extra: 1 }], [true], [{}]])('refuses approvals %p', (approvals) => {
    expect(() => parseCapabilitiesCore({ ...valid, approvals })).toThrow(/approvals/);
  });
});
```


- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/common`
Expected: FAIL (`[2, true]` row, missing exports, `approvals` dropped, `APPROVAL_ANSWER` missing from the enum).

- [ ] **Step 3: Implement the package changes**

In `packages/fleet-protocol/src/index.ts`:

```ts
export const FLEET_PROTOCOL_VERSION = 2 as const;

/** S1.5 §1.6: `gated` and `escalate` relay nax bash asks to the approvals inbox (protocol v2 runners only). */
export type BashMode = 'raw' | 'gated' | 'escalate';
```

Add to `RunnerCapabilities` (after `executors`):

```ts
  /** S1.5 §3: present only when the runner hosts the nax approval relay (protocol v2, nax >= 0.83.0). */
  approvals?: { relay: true };
```

Replace the two unions:

```ts
export type FleetCommandTypeName = 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON' | 'APPROVAL_ANSWER';
export type RunnerEventType = 'state' | 'snapshot' | 'lifecycle' | 'log' | 'approval_request';
```

Add after `LogEventPayload`:

```ts
// ---- S1.5 slice 2a: approval relay (spec §3, §4) ----

/** The choices nax offers on a bash ask; `allow-remember` only when nax can remember it. */
export type ApprovalOption = 'allow' | 'allow-remember' | 'deny';

/** Cap for `command` and `rawDetail` (UTF-8 bytes); keeps the event under the 16 KiB sync payload limit. */
export const APPROVAL_TEXT_MAX_BYTES = 12_288;

/**
 * One nax bash ask, relayed by the runner (spec §1.2, plan D256/D283). `command` is nax's masked command; on a
 * detail the runner could not parse, `command` is '' and `rawDetail` holds nax's text. `commandTruncated` is true
 * when either text was cut to the cap; such an ask can only be denied.
 */
export interface ApprovalRequestEventPayload {
  /** nax's request id, `ask-<hex>`. */
  naxAskId: string;
  /** ISO time: nax's `createdAt + timeout` (plan D257). */
  deadlineAt: string;
  command: string;
  commandTruncated: boolean;
  maskedCount: number;
  root: string;
  stage: string;
  storyId: string | null;
  featureName: string;
  reason: string;
  options: ApprovalOption[];
  rawDetail?: string;
}

/** Server -> runner: the human's answer to one ask. */
export interface ApprovalAnswerPayload { approvalId: string; naxAskId: string; choice: ApprovalOption }
```

Widen `RunnerEvent.payload` to include `ApprovalRequestEventPayload`, and `FleetCommandOut.payload` to include
`ApprovalAnswerPayload`. Update the header comment line "Bump FLEET_PROTOCOL_VERSION ..." to add
"v2 (S1.5): approval relay."

- [ ] **Step 4: Implement the API side**

`apps/api/src/fleet/common/protocol.ts` (replace line 42 and add below the `isSupportedProtocolVersion` function):

```ts
export const SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1, 2]);
```

```ts
/** Mirror of the package's APPROVAL_TEXT_MAX_BYTES (protocol.spec pins them equal). */
export const APPROVAL_TEXT_MAX_BYTES = 12_288;
/** S1.5 §1.6, A3. */
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
export const MIN_APPROVAL_TIMEOUT_SEC = 30;
export const MAX_APPROVAL_TIMEOUT_SEC = 3600;
```

Also add `BashMode`, `ApprovalOption`, `ApprovalRequestEventPayload`, `ApprovalAnswerPayload` to the `export type {...}`
re-export block at the top of the file.

`apps/api/src/fleet/common/capabilities-core.ts`: add `approvals` to the destructure, validate it after `executors`, and
return it only when present:

```ts
  const { nax, sandbox, profiles, credentials, tools, executors, approvals } = raw;
  // ... existing checks ...
  // Plan D271: strict like every other field; only exactly { relay: true } is meaningful.
  if (approvals !== undefined && !(isObj(approvals) && approvals.relay === true && Object.keys(approvals).length === 1)) fail('approvals');
```

```ts
    executors: [...(executors as Array<'host'>)],
    ...(approvals !== undefined ? { approvals: { relay: true as const } } : {}),
```

`apps/api/src/common/enums.ts`:

```ts
export const FleetCommandType = {
  ASSIGN: 'ASSIGN', CANCEL: 'CANCEL', READOPT: 'READOPT', ABANDON: 'ABANDON',
  /** S1.5 §3: a human's answer to a relayed nax bash ask. */
  APPROVAL_ANSWER: 'APPROVAL_ANSWER',
} as const;
```

(the file declares this object on one line; keep it on one line with the new key). In `schema.prisma` change the
`FleetCommand.type` comment to `// ASSIGN | CANCEL | READOPT | ABANDON | APPROVAL_ANSWER`.

- [ ] **Step 5: Run the tests and both type-checks**

Run: `cd apps/api && bun run test:scoped src/fleet/common && bun run type-check`
Expected: PASS.
Run: `cd apps/runner && bun run type-check && bun run test`
Expected: the runner now sends `protocolVersion: 2`, so three specs that assert the literal `1` fail:
`src/sync/sync-loop.spec.ts:82`, `src/sync/batch.spec.ts:54`, `test/unit/daemon.spec.ts:92`. Change each to
`FLEET_PROTOCOL_VERSION` (imported from `@nathapp/fleet-protocol`), then PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/fleet-protocol/src/index.ts apps/api/src/fleet/common apps/api/src/common/enums.ts apps/api/prisma/schema.prisma apps/runner
git commit -m "feat(fleet): protocol v2 types for the approval relay (S1.5 2a)"
```

---

### Task 2: `bashMode` and `approvalTimeoutSec` through dispatch, the job row and ASSIGN

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`FleetJob` line ~759, `JobSchedule` 714-746)
- Create: `apps/api/prisma/migrations/20261003150000_fleet_approval_relay/migration.sql`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:36,95`
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:16-23` (`toJob`)
- Modify: `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts:16`
- Modify: `apps/api/src/fleet/jobs/dispatch-input.ts:24-41` (+ `dispatch-input.spec.ts`)
- Modify: `apps/api/src/fleet/jobs/assign-payload.ts:26-39` (+ its spec, or create `assign-payload.spec.ts`)
- Modify: `packages/fleet-protocol/src/index.ts` (`AssignPayload`)
- Modify: `apps/runner/src/supervisor/assign-parser.ts:52,69` (+ `assign-parser.spec.ts`)
- Modify: `apps/runner/test/helpers/assign.ts`, `apps/runner/src/journal/journal.spec.ts` (inline assign builder)
- Modify (fixtures that stop compiling once the fields are required; add `approvalTimeoutSec: 600` next to
  `bashMode: 'raw'`, and `bashMode: 'raw', approvalTimeoutSec: 600` to `ScheduleRecord`/`NewSchedule` literals in
  Task 4):
  - runner: `test/unit/checkout.spec.ts:29`, `test/unit/host-executor-auth.spec.ts:51`, `test/unit/job-check.spec.ts:41`,
    `test/unit/host-executor.spec.ts:34,223`, `src/executor/nax-process.spec.ts:13`, `src/sync/sync-loop.spec.ts:11`,
    `src/sync/batch.spec.ts:8`
  - API: `src/fleet/jobs/dispatch-input.spec.ts:12`, `src/fleet/jobs/dto/fleet-job.dto.spec.ts:9,29`,
    `src/fleet/jobs/job-transitions.service.spec.ts:7`, `test/integration/fleet/fleet-job-repository.integration.spec.ts:37`
  - CLI: `src/commands/fleet-job.spec.ts:37` (after Task 10 regenerates the client)
- Modify (assertions this task flips): `apps/api/test/integration/fleet/fleet-jobs.integration.spec.ts:71` row
  `['bashMode gated', ...]` expecting 400 -> use `bashMode: 'yolo'`; `apps/runner/src/supervisor/assign-parser.spec.ts:41`
  row `['bashMode gated' ...]` -> `bashMode: 'yolo'`; `dispatch-input.spec.ts` "fills defaults" exact `toEqual` gains
  `approvalTimeoutSec: 600`.

**Interfaces:**
- Consumes: `BashMode`, `DEFAULT_APPROVAL_TIMEOUT_SEC`, `MIN_/MAX_APPROVAL_TIMEOUT_SEC` (Task 1).
- Produces: `FleetJobRecord.bashMode: BashMode`, `FleetJobRecord.approvalTimeoutSec: number`, same on `NewFleetJob`;
  `AssignPayload.bashMode: BashMode`, `AssignPayload.approvalTimeoutSec: number`; DB columns
  `FleetJob.approvalTimeoutSec`, `JobSchedule.bashMode`, `JobSchedule.approvalTimeoutSec`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/fleet/jobs/dispatch-input.spec.ts`, add:

```ts
describe('bashMode and approvalTimeoutSec (S1.5 §1.6)', () => {
  const run = { repoId: 'r1', command: 'RUN' as const, feature: 'f', maxCostUsd: 5 };

  it('defaults to raw and 600 s', () => {
    expect(normalizeDispatch(run, 'main')).toEqual(expect.objectContaining({ bashMode: 'raw', approvalTimeoutSec: 600 }));
  });
  it.each(['gated', 'escalate'] as const)('keeps %s with its timeout for RUN', (bashMode) => {
    expect(normalizeDispatch({ ...run, bashMode, approvalTimeoutSec: 90 }, 'main'))
      .toEqual(expect.objectContaining({ bashMode, approvalTimeoutSec: 90 }));
  });
  it('refuses a non-raw PLAN', () => {
    expect(() => normalizeDispatch({ ...run, command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate' }, 'main'))
      .toThrow(expect.objectContaining({ args: { reason: 'bashMode must be raw for PLAN' } }));
  });
  it('stores the timeout of a raw job too (unused)', () => {
    expect(normalizeDispatch({ ...run, approvalTimeoutSec: 45 }, 'main').approvalTimeoutSec).toBe(45);
  });
});
```

(`AppException` exposes `args` and `prefix` getters.)

`apps/api/src/fleet/jobs/assign-payload.spec.ts` (create if absent; copy the job/repo fixture from the closest
existing assign test, e.g. in `placement.service.spec.ts`):

```ts
it('carries bashMode and approvalTimeoutSec from the job', () => {
  const payload = buildAssignPayload({ ...job, bashMode: 'escalate', approvalTimeoutSec: 120 }, repo, 'https://x/y.git', identity);
  expect(payload).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120 }));
});
```

DTO validation (no dispatch DTO spec exists; create `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.spec.ts` with
`import 'reflect-metadata'; import { plainToInstance } from 'class-transformer'; import { validate } from 'class-validator';`):

```ts
it.each([[29], [3601], [1.5]])('refuses approvalTimeoutSec %p', async (approvalTimeoutSec) => {
  const errors = await validate(plainToInstance(DispatchFleetJobDto, { repoId: 'r', command: 'RUN', feature: 'f', maxCostUsd: 1, approvalTimeoutSec }));
  expect(errors.map((e) => e.property)).toContain('approvalTimeoutSec');
});
it('refuses an unknown bashMode', async () => {
  const errors = await validate(plainToInstance(DispatchFleetJobDto, { repoId: 'r', command: 'RUN', feature: 'f', maxCostUsd: 1, bashMode: 'yolo' }));
  expect(errors.map((e) => e.property)).toContain('bashMode');
});
```

`apps/runner/src/supervisor/assign-parser.spec.ts`, add:

```ts
describe('bashMode and approvalTimeoutSec (S1.5 §4.1)', () => {
  test.each(['raw', 'gated', 'escalate'] as const)('accepts %s on RUN', (bashMode) => {
    const r = parseAssign(cmd(assignFor('RUN', { bashMode, approvalTimeoutSec: 90 })));
    expect(r.ok && r.assign.bashMode).toBe(bashMode);
    expect(r.ok && r.assign.approvalTimeoutSec).toBe(90);
  });
  test('refuses a non-raw PLAN', () => {
    expect(parseAssign(cmd(assignFor('PLAN', { bashMode: 'gated' })))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });
  test('refuses an unknown mode', () => {
    expect(parseAssign(cmd({ ...assignFor('RUN'), bashMode: 'yolo' } as never))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });
  test.each([29, 3601, 1.5, '60'])('refuses approvalTimeoutSec %p', (approvalTimeoutSec) => {
    expect(parseAssign(cmd({ ...assignFor('RUN'), approvalTimeoutSec } as never))).toEqual({ ok: false, detail: 'invalid approvalTimeoutSec' });
  });
  test('defaults a missing timeout to 600 (a server that predates the field)', () => {
    const { approvalTimeoutSec: _omit, ...legacy } = assignFor('RUN');
    const r = parseAssign(cmd(legacy as never));
    expect(r.ok && r.assign.approvalTimeoutSec).toBe(600);
  });
});
```

(`cmd(payload, over?)` is the spec's existing helper (`assign-parser.spec.ts:7`) that wraps a payload in a `FleetCommandOut`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/dispatch-input.spec.ts src/fleet/jobs/assign-payload.spec.ts`
Run: `cd apps/runner && bun test src/supervisor/assign-parser.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Schema and migration**

`schema.prisma`, `FleetJob`:

```prisma
  bashMode           String    @default("raw") // raw | gated | escalate (S1.5 §1.6); PLAN is always raw
  approvalTimeoutSec Int       @default(600) // S1.5 §1.6: 30..3600, used only when bashMode != raw
```

`JobSchedule` (template block, after `pinnedRunnerId`):

```prisma
  bashMode           String    @default("raw") // S1.5 §1.6, copied into each dispatched job
  approvalTimeoutSec Int       @default(600)
```

`apps/api/prisma/migrations/20261003150000_fleet_approval_relay/migration.sql`:

```sql
-- Fleet S1.5 slice 2a: approval relay fields (spec §1.6). FleetJob.bashMode already exists (S1, raw only).
ALTER TABLE "FleetJob" ADD COLUMN "approvalTimeoutSec" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "JobSchedule" ADD COLUMN "bashMode" TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE "JobSchedule" ADD COLUMN "approvalTimeoutSec" INTEGER NOT NULL DEFAULT 600;
```

Run `cd apps/api && bunx prisma generate`.

- [ ] **Step 4: Domain, repository, DTO, normalisation, ASSIGN**

`fleet-job.domain.ts` (import `type { BashMode } from '../../common/protocol'`):

```ts
  bashMode: BashMode;            // FleetJobRecord, line 36
  approvalTimeoutSec: number;
```

```ts
  bashMode: BashMode;            // NewFleetJob, line 95
  approvalTimeoutSec: number;
```

`prisma-fleet-job.repository.ts` `toJob`: add `bashMode: r.bashMode as BashMode,` to the returned object (the row
column is a plain string; every writer goes through `normalizeDispatch`).

`dispatch-fleet-job.dto.ts` (replace line 16):

```ts
  @ApiPropertyOptional({ enum: ['raw', 'gated', 'escalate'], default: 'raw', description: 'S1.5: gated/escalate relay bash asks to the approvals inbox. RUN only; needs a runner with the approval relay.' })
  @IsOptional() @IsIn(['raw', 'gated', 'escalate']) bashMode?: BashMode;

  @ApiPropertyOptional({ minimum: 30, maximum: 3600, default: 600, description: 'Seconds a bash ask waits for a decision before nax denies it. Used only when bashMode is not raw.' })
  @IsOptional() @IsInt() @Min(30) @Max(3600) approvalTimeoutSec?: number;
```

`dispatch-input.ts` (after the two `planFrom` checks; replace the hard-coded `bashMode: 'raw',` at line 41):

```ts
  const bashMode: BashMode = dto.bashMode ?? 'raw';
  if (dto.command === 'PLAN' && bashMode !== 'raw') fail('bashMode must be raw for PLAN');
```

```ts
    bashMode,
    approvalTimeoutSec: dto.approvalTimeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC,
```

`assign-payload.ts` (replace `bashMode: 'raw',`):

```ts
    bashMode: job.bashMode,
    approvalTimeoutSec: job.approvalTimeoutSec,
```

`packages/fleet-protocol/src/index.ts`, `AssignPayload`:

```ts
  bashMode: BashMode;
  /** S1.5 §1.6: seconds nax waits on a bash ask; 30..3600. Used only when bashMode is not raw. */
  approvalTimeoutSec: number;
```

- [ ] **Step 5: Runner parser and helpers**

`apps/runner/src/supervisor/assign-parser.ts` (replace line 52; add the constant near the top):

```ts
const BASH_MODES: readonly string[] = ['raw', 'gated', 'escalate'];
const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
```

```ts
  if (typeof p['bashMode'] !== 'string' || !BASH_MODES.includes(p['bashMode']) || (isPlan && p['bashMode'] !== 'raw')) return bad('bashMode');
  // A server that predates S1.5 2a sends no timeout; it also only sends raw jobs.
  const approvalTimeoutSec = p['approvalTimeoutSec'] ?? DEFAULT_APPROVAL_TIMEOUT_SEC;
  if (typeof approvalTimeoutSec !== 'number' || !Number.isInteger(approvalTimeoutSec) || approvalTimeoutSec < 30 || approvalTimeoutSec > 3600) return bad('approvalTimeoutSec');
```

and in the returned object replace `bashMode: 'raw',` with:

```ts
      bashMode: p['bashMode'] as BashMode,
      approvalTimeoutSec,
```

`apps/runner/test/helpers/assign.ts`: add `approvalTimeoutSec: 600,` after `bashMode: 'raw',`. Do the same in the
inline builder in `src/journal/journal.spec.ts`.

- [ ] **Step 6: Run the tests and type-checks**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs && bun run type-check`
Run: `cd apps/runner && bun run type-check && bun run test`
Expected: PASS. (`apps/web` and `apps/cli` compile against the regenerated client later, in Task 10.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/fleet/jobs packages/fleet-protocol/src/index.ts apps/runner
git commit -m "feat(fleet): bashMode and approvalTimeoutSec through dispatch and ASSIGN (S1.5 2a)"
```

---

### Task 3: Placement requires the relay for non-raw jobs

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts:5-23,47-64` (+ `placement-rules.spec.ts`)
- Modify: `apps/api/src/fleet/jobs/placement.service.ts:35` (`toPlacementJob`)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:86` (`PlacementMisfitDto.reason` enum)
- Modify: `apps/web/lib/fleet-types.ts:132-134`, `apps/web/i18n/locales/en.json` (`fleet.misfit`),
  `apps/web/i18n/locales/zh.json`, `apps/web/tests/i18n/fleet-locale-parity.spec.ts:21`

**Interfaces:**
- Consumes: `RunnerCapabilities.approvals` (Task 1), `FleetJobRecord.bashMode` (Task 2).
- Produces: `MisfitReason` member `'approvals_relay'` (permanent); `PlacementJob.bashMode: BashMode`.

- [ ] **Step 1: Write the failing tests**

`placement-rules.spec.ts` (its `caps`, `runner`, `job` are factories taking overrides; `misfit(j, r)` wraps
`firstMisfit`). First add `bashMode: 'raw'` to the `job()` factory defaults (the field is now required). Then:

```ts
describe('approvals relay (S1.5 §3, plan D270)', () => {
  it.each(['gated', 'escalate'] as const)('a %s job needs a relay runner', (bashMode) => {
    expect(misfit(job({ bashMode }), runner())).toBe('approvals_relay');
    expect(misfit(job({ bashMode }), runner({ capabilities: caps({ approvals: { relay: true } }) }))).toBeNull();
  });
  it('a raw job does not care', () => {
    expect(misfit(job({ bashMode: 'raw' }), runner())).toBeNull();
  });
  it('is checked before tool misfits', () => {
    expect(misfit(job({ bashMode: 'escalate' }), runner({ capabilities: caps({ tools: { git: false, gh: false, glab: false } }) }))).toBe('approvals_relay');
  });
  it('is permanent (a pinned dispatch is refused)', () => {
    expect(PERMANENT_MISFITS.has('approvals_relay')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`placement-rules.ts`:

```ts
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'approvals_relay' | 'busy_repo' | 'capacity';
```

Add `'approvals_relay'` to `PERMANENT_MISFITS`. Add `bashMode: BashMode;` to `PlacementJob`. First lines of
`capabilityMisfit`:

```ts
  // Plan D270: a gated/escalate job on a runner without the relay would have every ask denied (A7), so never place it.
  if (job.bashMode !== 'raw' && caps.approvals?.relay !== true) return 'approvals_relay';
```

`placement.service.ts:35` `toPlacementJob(job: Pick<FleetJobRecord, ...>, ...)`: add `'bashMode'` to the `Pick` list
and `bashMode: job.bashMode,` to the returned object.

`fleet-job.dto.ts:86`: add `'approvals_relay'` to the literal enum array, in the same position as the union.

Web:
- `apps/web/lib/fleet-types.ts`: add `'approvals_relay'` to the misfit union.
- `en.json` `fleet.misfit`: `"approvals_relay": "The runner cannot relay bash approvals (needs protocol v2 and nax 0.83 or later)"`.
- `zh.json` `fleet.misfit`: `"approvals_relay": "该运行器无法转发 bash 审批（需要协议 v2 和 nax 0.83 或更高版本）"`.
- `fleet-locale-parity.spec.ts:21`: add `'approvals_relay'` to the `'fleet.misfit'` key list.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs && bun run type-check`
Run: `cd apps/web && bun run test -- tests/i18n/fleet-locale-parity.spec.ts`
Expected: PASS. (`openapi.json` is regenerated once, in Task 10; `fleet-openapi.contract.spec.ts` is run there.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/jobs apps/web/lib/fleet-types.ts apps/web/i18n apps/web/tests/i18n
git commit -m "feat(fleet): placement requires the approval relay for gated/escalate jobs (S1.5 2a)"
```

---

### Task 4: Schedule templates carry `bashMode` and `approvalTimeoutSec`

**Files:**
- Modify: `apps/api/src/fleet/schedules/domain/schedule.domain.ts:15-55`
- Modify: `apps/api/src/fleet/schedules/prisma-schedule.repository.ts:12` (row mapping)
- Modify: `apps/api/src/fleet/schedules/dto/create-schedule.dto.ts`, `update-schedule.dto.ts`, `schedule.dto.ts`
- Modify: `apps/api/src/fleet/schedules/schedules.service.ts:22-44,80-118,159-184`
- Modify: `apps/api/src/fleet/schedules/schedule-template.ts:4-21` (+ its spec)
- Test: `apps/api/src/fleet/schedules/schedules.service.spec.ts`, `schedule-template.spec.ts`
- Modify (fixtures): every `ScheduleRecord` literal in `schedule-ticker.spec.ts`, `schedule-progress.service.spec.ts`,
  `schedules.service.spec.ts` gains `bashMode: 'raw', approvalTimeoutSec: 600`

**Interfaces:**
- Consumes: `normalizeDispatch` bash rules (Task 2).
- Produces: `ScheduleRecord.bashMode: BashMode`, `ScheduleRecord.approvalTimeoutSec: number`, both in `NewSchedule`,
  `SchedulePatch`, `ScheduleTemplate`, `ScheduleDto`.

- [ ] **Step 1: Write the failing tests**

`schedule-template.spec.ts` (it has no shared template; its existing exact `toEqual` cases gain
`bashMode: 'raw', approvalTimeoutSec: 600` on both sides):

```ts
it('copies bashMode and approvalTimeoutSec into the dispatch (S1.5 §1.6)', () => {
  const template = { repoId: 'r1', feature: 'f', ref: null, profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null,
    bashMode: 'escalate' as const, approvalTimeoutSec: 300 };
  expect(toDispatchDto(template)).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 300 }));
});
```

(If `ScheduleTemplate.ref` is `string` rather than `string | null`, use `'main'`.)

`schedules.service.spec.ts` (reuse the spec's create fixture and repo fake):

```ts
it('stores bashMode and approvalTimeoutSec, defaulting to raw and 600', async () => {
  await service.create(actor, projectId, { ...createDto });
  expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ bashMode: 'raw', approvalTimeoutSec: 600 }));
  await service.create(actor, projectId, { ...createDto, name: 'b', bashMode: 'gated', approvalTimeoutSec: 120 });
  expect(repo.create).toHaveBeenLastCalledWith(expect.objectContaining({ bashMode: 'gated', approvalTimeoutSec: 120 }));
});
it('keeps the stored mode on an update that omits it', async () => {
  repo.lockById.mockResolvedValue({ ...stored, bashMode: 'escalate', approvalTimeoutSec: 90 });   // update reads under lockById
  await service.update(actor, projectId, stored.id, { name: 'renamed' }, true, NOW);   // (actorId, projectId, id, dto, canAdminister, now)
  expect(repo.update).toHaveBeenCalledWith(stored.id, expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 90 }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `schedule.domain.ts`: add `bashMode: BashMode; approvalTimeoutSec: number;` to `ScheduleRecord`; add both keys to
  the `NewSchedule` and `SchedulePatch` `Pick` lists.
- `prisma-schedule.repository.ts` row mapping: `bashMode: r.bashMode as BashMode,` (Int passes through).
- `create-schedule.dto.ts` and `update-schedule.dto.ts`: the same two properties and decorators as
  `DispatchFleetJobDto` (Task 2 Step 4); on the update DTO wrap each in the file's `@ValidateIf(whenProvided)`.
- `schedule.dto.ts`: `@ApiProperty({ enum: ['raw', 'gated', 'escalate'] }) declare bashMode: BashMode;` and
  `@ApiProperty() declare approvalTimeoutSec: number;`, mapped in `from`.
- `schedules.service.ts`: add `bashMode?: BashMode; approvalTimeoutSec?: number;` to `TemplateInput` and the required
  forms to `CheckedTemplate`. In `checkTemplate`, pass both into `normalizeDispatch` and return
  `bashMode: normalized.bashMode, approvalTimeoutSec: normalized.approvalTimeoutSec`. In `update`, fill omitted values
  from `current` (`bashMode: dto.bashMode ?? current.bashMode`, `approvalTimeoutSec: dto.approvalTimeoutSec ?? current.approvalTimeoutSec`),
  exactly as it already does for `maxCostUsd`. `create` and `update` write both keys.
- `schedule-template.ts`: add `'bashMode' | 'approvalTimeoutSec'` to `ScheduleTemplate` and to the returned dispatch:

```ts
    bashMode: template.bashMode,
    approvalTimeoutSec: template.approvalTimeoutSec,
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/schedules && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/schedules
git commit -m "feat(fleet): schedule templates carry bashMode and approvalTimeoutSec (S1.5 2a)"
```

---

### Task 5: Approval store — job-keyed repository methods and `ApprovalCloser` bash methods

**Files:**
- Modify: `apps/api/src/fleet/approvals/domain/approval.domain.ts:87-103`
- Modify: `apps/api/src/fleet/approvals/prisma-approval.repository.ts`
- Modify: `apps/api/src/fleet/approvals/approval-closer.ts`
- Test: `apps/api/src/fleet/approvals/approval-closer.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-approval-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetJobRecord` (type only, from `../jobs/domain/fleet-job.domain`).
- Produces (repository, `IApprovalRepository`):
  - `findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetApprovalRecord | null>`
  - `findPendingForJob(jobId: string): Promise<FleetApprovalRecord[]>` (bash, pending, oldest first)
  - `findExpiredPending(now: Date, limit: number): Promise<FleetApprovalRecord[]>` (bash, pending, `expiresAt <= now`, soonest first)
  - `countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>>`
- Produces (closer):
  - `type BashJob = Pick<FleetJobRecord, 'id' | 'projectId' | 'leaseEpoch' | 'state' | 'bashMode' | 'approvalTimeoutSec' | 'requestedById'>`
  - `interface BashAsk { naxAskId: string; deadlineAt: Date; payload: Record<string, unknown> }`
  - `openBash(job: BashJob, ask: BashAsk, runnerId: string, now: Date): Promise<ApprovalChange>` (idempotent on `(jobId, leaseEpoch, naxAskId)`)
  - `closeForJob(job: Pick<FleetJobRecord, 'id' | 'requestedById'>, now: Date): Promise<LiveFleetApprovalEvent[]>`
  - `expire(approval: FleetApprovalRecord, job: Pick<FleetJobRecord, 'requestedById'>, now: Date): Promise<ApprovalChange>`
  - `runnerActor(runnerId, job)`, `jobSystemActor(job)`; `ApprovalActor.type` gains `'RUNNER'`.
  - `recordResolved` now writes `approval.expired` for an expired approval (D262).
- Callers hold the job row lock (lock order job -> approval) and publish the returned live events after commit.

- [ ] **Step 1: Write the failing closer tests**

Add to `approval-closer.spec.ts`. Its `fakes()` returns `{ closer, repo, activity, webhooks, rows }` per test; extend
the in-memory repo inside `fakes()` with `findByAsk(jobId, epoch, askId)` and `findPendingForJob(jobId)` (both read
`rows`), make `create` store `status: 'pending'` plus the given fields, and make `lockById` return the stored row:

```ts
describe('bash (S1.5 2a)', () => {
  let closer!: ReturnType<typeof fakes>['closer'];
  let repo!: ReturnType<typeof fakes>['repo'];
  let activity!: ReturnType<typeof fakes>['activity'];
  let webhooks!: ReturnType<typeof fakes>['webhooks'];
  let rows!: ReturnType<typeof fakes>['rows'];
  beforeEach(() => { ({ closer, repo, activity, webhooks, rows } = fakes()); });
  const job = { id: 'j1', projectId: 'p1', leaseEpoch: 2, state: 'RUNNING', bashMode: 'escalate', approvalTimeoutSec: 600, requestedById: 'u9' } as const;
  const ask = (over: Partial<{ naxAskId: string; deadlineAt: Date }> = {}) => ({
    naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date(NOW.getTime() + 300_000), payload: { command: 'bun run test' }, ...over,
  });

  it('opens a pending ask expiring at the earlier of nax deadline and job timeout, with requested activity and webhook', async () => {
    const { approval, live } = await closer.openBash(job, ask(), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({
      type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: 2, naxAskId: 'ask-1f2e3d4c',
      policyId: null, expiresAt: new Date(NOW.getTime() + 300_000),
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'RUNNER', actorId: 'r1', responsibleUserId: 'u9', action: 'approval.requested' }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.anything());
    expect(live).toHaveLength(1);
  });

  it('caps expiresAt at requestedAt + approvalTimeoutSec', async () => {
    const { approval } = await closer.openBash({ ...job, approvalTimeoutSec: 60 }, ask(), 'r1', NOW);
    expect(approval?.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('is idempotent on (jobId, leaseEpoch, naxAskId)', async () => {
    const first = await closer.openBash(job, ask(), 'r1', NOW);
    const again = await closer.openBash(job, ask(), 'r1', NOW);
    expect(again.approval?.id).toBe(first.approval?.id);
    expect(again.live).toEqual([]);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ state: 'UPLOADING' }, 'cancelled', 'job_ended'],
    [{ bashMode: 'raw' }, 'cancelled', 'job_ended'],
  ] as const)('a job %p gives a born-closed ask %s/%s without a webhook (D261)', async (over, status, resolvedBy) => {
    const { approval } = await closer.openBash({ ...job, ...over }, ask(), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({ status, resolvedBy }));
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledTimes(1);
  });

  it('a deadline already past gives expired/timeout', async () => {
    const { approval } = await closer.openBash(job, ask({ deadlineAt: new Date(NOW.getTime() - 1) }), 'r1', NOW);
    expect(approval).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.expired' }));
  });

  it('closeForJob cancels every pending ask of the job with job_ended and a resolved webhook', async () => {
    await closer.openBash(job, ask(), 'r1', NOW);
    await closer.openBash(job, ask({ naxAskId: 'ask-00000002' }), 'r1', NOW);
    webhooks.dispatch.mockClear();
    const live = await closer.closeForJob(job, NOW);
    expect(live).toHaveLength(2);
    expect([...rows.values()].every((r) => r.status === 'cancelled' && r.resolvedBy === 'job_ended')).toBe(true);
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.resolved', expect.anything());
  });

  it('expire marks expired/timeout with approval.expired activity (D262)', async () => {
    const { approval } = await closer.openBash(job, ask(), 'r1', NOW);
    const { approval: expired } = await closer.expire(approval!, job, NOW);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout', decidedAt: NOW }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: 'u9' }));
  });
});
```

(`NOW` is the spec's constant.)

- [ ] **Step 2: Write the failing repository integration tests**

Add to `fleet-approval-repository.integration.spec.ts` (it has `world.projectId`, a `job()` helper that creates a job
row, and `beforeEach` deletes; add `import type { NewFleetApproval } from '../../../src/fleet/approvals/domain/approval.domain';`):

```ts
describe('bash lookups (S1.5 2a)', () => {
  let projectId!: string;
  let jobId!: string;
  beforeEach(async () => { projectId = world.projectId; jobId = (await job()).id; });
  const bash = (over: Partial<NewFleetApproval> = {}): NewFleetApproval => ({
    type: 'nax_bash_escalate', projectId, policyId: null, jobId, leaseEpoch: 1, naxAskId: 'ask-a', payload: {},
    requestedAt: new Date('2026-10-04T10:00:00Z'), expiresAt: new Date('2026-10-04T10:10:00Z'), ...over,
  });

  it('finds by ask, lists pending for a job, finds expired, counts by job', async () => {
    const a = await repo.create(bash());
    await repo.create(bash({ naxAskId: 'ask-b', expiresAt: new Date('2026-10-04T10:01:00Z') }));
    const c = await repo.create(bash({ naxAskId: 'ask-c' }));
    await repo.resolve(c.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: new Date() });

    expect((await repo.findByAsk(jobId, 1, 'ask-a'))?.id).toBe(a.id);
    expect(await repo.findByAsk(jobId, 2, 'ask-a')).toBeNull();
    expect((await repo.findPendingForJob(jobId)).map((r) => r.naxAskId)).toEqual(['ask-a', 'ask-b']);
    expect((await repo.findExpiredPending(new Date('2026-10-04T10:05:00Z'), 10)).map((r) => r.naxAskId)).toEqual(['ask-b']);
    expect(await repo.countPendingByJob([jobId, 'nope'])).toEqual(new Map([[jobId, 2]]));
    expect(await repo.countPendingByJob([])).toEqual(new Map());
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approval-closer.spec.ts test/integration/fleet/fleet-approval-repository.integration.spec.ts`
Expected: FAIL (methods missing).

- [ ] **Step 4: Implement the repository**

`approval.domain.ts`, add to `IApprovalRepository`:

```ts
  /** S1.5 2a: re-reported asks are idempotent on (jobId, leaseEpoch, naxAskId). */
  findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetApprovalRecord | null>;
  /** Pending bash approvals of one job, oldest first. */
  findPendingForJob(jobId: string): Promise<FleetApprovalRecord[]>;
  /** Pending bash approvals whose expiresAt has passed, soonest first. */
  findExpiredPending(now: Date, limit: number): Promise<FleetApprovalRecord[]>;
  /** Pending approval count per job id; jobs with none are absent. */
  countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>>;
```

`prisma-approval.repository.ts` (the file's row mapper is `toApproval`, line 16):

```ts
  async findByAsk(jobId: string, leaseEpoch: number, naxAskId: string): Promise<FleetApprovalRecord | null> {
    const row = await this.db.fleetApproval.findUnique({ where: { jobId_leaseEpoch_naxAskId: { jobId, leaseEpoch, naxAskId } } });
    return row ? toApproval(row) : null;
  }

  async findPendingForJob(jobId: string): Promise<FleetApprovalRecord[]> {
    const rows = await this.db.fleetApproval.findMany({
      where: { jobId, status: 'pending', type: 'nax_bash_escalate' }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toApproval);
  }

  async findExpiredPending(now: Date, limit: number): Promise<FleetApprovalRecord[]> {
    const rows = await this.db.fleetApproval.findMany({
      where: { status: 'pending', type: 'nax_bash_escalate', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return rows.map(toApproval);
  }

  async countPendingByJob(jobIds: readonly string[]): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map();
    const groups = await this.db.fleetApproval.groupBy({
      by: ['jobId'], where: { status: 'pending', jobId: { in: [...jobIds] } }, _count: { _all: true },
    });
    return new Map(groups.filter((g) => g.jobId !== null).map((g) => [g.jobId as string, g._count._all]));
  }
```

- [ ] **Step 5: Implement the closer**

`approval-closer.ts` (add `import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';` — a type import,
so no module dependency):

```ts
export interface ApprovalActor { type: 'USER' | 'SYSTEM' | 'RUNNER'; id: string; responsibleUserId: string }

/** Plan D260: a runner-raised ask answers to the job's requester. */
export const runnerActor = (runnerId: string, job: Pick<FleetJobRecord, 'requestedById'>): ApprovalActor =>
  ({ type: 'RUNNER', id: runnerId, responsibleUserId: job.requestedById });
/** Plan D260: job-end and timeout closes answer to the job's requester. */
export const jobSystemActor = (job: Pick<FleetJobRecord, 'requestedById'>): ApprovalActor =>
  ({ type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: job.requestedById });

export type BashJob = Pick<FleetJobRecord, 'id' | 'projectId' | 'leaseEpoch' | 'state' | 'bashMode' | 'approvalTimeoutSec' | 'requestedById'>;
export interface BashAsk { naxAskId: string; deadlineAt: Date; payload: Record<string, unknown> }
```

Update the class comment to "budgets and jobs use to open and close approvals inside their own transactions. Budget
callers hold the BudgetPolicy lock, bash callers the FleetJob lock (lock order, spec §1.4)". Add the methods:

```ts
  /**
   * Spec §2.2: one approval per relayed ask. Born closed when the job is no longer RUNNING (or is raw) or the deadline
   * has passed; a born-closed ask gets its activity row and live event but no webhook (plan D261).
   */
  async openBash(job: BashJob, ask: BashAsk, runnerId: string, now: Date): Promise<ApprovalChange> {
    const existing = await this.repo.findByAsk(job.id, job.leaseEpoch, ask.naxAskId);
    if (existing) return { approval: existing, live: [] };
    const expiresAt = new Date(Math.min(ask.deadlineAt.getTime(), now.getTime() + job.approvalTimeoutSec * 1000));
    const created = await this.repo.create({
      type: 'nax_bash_escalate', projectId: job.projectId, policyId: null, jobId: job.id, leaseEpoch: job.leaseEpoch,
      naxAskId: ask.naxAskId, payload: ask.payload, requestedAt: now, expiresAt,
    });
    const actor = runnerActor(runnerId, job);
    const born = job.state !== 'RUNNING' || job.bashMode === 'raw'
      ? { status: 'cancelled' as const, resolvedBy: 'job_ended' as const }
      : expiresAt.getTime() <= now.getTime() ? { status: 'expired' as const, resolvedBy: 'timeout' as const } : null;
    if (!born) {
      await this.record(created, actor, 'approval.requested');
      await this.dispatch(created, 'fleet.approval.requested');
      return { approval: created, live: this.livePublisher.event(created) };
    }
    const closed = await this.repo.resolve(created.id, { ...born, decidedAt: now });
    await this.record(closed, actor, closedAction(closed));
    return { approval: closed, live: this.livePublisher.event(closed) };
  }

  /** Spec §1.4: the job left RUNNING, so nax has exited or is exiting; every pending ask of it is moot. */
  async closeForJob(job: Pick<FleetJobRecord, 'id' | 'requestedById'>, now: Date): Promise<LiveFleetApprovalEvent[]> {
    const live: LiveFleetApprovalEvent[] = [];
    for (const pending of await this.repo.findPendingForJob(job.id)) {
      const locked = await this.repo.lockById(pending.id);
      if (!locked || locked.status !== 'pending') continue;
      const closed = await this.repo.resolve(locked.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: now });
      live.push(...(await this.recordResolved(closed, jobSystemActor(job))));
    }
    return live;
  }

  /** Spec §2.4: nax has already denied by its own timeout. The caller re-checked `pending` under the lock. */
  async expire(approval: FleetApprovalRecord, job: Pick<FleetJobRecord, 'requestedById'>, now: Date): Promise<ApprovalChange> {
    const expired = await this.repo.resolve(approval.id, { status: 'expired', resolvedBy: 'timeout', decidedAt: now });
    return { approval: expired, live: await this.recordResolved(expired, jobSystemActor(job)) };
  }
```

Replace the action ternary in `recordResolved` with a module-level helper:

```ts
/** Plan D262: spec §2.5 activity actions for a closed approval. */
const closedAction = (a: Pick<FleetApprovalRecord, 'status'>): string =>
  a.status === 'expired' ? 'approval.expired' : a.status === 'cancelled' ? 'approval.cancelled' : 'approval.decided';
```

```ts
  async recordResolved(approval: FleetApprovalRecord, actor: ApprovalActor): Promise<LiveFleetApprovalEvent[]> {
    await this.record(approval, actor, closedAction(approval));
    await this.dispatch(approval, 'fleet.approval.resolved');
    return this.livePublisher.event(approval);
  }
```

- [ ] **Step 6: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals test/integration/fleet/fleet-approval-repository.integration.spec.ts && bun run type-check`
Expected: PASS (existing budget closer tests unchanged: no budget path produces `expired`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/approvals apps/api/test/integration/fleet/fleet-approval-repository.integration.spec.ts
git commit -m "feat(fleet): job-keyed approval store and closer for bash asks (S1.5 2a)"
```

---

### Task 6: The `approval_request` event opens an approval in the report transaction

**Files:**
- Create: `apps/api/src/fleet/sync/approval-request-payload.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/fleet/sync/sync-request.parser.ts:5` (`EVENT_TYPES`)
- Modify: `apps/api/src/fleet/sync/event-payloads.ts:4-8,89-108` (+ spec)
- Modify: `apps/api/src/fleet/sync/job-report.processor.ts:17-29,49-57,89-126` (+ spec)
- Modify: `apps/api/src/fleet/sync/sync.service.ts:57-79`
- Modify: `apps/api/src/fleet/sync/sync.module.ts:15` (import `ApprovalStoreModule`)

**Interfaces:**
- Consumes: `ApprovalCloser.openBash`, `BashAsk` (Task 5); `APPROVAL_TEXT_MAX_BYTES` (Task 1).
- Produces: `parseApprovalRequest(payload: unknown): { ok: true; ask: BashAsk } | { ok: false; reason: string }`;
  `EventEffect` member `{ kind: 'approval'; ask: BashAsk }`; `ReportOutcome.approvalLive: LiveFleetApprovalEvent[]`.
- The stored approval payload (spec §1.2 as amended by D283):
  `{ command, commandTruncated, maskedCount, root, stage, storyId, featureName, reason, options, rawDetail? }`.

- [ ] **Step 1: Write the failing payload parser tests**

`apps/api/src/fleet/sync/approval-request-payload.spec.ts`:

```ts
import { parseApprovalRequest } from './approval-request-payload';

const valid = {
  naxAskId: 'ask-1f2e3d4c', deadlineAt: '2026-10-04T10:10:00.000Z', command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
};

describe('parseApprovalRequest (S1.5 §3)', () => {
  it('returns the ask and the stored payload', () => {
    const r = parseApprovalRequest(valid);
    expect(r).toEqual({ ok: true, ask: {
      naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date('2026-10-04T10:10:00.000Z'),
      payload: { command: 'bun run test', commandTruncated: false, maskedCount: 0, root: '/work/repo', stage: 'execution',
        storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule', options: ['allow', 'allow-remember', 'deny'] },
    } });
  });

  it('keeps rawDetail for an unparsed ask with an empty command', () => {
    const r = parseApprovalRequest({ ...valid, command: '', rawDetail: 'request: x\nruns in: /w\nreason:  r\nstage:   s' });
    expect('ask' in r && r.ask.payload['rawDetail']).toContain('runs in: /w');
  });

  it('accepts a null storyId', () => {
    expect('ask' in parseApprovalRequest({ ...valid, storyId: null })).toBe(true);
  });

  it.each([
    ['naxAskId', { naxAskId: 'nope' }],
    ['deadlineAt', { deadlineAt: 'yesterday' }],
    ['command', { command: 'x'.repeat(12_289) }],
    ['commandTruncated', { commandTruncated: 'no' }],
    ['maskedCount', { maskedCount: -1 }],
    ['options', { options: [] }],
    ['options', { options: ['allow'] }],
    ['options', { options: ['allow', 'deny', 'deny'] }],
    ['options', { options: ['allow', 'maybe', 'deny'] }],
    ['root', { root: 'x'.repeat(2001) }],
    ['rawDetail', { command: '', rawDetail: 'x'.repeat(12_289) }],
    ['command', { command: '' }],
  ])('refuses a bad %s', (field, over) => {
    expect(parseApprovalRequest({ ...valid, ...over })).toEqual({ ok: false, reason: `approval_request.${field}` });
  });
});
```

- [ ] **Step 2: Implement the parser**

`apps/api/src/fleet/sync/approval-request-payload.ts`:

```ts
import type { BashAsk } from '../approvals/approval-closer';
import { APPROVAL_TEXT_MAX_BYTES } from '../common/protocol';

const ASK_ID = /^ask-[0-9a-f]{1,16}$/;
const OPTIONS: readonly string[] = ['allow', 'allow-remember', 'deny'];
const MAX_FIELD_CHARS = 2000;

type Obj = Record<string, unknown>;
type Parsed = { ok: true; ask: BashAsk } | { ok: false; reason: string };

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const field = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_FIELD_CHARS;
const text = (v: unknown): v is string => typeof v === 'string' && bytes(v) <= APPROVAL_TEXT_MAX_BYTES;

function options(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((o) => typeof o === 'string' && OPTIONS.includes(o))
    && new Set(v).size === v.length && v.includes('deny');
}

/**
 * Spec §3 / plan D269: validates one relayed ask. A bad payload is a rejected event (warn + activity), never a sync
 * failure; nax then times out and denies. The stored payload is everything except the id and deadline.
 */
export function parseApprovalRequest(payload: unknown): Parsed {
  const p = (payload ?? {}) as Obj;
  const bad = (name: string): Parsed => ({ ok: false, reason: `approval_request.${name}` });
  if (typeof p.naxAskId !== 'string' || !ASK_ID.test(p.naxAskId)) return bad('naxAskId');
  const deadline = typeof p.deadlineAt === 'string' ? new Date(p.deadlineAt) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) return bad('deadlineAt');
  if (!text(p.command)) return bad('command');
  if (typeof p.commandTruncated !== 'boolean') return bad('commandTruncated');
  if (!Number.isInteger(p.maskedCount) || (p.maskedCount as number) < 0) return bad('maskedCount');
  for (const name of ['root', 'stage', 'featureName', 'reason'] as const) if (!field(p[name])) return bad(name);
  if (p.storyId !== null && !field(p.storyId)) return bad('storyId');
  if (!options(p.options)) return bad('options');
  if (p.rawDetail !== undefined && !text(p.rawDetail)) return bad('rawDetail');
  if (p.command === '' && p.rawDetail === undefined) return bad('command');   // nothing a human could read
  return {
    ok: true,
    ask: {
      naxAskId: p.naxAskId, deadlineAt: deadline,
      payload: {
        command: p.command, commandTruncated: p.commandTruncated, maskedCount: p.maskedCount, root: p.root, stage: p.stage,
        storyId: p.storyId, featureName: p.featureName, reason: p.reason, options: [...p.options],
        ...(p.rawDetail !== undefined ? { rawDetail: p.rawDetail } : {}),
      },
    },
  };
}
```

Run: `cd apps/api && bun run test:scoped src/fleet/sync/approval-request-payload.spec.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing interpret and processor tests**

`event-payloads.spec.ts`:

```ts
it('interprets approval_request as an approval effect, or invalid', () => {
  expect(interpretEvent('approval_request', VALID_ASK)).toEqual(expect.objectContaining({ kind: 'approval' }));
  expect(interpretEvent('approval_request', { ...VALID_ASK, options: [] })).toEqual({ kind: 'invalid', reason: 'approval_request.options' });
});
```

(`VALID_ASK` = the `valid` object from Step 1; export it from a small `test-fixtures` const in the spec or repeat it.)

`sync-request.parser.spec.ts`: an event of type `approval_request` with an object payload parses.

Create `apps/api/src/fleet/sync/job-report.processor.spec.ts` (none exists). Constructor order after this task:
`new JobReportProcessor(repo, transitions, live, fence, activity, budgets, approvals, tx)` (the new `approvals` goes
between `budgets` and the transaction manager, which stays last). Fakes, all `as never`: an in-memory `repo` with
`seed(job)` plus the methods `process` calls (`lockById`, `findRunnerEvents`, `appendEvent`, `findRunnerEventsAfter`,
`update` — `update` also persists `ackedRunnerSeq`; `findRunnerEventsAfter` returns the appended events with
`runnerSeq` above the given seq; read `job-report.processor.ts:59-126`); `fence = { holds: (j, r, e) => j.runnerId === r && j.leaseEpoch === e, abandon: jest.fn() }`;
`activity = { record: jest.fn() }`; `budgets = { signal: jest.fn() }`; `live = { event: jest.fn(() => JOB_LIVE) }`;
`tx = { run: (fn) => fn() }`; `closer = { openBash: jest.fn().mockResolvedValue({ approval: { id: 'a1' }, live: [APPROVAL_LIVE] }) }`;
`runningJob` = a `FleetJobRecord` with `state: 'RUNNING'`, `runnerId: 'r1'`, `leaseEpoch: 1`, `ackedRunnerSeq: 0`:

```ts
it('opens a bash approval for an approval_request on a RUNNING job and returns its live event', async () => {
  repo.seed({ ...runningJob, bashMode: 'escalate' });
  const outcome = await processor.process('r1', { jobId: runningJob.id, leaseEpoch: runningJob.leaseEpoch, events: [{ seq: 1, type: 'approval_request', payload: VALID_ASK }] }, NOW);
  expect(closer.openBash).toHaveBeenCalledWith(expect.objectContaining({ id: runningJob.id }), expect.objectContaining({ naxAskId: 'ask-1f2e3d4c' }), 'r1', NOW);
  expect(outcome.approvalLive).toEqual([APPROVAL_LIVE]);
  expect(outcome.ack).toEqual({ jobId: runningJob.id, ackedSeq: 1 });
});

it('rejects a malformed ask as an event, acks it, and opens nothing (D269)', async () => {
  repo.seed({ ...runningJob, bashMode: 'escalate' });
  const outcome = await processor.process('r1', { jobId: runningJob.id, leaseEpoch: runningJob.leaseEpoch, events: [{ seq: 1, type: 'approval_request', payload: { naxAskId: 'x' } }] }, NOW);
  expect(closer.openBash).not.toHaveBeenCalled();
  expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'job.event_rejected' }));
  expect(outcome.ack).toEqual({ jobId: runningJob.id, ackedSeq: 1 });
});

it('a stale epoch is fenced before any ask is applied', async () => {
  repo.seed({ ...runningJob, leaseEpoch: 3 });
  await processor.process('r1', { jobId: runningJob.id, leaseEpoch: 2, events: [{ seq: 1, type: 'approval_request', payload: VALID_ASK }] }, NOW);
  expect(closer.openBash).not.toHaveBeenCalled();
});
```


- [ ] **Step 4: Implement interpret, processor and publishing**

`sync-request.parser.ts`:

```ts
const EVENT_TYPES: readonly string[] = ['state', 'snapshot', 'lifecycle', 'log', 'approval_request'];
```

`event-payloads.ts`:

```ts
import type { BashAsk } from '../approvals/approval-closer';
import { parseApprovalRequest } from './approval-request-payload';

export type EventEffect =
  | { kind: 'transition'; to: FleetJobState; reason: string | null; exitCode: number | null }
  | { kind: 'mirror'; patch: FleetJobPatch }
  | { kind: 'approval'; ask: BashAsk }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string };
```

```ts
    case 'approval_request': {
      const parsed = parseApprovalRequest(payload);
      // strictNullChecks is off in apps/api: `parsed.ok` does not narrow, `in` does.
      return 'ask' in parsed ? { kind: 'approval', ask: parsed.ask } : { kind: 'invalid', reason: parsed.reason };
    }
```

`job-report.processor.ts`:
- Inject `private readonly approvals: ApprovalCloser` (constructor, after `budgets`, before the transaction manager).
- `ReportOutcome` gains `approvalLive: LiveFleetApprovalEvent[]`; the `NONE` constant gets `approvalLive: []`.
- `applyOne` returns `{ job; live?: LiveFleetJobEvent; approvalLive?: LiveFleetApprovalEvent[]; mirrored }`. Add before
  the transition branch:

```ts
    if (effect.kind === 'approval') {
      // Spec §2.2: inside the report transaction, after the lease fence; the job row is locked (lock order job -> approval).
      const change = await this.approvals.openBash(job, effect.ask, runnerId, now);
      return { job, approvalLive: change.live, mirrored: false };
    }
```

- `applyContiguous` collects `approvalLive` from every `applyOne` result into the outcome (same loop that collects
  `live`).

`sync.service.ts`: inject `ApprovalLivePublisher`; next to `const live: LiveFleetJobEvent[] = ...` keep
`const approvalLive: LiveFleetApprovalEvent[] = [];`, push `...outcome.approvalLive` beside `live.push(...outcome.live)`,
and after `this.live.publish(live);` add `this.approvalLive.publish(approvalLive);`.

`sync.module.ts`: add `ApprovalStoreModule` to `imports`.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/sync && bun run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/sync
git commit -m "feat(fleet): approval_request events open bash approvals (S1.5 2a)"
```

---

### Task 7: A job leaving RUNNING closes its asks and withdraws unsent answers

**Files:**
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:206-214` (`withdrawPendingCommands` signature)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:258-264`
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.ts:28-59` (+ spec)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts:19` (import `ApprovalStoreModule`)
- Modify: `apps/api/src/fleet/sync/job-report.processor.ts` (transition branch passes `approvalLive`)
- Modify: `apps/api/src/fleet/sync/fleet-sweeper.ts:53-56` (+ spec)
- Modify: `apps/api/src/fleet/sync/command-ack.processor.ts:26-76` (+ spec), `sync.service.ts:57`
- Test: `apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `ApprovalCloser.closeForJob` (Task 5).
- Produces: `JobTransitionsService.apply(...)` returns `{ job; live; approvalLive: LiveFleetApprovalEvent[] }`;
  `withdrawPendingCommands(jobId, now, opts?: { types?: readonly FleetCommandType[] })`;
  `CommandAckProcessor.process(...)` returns `{ live: LiveFleetJobEvent[]; approvalLive: LiveFleetApprovalEvent[] }`.

- [ ] **Step 1: Write the failing tests**

`job-transitions.service.spec.ts` (add a `closer` fake `{ closeForJob: jest.fn().mockResolvedValue([APPROVAL_LIVE]) }`
to the constructor call, after `schedules`):

```ts
describe('leaving RUNNING (S1.5 §1.4, plan D263)', () => {
  it.each([['UPLOADING', 'runner'], ['CANCELLED', 'runner'], ['CRASHED', 'server']] as const)(
    'RUNNING -> %s closes the asks and withdraws unsent answers', async (to, by) => {
      const r = await service.apply({ job: { ...job, state: 'RUNNING' }, to, by, now: NOW, actor: ACTOR });
      expect(repo.withdrawPendingCommands).toHaveBeenCalledWith(job.id, NOW, { types: ['APPROVAL_ANSWER'] });
      expect(closer.closeForJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), NOW);
      expect(r.approvalLive).toEqual([APPROVAL_LIVE]);
    });

  it('a move that does not leave RUNNING touches no approvals', async () => {
    const r = await service.apply({ job: { ...job, state: 'ASSIGNED' }, to: 'RUNNING', by: 'runner', now: NOW, actor: ACTOR });
    expect(closer.closeForJob).not.toHaveBeenCalled();
    expect(r.approvalLive).toEqual([]);
  });
});
```

`fleet-job-repository.integration.spec.ts` (use the file's `repo`, `base` job input and `runnerId`):

```ts
it('withdraws only the given command types when asked (plan D263)', async () => {
  const job = await repo.createJob({ ...base, feature: 'withdraw-types' });
  await repo.createCommand({ runnerId, jobId: job.id, type: 'CANCEL', leaseEpoch: 1, payload: {} });
  await repo.createCommand({ runnerId, jobId: job.id, type: 'APPROVAL_ANSWER', leaseEpoch: 1, payload: { approvalId: 'a', naxAskId: 'ask-1', choice: 'deny' } });
  expect(await repo.withdrawPendingCommands(job.id, new Date(), { types: ['APPROVAL_ANSWER'] })).toBe(1);
  expect((await repo.findPendingCommands(runnerId)).filter((c) => c.jobId === job.id).map((c) => c.type)).toEqual(['CANCEL']);
});
```

`fleet-sweeper.spec.ts` today only covers timer scheduling with `new FleetSweeper({}, {}, {}, {}, cfg, {})` (six
positional args). Add the `ApprovalLivePublisher` as a new last constructor parameter and pass `{}` for it in those
calls. Add one `tick` case: fakes `repo.findStaleHeld`-style finder (read `fleet-sweeper.ts` for the real method that
lists silent runner-held jobs and the `lockById(..., { skipLocked: true })` call), `transitions.apply` resolving
`{ job, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] }`, `tx.run = (fn) => fn()`; assert
`approvalPublisher.publish` was called with `[APPROVAL_LIVE]`.

Create `apps/api/src/fleet/sync/command-ack.processor.spec.ts` (none exists). Constructor today:
`new CommandAckProcessor(repo, transitions, fence, activity, tx)` (Task 8 inserts `approvals` before `tx`). Cover: an
`ok` ASSIGN ack returns `{ live: [], approvalLive: [] }`; a rejected READOPT on a RUNNING job (fake
`transitions.apply` resolving `{ job, live: JOB_LIVE, approvalLive: [APPROVAL_LIVE] }`) returns both lists.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-transitions.service.spec.ts src/fleet/sync test/integration/fleet/fleet-job-repository.integration.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Repository interface (`fleet-job.domain.ts`):

```ts
  /** Withdraws unacked non-ABANDON commands; with `types`, only those types (plan D263: RUNNING -> UPLOADING). */
  withdrawPendingCommands(jobId: string, now: Date, opts?: { types?: readonly FleetCommandType[] }): Promise<number>;
```

Prisma (`prisma-fleet-job.repository.ts`):

```ts
  async withdrawPendingCommands(jobId: string, now: Date, opts: { types?: readonly FleetCommandType[] } = {}): Promise<number> {
    const type = opts.types ? { in: [...opts.types] } : { not: FleetCommandType.ABANDON };
    const { count } = await this.db.fleetCommand.updateMany({
      where: { jobId, ackedAt: null, type },
      data: { ackedAt: now, ackResult: FleetCommandAckResult.WITHDRAWN },
    });
    return count;
  }
```

`job-transitions.service.ts`: inject `private readonly approvals: ApprovalCloser` (last constructor parameter). Update
the leaf-module comment ("§2.4 closes an approval from the jobs side") to say it now does, via `ApprovalStoreModule`.
In `apply`, after `const live = await this.record(...)`:

```ts
    // Spec §1.4 / plan D263: nax has exited or is exiting, so its asks are moot and an unsent answer must not go out.
    const approvalLive = job.state === FleetJobState.RUNNING && to !== FleetJobState.RUNNING ? await this.leaveRunning(after, now) : [];
```

return `{ job: after, live, approvalLive }`, and add:

```ts
  private async leaveRunning(job: FleetJobRecord, now: Date): Promise<LiveFleetApprovalEvent[]> {
    await this.repo.withdrawPendingCommands(job.id, now, { types: [FleetCommandType.APPROVAL_ANSWER] });
    return this.approvals.closeForJob(job, now);
  }
```

`fleet-jobs.module.ts`: add `ApprovalStoreModule` to `imports` (it does not import `FleetJobsModule`, so no cycle).

`job-report.processor.ts` transition branch: `return { job: r.job, live: r.live, approvalLive: r.approvalLive, mirrored: false };`

`fleet-sweeper.ts`: inject `ApprovalLivePublisher`; the per-job transaction returns the whole `apply` result; publish
`[result.live]` with the job publisher and `result.approvalLive` with the approval publisher after it.

`command-ack.processor.ts`: `processOne` returns `{ live: LiveFleetJobEvent | null; approvalLive: LiveFleetApprovalEvent[] }`
(every early `return null` becomes `return NO_CHANGE` with `const NO_CHANGE = { live: null, approvalLive: [] }`;
the READOPT-crash, ASSIGN-fail and CANCEL branches return `{ live: r.live, approvalLive: r.approvalLive }`); `process`
collects both lists. `sync.service.ts` line 57 destructures both and appends `approvalLive` to the list from Task 6.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet test/integration/fleet/fleet-job-repository.integration.spec.ts && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts
git commit -m "feat(fleet): close bash asks and withdraw answers when a job leaves RUNNING (S1.5 2a)"
```

---

### Task 8: Deciding a bash approval sends `APPROVAL_ANSWER`; its ack is stored as delivery

**Files:**
- Create: `apps/api/src/fleet/approvals/bash-decision.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/fleet/approvals/approvals.service.ts:29-123` (+ spec)
- Modify: `apps/api/src/fleet/sync/command-ack.processor.ts` (+ spec)

**Interfaces:**
- Consumes: `ApprovalCloser.expire/closeForJob/recordResolved`, `userActor` (Task 5); `FLEET_JOB_REPOSITORY`
  (`lockById`, `createCommand`) and `RunnerNotifier` from `FleetJobsModule` (already imported by `ApprovalsModule`).
- Produces: `checkBashDecision(payload: Record<string, unknown>, decision: ApprovalDecision): { ok: true; choice: ApprovalOption; status: 'approved' | 'rejected' } | { ok: false; reason: string }`;
  `mayDecideBash(route)`.

- [ ] **Step 1: Write the failing pure tests**

`bash-decision.spec.ts`:

```ts
import { checkBashDecision } from './bash-decision';

const payload = (over: Record<string, unknown> = {}) => ({ command: 'bun run test', commandTruncated: false, options: ['allow', 'allow-remember', 'deny'], ...over });

describe('checkBashDecision (spec §1.3, plan D267)', () => {
  it('maps the three decisions', () => {
    expect(checkBashDecision(payload(), 'allow')).toEqual({ ok: true, choice: 'allow', status: 'approved' });
    expect(checkBashDecision(payload(), 'allow_for_job')).toEqual({ ok: true, choice: 'allow-remember', status: 'approved' });
    expect(checkBashDecision(payload(), 'deny')).toEqual({ ok: true, choice: 'deny', status: 'rejected' });
  });
  it('refuses allow on a truncated command, still allows deny', () => {
    expect(checkBashDecision(payload({ commandTruncated: true }), 'allow')).toEqual({ ok: false, reason: 'the command was truncated; it can only be denied' });
    expect(checkBashDecision(payload({ commandTruncated: true }), 'allow_for_job').ok).toBe(false);
    expect(checkBashDecision(payload({ commandTruncated: true }), 'deny').ok).toBe(true);
  });
  it('refuses allow when nax did not offer it (defence in depth)', () => {
    expect(checkBashDecision(payload({ options: ['deny'] }), 'allow')).toEqual({ ok: false, reason: 'nax did not offer allow for this ask' });
  });
  it('refuses allow_for_job when nax did not offer allow-remember', () => {
    expect(checkBashDecision(payload({ options: ['allow', 'deny'] }), 'allow_for_job')).toEqual({ ok: false, reason: 'nax did not offer allow-remember for this ask' });
  });
  it.each(['raise_budget_and_resume', 'keep_paused'] as const)('refuses the budget decision %s', (d) => {
    expect(checkBashDecision(payload(), d)).toEqual({ ok: false, reason: `${d} does not apply to a bash approval` });
  });
});
```

- [ ] **Step 2: Implement it**

`bash-decision.ts`:

```ts
import type { ApprovalOption } from '../common/protocol';
import type { ApprovalDecision } from './domain/approval.domain';

type Checked = { ok: true; choice: ApprovalOption; status: 'approved' | 'rejected' } | { ok: false; reason: string };

/** Spec §1.3 / plan D267: a human never approves text they could not see, nor an option nax did not offer. */
export function checkBashDecision(payload: Record<string, unknown>, decision: ApprovalDecision): Checked {
  if (decision === 'deny') return { ok: true, choice: 'deny', status: 'rejected' };
  if (decision !== 'allow' && decision !== 'allow_for_job') return { ok: false, reason: `${decision} does not apply to a bash approval` };
  if (payload['commandTruncated'] === true) return { ok: false, reason: 'the command was truncated; it can only be denied' };
  const options = Array.isArray(payload['options']) ? payload['options'] : [];
  if (decision === 'allow') return options.includes('allow') ? { ok: true, choice: 'allow', status: 'approved' } : { ok: false, reason: 'nax did not offer allow for this ask' };
  const offered = options.includes('allow-remember');
  return offered ? { ok: true, choice: 'allow-remember', status: 'approved' } : { ok: false, reason: 'nax did not offer allow-remember for this ask' };
}
```

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/bash-decision.spec.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing service tests**

`approvals.service.spec.ts`. Its `build(approval, policyScope)` constructs
`new ApprovalsService(repo, budgetRepo, budgets, jobs, closer, live, activity, tx)`; this task appends two parameters,
so it becomes `(..., activity, tx, jobRepo, notifier)` — update `build()` to create
`jobRepo = { lockById: jest.fn(), createCommand: jest.fn() }` and `notifier = { notify: jest.fn() }`, pass them last
and return them. In the combined "refuses" test (`:115-121`) the `nax_bash_escalate` row (`decision: 'deny'`, no
`jobId`) still answers 400, now because the approval has no job: rename that clause "bash with no job". For the bash
cases below, write a `buildBash()` beside `build()` that uses a **real** `ApprovalCloser` over an in-memory approval
repo (copy the fake from `approval-closer.spec.ts`) so `expire`/`recordResolved` really resolve rows; it returns
`{ service, rows, seed, jobRepo, notifier }`, and `seed(approval)` stores a row. `DEV_CALLER = { id: 'dev', globalAdmin: false }`:

```ts
describe('bash decide (S1.5 §2.3, plan D265-D267)', () => {
  const pending = { id: 'a1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', leaseEpoch: 2,
    naxAskId: 'ask-1f2e3d4c', expiresAt: new Date(NOW.getTime() + 60_000), payload: { command: 'ls', commandTruncated: false, options: ['allow', 'deny'] } };
  const running = { id: 'j1', state: 'RUNNING', leaseEpoch: 2, runnerId: 'r1', requestedById: 'u9' };
  const dev = { kind: 'project', projectId: 'p1', role: 'DEVELOPER' } as const;

  it('a DEVELOPER allows: approved, APPROVAL_ANSWER for the job runner and epoch, notify after commit', async () => {
    seed(pending); jobRepo.lockById.mockResolvedValue(running);
    const dto = await service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW);
    expect(dto).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow', resolvedBy: 'user' }));
    expect(jobRepo.createCommand).toHaveBeenCalledWith({ runnerId: 'r1', jobId: 'j1', type: 'APPROVAL_ANSWER', leaseEpoch: 2,
      payload: { approvalId: 'a1', naxAskId: 'ask-1f2e3d4c', choice: 'allow' } });
    expect(notifier.notify).toHaveBeenCalledWith('r1');
  });

  it('deny is rejected and sends choice deny', async () => {
    seed(pending); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny' }, NOW)).resolves.toEqual(expect.objectContaining({ status: 'rejected' }));
    expect(jobRepo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ choice: 'deny' }) }));
  });

  it.each(['VIEWER', 'MEMBER', 'AGENT', null])('role %p is forbidden (D266)', async (role) => {
    seed(pending);
    await expect(service.decide(DEV_CALLER, { ...dev, role }, 'a1', { decision: 'deny' }, NOW)).rejects.toThrow(ForbiddenAppException);
  });

  it('expired at decide commits the expiry, then answers 409 (D265)', async () => {
    seed({ ...pending, expiresAt: new Date(NOW.getTime() - 1) }); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ConflictAppException);
    expect(rows.get('a1')).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    expect(jobRepo.createCommand).not.toHaveBeenCalled();
  });

  it('a job that left RUNNING closes the ask job_ended, then 409', async () => {
    seed(pending); jobRepo.lockById.mockResolvedValue({ ...running, state: 'UPLOADING' });
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ConflictAppException);
    expect(rows.get('a1')).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'job_ended' }));
  });

  it('a second decide gets 409', async () => {
    seed({ ...pending, status: 'approved' }); jobRepo.lockById.mockResolvedValue(running);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny' }, NOW)).rejects.toThrow(ConflictAppException);
  });

  it('budget-only fields on a bash decide are 400 (D287)', async () => {
    seed(pending);
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'deny', amountUsd: 5 }, NOW)).rejects.toThrow(ValidationAppException);
  });

  it('allow on a truncated command is 400 before any lock', async () => {
    seed({ ...pending, payload: { ...pending.payload, commandTruncated: true } });
    await expect(service.decide(DEV_CALLER, dev, 'a1', { decision: 'allow' }, NOW)).rejects.toThrow(ValidationAppException);
    expect(jobRepo.lockById).not.toHaveBeenCalled();
  });
});
```

(Each `it` starts with `const { service, rows, seed, jobRepo, notifier } = buildBash();`.)

`command-ack.processor.spec.ts` (created in Task 7; add `approvals = { lockById: jest.fn(), setOutcome: jest.fn() }`
to its construction, and two helpers: `seedCommand(c)` makes the repo fake's `findCommand` return `c`, `seedJob(j)`
makes `lockById` return `j`):

```ts
describe('APPROVAL_ANSWER acks (spec §3, plan D268)', () => {
  it.each([['ok', undefined], ['rejected', 'callback_failed:429']] as const)('stores %s as outcome.delivery', async (result, detail) => {
    seedCommand({ id: 'c1', type: 'APPROVAL_ANSWER', runnerId: 'r1', jobId: 'j1', leaseEpoch: 2, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' } });
    seedJob({ id: 'j1', runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING' });
    approvals.lockById.mockResolvedValue({ id: 'a1', outcome: null });
    const out = await processor.process('r1', 'boot', [{ commandId: 'c1', leaseEpoch: 2, result, ...(detail ? { detail } : {}) }], NOW);
    expect(approvals.setOutcome).toHaveBeenCalledWith('a1', { delivery: { result, detail: detail ?? null, at: NOW.toISOString() } });
    expect(out.live).toEqual([]);
    expect(transitions.apply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Implement decide**

`approvals.service.ts`:
- Constructor gains, **appended after the transaction manager**,
  `@Inject(FLEET_JOB_REPOSITORY) private readonly jobRepo: Pick<IFleetJobRepository, 'lockById' | 'createCommand'>` and
  `private readonly notifier: RunnerNotifier` (the class already has `jobs: FleetJobsService` and
  `live: ApprovalLivePublisher`; do not rename those). New imports: `FleetCommandType` (`../../common/enums`),
  `jobSystemActor` (`./approval-closer`), `checkBashDecision` (`./bash-decision`), `FLEET_JOB_REPOSITORY`,
  `IFleetJobRepository` (`../jobs/domain/fleet-job.domain`), `RunnerNotifier` (`../jobs/runner-notifier`),
  `LiveFleetApprovalEvent` (type, `../../live/live-event`).
- Add beside `mayDecideBudget`:

```ts
/** Spec §1.7 / A6 / plan D266: bash asks are decided by project DEVELOPER+ (or a global ADMIN on the admin prefix). */
const mayDecideBash = (route: ApprovalRoute): boolean => route.kind === 'admin' || route.role === 'ADMIN' || route.role === 'DEVELOPER';

type BashResult =
  | { kind: 'decided'; approval: FleetApprovalRecord; live: LiveFleetApprovalEvent[]; runnerId: string }
  | { kind: 'closed'; live: LiveFleetApprovalEvent[] }
  | { kind: 'not_pending' };
```

- Replace the two D236 lines in `decide` with a branch to a new method, keeping the budget path below unchanged
  (`mayDecideBudget` moves below this branch so a DEVELOPER is not forbidden on a bash ask):

```ts
    const current = await this.findVisible(route, id);
    if (current.type === 'nax_bash_escalate') return this.decideBash(caller, route, current, dto, now);
    if (!mayDecideBudget(route)) throw new ForbiddenAppException({}, 'projects');
```

```ts
  private async decideBash(caller: ApprovalCaller, route: ApprovalRoute, current: FleetApprovalRecord, dto: DecideApprovalDto, now: Date): Promise<FleetApprovalDto> {
    if (!mayDecideBash(route)) throw new ForbiddenAppException({}, 'projects');
    if (dto.amountUsd !== undefined || dto.requeueJobIds !== undefined) {
      throw new ValidationAppException({ reason: 'amountUsd and requeueJobIds apply only to budget approvals' }, 'fleet.approvalInput');   // plan D287
    }
    const checked = checkBashDecision(current.payload, dto.decision);
    if ('reason' in checked) invalid(checked.reason);   // strictNullChecks is off: `in` narrows, `.ok` does not
    const jobId = current.jobId;
    if (!jobId) invalid('a bash approval with no job cannot be decided');
    const result = await this.txManager.run(async (): Promise<BashResult> => {
      const job = await this.jobRepo.lockById(jobId);   // lock order: job first, then approval (spec §1.4)
      const approval = await this.repo.lockById(current.id);
      if (!job || !approval || approval.status !== 'pending') return { kind: 'not_pending' };
      if (job.state !== 'RUNNING' || job.leaseEpoch !== approval.leaseEpoch || job.runnerId === null) {
        // nax has exited or is exiting. Close only THIS ask: on an epoch mismatch the job's other asks belong to a newer lease.
        const ended = await this.repo.resolve(approval.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: now });
        return { kind: 'closed', live: await this.closer.recordResolved(ended, jobSystemActor(job)) };
      }
      if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
        return { kind: 'closed', live: (await this.closer.expire(approval, job, now)).live };   // nax has already denied
      }
      const decided = await this.repo.resolve(approval.id, {
        status: checked.status, resolvedBy: 'user', decision: dto.decision, decidedById: caller.id, decidedAt: now,
        comment: dto.comment ?? null,
      });
      await this.jobRepo.createCommand({
        runnerId: job.runnerId, jobId: job.id, type: FleetCommandType.APPROVAL_ANSWER, leaseEpoch: job.leaseEpoch,
        payload: { approvalId: decided.id, naxAskId: decided.naxAskId, choice: checked.choice },
      });
      return { kind: 'decided', approval: decided, live: await this.closer.recordResolved(decided, userActor(caller.id)), runnerId: job.runnerId };
    });
    // Plan D265: the expiry or job-end close above has committed; only now refuse the decide.
    if (result.kind !== 'not_pending') this.live.publish(result.live);
    if (result.kind !== 'decided') throw new ConflictAppException({}, 'fleet.approvalNotPending');
    this.notifier.notify(result.runnerId);
    return FleetApprovalDto.from(result.approval);
  }
```

(`jobSystemActor` is exported from `approval-closer.ts` by Task 5; `this.closer`, `this.live`, `this.repo`,
`this.txManager`, `invalid`, `userActor` are the names already in the file. The `'decided'`/`'closed'` checks use
`result.kind`, a string discriminant, which narrows without strictNullChecks.)

- [ ] **Step 5: Implement delivery on ack**

`command-ack.processor.ts`: inject `@Inject(APPROVAL_REPOSITORY) private readonly approvals: Pick<IApprovalRepository, 'lockById' | 'setOutcome'>`
as the parameter before the transaction manager (constructor becomes `(repo, transitions, fence, activity, approvals, tx)`;
update the Task 7 spec's construction). `NO_CHANGE` is the constant Task 7 introduced.
After `await this.repo.ackCommand(command.id, ack.result, now);` and the `detail` line:

```ts
    if (command.type === FleetCommandType.APPROVAL_ANSWER) {
      // Spec §3 / plan D268: the delivery result is shown on the approval; no transition, no live event.
      const { approvalId } = command.payload as { approvalId?: unknown };
      const approval = typeof approvalId === 'string' ? await this.approvals.lockById(approvalId) : null;   // job locked above
      if (approval) {
        await this.approvals.setOutcome(approval.id, { ...(approval.outcome ?? {}), delivery: { result: ack.result, detail: ack.detail ? detail : null, at: now.toISOString() } });
      }
      return NO_CHANGE;
    }
```

- [ ] **Step 6: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals src/fleet/sync && bun run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/approvals apps/api/src/fleet/sync
git commit -m "feat(fleet): decide bash approvals into APPROVAL_ANSWER and record delivery (S1.5 2a)"
```

---

### Task 9: `ApprovalExpirySweeper`

**Files:**
- Create: `apps/api/src/fleet/approvals/approval-expiry-sweeper.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/fleet/approvals/approvals.module.ts` (provider)

**Interfaces:**
- Consumes: `IApprovalRepository.findExpiredPending/lockById` (Task 5), `ApprovalCloser.expire`, `FLEET_JOB_REPOSITORY.lockById`.
- Produces: `ApprovalExpirySweeper.tick(now?: Date): Promise<{ expired: number; failed: number }>`; a 15 s interval
  when `sweepEnabled`.

- [ ] **Step 1: Write the failing tests**

`approval-expiry-sweeper.spec.ts` (pattern: `budget-sweeper.spec.ts` and `fleet-sweeper.spec.ts`):

```ts
import { ApprovalExpirySweeper } from './approval-expiry-sweeper';

const NOW = new Date('2026-10-04T10:00:00Z');
const due = { id: 'a1', jobId: 'j1', status: 'pending', expiresAt: new Date(NOW.getTime() - 1) };

function build(over: { sweepEnabled?: boolean; locked?: object | null } = {}) {
  const repo = { findExpiredPending: jest.fn().mockResolvedValue([due]), lockById: jest.fn().mockResolvedValue(over.locked === undefined ? due : over.locked) };
  const jobs = { lockById: jest.fn().mockResolvedValue({ id: 'j1', requestedById: 'u9' }) };
  const closer = { expire: jest.fn().mockResolvedValue({ approval: { ...due, status: 'expired' }, live: [{ approvalId: 'a1' }] }) };
  const live = { publish: jest.fn() };
  const tx = { run: (fn: () => Promise<unknown>) => fn() };
  const sweeper = new ApprovalExpirySweeper(repo as never, jobs as never, closer as never, live as never, tx as never, { sweepEnabled: over.sweepEnabled ?? false });
  return { sweeper, repo, jobs, closer, live };
}

describe('ApprovalExpirySweeper (spec §2.4)', () => {
  it('expires a due ask under job-then-approval locks and publishes after commit', async () => {
    const b = build();
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 1, failed: 0 });
    expect(b.jobs.lockById.mock.invocationCallOrder[0]).toBeLessThan(b.repo.lockById.mock.invocationCallOrder[0]);
    expect(b.closer.expire).toHaveBeenCalledWith(due, { id: 'j1', requestedById: 'u9' }, NOW);
    expect(b.live.publish).toHaveBeenCalledWith([{ approvalId: 'a1' }]);
  });
  it('skips an ask decided between the scan and the lock', async () => {
    const b = build({ locked: { ...due, status: 'approved' } });
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(b.closer.expire).not.toHaveBeenCalled();
  });
  it('counts a failure and carries on', async () => {
    const b = build();
    b.closer.expire.mockRejectedValueOnce(new Error('boom'));
    expect(await b.sweeper.tick(NOW)).toEqual({ expired: 0, failed: 1 });
  });
  it('starts no timer unless sweepEnabled', () => {
    jest.useFakeTimers();
    const off = build();
    off.sweeper.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    const on = build({ sweepEnabled: true });
    on.sweeper.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    on.sweeper.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approval-expiry-sweeper.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`approval-expiry-sweeper.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY, FleetApprovalRecord, IApprovalRepository } from './domain/approval.domain';

const SWEEP_INTERVAL_MS = 15_000;
const MAX_PER_TICK = 100;

export interface ApprovalExpiryResult { expired: number; failed: number }

/** Spec §2.4: expires pending bash asks past `expiresAt` (nax has already denied them). Budget asks never expire. */
@Injectable()
export class ApprovalExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: Pick<IApprovalRepository, 'findExpiredPending' | 'lockById'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById'>,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Approval expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<ApprovalExpiryResult> {
    const result: ApprovalExpiryResult = { expired: 0, failed: 0 };
    for (const due of await this.repo.findExpiredPending(now, MAX_PER_TICK)) {
      try {
        const live = await this.txManager.run(() => this.expireOne(due, now));
        if (live) {
          this.live.publish(live);
          result.expired += 1;
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Approval ${due.id} not expired: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /** Lock order job -> approval (spec §1.4); re-checks under the lock, since a decide may have won. */
  private async expireOne(due: FleetApprovalRecord, now: Date): Promise<LiveFleetApprovalEvent[] | null> {
    const job = due.jobId ? await this.jobs.lockById(due.jobId) : null;
    const locked = await this.repo.lockById(due.id);
    if (!job || !locked || locked.status !== 'pending' || !locked.expiresAt || locked.expiresAt.getTime() > now.getTime()) return null;
    return (await this.closer.expire(locked, job, now)).live;
  }
}
```

Register `ApprovalExpirySweeper` in `approvals.module.ts` `providers`. `FLEET_CFG` comes from the same global config
provider `BudgetSweeper` uses; if `ApprovalsModule` cannot resolve it, add the module that provides it to its imports
exactly as `BudgetsModule` does.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/approvals
git commit -m "feat(fleet): approval expiry sweeper for bash asks (S1.5 2a)"
```

---

### Task 10: `FleetJobDto` fields, OpenAPI, CLI decide/show, web types

**Files:**
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:16-81` (+ `fleet-job.dto.spec.ts`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:90-97,140,221,226-228` (+ spec)
- Modify: `openapi.json` (regenerated)
- Modify: `apps/cli/src/commands/fleet-approval.ts:62-69,157-158` (+ `fleet-approval.spec.ts`)
- Modify: `apps/web/lib/fleet-types.ts` (`FleetJob` type)

**Interfaces:**
- Consumes: `IApprovalRepository.countPendingByJob` (Task 5); `FleetJobRecord.approvalTimeoutSec` (Task 2).
- Produces: `FleetJobDto.approvalTimeoutSec: number`, `FleetJobDto.pendingApprovals: number`,
  `FleetJobDto.from(r, pendingApprovals = 0)`, `FleetJobDto.summary(r, pendingApprovals = 0)`.

- [ ] **Step 1: Write the failing tests**

`fleet-job.dto.spec.ts`:

```ts
it('maps bashMode, approvalTimeoutSec and pendingApprovals (S1.5 §1.6)', () => {
  const dto = FleetJobDto.from({ ...record, bashMode: 'escalate', approvalTimeoutSec: 120 }, 2);
  expect(dto).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 120, pendingApprovals: 2 }));
  expect(FleetJobDto.summary(record).pendingApprovals).toBe(0);
});
```

`fleet-jobs.service.spec.ts` (create it if absent; `approvals = { countPendingByJob: jest.fn() }` is the last
constructor argument, every other one an `as never` fake):

```ts
it('list counts pending approvals for the whole page in one query (D272)', async () => {
  repo.findPage.mockResolvedValue({ total: 2, current: 1, size: 20, hasNext: false, hasPrev: false, records: [jobA, jobB] });
  approvals.countPendingByJob.mockResolvedValue(new Map([[jobB.id, 3]]));
  const page = await service.list(projectId, {}, { page: 1, size: 20 });
  expect(approvals.countPendingByJob).toHaveBeenCalledTimes(1);
  expect(approvals.countPendingByJob).toHaveBeenCalledWith([jobA.id, jobB.id]);
  expect(page.records.map((r) => r.pendingApprovals)).toEqual([0, 3]);
});

it('get counts the job pending approvals', async () => {
  repo.findById.mockResolvedValue(jobA);
  approvals.countPendingByJob.mockResolvedValue(new Map([[jobA.id, 1]]));
  expect((await service.get(projectId, jobA.id)).pendingApprovals).toBe(1);
});
```

(Use the service's real `list` signature; the point is one grouped call per page.)

`apps/cli/src/commands/fleet-approval.spec.ts` (harness: `run(...args)` prefixes `fleet approval`; the generated
client functions are `jest.mock`ed; `ok(row(over))` builds a response; `logged()` joins console output):

```ts
it.each(['allow', 'allow_for_job', 'deny'])('decide accepts the bash decision %s (D280)', async (decision) => {
  (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ type: 'nax_bash_escalate', status: 'approved', decision })));
  await run('decide', 'a1', '--project', 'web', '--decision', decision);
  expect(projectFleetApprovalsControllerDecide).toHaveBeenCalledWith({ path: { slug: 'web', id: 'a1' }, body: { decision } });
});

it('show prints a bash ask', async () => {
  (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({ type: 'nax_bash_escalate', jobId: 'j1', policyId: null,
    payload: { command: 'bun run test', commandTruncated: false, maskedCount: 1, root: '/w', stage: 'execution', storyId: 'US-001',
      featureName: 'demo', reason: 'matched ask rule', options: ['allow', 'deny'] }, expiresAt: '2026-10-04T10:10:00Z' })));
  await run('show', 'a1', '--project', 'web');
  expect(logged()).toContain('bun run test');
  expect(logged()).toContain('1 secret value(s) masked');
  expect(logged()).toContain('Options:  allow, deny');
});
```

The existing test "refuses an undecidable --decision before any request" (`:123-125`) passes `allow`, which is now
valid: change it to `--decision bogus` and its expected message to `/one of allow, allow_for_job, deny, raise_budget_and_resume, keep_paused/`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs`
Run: `cd apps/cli && bun run test -- src/commands/fleet-approval.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the DTO and service**

`fleet-job.dto.ts`:

```ts
  @ApiProperty({ enum: ['raw', 'gated', 'escalate'] }) declare bashMode: BashMode;
  @ApiProperty({ minimum: 30, maximum: 3600, description: 'S1.5: seconds a bash ask waits; used only when bashMode is not raw' })
  declare approvalTimeoutSec: number;
  @ApiProperty({ description: 'S1.5: pending bash approvals of this job' })
  declare pendingApprovals: number;
```

```ts
  static from(r: FleetJobRecord, pendingApprovals = 0): FleetJobDto {
    // existing body, plus:
    //   approvalTimeoutSec: r.approvalTimeoutSec,
    //   pendingApprovals,
  }

  static summary(r: FleetJobRecord, pendingApprovals = 0): FleetJobDto {
    return Object.assign(FleetJobDto.from(r, pendingApprovals), { stories: null, storiesTruncated: false });
  }
```

`fleet-jobs.service.ts`: inject `@Inject(APPROVAL_REPOSITORY) private readonly approvals: Pick<IApprovalRepository, 'countPendingByJob'>`
(`FleetJobsModule` imports `ApprovalStoreModule` since Task 7). Then:

```ts
  async list(/* existing params */): Promise<IPageResult<FleetJobDto>> {
    const page = await this.repo.findPage(filters, pageOption);
    const pending = await this.approvals.countPendingByJob(page.records.map((r) => r.id));   // plan D272: one query per page
    return remapPage(page, (r) => FleetJobDto.summary(r, pending.get(r.id) ?? 0));
  }

  private async withPending(r: FleetJobRecord): Promise<FleetJobDto> {
    return FleetJobDto.from(r, (await this.approvals.countPendingByJob([r.id])).get(r.id) ?? 0);
  }
```

`get` and `cancel` return `this.withPending(record)`; `requeue` returns a `DispatchResultDto`, so its `job` becomes
`await this.withPending(fresh)`; `dispatch` keeps `FleetJobDto.from(job)` (0). Constructor: append the new
`approvals` parameter last, and update the construction in any spec that builds `FleetJobsService` directly (grep
`new FleetJobsService(`; if no unit spec exists, create `fleet-jobs.service.spec.ts` for the two tests above with
`as never` fakes for every other parameter).

- [ ] **Step 4: Regenerate OpenAPI**

Run: `bun run generate` (repo root; copy `apps/api/.env` from the main checkout if missing).
Expected: `openapi.json` gains `approvals_relay` in the misfit enum, `bashMode` enums, `approvalTimeoutSec` on the
dispatch/schedule/job DTOs, `pendingApprovals` on `FleetJobDto`.
Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts` — Expected: PASS (update its pinned
lists if it enumerates misfit reasons or DTO fields).

- [ ] **Step 5: Implement the CLI**

`apps/cli/src/commands/fleet-approval.ts`:

```ts
const DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const;

function parseDecision(value: string): DecideApprovalDto['decision'] {
  if (!(DECISIONS as readonly string[]).includes(value)) throw new InvalidArgumentError(`one of ${DECISIONS.join(', ')}`);
  return value as DecideApprovalDto['decision'];
}
```

(delete the D236 comment). Option text at line 158: `'allow, allow_for_job, deny, keep_paused or raise_budget_and_resume'`;
the `decide` command description (line 157) becomes `'Decide an approval (budget override or bash ask)'`.
`--amount` and `--requeue` keep their budget-only meaning; the server answers 400 when they are sent on a bash decide
(D287), so the CLI adds no rule. In the list renderer's one-line `summary()`, a bash row with an empty `command` shows
the first line of `payload.rawDetail` instead of a blank.

Add a bash renderer used by `show` when `type === 'nax_bash_escalate'` (beside the existing budget renderer):

```ts
/** Plan D280: never the request line (nax does not send it separately and the CLI never rebuilds it). */
function bashLines(p: Record<string, unknown>): string[] {
  const command = typeof p['command'] === 'string' && p['command'] !== '' ? p['command'] : null;
  return [
    ...(command ? ['Command:', ...command.split('\n').map((l) => `  ${l}`)] : ['Detail (not parsed):', ...String(p['rawDetail'] ?? '').split('\n').map((l) => `  ${l}`)]),
    ...(p['commandTruncated'] === true ? ['  (truncated: this ask can only be denied)'] : []),
    ...(typeof p['maskedCount'] === 'number' && p['maskedCount'] > 0 ? [`  ${p['maskedCount']} secret value(s) masked`] : []),
    `Runs in:  ${String(p['root'] ?? '')}`,
    `Stage:    ${String(p['stage'] ?? '')}`,
    `Story:    ${String(p['storyId'] ?? '-')}`,
    `Reason:   ${String(p['reason'] ?? '')}`,
    `Options:  ${Array.isArray(p['options']) ? p['options'].join(', ') : ''}`,
  ];
}
```

Also print `Expires:` from `expiresAt` for bash approvals and the `outcome.delivery` result when present.

- [ ] **Step 6: Web types**

`apps/web/lib/fleet-types.ts`, `FleetJobDto` (line ~144): `bashMode: 'raw' | 'gated' | 'escalate';`, add
`approvalTimeoutSec: number;` and `pendingApprovals: number;`. Update any web test fixture that builds a full
`FleetJobDto` literal (type-check will name them) with `approvalTimeoutSec: 600, pendingApprovals: 0`.

- [ ] **Step 7: Run everything touched**

Run: `cd apps/api && bun run test:scoped src/fleet && bun run type-check`
Run: `cd apps/cli && bun run test && bun run type-check`
Run: `cd apps/web && bun run type-check && bun run test -- tests/lib`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/jobs openapi.json apps/cli/src/commands apps/web/lib apps/web/tests
git commit -m "feat(fleet): job approval fields, bash decide in the CLI, OpenAPI (S1.5 2a)"
```

---

### Task 11: API integration suite for the relay (real PG)

**Files:**
- Create: `apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-10 over HTTP; `ApprovalExpirySweeper.tick` via `app.get`.

- [ ] **Step 1: Write the suite**

```ts
/**
 * Fleet S1.5 slice 2a — relay loop over HTTP: report ask -> approval -> decide -> APPROVAL_ANSWER -> ack -> delivery;
 * expiry; job-end cleanup; idempotent re-report; placement relay misfit.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-relay.integration.spec.ts
 */
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import request from 'supertest';
import type { ApprovalRequestEventPayload, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { ApprovalExpirySweeper } from '../../../src/fleet/approvals/approval-expiry-sweeper';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const ask = (naxAskId: string, deadlineMs = 300_000): ApprovalRequestEventPayload => ({
  naxAskId, deadlineAt: new Date(Date.now() + deadlineMs).toISOString(), command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'relay', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
});

describeIntegration('fleet approval relay (S1.5 2a, PG)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaClient;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let runner: { runnerId: string; apiKey: string };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ protocolVersion: 2, ...over })).expect(200));
  const dispatch = (body: object, expected = 201) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth(world.tokens.dev)).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body }).expect(expected);
  const approvals = async (jobId: string) =>
    data<{ records: Array<Record<string, unknown>> }>(await request(server).get(`/api/projects/web/fleet/approvals?jobId=${jobId}`).set(auth(world.tokens.dev)).expect(200)).records;
  const decide = (id: string, token: string, decision: string) =>
    request(server).post(`/api/projects/web/fleet/approvals/${id}/decide`).set(auth(token)).send({ decision });

  /**
   * One repo and one runner: placement refuses a second job on a busy repo (`busy_repo`), so every test that starts a
   * job ends it with `finish` (UPLOADING then COMPLETED, as runner-sync-lifecycle.integration.spec.ts does).
   */
  const finish = (jobId: string, leaseEpoch: number, seq: number, fromUploading = false) =>
    sync({ jobs: [{ jobId, leaseEpoch, events: [
      ...(fromUploading ? [] : [{ seq, type: 'state' as const, payload: { to: 'UPLOADING' as const } }]),
      { seq: fromUploading ? seq : seq + 1, type: 'state' as const, payload: { to: 'COMPLETED' as const } },
    ] }] });

  /** ASSIGN -> ack -> RUNNING at seq 1; returns the job id and its epoch. */
  async function startRunning(feature: string, body: object = {}): Promise<{ jobId: string; leaseEpoch: number }> {
    const jobId = data<{ job: { id: string } }>(await dispatch({ feature, bashMode: 'escalate', approvalTimeoutSec: 600, ...body })).job.id;
    const assign = (await sync({ freeSlots: 1 })).commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    if (!assign) throw new Error('no ASSIGN');
    expect(assign.payload).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 600 }));
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId, leaseEpoch: assign.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    return { jobId, leaseEpoch: assign.leaseEpoch };
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'relay-1');
  });
  afterAll(async () => {
    await app.close();
  });

  it('a runner without the relay: a pinned escalate dispatch is 422, an unpinned one waits QUEUED (D270)', async () => {
    await sync();   // first sync: runner online with FLEET_CAPS (no relay)
    const pinned = await dispatch({ feature: 'pinned', bashMode: 'escalate', pinnedRunnerId: runner.runnerId }, 422);
    expect(JSON.stringify(pinned.body)).toContain('approvals_relay');
    const jobId = data<{ job: { id: string } }>(await dispatch({ feature: 'waits', bashMode: 'gated' })).job.id;
    expect((await sync({ freeSlots: 1 })).commands.some((c) => c.jobId === jobId)).toBe(false);   // a free slot, still no ASSIGN
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).state).toBe('QUEUED');
    await request(server).post(`/api/projects/web/fleet/jobs/${jobId}/cancel`).set(auth(world.tokens.dev)).expect(200);
  });

  it('report ask -> pending approval -> DEVELOPER allows -> APPROVAL_ANSWER -> ack ok -> delivery', async () => {
    await sync({ capabilities: { ...FLEET_CAPS, approvals: { relay: true } } });
    const { jobId, leaseEpoch } = await startRunning('loop');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000a') }] }] });

    const [pending] = await approvals(jobId);
    expect(pending).toEqual(expect.objectContaining({ type: 'nax_bash_escalate', status: 'pending', jobId }));
    const job = data<{ pendingApprovals: number }>(await request(server).get(`/api/projects/web/fleet/jobs/${jobId}`).set(auth(world.tokens.dev)).expect(200));
    expect(job.pendingApprovals).toBe(1);

    await decide(String(pending.id), world.tokens.viewer, 'allow').expect(403);
    await decide(String(pending.id), world.tokens.dev, 'allow').expect(200);
    await decide(String(pending.id), world.tokens.dev, 'deny').expect(409);

    const answer = (await sync()).commands.find((c) => c.type === 'APPROVAL_ANSWER' && c.jobId === jobId);
    expect(answer?.payload).toEqual({ approvalId: pending.id, naxAskId: 'ask-0000000a', choice: 'allow' });
    await sync({ commandAcks: [{ commandId: answer!.commandId, leaseEpoch, result: 'ok' }] });
    const [decided] = await approvals(jobId);
    expect(decided).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow', outcome: { delivery: expect.objectContaining({ result: 'ok' }) } }));
    await finish(jobId, leaseEpoch, 3);
  });

  it('a re-reported ask (same seq, or a new seq with the same naxAskId) stays one approval', async () => {
    const { jobId, leaseEpoch } = await startRunning('idem');
    const event = { seq: 2, type: 'approval_request' as const, payload: ask('ask-0000000b') };
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ ...event, seq: 3 }] }] });
    expect(await approvals(jobId)).toHaveLength(1);
    await finish(jobId, leaseEpoch, 4);
  });

  it('an unanswered ask expires through the sweeper; a decide after it is 409 and leaves it expired', async () => {
    const { jobId, leaseEpoch } = await startRunning('expiry');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000c', 2_000) }] }] });
    const result = await app.get(ApprovalExpirySweeper).tick(new Date(Date.now() + 5_000));
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const [expired] = await approvals(jobId);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    await decide(String(expired.id), world.tokens.dev, 'allow').expect(409);
    await finish(jobId, leaseEpoch, 3);
  });

  it('an ask past its deadline on arrival is born expired', async () => {
    const { jobId, leaseEpoch } = await startRunning('late');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000d', -1_000) }] }] });
    expect((await approvals(jobId))[0]).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    await finish(jobId, leaseEpoch, 3);
  });

  it('the job leaving RUNNING cancels its asks job_ended and withdraws an unsent answer', async () => {
    const { jobId, leaseEpoch } = await startRunning('ending');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: 2, type: 'approval_request', payload: ask('ask-0000000e') },
      { seq: 3, type: 'approval_request', payload: ask('ask-0000000f') },
    ] }] });
    const [first] = (await approvals(jobId)).filter((a) => a.status === 'pending');
    await decide(String(first.id), world.tokens.dev, 'deny').expect(200);   // answer queued, not yet synced down
    const after = await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 4, type: 'state', payload: { to: 'UPLOADING' } }] }] });
    expect(after.commands.some((c) => c.type === 'APPROVAL_ANSWER' && c.jobId === jobId)).toBe(false);
    const rows = await approvals(jobId);
    expect(rows.find((a) => a.id !== first.id)).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'job_ended' }));
    await finish(jobId, leaseEpoch, 5, true);
  });

  it('a malformed ask is a rejected event, not a sync failure (D269)', async () => {
    const { jobId, leaseEpoch } = await startRunning('malformed');
    const res = await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: { ...ask('ask-00000010'), options: [] } }] }] });
    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: 2 });
    expect(await approvals(jobId)).toHaveLength(0);
    await finish(jobId, leaseEpoch, 3);
  });

  it('a v1 sync is still accepted (deploy order: server first)', async () => {
    await sync({ protocolVersion: 1 });
  });
});
```

Notes for the implementer:
- If `syncBody` already sets `protocolVersion`, the override above still wins.
- `syncBody` defaults `freeSlots: 0`; `startRunning` syncs with `freeSlots: 1` so placement assigns. Decide and cancel
  answer **200** (`@HttpCode(200)`); dispatch answers 201 with `{ job, placement }`.
- If COMPLETED needs a bundle or result fields in this API, copy exactly what `runner-sync-lifecycle.integration.spec.ts`
  sends around its `:105` to finish a job.
- Add one webhook assertion in the loop test following `fleet-approvals-api.integration.spec.ts` (how it asserts
  `fleet.approval.requested`): a bash approval produces `fleet.approval.requested` then `fleet.approval.resolved`, and
  neither payload contains `bun run test`.

- [ ] **Step 2: Run it**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-approval-relay.integration.spec.ts`
Expected: PASS. A failure here is a defect in Tasks 1-10, not in the test: fix the owning task's code.

- [ ] **Step 3: Run the whole fleet integration set (no regressions in 1a/1b/S1)**

Run: `cd apps/api && bun run test:scoped test/integration/fleet`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/integration/fleet/fleet-approval-relay.integration.spec.ts
git commit -m "test(fleet): approval relay integration suite (S1.5 2a)"
```

---

### Task 12: The runner reports `approvals.relay`

**Files:**
- Modify: `apps/runner/src/nax/nax-cli.ts:125-135` (+ `nax-cli.spec.ts`)
- Modify: `apps/runner/src/capabilities/nax-probe.ts:135-150` (+ `nax-probe.spec.ts`)

**Interfaces:**
- Consumes: `RunnerCapabilities.approvals` (Task 1).
- Produces: `RELAY_MIN_NAX_VERSION = [0, 83, 0]`, `relaySupported(version: string): boolean`.

- [ ] **Step 1: Write the failing tests**

`nax-cli.spec.ts`:

```ts
describe('relaySupported (plan D258)', () => {
  test.each([['0.83.0', true], ['0.83.2', true], ['0.84.0', true], ['1.0.0', true], ['0.83.1-fake', true], ['0.82.2', false], ['garbage', false]])(
    '%s -> %p', (version, expected) => {
      expect(relaySupported(version)).toBe(expected);
    });
});
```

`nax-probe.spec.ts`: the happy-path test near `:60-80` asserts the whole report with `toEqual({...})` for
`version: '0.83.1'`; add `approvals: { relay: true }` to that expected object. No below-floor probe case is possible
(`readNaxVersion` throws under `MIN_NAX_VERSION` 0.83.1), so the `relaySupported` table is the floor test.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/runner && bun test src/nax/nax-cli.spec.ts src/capabilities/nax-probe.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`nax-cli.ts`, below `versionAtLeast`:

```ts
/**
 * Plan D258: the first nax with the relay's guarantees: allow-remember offered only when nax can remember (#2252,
 * 0.83.0), escalate refusing out-of-bounds commands instead of asking (#2250, 0.82.2). Verified v0.82.0..v0.83.2.
 */
export const RELAY_MIN_NAX_VERSION: readonly [number, number, number] = [0, 83, 0];

export function relaySupported(version: string): boolean {
  const parsed = parseNaxVersion(version);
  return parsed !== null && versionAtLeast(parsed, RELAY_MIN_NAX_VERSION);
}
```

`nax-probe.ts` `probe()`: pass `...(relaySupported(version) ? { approvals: { relay: true as const } } : {})` in the object
given to `boundReport` (`boundReport` spreads the report, so the key survives).

- [ ] **Step 4: Run tests**

Run: `cd apps/runner && bun run test && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/nax apps/runner/src/capabilities
git commit -m "feat(runner): report the approvals relay capability for nax >= 0.83.0 (S1.5 2a)"
```

---

### Task 13: nax ask parsing — `detail` parser and the event payload builder

**Files:**
- Create: `apps/runner/test/fixtures/nax-asks/v0.83.2.json` (content in Step 1)
- Create: `apps/runner/src/approvals/detail-parser.ts` (+ `.spec.ts`)
- Create: `apps/runner/src/approvals/ask-payload.ts` (+ `.spec.ts`)

**Interfaces:**
- Consumes: `ApprovalRequestEventPayload`, `APPROVAL_TEXT_MAX_BYTES`, `ApprovalOption` (Task 1); `SYNC_LIMITS`,
  `byteLength` from `src/sync/batch.ts`.
- Produces:
  - `parseDetail(detail: string): ParsedDetail | null` where
    `interface ParsedDetail { command: string; maskedCount: number; root: string; reason: string }`
  - `interface NaxAskRequest { id: string; type: string; featureName: string; storyId?: string; stage: string; detail?: string; options?: Array<{ key: string }>; timeout?: number; createdAt: number; metadata?: Record<string, unknown>; callbackUrl: string }`
  - `buildAskPayload(request: NaxAskRequest): ApprovalRequestEventPayload | null` (null = not a relayable ask)
  - `capUtf8(text: string, maxBytes: number): { text: string; cut: boolean }`

- [ ] **Step 1: Add the captured fixtures**

Create `apps/runner/test/fixtures/nax-asks/v0.83.2.json` with the content of the **Appendix A** block at the end of
this plan, verbatim. Provenance: produced by calling nax's real `buildApprovalRequest` (`interaction/ask-link-session.ts`)
and the webhook plugin's payload assembly from extracted sources at tag `v0.83.2` (`bcfcddb01`) and main
`a755a5464`; the two outputs are byte-identical (D259). `id`, `createdAt` and the callback port are fixed values.

- [ ] **Step 2: Write the failing parser tests**

`apps/runner/src/approvals/detail-parser.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { parseDetail } from './detail-parser';

const FENCE = '```';
/** nax's own layout (ask-link-session.ts:181-188), for synthetic cases. */
const naxDetail = (command: string, opts: { masked?: number; root?: string; reason?: string; stage?: string } = {}): string => [
  FENCE, command, FENCE,
  ...(opts.masked ? [`${opts.masked} secret value(s) masked; the approved command contains them`] : []),
  `request: ${`Bash command=${command}`.slice(0, 200)}`,
  `runs in: ${opts.root ?? '/work/repo'}`,
  `reason:  ${opts.reason ?? 'matched ask rule'}`,
  `stage:   ${opts.stage ?? 'execution'}`,
].join('\n');

describe('parseDetail on captured nax v0.83.2 asks (plan D256, D259)', () => {
  test('a: simple command', () => {
    expect(parseDetail(fixtures.a_simple.detail)).toEqual({ command: 'bun run test', maskedCount: 0, root: '/work/repo', reason: 'matched ask rule', stage: 'execution' });
  });
  test('b: two masked secrets', () => {
    const parsed = parseDetail(fixtures.b_two_secrets.detail);
    expect(parsed?.maskedCount).toBe(2);
    expect(parsed?.command).toContain('[REDACTED:openai]');
  });
  test('c: a multi-line command containing a fence', () => {
    expect(parseDetail(fixtures.c_multiline_fence.detail)?.command).toBe("cat > notes.md <<'EOF'\n```ts\nconsole.log(1)\n```\nEOF\nbun run test");
  });
  test('d: long root and free-text reason', () => {
    const parsed = parseDetail(fixtures.d_longest_padding.detail);
    expect(parsed?.root).toBe('/Users/someone/very/long/path/to/repo/packages/pkg-a');
    expect(parsed?.reason).toStartWith("command 'rm -rf build/' is not covered");
  });
  test('e: a command-less ask is not parsed (bash asks always carry a command)', () => {
    expect(parseDetail(fixtures.e_no_command_write.detail)).toBeNull();
  });
});

describe('parseDetail edge cases', () => {
  test('a command longer than the 200-char request cap still parses', () => {
    const command = `echo ${'x'.repeat(400)}`;
    expect(parseDetail(naxDetail(command))?.command).toBe(command);
  });
  test('spoofed split: a command that fakes a closing fence and request line is not parsed (Review Focus 1)', () => {
    const command = `echo hi\n${FENCE}\nrequest: Bash command=echo hi`;
    expect(parseDetail(naxDetail(command))).toBeNull();
  });
  test('a summary nax did not cut must equal the command exactly (a diverging summary is not parsed)', () => {
    const detail = [FENCE, 'ls', FENCE, 'request: Bash command=rm', 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
  test('a real split that diverges plus one crafted consistent fake is still not parsed (two candidates)', () => {
    const fakeSummary = 'Bash command=DIFFERENT';
    const command = `ls\n${FENCE}\nrequest: ${fakeSummary}\n${FENCE}\nrequest: Bash command=ls`;
    const detail = [FENCE, command, FENCE, `request: ${fakeSummary}`, 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
  test('a 200-char summary is checked as a prefix (nax cut it)', () => {
    const command = 'x'.repeat(187);   // "Bash command=" + 187 = exactly 200
    expect(parseDetail(naxDetail(command))?.command).toBe(command);
  });
  test('stage comes from the detail line', () => {
    expect(parseDetail(naxDetail('ls', { stage: 'review' }))?.stage).toBe('review');
  });
  test('a missing tail line is not parsed', () => {
    expect(parseDetail(naxDetail('ls').split('\n').slice(0, -1).join('\n'))).toBeNull();
  });
  test('a reason with a newline is not parsed (tail lines are single-line)', () => {
    expect(parseDetail(naxDetail('ls', { reason: 'a\nb' }))).toBeNull();
  });
  test('a non-Bash summary that does not repeat the command is not parsed', () => {
    const detail = [FENCE, 'ls', FENCE, 'request: Exec argv=ls', 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
});
```

- [ ] **Step 3: Implement the parser**

`apps/runner/src/approvals/detail-parser.ts`:

```ts
/**
 * Spec §4.3 / plan D256: parses nax's flattened approval `detail` (ask-link-session.ts:181-188, identical in v0.83.2
 * and main):
 *
 *   ```\n<command>\n```\n[N secret value(s) masked; the approved command contains them\n]request: <summary>\nruns in: <root>\nreason:  <reason>\nstage:   <stage>
 *
 * `<summary>` is `<tool> command=<command>` masked, trimmed and cut to 200 chars, so it may span lines. Any ambiguity
 * returns null: the caller then relays the raw text, never a guessed command.
 */
export interface ParsedDetail { command: string; maskedCount: number; root: string; reason: string; stage: string }

const FENCE = '```';
const FOOTER = /^(\d+) secret value\(s\) masked; the approved command contains them\n/;
const TAIL = [/^runs in: (.*)$/, /^reason:\s+(.*)$/, /^stage:\s+(.*)$/] as const;
const REQUEST = 'request: ';
/** nax cuts the summary to this many chars (tools/ask-request.ts MAX_ASK_SUMMARY_CHARS). */
const SUMMARY_MAX = 200;

export function parseDetail(detail: string): ParsedDetail | null {
  const lines = detail.split('\n');
  if (lines.length < 4) return null;
  const tail = lines.slice(-3).map((line, i) => TAIL[i].exec(line)?.[1]);
  if (tail.some((value) => value === undefined)) return null;
  const [root, reason, stage] = tail as [string, string, string];
  const head = lines.slice(0, -3).join('\n');
  if (!head.startsWith(`${FENCE}\n`)) return null;

  const separator = `\n${FENCE}\n`;
  const candidates: Array<{ command: string; maskedCount: number; summary: string }> = [];
  for (let at = head.indexOf(separator, FENCE.length); at !== -1; at = head.indexOf(separator, at + 1)) {
    let rest = head.slice(at + separator.length);
    const footer = FOOTER.exec(rest);
    if (footer) rest = rest.slice(footer[0].length);
    if (rest.startsWith(REQUEST)) {
      candidates.push({ command: head.slice(FENCE.length + 1, at), maskedCount: footer ? Number(footer[1]) : 0, summary: rest.slice(REQUEST.length) });
    }
  }
  // A command that itself contains a closing fence followed by a request line makes the layout ambiguous: never guess.
  if (candidates.length !== 1) return null;
  const { command, maskedCount, summary } = candidates[0];
  const tool = summary.split(' ', 1)[0];
  const recon = `${tool} command=${command}`;
  // Exact when nax did not cut the summary; a prefix only when it did (exactly 200 chars).
  const consistent = summary.length < SUMMARY_MAX ? recon.trim() === summary : summary.length === SUMMARY_MAX && recon.startsWith(summary);
  if (tool === '' || !consistent) return null;
  return { command, maskedCount, root, reason, stage };
}
```

Run: `cd apps/runner && bun test src/approvals/detail-parser.spec.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing payload builder tests**

`apps/runner/src/approvals/ask-payload.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { buildAskPayload, capUtf8 } from './ask-payload';

const a = fixtures.a_simple;

describe('buildAskPayload (spec §1.2, §4.2, plan D283)', () => {
  test('a parsed ask: top-level stage/story/feature, detail-derived command/root/reason, deadline = createdAt + timeout', () => {
    expect(buildAskPayload(a)).toEqual({
      naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date(a.createdAt + a.timeout).toISOString(),
      command: 'bun run test', commandTruncated: false, maskedCount: 0, root: '/work/repo', stage: 'execution',
      storyId: 'US-001', featureName: 'demo-feature', reason: 'matched ask rule', options: ['allow', 'allow-remember', 'deny'],
    });
  });
  test('options without allow-remember are kept as offered', () => {
    expect(buildAskPayload(fixtures.d_longest_padding)?.options).toEqual(['allow', 'deny']);
    expect(buildAskPayload(fixtures.d_longest_padding)?.storyId).toBeNull();
  });
  test('an unparsed detail is relayed raw with an empty command (D255: the request line stays, it is masked)', () => {
    const payload = buildAskPayload({ ...a, detail: 'something nax changed\nruns in: /w' });
    expect(payload).toEqual(expect.objectContaining({ command: '', rawDetail: 'something nax changed\nruns in: /w', commandTruncated: false }));
  });
  test('a command over 12 KiB is cut on a UTF-8 boundary and flagged', () => {
    const command = `echo ${'é'.repeat(7000)}`;
    const detail = ['```', command, '```', `request: ${`Bash command=${command}`.slice(0, 200)}`, 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    const payload = buildAskPayload({ ...a, detail })!;
    expect(payload.commandTruncated).toBe(true);
    expect(Buffer.byteLength(payload.command, 'utf8')).toBeLessThanOrEqual(12_288);
    expect(payload.command).not.toContain('�');
  });
  const naxDetail = (command: string, over: { root?: string; reason?: string } = {}) =>
    ['```', command, '```', `request: ${`Bash command=${command}`.slice(0, 200)}`, `runs in: ${over.root ?? '/w'}`, `reason:  ${over.reason ?? 'r'}`, 'stage:   execution'].join('\n');
  const json = (p: unknown) => Buffer.byteLength(JSON.stringify(p), 'utf8');

  test.each([
    ['a 12 KiB command of quotes (JSON doubles them)', { detail: naxDetail('"'.repeat(12_288)) }],
    ['control characters (JSON escapes them to 6 bytes)', { detail: naxDetail('\u0001'.repeat(4_000)) }],
    ['500-char 3-byte short fields', { detail: naxDetail('x'.repeat(12_000), { root: `/${'中'.repeat(500)}`, reason: '中'.repeat(500) }), featureName: '中'.repeat(500), storyId: '中'.repeat(500) }],
  ])('%s still fits the 16 KiB sync event limit, flagged', (_name, over) => {
    const payload = buildAskPayload({ ...a, ...over })!;
    expect(json(payload)).toBeLessThanOrEqual(16_384);
    expect(payload.commandTruncated).toBe(true);
    expect(payload.command.length).toBeGreaterThan(0);
  });
  test('a command-less ask whose summary nax cut at 200 chars is deny-only (D256)', () => {
    const detail = `request: Write path=${'p'.repeat(191)}\nruns in: /w\nreason:  r\nstage:   execution`;
    expect(buildAskPayload({ ...a, detail })?.commandTruncated).toBe(true);
    expect(buildAskPayload({ ...a, detail: 'request: Write path=/a\nruns in: /w\nreason:  r\nstage:   execution' })?.commandTruncated).toBe(false);
  });
  test.each([
    ['a non-approval ask', { metadata: {} }],
    ['an ask without deny', { options: [{ key: 'allow', label: 'Allow once' }] }],
    ['a non-numeric createdAt', { createdAt: 'now' }],
    ['a missing timeout', { timeout: undefined }],
    ['a bad id', { id: 'trigger-cost-1' }],
  ])('%s is not relayable', (_name, over) => {
    expect(buildAskPayload({ ...a, ...over } as never)).toBeNull();
  });
});

describe('capUtf8', () => {
  test('keeps short text and cuts long text on a character boundary', () => {
    expect(capUtf8('abc', 10)).toEqual({ text: 'abc', cut: false });
    expect(capUtf8('ééé', 5)).toEqual({ text: 'éé', cut: true });
  });
});
```

- [ ] **Step 5: Implement the builder**

`apps/runner/src/approvals/ask-payload.ts`:

```ts
import { APPROVAL_TEXT_MAX_BYTES, type ApprovalOption, type ApprovalRequestEventPayload } from '@nathapp/fleet-protocol';
import { SYNC_LIMITS, byteLength } from '../sync/batch';
import { parseDetail } from './detail-parser';

/** The `InteractionRequest` nax's webhook plugin POSTs, plus `callbackUrl` (nax interaction/types.ts:17-42). */
export interface NaxAskRequest {
  id: string;
  type: string;
  featureName: string;
  storyId?: string;
  stage: string;
  summary?: string;
  detail?: string;
  options?: Array<{ key: string; label?: string }>;
  timeout?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
  callbackUrl: string;
}

const ASK_ID = /^ask-[0-9a-f]{1,16}$/;
const OPTION_KEYS: readonly string[] = ['allow', 'allow-remember', 'deny'];
/** Runner-side cap for the short text fields, so the event fits 16 KiB even with a 12 KiB command (server allows 2000). */
const FIELD_MAX_CHARS = 500;
/** `request: ` plus nax's 200-char summary: a line this long may have been cut by nax. */
const SUMMARY_LINE_MAX = 'request: '.length + 200;

export function capUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;   // never split a multi-byte character
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

const short = (value: string): string => value.slice(0, FIELD_MAX_CHARS);

/**
 * Spec §4.2 / plan D256, D257, D283: one relayable bash ask, or null (not an approval ask, or not one nax would
 * accept an answer for). The caller answers null with 400, so nax's POST fails and nax denies.
 */
export function buildAskPayload(request: NaxAskRequest): ApprovalRequestEventPayload | null {
  if (request.metadata?.['approvalPrompt'] !== true || request.type !== 'choose' || !ASK_ID.test(request.id)) return null;
  if (typeof request.createdAt !== 'number' || typeof request.timeout !== 'number' || typeof request.detail !== 'string') return null;
  const options = (request.options ?? []).map((o) => o.key).filter((k): k is ApprovalOption => OPTION_KEYS.includes(k));
  if (!options.includes('deny') || new Set(options).size !== options.length) return null;
  const parsed = parseDetail(request.detail);
  const base = {
    naxAskId: request.id,
    deadlineAt: new Date(request.createdAt + request.timeout).toISOString(),
    maskedCount: parsed?.maskedCount ?? 0,
    root: short(parsed?.root ?? ''),
    stage: short(parsed?.stage ?? request.stage),
    storyId: request.storyId === undefined ? null : short(request.storyId),
    featureName: short(request.featureName),
    reason: short(parsed?.reason ?? ''),
    options,
  };
  if (parsed) {
    const command = capUtf8(parsed.command, APPROVAL_TEXT_MAX_BYTES);
    return fit({ ...base, command: command.text, commandTruncated: command.cut });
  }
  const raw = capUtf8(request.detail, APPROVAL_TEXT_MAX_BYTES);
  // Plan D256: a command-less ask (Write/Edit) carries only nax's 200-char summary; a cut one must not be approvable.
  const cutSummary = !request.detail.startsWith('```') && request.detail.split('\n').some((l) => l.startsWith('request: ') && l.length >= SUMMARY_LINE_MAX);
  return fit({ ...base, command: '', rawDetail: raw.text, commandTruncated: raw.cut || cutSummary });
}

/**
 * The server refuses the whole sync when an event's JSON exceeds 16 KiB (`sync-request.parser.ts` parseEvent), so the
 * payload must fit. `byteLength` (batch.ts) measures JSON, which escapes quotes, backslashes and control characters, so
 * the text is shrunk proportionally in raw bytes until the JSON fits. A shrunk text is flagged: deny-only.
 */
function fit(payload: ApprovalRequestEventPayload): ApprovalRequestEventPayload {
  const field: 'command' | 'rawDetail' = payload.rawDetail !== undefined ? 'rawDetail' : 'command';
  let fitted = payload;
  for (let round = 0; round < 8 && byteLength(fitted) > SYNC_LIMITS.payloadBytes; round += 1) {
    const text = fitted[field] ?? '';
    const jsonBytes = byteLength(text);
    const allowed = jsonBytes - (byteLength(fitted) - SYNC_LIMITS.payloadBytes) - 64;
    const target = Math.max(0, Math.floor((Buffer.byteLength(text, 'utf8') * allowed) / jsonBytes));
    fitted = { ...fitted, [field]: capUtf8(text, target).text, commandTruncated: true };
  }
  return fitted;
}
```

(`byteLength` in `batch.ts:30` is `Buffer.byteLength(JSON.stringify(value), 'utf8')`. The prototype of this function
was run against: a 12,288-byte command of `"`, 4,000 `\u0001` characters, and 500-char 3-byte fields; each result was
16,319 bytes and flagged.)

- [ ] **Step 6: Run tests**

Run: `cd apps/runner && bun test src/approvals && bun run type-check`
Expected: PASS. (`resolveJsonModule` is on via the shared base tsconfig; `with { type: 'json' }` is the runner's
convention, as in `src/version.ts`.)

- [ ] **Step 7: Commit**

```bash
git add apps/runner/src/approvals apps/runner/test/fixtures/nax-asks
git commit -m "feat(runner): parse nax approval asks into relay events (S1.5 2a)"
```

---

### Task 14: `ApprovalReceiver` and the signed nax callback

**Files:**
- Create: `apps/runner/src/approvals/approval-receiver.ts` (+ `.spec.ts`)
- Create: `apps/runner/src/approvals/nax-callback.ts` (+ `.spec.ts`)

**Interfaces:**
- Produces:
  - `signNax(secret: string, body: string | Uint8Array): string` (hex HMAC-SHA256)
  - `verifyNax(secret: string, body: Uint8Array, header: string | null): boolean` (constant time)
  - `class ApprovalReceiver { static start(opts: { port: number; secret: string; onRequest: (body: unknown) => Promise<number> }): ApprovalReceiver; readonly port: number; stop(): void }`
  - `interface NaxAnswer { requestId: string; action: 'choose' | 'skip' | 'approve'; value?: string; respondedBy: string; respondedAt: number }`
  - `postToNax(callbackUrl: string, secret: string, answer: NaxAnswer, opts?: { timeoutMs?: number; fetch?: typeof fetch }): Promise<{ ok: true } | { ok: false; detail: string }>`
  - `callbackUrlFor(request: { id: unknown; callbackUrl: unknown }): string | null` (D274)

- [ ] **Step 1: Write the failing tests**

`nax-callback.spec.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { callbackUrlFor, postToNax, signNax, verifyNax } from './nax-callback';

describe('signing (nax webhook.ts:578-583)', () => {
  test('matches the captured nax signature', () => {
    const body = '{"requestId":"ask-1f2e3d4c","action":"choose","value":"allow","respondedBy":"koda:alice","respondedAt":1790000005000}';
    expect(signNax('test-secret', body)).toBe('90407e68331b948e945a8bc4a686f294d65a8d95aa105981a2bec0ba3df7e5cf');
  });
  test('verify accepts the right signature and refuses wrong, missing and odd-length ones', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const good = signNax('s', body);
    expect(verifyNax('s', body, good)).toBe(true);
    expect(verifyNax('s', body, good.replace(/.$/, good.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(verifyNax('s', body, null)).toBe(false);
    expect(verifyNax('s', body, 'abc')).toBe(false);
  });
});

describe('callbackUrlFor (plan D274)', () => {
  test.each([
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-1' }, 'http://127.0.0.1:43210/nax/interact/ask-1'],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-2' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://evil.example:43210/nax/interact/ask-1' }, null],
    [{ id: 'ask-1', callbackUrl: 'https://127.0.0.1:43210/nax/interact/ask-1' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ask-1?x=1' }, null],
    [{ id: 'ask-1', callbackUrl: 'http://127.0.0.1:99999/nax/interact/ask-1' }, null],
    [{ id: 'ix-US_1.2-size-gate', callbackUrl: 'http://127.0.0.1:43210/nax/interact/ix-US_1.2-size-gate' }, 'http://127.0.0.1:43210/nax/interact/ix-US_1.2-size-gate'],
    [{ id: 'a/b', callbackUrl: 'http://127.0.0.1:43210/nax/interact/a/b' }, null],
  ])('%p -> %p', (input, expected) => {
    expect(callbackUrlFor(input)).toBe(expected);
  });
});

describe('postToNax (spec §4.4)', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => { server?.stop(true); server = null; });

  test('POSTs the signed answer with a numeric respondedAt', async () => {
    let seen: { body: string; sig: string | null } | null = null;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (req) => { seen = { body: await req.text(), sig: req.headers.get('x-nax-signature') }; return new Response('OK'); } });
    const answer = { requestId: 'ask-1', action: 'choose' as const, value: 'allow', respondedBy: 'koda', respondedAt: 1790000005000 };
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', answer)).toEqual({ ok: true });
    expect(JSON.parse(seen!.body)).toEqual(answer);
    expect(seen!.sig).toBe(signNax('s', seen!.body));
  });
  test.each([[429], [401], [503]])('a %i is callback_failed:<status>', async (status) => {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no', { status }) });
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'choose', value: 'deny', respondedBy: 'koda', respondedAt: 1 }))
      .toEqual({ ok: false, detail: `callback_failed:${status}` });
  });
  test('an unreachable callback is callback_failed:error; a slow one callback_failed:timeout', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
    const deadPort = gone.port;
    gone.stop(true);   // a port that was just free and is now closed
    expect(await postToNax(`http://127.0.0.1:${deadPort}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'skip', respondedBy: 'koda', respondedAt: 1 }))
      .toEqual({ ok: false, detail: 'callback_failed:error' });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    expect(await postToNax(`http://127.0.0.1:${server.port}/nax/interact/ask-1`, 's', { requestId: 'ask-1', action: 'skip', respondedBy: 'koda', respondedAt: 1 }, { timeoutMs: 50 }))
      .toEqual({ ok: false, detail: 'callback_failed:timeout' });
  });
});
```

`approval-receiver.spec.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { ApprovalReceiver } from './approval-receiver';
import { signNax } from './nax-callback';

let receiver: ApprovalReceiver | null = null;
afterEach(() => { receiver?.stop(); receiver = null; });

const post = (port: number, body: string, sig: string | null, path = '/ask') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-nax-signature': sig } : {}) }, body });

describe('ApprovalReceiver (spec §4.2)', () => {
  test('binds 127.0.0.1 on a free port and hands a verified body to onRequest', async () => {
    const seen: unknown[] = [];
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async (b) => { seen.push(b); return 200; } });
    expect(receiver.port).toBeGreaterThan(0);
    const body = JSON.stringify({ id: 'ask-1' });
    expect((await post(receiver.port, body, signNax('s', body))).status).toBe(200);
    expect(seen).toEqual([{ id: 'ask-1' }]);
  });
  test('401 on a bad or missing signature; onRequest not called', async () => {
    let calls = 0;
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => { calls += 1; return 200; } });
    expect((await post(receiver.port, '{}', signNax('other', '{}'))).status).toBe(401);
    expect((await post(receiver.port, '{}', null)).status).toBe(401);
    expect(calls).toBe(0);
  });
  test('413 over 64 KiB', async () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    const body = JSON.stringify({ pad: 'x'.repeat(70_000) });
    expect((await post(receiver.port, body, signNax('s', body))).status).toBe(413);
  });
  test('404 for another path or method; 400 for invalid JSON', async () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    expect((await post(receiver.port, '{}', signNax('s', '{}'), '/other')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${receiver.port}/ask`)).status).toBe(404);
    expect((await post(receiver.port, 'not json', signNax('s', 'not json'))).status).toBe(400);
  });
  test('starting on a taken port throws', () => {
    receiver = ApprovalReceiver.start({ port: 0, secret: 's', onRequest: async () => 200 });
    expect(() => ApprovalReceiver.start({ port: receiver!.port, secret: 's', onRequest: async () => 200 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/runner && bun test src/approvals/nax-callback.spec.ts src/approvals/approval-receiver.spec.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/runner/src/approvals/nax-callback.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** nax's answer schema (webhook.ts:56-62): `respondedAt` is a number (epoch ms), never an ISO string. */
export interface NaxAnswer { requestId: string; action: 'choose' | 'skip' | 'approve'; value?: string; respondedBy: string; respondedAt: number }

// Plan D274: nax does not URL-encode ids (`ix-<storyId>-size-gate` carries a story id), so accept any id without / ? # or whitespace.
const CALLBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/nax\/interact\/([^/?#\s]{1,200})$/;
const DEFAULT_TIMEOUT_MS = 10_000;

export function signNax(secret: string, body: string | Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyNax(secret: string, body: Uint8Array, header: string | null): boolean {
  if (header === null || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

/** Plan D274: the runner only ever POSTs to nax's own loopback callback for this exact ask. */
export function callbackUrlFor(request: { id: unknown; callbackUrl: unknown }): string | null {
  if (typeof request.id !== 'string' || typeof request.callbackUrl !== 'string') return null;
  const match = CALLBACK.exec(request.callbackUrl);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535 || match[2] !== request.id) return null;
  return request.callbackUrl;
}

/** Spec §4.4: one signed POST with a 10 s deadline. No retry: a failed answer ends in nax's timeout deny. */
export async function postToNax(callbackUrl: string, secret: string, answer: NaxAnswer, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const body = JSON.stringify(answer);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (opts.fetch ?? fetch)(callbackUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-nax-signature': signNax(secret, body) }, body, signal: controller.signal,
    });
    return res.status === 200 ? { ok: true } : { ok: false, detail: `callback_failed:${res.status}` };
  } catch {
    return { ok: false, detail: controller.signal.aborted ? 'callback_failed:timeout' : 'callback_failed:error' };
  } finally {
    clearTimeout(timer);
  }
}
```

`apps/runner/src/approvals/approval-receiver.ts`:

```ts
import { verifyNax } from './nax-callback';

/** Spec §4.2: nax's webhook bodies are small; anything bigger is not an ask. */
export const MAX_ASK_BODY_BYTES = 64 * 1024;

export interface ReceiverOptions {
  readonly port: number;
  readonly secret: string;
  /** Called with a verified, parsed body; returns the HTTP status for nax. Must answer quickly (nax POST timeout 30 s). */
  readonly onRequest: (body: unknown) => Promise<number>;
}

/** Spec §4.1: one loopback receiver per non-raw job; nax's webhook plugin POSTs its asks to `/ask`. */
export class ApprovalReceiver {
  private constructor(private readonly server: ReturnType<typeof Bun.serve>) {}

  /** Throws when the port is taken (a READOPT re-bind reports that; plan D273). */
  static start(options: ReceiverOptions): ApprovalReceiver {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: options.port,
      maxRequestBodySize: MAX_ASK_BODY_BYTES,
      fetch: (req) => ApprovalReceiver.handle(req, options),
    });
    return new ApprovalReceiver(server);
  }

  get port(): number {
    return this.server.port ?? 0;
  }

  stop(): void {
    this.server.stop(true);
  }

  private static async handle(req: Request, options: ReceiverOptions): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/ask') return new Response('Not Found', { status: 404 });
    if (Number(req.headers.get('content-length') ?? '0') > MAX_ASK_BODY_BYTES) return new Response('Payload Too Large', { status: 413 });
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_ASK_BODY_BYTES) return new Response('Payload Too Large', { status: 413 });
    if (!verifyNax(options.secret, raw, req.headers.get('x-nax-signature'))) return new Response('Unauthorized', { status: 401 });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    const status = await options.onRequest(body).catch(() => 500);
    return new Response(status === 200 ? 'OK' : 'Rejected', { status });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/runner && bun test src/approvals && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/approvals
git commit -m "feat(runner): loopback approval receiver and signed nax callback (S1.5 2a)"
```

---

### Task 15: Journal tables and `ApprovalRelay` (ask in, answer out)

**Files:**
- Modify: `apps/runner/src/journal/schema.ts` (`SCHEMA_SQL`), `src/journal/journal.ts`, `src/journal/types.ts`
  (+ `journal.spec.ts`)
- Modify: `apps/runner/src/supervisor/job-events.ts` (+ spec)
- Create: `apps/runner/src/approvals/approval-relay.ts` (+ `.spec.ts`)

**Interfaces:**
- Consumes: `ApprovalReceiver`, `postToNax`, `callbackUrlFor`, `NaxAnswer` (Task 14); `buildAskPayload`,
  `NaxAskRequest` (Task 13); `ApprovalAnswerPayload` (Task 1).
- Produces (journal; everything keyed by `(jobId, leaseEpoch)`, plan D285):
  - `interface ApprovalReceiverRow { jobId: string; leaseEpoch: number; port: number; secret: string }`
  - `interface PendingAskRow { jobId: string; leaseEpoch: number; naxAskId: string; callbackUrl: string; deadlineAt: string }`
  - `putApprovalReceiver(row): void`, `getApprovalReceiver(jobId, leaseEpoch): ApprovalReceiverRow | null`,
    `insertPendingAsk(row): boolean` (false when it already existed), `getPendingAsk(jobId, leaseEpoch, naxAskId)`,
    `deletePendingAsk(jobId, leaseEpoch, naxAskId)`, `deleteApprovalState(jobId, leaseEpoch)`,
    `approvalStateKeys(): Array<{ jobId: string; leaseEpoch: number }>`
- Produces (events): `JobEvents.approvalRequest(payload: ApprovalRequestEventPayload): void`
- Produces (relay):
  - `interface RelayEndpoint { url: string; secret: string }`
  - `class ApprovalRelay { open(job: JobRow): Promise<RelayEndpoint>; resume(job: JobRow): Promise<void>; close(jobId: string, leaseEpoch: number): Promise<void>; sweepOrphans(active: readonly JobRow[]): void; answer(command: FleetCommandOut): Promise<{ result: 'ok' | 'rejected'; detail?: string }>; stopAll(): void }`
- `journal.pendingEvents(jobId, leaseEpoch, limit)` takes a **limit** (`LIMIT ?`); the tests pass `1_000`.

- [ ] **Step 1: Write the failing journal tests**

`journal.spec.ts` (inside the existing `beforeEach` `Journal.open(':memory:', now)` setup):

```ts
describe('approval relay state (S1.5 §4.1, plan D278, D285)', () => {
  test('stores a receiver per (job, epoch) and pending asks per ask id', () => {
    journal.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 1, port: 43_210, secret: 'a'.repeat(64) });
    expect(journal.getApprovalReceiver('j1', 1)).toEqual({ jobId: 'j1', leaseEpoch: 1, port: 43_210, secret: 'a'.repeat(64) });
    expect(journal.getApprovalReceiver('j1', 2)).toBeNull();

    const ask = { jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-1', callbackUrl: 'http://127.0.0.1:5/nax/interact/ask-1', deadlineAt: '2026-10-04T10:10:00.000Z' };
    expect(journal.insertPendingAsk(ask)).toBe(true);
    expect(journal.insertPendingAsk(ask)).toBe(false);   // a re-sent nax POST is idempotent (D286)
    expect(journal.getPendingAsk('j1', 1, 'ask-1')).toEqual(ask);
    journal.deletePendingAsk('j1', 1, 'ask-1');
    expect(journal.getPendingAsk('j1', 1, 'ask-1')).toBeNull();
  });
  test('deleteApprovalState removes one epoch only (D285)', () => {
    journal.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 1, port: 1, secret: 's' });
    journal.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 2, port: 2, secret: 's' });
    journal.insertPendingAsk({ jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-1', callbackUrl: 'u', deadlineAt: 'd' });
    journal.deleteApprovalState('j1', 1);
    expect(journal.approvalStateKeys()).toEqual([{ jobId: 'j1', leaseEpoch: 2 }]);
    expect(journal.getPendingAsk('j1', 1, 'ask-1')).toBeNull();
  });
});
```

`job-events.spec.ts`:

```ts
test('approvalRequest appends an approval_request event (and wakes the sync loop through onWrite)', () => {
  let writes = 0;
  journal.onWrite(() => { writes += 1; });
  events.approvalRequest(ASK_PAYLOAD);
  expect(journal.pendingEvents('j1', 1, 1_000).at(-1)).toEqual(expect.objectContaining({ type: 'approval_request', payload: ASK_PAYLOAD }));
  expect(writes).toBeGreaterThan(0);
});
```

(`ASK_PAYLOAD` = `buildAskPayload(fixtures.a_simple)!`, importing the fixture with `with { type: 'json' }`.)

- [ ] **Step 2: Implement the journal and event**

`schema.ts`, append to `SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS approval_receivers (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  port INTEGER NOT NULL,
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, lease_epoch)
);
CREATE TABLE IF NOT EXISTS pending_asks (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  nax_ask_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, lease_epoch, nax_ask_id)
);
```

Update the schema comment line to add "S1.5 2a: approval_receivers, pending_asks (plan D278)". `types.ts`: the two
row interfaces above. `journal.ts` (prepared statements in the file's style; `this.now` is the injected clock,
`private readonly now: Now`, line 41):

```ts
  putApprovalReceiver(row: ApprovalReceiverRow): void {
    this.db.query('INSERT OR REPLACE INTO approval_receivers (job_id, lease_epoch, port, secret, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.jobId, row.leaseEpoch, row.port, row.secret, this.now().toISOString());
  }

  getApprovalReceiver(jobId: string, leaseEpoch: number): ApprovalReceiverRow | null {
    const r = this.db.query('SELECT port, secret FROM approval_receivers WHERE job_id = ? AND lease_epoch = ?')
      .get(jobId, leaseEpoch) as { port: number; secret: string } | null;
    return r ? { jobId, leaseEpoch, port: r.port, secret: r.secret } : null;
  }

  /** Plan D286: false when the ask was already journalled (a re-sent nax POST). */
  insertPendingAsk(row: PendingAskRow): boolean {
    const result = this.db.query('INSERT OR IGNORE INTO pending_asks (job_id, lease_epoch, nax_ask_id, callback_url, deadline_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.jobId, row.leaseEpoch, row.naxAskId, row.callbackUrl, row.deadlineAt, this.now().toISOString());
    return result.changes > 0;
  }

  getPendingAsk(jobId: string, leaseEpoch: number, naxAskId: string): PendingAskRow | null {
    const r = this.db.query('SELECT callback_url, deadline_at FROM pending_asks WHERE job_id = ? AND lease_epoch = ? AND nax_ask_id = ?')
      .get(jobId, leaseEpoch, naxAskId) as { callback_url: string; deadline_at: string } | null;
    return r ? { jobId, leaseEpoch, naxAskId, callbackUrl: r.callback_url, deadlineAt: r.deadline_at } : null;
  }

  deletePendingAsk(jobId: string, leaseEpoch: number, naxAskId: string): void {
    this.db.query('DELETE FROM pending_asks WHERE job_id = ? AND lease_epoch = ? AND nax_ask_id = ?').run(jobId, leaseEpoch, naxAskId);
  }

  /** Plan D285: per epoch, like `abandon`; a stale epoch must never touch a live requeued epoch's relay. */
  deleteApprovalState(jobId: string, leaseEpoch: number): void {
    this.tx(() => {
      this.db.query('DELETE FROM pending_asks WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
      this.db.query('DELETE FROM approval_receivers WHERE job_id = ? AND lease_epoch = ?').run(jobId, leaseEpoch);
    });
  }

  approvalStateKeys(): Array<{ jobId: string; leaseEpoch: number }> {
    const rows = this.db.query('SELECT job_id, lease_epoch FROM approval_receivers UNION SELECT job_id, lease_epoch FROM pending_asks')
      .all() as Array<{ job_id: string; lease_epoch: number }>;
    return rows.map((r) => ({ jobId: r.job_id, leaseEpoch: r.lease_epoch }));
  }
```

`abandon(jobId, leaseEpoch)` and each `(jobId, leaseEpoch)` that `prune` removes also call
`deleteApprovalState(jobId, leaseEpoch)` inside their transaction.

`job-events.ts`:

```ts
  /** Spec §4.2 step 4: the ask goes up in the job's report; ask-payload.ts already fit it to the 16 KiB limit. */
  approvalRequest(payload: ApprovalRequestEventPayload): void {
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'approval_request', payload);
  }
```

Run: `cd apps/runner && bun test src/journal src/supervisor/job-events.spec.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing relay tests**

`apps/runner/src/approvals/approval-relay.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { assignFor } from '../../test/helpers/assign';
import { Journal } from '../journal/journal';
import { ApprovalRelay } from './approval-relay';
import { signNax } from './nax-callback';

const NOW = new Date('2026-10-04T10:00:00Z');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

let journal: Journal;
let relay: ApprovalRelay;
let nax: ReturnType<typeof Bun.serve> | null;
let answers: Array<{ path: string; body: unknown; sig: string | null }>;
let naxStatus: number;

beforeEach(() => {
  journal = Journal.open(':memory:', () => NOW);
  journal.insertJob({ assign: assignFor('RUN', { jobId: 'j1', bashMode: 'escalate' }), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/tmp/j1' });
  journal.updateJob('j1', 1, { state: 'RUNNING' });
  relay = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => 'f'.repeat(64) });
  answers = []; naxStatus = 200;
  nax = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (req) => {
    answers.push({ path: new URL(req.url).pathname, body: await req.json(), sig: req.headers.get('x-nax-signature') });
    return new Response('OK', { status: naxStatus });
  } });
});
afterEach(() => { relay.stopAll(); nax?.stop(true); journal.close(); });

const job = () => journal.getJob('j1', 1)!;
const events = () => journal.pendingEvents('j1', 1, 1_000);
const callbackFor = (id: string) => `http://127.0.0.1:${nax!.port}/nax/interact/${id}`;
const naxAsk = (id = 'ask-1f2e3d4c') => ({ ...fixtures.a_simple, id, callbackUrl: callbackFor(id) });
const prompt = (id: string) => ({ id, type: 'choose', featureName: 'fa', stage: 'pre-flight', summary: 's', createdAt: 1, timeout: 300_000, fallback: 'continue', callbackUrl: callbackFor(id) });
async function send(endpoint: { url: string; secret: string }, body: object): Promise<number> {
  const raw = JSON.stringify(body);
  return (await fetch(endpoint.url, { method: 'POST', headers: { 'x-nax-signature': signNax(endpoint.secret, raw) }, body: raw })).status;
}
const answerCommand = (choice: string, naxAskId = 'ask-1f2e3d4c') =>
  ({ commandId: 'c1', type: 'APPROVAL_ANSWER', jobId: 'j1', leaseEpoch: 1, payload: { approvalId: 'a1', naxAskId, choice } }) as never;

describe('ApprovalRelay (spec §4)', () => {
  test('open journals the port and secret and returns the /ask url; open again is the same endpoint', async () => {
    const endpoint = await relay.open(job());
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ask$/);
    expect(endpoint.secret).toBe('f'.repeat(64));
    expect(journal.getApprovalReceiver('j1', 1)?.port).toBe(Number(new URL(endpoint.url).port));
    expect(await relay.open(job())).toEqual(endpoint);
  });

  test('a re-prepare whose stored port is taken gets a fresh port and secret (D286)', async () => {
    const endpoint = await relay.open(job());
    relay.stopAll();
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(endpoint.url).port), fetch: () => new Response('x') });
    try {
      const fresh = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => '0'.repeat(64) });
      const reopened = await fresh.open(job());
      expect(reopened.url).not.toBe(endpoint.url);
      expect(reopened.secret).toBe('0'.repeat(64));
      expect(journal.getApprovalReceiver('j1', 1)?.port).toBe(Number(new URL(reopened.url).port));
      fresh.stopAll();
    } finally {
      squatter.stop(true);
    }
  });

  test('an ask is journalled, appended once as approval_request, and answered 200', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, naxAsk())).toBe(200);
    expect(await send(endpoint, naxAsk())).toBe(200);   // a re-sent POST: no second event (D286)
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toEqual(expect.objectContaining({ deadlineAt: new Date(fixtures.a_simple.createdAt + fixtures.a_simple.timeout).toISOString() }));
    expect(events().filter((e) => e.type === 'approval_request')).toHaveLength(1);
    expect(events().at(-1)).toEqual(expect.objectContaining({ type: 'approval_request', payload: expect.objectContaining({ naxAskId: 'ask-1f2e3d4c', command: 'bun run test' }) }));
  });

  test('a foreign callbackUrl is refused 400 and nothing is journalled (D274)', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, { ...naxAsk(), callbackUrl: 'http://10.0.0.1:1/nax/interact/ask-1f2e3d4c' })).toBe(400);
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toBeNull();
  });

  test('size gate and paused prompts get the headless answers; any other prompt gets skip (D277, Review Focus 6)', async () => {
    const endpoint = await relay.open(job());
    expect(await send(endpoint, prompt('ix-US-001-size-gate'))).toBe(200);
    expect(await send(endpoint, prompt('ix-US_1.2-paused-resume'))).toBe(200);
    expect(await send(endpoint, { ...prompt('trigger-cost-warning-1-abcdef12'), type: 'confirm', metadata: { trigger: 'cost-warning' } })).toBe(200);
    await Bun.sleep(100);
    const byPath = Object.fromEntries(answers.map((a) => [a.path.split('/').pop(), a.body]));
    expect(byPath['ix-US-001-size-gate']).toEqual(expect.objectContaining({ action: 'approve' }));
    expect(byPath['ix-US_1.2-paused-resume']).toEqual(expect.objectContaining({ action: 'choose', value: 'keep' }));
    expect(byPath['trigger-cost-warning-1-abcdef12']).toEqual(expect.objectContaining({ action: 'skip' }));
    expect(events().filter((e) => e.type === 'approval_request')).toHaveLength(0);
  });

  test('answer POSTs the signed choice, acks ok and clears the ask', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    expect(await relay.answer(answerCommand('allow'))).toEqual({ result: 'ok' });
    expect(answers[0]?.body).toEqual({ requestId: 'ask-1f2e3d4c', action: 'choose', value: 'allow', respondedBy: 'koda', respondedAt: expect.any(Number) });
    expect(answers[0]?.sig).toBe(signNax('f'.repeat(64), JSON.stringify(answers[0]?.body)));
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).toBeNull();
  });

  test('an unknown ask is rejected ask_not_pending', async () => {
    await relay.open(job());
    expect(await relay.answer(answerCommand('allow', 'ask-99999999'))).toEqual({ result: 'rejected', detail: 'ask_not_pending' });
  });

  test('a job that is no longer RUNNING is rejected job_not_running', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    journal.updateJob('j1', 1, { state: 'UPLOADING' });
    expect(await relay.answer(answerCommand('allow'))).toEqual({ result: 'rejected', detail: 'job_not_running' });
    expect(answers).toHaveLength(0);
  });

  test('a 429 from nax is callback_failed:429 and the ask stays journalled', async () => {
    const endpoint = await relay.open(job());
    await send(endpoint, naxAsk());
    naxStatus = 429;
    expect(await relay.answer(answerCommand('deny'))).toEqual({ result: 'rejected', detail: 'callback_failed:429' });
    expect(journal.getPendingAsk('j1', 1, 'ask-1f2e3d4c')).not.toBeNull();
  });

  test('a malformed answer payload is rejected, never posted', async () => {
    await relay.open(job());
    expect(await relay.answer({ ...answerCommand('allow'), payload: { approvalId: 'a1', naxAskId: 'ask-1f2e3d4c', choice: 'yes' } } as never))
      .toEqual({ result: 'rejected', detail: 'invalid payload' });
  });

  test('close stops that epoch receiver and deletes only its journal state (D285)', async () => {
    const endpoint = await relay.open(job());
    journal.putApprovalReceiver({ jobId: 'j1', leaseEpoch: 2, port: 1, secret: 's' });
    await relay.close('j1', 1);
    expect(journal.getApprovalReceiver('j1', 1)).toBeNull();
    expect(journal.getApprovalReceiver('j1', 2)).not.toBeNull();
    await expect(fetch(endpoint.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  test('resume re-binds the journalled port and secret (Review Focus 3); a taken port throws', async () => {
    const endpoint = await relay.open(job());
    relay.stopAll();                       // the daemon died; the journal survives
    const fresh = new ApprovalRelay({ journal, log: silent, now: () => NOW, randomSecret: () => '0'.repeat(64) });
    await fresh.resume(job());
    expect(await send(endpoint, naxAsk())).toBe(200);   // same url, same secret
    fresh.stopAll();
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(endpoint.url).port), fetch: () => new Response('x') });
    try {
      await expect(new ApprovalRelay({ journal, log: silent, now: () => NOW }).resume(job())).rejects.toThrow();
    } finally {
      squatter.stop(true);
    }
  });

  test('sweepOrphans deletes state of (job, epoch) pairs that are not active', async () => {
    await relay.open(job());
    journal.putApprovalReceiver({ jobId: 'old', leaseEpoch: 3, port: 1, secret: 's' });
    relay.sweepOrphans([job()]);
    expect(journal.approvalStateKeys()).toEqual([{ jobId: 'j1', leaseEpoch: 1 }]);
  });
});
```

- [ ] **Step 4: Implement the relay**

`apps/runner/src/approvals/approval-relay.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { ApprovalAnswerPayload, FleetCommandOut } from '@nathapp/fleet-protocol';
import { errorMessage } from '../errors';
import type { Journal } from '../journal/journal';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';
import { JobEvents } from '../supervisor/job-events';
import type { Now } from '../time';
import { ApprovalReceiver } from './approval-receiver';
import { buildAskPayload, type NaxAskRequest } from './ask-payload';
import { callbackUrlFor, postToNax, type NaxAnswer } from './nax-callback';

export interface RelayEndpoint { url: string; secret: string }
export interface ApprovalRelayDeps {
  readonly journal: Journal;
  readonly log: Logger;
  readonly now: Now;
  readonly randomSecret?: () => string;
}
type Outcome = { result: 'ok' | 'rejected'; detail?: string };

const CHOICES: readonly string[] = ['allow', 'allow-remember', 'deny'];
const SIZE_GATE = /^ix-.+-size-gate$/;
const PAUSED_RESUME = /^ix-.+-paused-resume$/;
const key = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;
const urlOf = (port: number): string => `http://127.0.0.1:${port}/ask`;

/**
 * Plan D277: a headless nax run never prompts (null chain). With the relay's chain present, two prompts that are not
 * trigger-guarded would fire; answer them as headless behaves: a size-flagged story runs, a paused story stays paused.
 */
function headlessAnswer(id: string): Pick<NaxAnswer, 'action' | 'value'> & { known: boolean } {
  if (SIZE_GATE.test(id)) return { action: 'approve', known: true };
  if (PAUSED_RESUME.test(id)) return { action: 'choose', value: 'keep', known: true };
  return { action: 'skip', known: false };
}

/** Spec §4: one loopback receiver per non-raw (job, epoch); asks go up as events, answers come down as commands. */
export class ApprovalRelay {
  private readonly receivers = new Map<string, ApprovalReceiver>();

  constructor(private readonly deps: ApprovalRelayDeps) {}

  /** Spec §4.1: fresh 32-byte secret, free port. Re-prepare: same endpoint, or a fresh one if its port was taken (D286). */
  async open(job: JobRow): Promise<RelayEndpoint> {
    const k = key(job.jobId, job.leaseEpoch);
    const stored = this.deps.journal.getApprovalReceiver(job.jobId, job.leaseEpoch);
    if (stored) {
      if (this.receivers.has(k)) return { url: urlOf(stored.port), secret: stored.secret };
      try {
        this.bind(job, stored.port, stored.secret);
        return { url: urlOf(stored.port), secret: stored.secret };
      } catch {
        // nax was not spawned yet (this is prepare), so nothing holds the old address: take a new one.
      }
    }
    const secret = (this.deps.randomSecret ?? (() => randomBytes(32).toString('hex')))();
    const receiver = this.bind(job, 0, secret);
    this.deps.journal.putApprovalReceiver({ jobId: job.jobId, leaseEpoch: job.leaseEpoch, port: receiver.port, secret });
    return { url: urlOf(receiver.port), secret };
  }

  /** Spec §4.5 / plan D273: READOPT re-binds the journalled port and secret (a live nax holds them). Throws when taken. */
  async resume(job: JobRow): Promise<void> {
    const stored = this.deps.journal.getApprovalReceiver(job.jobId, job.leaseEpoch);
    if (!stored || this.receivers.has(key(job.jobId, job.leaseEpoch))) return;
    this.bind(job, stored.port, stored.secret);
  }

  /** Plan D285: one epoch only. */
  async close(jobId: string, leaseEpoch: number): Promise<void> {
    const k = key(jobId, leaseEpoch);
    this.receivers.get(k)?.stop();
    this.receivers.delete(k);
    this.deps.journal.deleteApprovalState(jobId, leaseEpoch);
  }

  /** Daemon start: a crash can leave state of (job, epoch) pairs that have since ended. */
  sweepOrphans(active: readonly JobRow[]): void {
    const live = new Set(active.map((j) => key(j.jobId, j.leaseEpoch)));
    for (const s of this.deps.journal.approvalStateKeys()) if (!live.has(key(s.jobId, s.leaseEpoch))) this.deps.journal.deleteApprovalState(s.jobId, s.leaseEpoch);
  }

  /** Daemon stop or crash: stop listening; the journal keeps the state for the next boot's READOPT. */
  stopAll(): void {
    for (const receiver of this.receivers.values()) receiver.stop();
    this.receivers.clear();
  }

  /** Spec §4.4: APPROVAL_ANSWER -> one signed POST to nax's callback. Never throws (a throw would re-run it). */
  async answer(command: FleetCommandOut): Promise<Outcome> {
    const p = command.payload as Partial<ApprovalAnswerPayload>;
    if (typeof p.naxAskId !== 'string' || typeof p.choice !== 'string' || !CHOICES.includes(p.choice)) return { result: 'rejected', detail: 'invalid payload' };
    const { journal } = this.deps;
    const ask = journal.getPendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
    if (!ask) return { result: 'rejected', detail: 'ask_not_pending' };
    const row = journal.getJob(command.jobId, command.leaseEpoch);
    if (!row || row.doneAt !== null || row.state !== 'RUNNING') return { result: 'rejected', detail: 'job_not_running' };
    const receiver = journal.getApprovalReceiver(command.jobId, command.leaseEpoch);
    if (!receiver) return { result: 'rejected', detail: 'job_not_running' };
    const posted = await postToNax(ask.callbackUrl, receiver.secret, {
      requestId: p.naxAskId, action: 'choose', value: p.choice, respondedBy: 'koda', respondedAt: Date.now(),
    });
    if (!posted.ok) return { result: 'rejected', detail: posted.detail };
    journal.deletePendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
    return { result: 'ok' };
  }

  private bind(job: JobRow, port: number, secret: string): ApprovalReceiver {
    const receiver = ApprovalReceiver.start({ port, secret, onRequest: (body) => this.onRequest(job, secret, body) });
    this.receivers.set(key(job.jobId, job.leaseEpoch), receiver);
    return receiver;
  }

  /** Spec §4.2: answer nax at once; the human's answer arrives later through `answer`. */
  private async onRequest(job: JobRow, secret: string, body: unknown): Promise<number> {
    const events = new JobEvents(this.deps.journal, job.jobId, job.leaseEpoch, this.deps.log);
    const request = (body ?? {}) as NaxAskRequest;
    const callbackUrl = callbackUrlFor(request);
    if (!callbackUrl) {
      events.lifecycle('warn', 'nax interaction refused: unexpected callback address');
      return 400;
    }
    if (request.metadata?.['approvalPrompt'] !== true) {
      const reply = headlessAnswer(request.id);
      events.lifecycle(reply.known ? 'info' : 'warn', `nax prompt ${request.id} answered ${reply.value ?? reply.action} (headless behaviour, plan D277)`);
      const { known: _known, ...answer } = reply;
      void postToNax(callbackUrl, secret, { requestId: request.id, ...answer, respondedBy: 'koda', respondedAt: Date.now() })
        .then((posted) => { if (!posted.ok) this.deps.log.warn('nax prompt answer failed', { jobId: job.jobId, detail: posted.detail }); })
        .catch((error: unknown) => this.deps.log.warn('nax prompt answer failed', { jobId: job.jobId, error: errorMessage(error) }));
      return 200;
    }
    const payload = buildAskPayload(request);
    if (!payload) {
      events.lifecycle('warn', 'nax approval ask refused: not a relayable ask');
      return 400;
    }
    this.deps.journal.tx(() => {
      const fresh = this.deps.journal.insertPendingAsk({ jobId: job.jobId, leaseEpoch: job.leaseEpoch, naxAskId: payload.naxAskId, callbackUrl, deadlineAt: payload.deadlineAt });
      if (fresh) events.approvalRequest(payload);   // plan D286: a re-sent nax POST appends nothing
    });
    return 200;
  }
}
```

(`NaxAnswer.action` is `'choose' | 'skip' | 'approve'` since Task 14; nax's response schema accepts all three.)

- [ ] **Step 5: Run tests**

Run: `cd apps/runner && bun test src/approvals src/journal src/supervisor && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/approvals apps/runner/src/journal apps/runner/src/supervisor/job-events.ts apps/runner/src/supervisor/job-events.spec.ts
git commit -m "feat(runner): approval relay with journalled receivers and pending asks (S1.5 2a)"
```

---

### Task 16: Job profile overlay and the executor, run and daemon wiring

**Files:**
- Create: `apps/runner/src/approvals/nax-triggers.ts` (+ `.spec.ts`), `apps/runner/test/live/nax-triggers.live.spec.ts`
- Modify: `apps/runner/src/executor/job-profile.ts` (+ `job-profile.spec.ts`)
- Modify: `apps/runner/src/executor/job-executor.ts`, `src/executor/host-executor.ts` (+ `test/unit/host-executor.spec.ts`)
- Create: `apps/runner/test/helpers/no-approvals.ts` (like `no-credentials.ts`)
- Modify (every `new HostExecutor({...})` must now pass `approvals`; add `approvals: NO_APPROVALS`):
  `test/unit/host-executor.spec.ts:39,227,265`, `test/unit/host-executor-auth.spec.ts:55,134`, `test/unit/job-check.spec.ts:46`
  (grep `new HostExecutor(` for any other site)
- Modify: `apps/runner/src/supervisor/job-run.ts:91-110,170-185` (+ `job-run.spec.ts`)
- Modify: `apps/runner/test/helpers/fake-executor.ts`
- Modify: `apps/runner/src/daemon/daemon.ts:100-216` (relay construction, HostExecutor deps, orphan sweep, stop/crash;
  the `CommandHandler` wiring is Task 17)

**Interfaces:**
- Consumes: `ApprovalRelay`, `RelayEndpoint` (Task 15).
- Produces:
  - `NAX_TRIGGER_NAMES` (nine names)
  - `interface RelayOverlay { bashMode: 'gated' | 'escalate'; approvalTimeoutSec: number; endpoint: RelayEndpoint }`
  - `jobProfileContent(outputDir: string, projectName: string, relay?: RelayOverlay): Record<string, unknown>`
  - `writeJobProfile(naxHome, jobId, outputDir, projectName, relay?: RelayOverlay)` (mode 0600)
  - `JobExecutor.resumeApprovals(job: JobRow): Promise<void>` and `JobExecutor.releaseApprovals(job: JobRow): Promise<void>` (D285)
  - `HostExecutorDeps.approvals: Pick<ApprovalRelay, 'open' | 'close' | 'resume'>` (a `type` import: a value import
    would create an executor -> approvals -> supervisor import cycle)
  - `NO_APPROVALS` test helper

- [ ] **Step 1: Write the failing tests**

`nax-triggers.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { NAX_TRIGGER_NAMES } from './nax-triggers';

test('pins nax TriggerName (interaction/types.ts:78-87, identical at v0.83.2 and main a755a5464)', () => {
  expect([...NAX_TRIGGER_NAMES]).toEqual([
    'security-review', 'cost-exceeded', 'merge-conflict', 'cost-warning', 'max-retries', 'pre-merge', 'human-review', 'story-oversized', 'review-gate',
  ]);
});
```

`test/live/nax-triggers.live.spec.ts` (runs only with a nax checkout; documents the drift check):

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAX_TRIGGER_NAMES } from '../../src/approvals/nax-triggers';

const naxSource = process.env['NAX_SOURCE_DIR'];
const describeLive = naxSource ? describe : describe.skip;

describeLive('nax TriggerName drift (spec §4.1)', () => {
  test('the runner list equals nax\'s union', () => {
    const text = readFileSync(join(naxSource!, 'packages/nax/src/interaction/types.ts'), 'utf8');
    const union = /export type TriggerName =([\s\S]*?);/.exec(text)?.[1] ?? '';
    expect([...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual([...NAX_TRIGGER_NAMES].sort());
  });
});
```

`job-profile.spec.ts` (add `import { NAX_TRIGGER_NAMES } from '../approvals/nax-triggers';`, `stat` from
`node:fs/promises`, and the spec's temp-dir helper for a `naxHome`):

```ts
describe('relay overlay (spec §4.1, plan D275)', () => {
  let naxHome!: string;
  beforeEach(async () => { naxHome = await tmp.make('profile-relay'); });
  const relay = { bashMode: 'escalate' as const, approvalTimeoutSec: 90, endpoint: { url: 'http://127.0.0.1:43210/ask', secret: 'f'.repeat(64) } };

  test('a raw job keeps the bare overlay', () => {
    expect(jobProfileContent('/out', 'acme-app-1234abcd')).toEqual({ outputDir: '/out', name: 'acme-app-1234abcd' });
  });

  test('a relayed job sets bash approval, the webhook plugin and silences every trigger', () => {
    expect(jobProfileContent('/out', 'p', relay)).toEqual({
      outputDir: '/out', name: 'p',
      execution: { bashApproval: 'escalate', approvalTimeout: 90_000 },
      interaction: {
        plugin: 'webhook',
        config: { url: 'http://127.0.0.1:43210/ask', secret: 'f'.repeat(64), requireSecret: true, callbackPort: 0 },
        triggers: Object.fromEntries(NAX_TRIGGER_NAMES.map((n) => [n, false])),
      },
    });
  });

  test('the written profile is mode 0600 (it now holds a secret)', async () => {
    const path = await writeJobProfile(naxHome, 'j1', '/out', 'p', relay);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).interaction.config.secret).toBe('f'.repeat(64));
  });
});
```

`apps/runner/test/helpers/no-approvals.ts`:

```ts
import type { ApprovalRelay } from '../../src/approvals/approval-relay';

/** A raw-only executor never opens a relay; tests that do not exercise it pass this (mirrors NO_CREDENTIALS). */
export const NO_APPROVALS: Pick<ApprovalRelay, 'open' | 'close' | 'resume'> = {
  open: async () => { throw new Error('NO_APPROVALS: a test opened a relay without providing one'); },
  close: async () => undefined,
  resume: async () => undefined,
};
```

`test/unit/host-executor.spec.ts`: give `world()` a fourth parameter `approvals = NO_APPROVALS` passed into
`new HostExecutor({ ..., approvals })`, then:

```ts
describe('HostExecutor approval relay (plan D273, D285)', () => {
  const spy = () => ({
    open: mock(async () => ({ url: 'http://127.0.0.1:1/ask', secret: 's' })),
    close: mock(async () => undefined),
    resume: mock(async () => undefined),
  });

  test('prepare opens the relay and writes the overlay for a non-raw RUN', async () => {
    const approvals = spy();
    const w = await world('RUN', { bashMode: 'gated', approvalTimeoutSec: 60 }, {}, approvals);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
    expect(approvals.open).toHaveBeenCalledTimes(1);
    const profile = JSON.parse(await readFile(jobProfilePath(w.naxHome, 'cjob1'), 'utf8'));
    expect(profile.execution).toEqual({ bashApproval: 'gated', approvalTimeout: 60_000 });
  });
  test('a raw RUN never opens the relay', async () => {
    const approvals = spy();
    const w = await world('RUN', {}, {}, approvals);
    await w.ex.prepare(w.row);
    expect(approvals.open).not.toHaveBeenCalled();
  });
  test('cleanup and releaseApprovals close this epoch only', async () => {
    const approvals = spy();
    const w = await world('RUN', { bashMode: 'escalate' }, {}, approvals);
    await w.ex.cleanup(w.row);
    expect(approvals.close).toHaveBeenCalledWith('cjob1', 1);
    await w.ex.releaseApprovals(w.row);
    expect(approvals.close).toHaveBeenCalledTimes(2);
  });
  test('resumeApprovals resumes only non-raw jobs', async () => {
    const approvals = spy();
    const raw = await world('RUN', {}, {}, approvals);
    await raw.ex.resumeApprovals(raw.row);
    expect(approvals.resume).not.toHaveBeenCalled();
    const gated = await world('RUN', { bashMode: 'escalate' }, {}, approvals);
    await gated.ex.resumeApprovals(gated.row);
    expect(approvals.resume).toHaveBeenCalledTimes(1);
  });
});
```

(`mock` comes from `bun:test`; `world()` builds a real origin and checkout, so the prepare test exercises the whole
prepare path.)

`job-run.spec.ts`, next to the `resumeCredentials` cases:

```ts
test('a watch start resumes approvals before the first tick', async () => {
  const b = build();
  b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
  b.ex.alive = true;
  let resumedFirst = false;
  b.ex.onTick = (n) => { if (n === 1) resumedFirst = b.ex.calls.includes('resumeApprovals:j1'); if (n >= 1) b.ex.alive = false; };
  await b.run.start('watch');
  expect(resumedFirst).toBe(true);
});
test('abandon of a lower epoch releases its relay even when a higher epoch is live (plan D285)', async () => {
  const b = build();
  b.ex.onTick = () => undefined;
  const running = b.run.start('prepare');
  await waitFor(() => b.ex.calls.includes('spawn:j1') && b.ex.ticks >= 1);
  b.journal.insertJob({ assign: assignFor('RUN'), leaseEpoch: 2, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });   // the requeued attempt
  const callsBefore = b.ex.calls.length;
  await b.run.abandon();
  await running;
  expect(b.ex.calls.slice(callsBefore)).toEqual(['releaseCredentials:j1', 'releaseApprovals:j1']);   // no reap, no cleanup
});
test('a failing approvals resume is a lifecycle error and the run is still watched (plan D273)', async () => {
  const b = build();
  b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
  b.ex.alive = true;
  b.ex.resumeApprovalsError = new Error('EADDRINUSE');
  b.ex.dieAfterTicks(1);
  await b.run.start('watch');
  expect(events(b).some((e) => e.type === 'lifecycle' && JSON.stringify(e.payload).includes('approval relay could not be restored'))).toBe(true);
  expect(b.ex.calls.some((c) => c.startsWith('tick'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/runner && bun run test`
Expected: FAIL.

- [ ] **Step 3: Implement the triggers list and profile**

`apps/runner/src/approvals/nax-triggers.ts`:

```ts
/**
 * nax `TriggerName` (interaction/types.ts:78-87, identical at v0.83.2 and main). Spec §4.1 / A1: every trigger is set
 * to false in the per-job profile, so a relayed job behaves like a headless run apart from bash asks.
 * `test/live/nax-triggers.live.spec.ts` checks this list against a nax checkout (NAX_SOURCE_DIR).
 */
export const NAX_TRIGGER_NAMES = [
  'security-review', 'cost-exceeded', 'merge-conflict',
  'cost-warning', 'max-retries', 'pre-merge', 'human-review', 'story-oversized',
  'review-gate',
] as const;
```

`job-profile.ts`:

```ts
export interface RelayOverlay {
  readonly bashMode: 'gated' | 'escalate';
  readonly approvalTimeoutSec: number;
  readonly endpoint: RelayEndpoint;
}

/** Spec §4.1 / plan D275. Profiles deep-merge after the repo config, so these keys win; callbackPort 0 overrides a pinned one. */
export function jobProfileContent(outputDir: string, projectName: string, relay?: RelayOverlay): Record<string, unknown> {
  if (!relay) return { outputDir, name: projectName };
  return {
    outputDir, name: projectName,
    execution: { bashApproval: relay.bashMode, approvalTimeout: relay.approvalTimeoutSec * 1000 },
    interaction: {
      plugin: 'webhook',
      config: { url: relay.endpoint.url, secret: relay.endpoint.secret, requireSecret: true, callbackPort: 0 },
      triggers: Object.fromEntries(NAX_TRIGGER_NAMES.map((name) => [name, false])),
    },
  };
}

/** A raw overlay is appended last to the chain; it must exist until nax exits (SP-1). Mode 0600: it may hold the relay secret. */
export async function writeJobProfile(naxHome: string, jobId: string, outputDir: string, projectName: string, relay?: RelayOverlay): Promise<string> {
  const path = jobProfilePath(naxHome, jobId);
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(jobProfileContent(outputDir, projectName, relay), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}
```

- [ ] **Step 4: Implement the executor, run and daemon wiring**

`job-executor.ts`, `JobExecutor`:

```ts
  /** Plan D273: READOPT `watch` re-binds the job's approval receiver (no-op for raw jobs). */
  resumeApprovals(job: JobRow): Promise<void>;
  /** Plan D285: an abandoned epoch closes its own receiver even when a live higher epoch keeps the profile. */
  releaseApprovals(job: JobRow): Promise<void>;
```

`host-executor.ts`: add `import type { ApprovalRelay } from '../approvals/approval-relay';` and
`readonly approvals: Pick<ApprovalRelay, 'open' | 'close' | 'resume'>;` to `HostExecutorDeps`.
In `prepare`, replace the `writeJobProfile` line:

```ts
      await mkdir(outDir, { recursive: true });
      const relay = assign.bashMode === 'raw' ? undefined
        : { bashMode: assign.bashMode, approvalTimeoutSec: assign.approvalTimeoutSec, endpoint: await this.deps.approvals.open(job) };
      await writeJobProfile(this.deps.config.naxHome, job.jobId, outDir, projectNameFor(assign.repo.owner, assign.repo.name), relay);
```

`cleanup`:

```ts
  async cleanup(job: JobRow): Promise<void> {
    try {
      await deleteJobProfile(this.deps.config.naxHome, job.jobId);
    } finally {
      try {
        await this.deps.approvals.close(job.jobId, job.leaseEpoch);
      } finally {
        await this.deps.credentials.release(job);
      }
    }
  }

  async resumeApprovals(job: JobRow): Promise<void> {
    if (job.assign.bashMode !== 'raw') await this.deps.approvals.resume(job);
  }

  async releaseApprovals(job: JobRow): Promise<void> {
    await this.deps.approvals.close(job.jobId, job.leaseEpoch);
  }
```

`fake-executor.ts`: add `resumeApprovalsError: Error | null = null;` and

```ts
  async resumeApprovals(job: JobRow): Promise<void> {
    this.calls.push(`resumeApprovals:${job.jobId}`);
    if (this.resumeApprovalsError) throw this.resumeApprovalsError;
  }

  async releaseApprovals(job: JobRow): Promise<void> {
    this.calls.push(`releaseApprovals:${job.jobId}`);
  }
```

`job-run.ts` `abandonCleanup` (line ~170), right after the `releaseCredentials` call and before the
`higherEpochLive()` early return:

```ts
      // Plan D285: the receiver is per epoch, like the credential socket (D90).
      await this.deps.executor.releaseApprovals(row).catch((error: unknown) => {
        this.deps.log.warn('approval relay release failed', { jobId: this.jobId, error: errorMessage(error) });
      });
```

The existing D64 case at `job-run.spec.ts:494` asserts the exact list `['releaseCredentials:j1']`; change it to
`['releaseCredentials:j1', 'releaseApprovals:j1']`.

`job-run.ts` `lifecycle`:

```ts
    if (from === 'watch') {
      await this.resumeCredentials();
      await this.resumeApprovals();
    }
```

```ts
  /** Plan D273: asks raised before the restart stay answerable; a failure means they time out and nax denies. */
  private async resumeApprovals(): Promise<void> {
    const row = this.row();
    if (!row) return;
    try {
      await this.deps.executor.resumeApprovals(row);
    } catch (error) {
      this.events.lifecycle('error', `approval relay could not be restored: ${errorMessage(error)}; pending asks will time out and be denied`);
    }
  }
```

`daemon.ts`:
- After the journal is opened (~line 100): `const approvals = new ApprovalRelay({ journal, log, now });`
- Next to `sweepOrphanProfiles` (~line 115): `approvals.sweepOrphans(journal.activeJobs());`
- Pass `approvals` into `new HostExecutor({ ..., approvals })` (~line 130). (`CommandHandler` gets it in Task 17.)
- In both `stop` (~line 193) and `crash` (~line 213), right after `supervisor.shutdown();`: `approvals.stopAll();` (no
  new asks are accepted while runs drain; a killed daemon's listeners die with it, and READOPT re-binds).

- [ ] **Step 5: Run tests**

Run: `cd apps/runner && bun run test && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src apps/runner/test
git commit -m "feat(runner): relay overlay in the job profile, executor and readopt wiring (S1.5 2a)"
```

---

### Task 17: `APPROVAL_ANSWER` in the command handler

**Files:**
- Modify: `apps/runner/src/supervisor/command-handler.ts:10-89` (+ `command-handler.spec.ts`)
- Modify: `apps/runner/src/daemon/daemon.ts:144` (`new CommandHandler({ ..., approvals })`)

**Interfaces:**
- Consumes: `ApprovalRelay.answer` (Task 15).
- Produces: `CommandHandlerDeps.approvals: Pick<ApprovalRelay, 'answer'>`.

- [ ] **Step 1: Write the failing tests**

`command-handler.spec.ts`: its `build()` returns `{ time, journal, ex, supervisor, handler }`; create
`const approvals = { answer: mock(async (): Promise<{ result: 'ok' | 'rejected'; detail?: string }> => ({ result: 'ok' })) };`
inside `build()`, pass it in the `CommandHandler` deps and return it. In the cases below, start with
`const { handler, approvals } = build();`:

```ts
describe('APPROVAL_ANSWER (spec §4.4)', () => {
  const answer = { commandId: 'c9', type: 'APPROVAL_ANSWER', jobId: 'j1', leaseEpoch: 1, payload: { approvalId: 'a1', naxAskId: 'ask-1', choice: 'allow' } } as const;

  test('delegates to the relay and acks its outcome', async () => {
    expect(await handler.handle([answer])).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok' }]);
    approvals.answer.mockResolvedValueOnce({ result: 'rejected', detail: 'callback_failed:429' });
    expect(await handler.handle([{ ...answer, commandId: 'c10' }])).toEqual([{ commandId: 'c10', leaseEpoch: 1, result: 'rejected', detail: 'callback_failed:429' }]);
  });

  test('a re-sent answer is acked from the applied-command record; nax is not POSTed twice (Review Focus 4)', async () => {
    await handler.handle([answer]);
    expect(await handler.handle([answer])).toEqual([{ commandId: 'c9', leaseEpoch: 1, result: 'ok' }]);
    expect(approvals.answer).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/runner && bun test src/supervisor/command-handler.spec.ts`
Expected: FAIL (`unknown command type`).

- [ ] **Step 3: Implement**

`command-handler.ts`: add `import type { ApprovalRelay } from '../approvals/approval-relay';` and
`readonly approvals: Pick<ApprovalRelay, 'answer'>;` to `CommandHandlerDeps`; in `daemon.ts` pass `approvals` into
`new CommandHandler({ ... })`. In `apply`:

```ts
      case 'APPROVAL_ANSWER': {
        // Spec §4.4 / plan D276: inline, bounded by the 10 s callback deadline; recorded so a re-sent command is not re-POSTed.
        const outcome = await this.deps.approvals.answer(command);
        this.record(command, outcome);
        return outcome;
      }
```

- [ ] **Step 4: Run tests**

Run: `cd apps/runner && bun run test && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/supervisor/command-handler.ts apps/runner/src/supervisor/command-handler.spec.ts apps/runner/src/daemon/daemon.ts
git commit -m "feat(runner): answer relayed asks from APPROVAL_ANSWER commands (S1.5 2a)"
```

---

### Task 18: Fake nax `ask` scenario and the end-to-end runner integration

**Files:**
- Create: `apps/runner/test/fixtures/fake-nax-ask.ts`
- Modify: `apps/runner/test/fixtures/fake-nax.ts:41-55,80` (profile type, scenario hook)
- Modify: `apps/runner/test/integration/harness/world.ts:74,175-181` (dispatch input, approval helpers)
- Create: `apps/runner/test/integration/approval-relay.integration.spec.ts`

**Interfaces:**
- Consumes: everything; the real API in a subprocess (`world.ts`).
- Produces: `askOnce(profile: FakeProfile, outDir: string): Promise<void>` writing `<outDir>/fake-ask.json`;
  `World.dispatch` accepts `bashMode` and `approvalTimeoutSec`; `World.approvals(jobId)`; `World.decide(approvalId, decision)`.

- [ ] **Step 1: Write the fake nax ask**

`apps/runner/test/fixtures/fake-nax-ask.ts`:

```ts
/**
 * Plan D282: behaves like nax's webhook plugin for one bash ask (webhook.ts:255-277, 451-573): POSTs a real-shaped,
 * signed InteractionRequest to the profile's interaction url, serves its own loopback callback, verifies the answer's
 * signature, and records what it got (or that it timed out / its POST failed) in <outDir>/fake-ask.json.
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeProfile {
  outputDir?: string;
  execution?: { approvalTimeout?: number };
  interaction?: { plugin?: string; config?: { url?: string; secret?: string } };
}

const sign = (secret: string, body: string): string => createHmac('sha256', secret).update(body).digest('hex');

export async function askOnce(profile: FakeProfile, outDir: string): Promise<void> {
  const record = (result: object): void => writeFileSync(join(outDir, 'fake-ask.json'), `${JSON.stringify(result)}\n`);
  const url = profile.interaction?.config?.url;
  const secret = profile.interaction?.config?.secret;
  if (profile.interaction?.plugin !== 'webhook' || !url || !secret) return record({ skipped: 'no webhook in profile' });
  const timeout = profile.execution?.approvalTimeout ?? 600_000;
  const id = `ask-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;

  let settle: (answer: object) => void = () => undefined;
  const answered = new Promise<object>((resolve) => { settle = resolve; });
  const callback = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async (req) => {
      const body = await req.text();
      if (req.headers.get('x-nax-signature') !== sign(secret, body)) return new Response('Unauthorized', { status: 401 });
      settle(JSON.parse(body) as object);
      return new Response('OK');
    },
  });
  try {
    const request = {
      id, type: 'choose', featureName: 'fa', storyId: 'US-001', stage: 'execution', summary: 'Bash - approval required',
      detail: '```\nbun run test\n```\nrequest: Bash command=bun run test\nruns in: /work/repo\nreason:  matched ask rule\nstage:   execution',
      options: [{ key: 'allow', label: 'Allow once' }, { key: 'allow-remember', label: 'Allow + remember' }, { key: 'deny', label: 'Deny' }],
      timeout, fallback: 'abort', createdAt: Date.now(), metadata: { approvalPrompt: true },
      callbackUrl: `http://127.0.0.1:${callback.port}/nax/interact/${id}`,
    };
    const body = JSON.stringify(request);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nax-signature': sign(secret, body) }, body })
      .catch(() => null);
    if (!res || !res.ok) return record({ postFailed: res?.status ?? 'unreachable' });   // nax: deny / unavailable (A7)
    const answer = await Promise.race([answered, Bun.sleep(timeout).then(() => ({ timeout: true }))]);
    record(answer);
  } finally {
    callback.stop(true);
  }
}
```

`fake-nax.ts`: widen the profile type at line 47 to `FakeProfile` (import it). In `run()`, **after** the first
`flush()` (so `status.json` exists and the watcher has the run id; READOPT needs it) and before the `hang` block:

```ts
  if (scenario === 'ask') {
    // Keep status.json fresh while blocked: READOPT's `fresh(status)` needs a heartbeat within 120 s.
    const heartbeat = setInterval(flush, 200);
    try {
      await askOnce(profile, outDir);
    } finally {
      clearInterval(heartbeat);
    }
  }
```

- [ ] **Step 2: Extend the world harness**

`world.ts`:
- `dispatch` input type gains `bashMode?: 'raw' | 'gated' | 'escalate'; approvalTimeoutSec?: number;` and its body
  (line ~177) gains `...(input.bashMode ? { bashMode: input.bashMode } : {}), ...(input.approvalTimeoutSec ? { approvalTimeoutSec: input.approvalTimeoutSec } : {}),`.
- Add to `World` (the local `http(method, path, { body?, token? })` prefixes `/api` itself; `admin` is the global
  ADMIN token the harness registered; admin decide answers **200**):

```ts
  approvals(jobId: string): Promise<Array<{ id: string; status: string; resolvedBy: string | null; outcome: Record<string, unknown> | null }>>;
  decide(approvalId: string, decision: 'allow' | 'allow_for_job' | 'deny'): Promise<number>;
```

```ts
    async approvals(jobId) {
      const res = await http('GET', `/fleet/approvals?jobId=${encodeURIComponent(jobId)}`, { token: admin });
      return (res.body as { data: { records: Array<{ id: string; status: string; resolvedBy: string | null; outcome: Record<string, unknown> | null }> } }).data.records;
    },
    async decide(approvalId, decision) {
      return (await http('POST', `/fleet/approvals/${approvalId}/decide`, { token: admin, body: { decision } })).status;
    },
```

- [ ] **Step 3: Write the integration spec**

`apps/runner/test/integration/approval-relay.integration.spec.ts`:

```ts
/**
 * S1.5 2a end to end: real API + real runner daemon + fake nax. An escalate job raises an ask through the relay; a
 * decision in koda reaches nax's callback; the delivery is recorded; a daemon restart keeps the ask answerable.
 * Run: cd apps/runner && bun run test:integration test/integration/approval-relay.integration.spec.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, type TestRunner, type World } from './harness/world';
import { waitFor } from '../helpers/wait';

let world: World;
let runner: TestRunner;

beforeAll(async () => {
  world = await createWorld();
  runner = await world.addRunner('relay');
  await runner.start();
}, 120_000);
afterAll(async () => {
  await world.close();
});

const fakeAsk = (jobId: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(join(runner.jobDir(jobId), 'nax-out', 'fake-ask.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
async function pendingAsk(jobId: string): Promise<{ id: string }> {
  let found: { id: string } | undefined;
  await waitFor(async () => { found = (await world.approvals(jobId)).find((a) => a.status === 'pending'); return found !== undefined; }, { timeoutMs: 30_000 });
  return found!;
}

describe('approval relay (S1.5 2a)', () => {
  test('allow: the decision reaches nax signed, delivery ok, the job completes', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fa', bashMode: 'escalate', approvalTimeoutSec: 60 });
      const ask = await pendingAsk(jobId);
      expect(await world.decide(ask.id, 'allow')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ action: 'choose', value: 'allow', respondedBy: 'koda' }));
      await waitFor(async () => (await world.approvals(jobId))[0]?.outcome?.['delivery'] !== undefined, { timeoutMs: 15_000 });
      expect((await world.approvals(jobId))[0]?.outcome).toEqual({ delivery: expect.objectContaining({ result: 'ok' }) });
    });
  }, 120_000);

  test('deny: nax receives deny', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fb', bashMode: 'gated', approvalTimeoutSec: 60 });
      const ask = await pendingAsk(jobId);
      expect(await world.decide(ask.id, 'deny')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ value: 'deny' }));
    });
  }, 120_000);

  test('a daemon restart keeps a pending ask answerable (Review Focus 3)', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fc', bashMode: 'escalate', approvalTimeoutSec: 120 });
      const ask = await pendingAsk(jobId);
      runner.crash();
      await runner.start();                       // READOPT -> watch -> resumeApprovals re-binds port + secret
      expect(await world.decide(ask.id, 'allow')).toBe(200);
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 90_000);
      expect(fakeAsk(jobId)).toEqual(expect.objectContaining({ value: 'allow' }));
    });
  }, 180_000);

  test('a raw job writes no relay overlay and the fake records that it had no webhook', async () => {
    await world.withFake({ FAKE_NAX_SCENARIO: 'ask', FAKE_NAX_STEPS: '1' }, async () => {
      const jobId = await world.dispatch({ feature: 'fd' });
      await world.waitForJob(jobId, (j) => j.state === 'COMPLETED', 60_000);
      expect(fakeAsk(jobId)).toEqual({ skipped: 'no webhook in profile' });
      expect(await world.approvals(jobId)).toEqual([]);
    });
  }, 120_000);
});
```

Notes for the implementer:
- `waitFor(cond, { timeoutMs })` (`test/helpers/wait.ts`) accepts an async predicate.
- `runner.crash()` is the in-process stand-in for `kill -9`: it stops the daemon's listeners (Task 16 adds
  `approvals.stopAll()` there) but not the detached fake nax, which keeps its heartbeat while it waits.
- `FAKE_NAX_STEPS: '1'` keeps each run short; the fake asks after its first status flush and before the steps loop,
  so the job is RUNNING while the ask is pending.

- [ ] **Step 4: Run it**

Run: `cd apps/api && bun run test:db:up` then `cd apps/runner && bun run test:integration test/integration/approval-relay.integration.spec.ts`
Expected: PASS. Then the whole runner integration set: `bun run test:integration` — Expected: PASS (no regression in
the S1 flows; raw jobs are unchanged apart from protocol v2).

- [ ] **Step 5: Commit**

```bash
git add apps/runner/test
git commit -m "test(runner): end-to-end approval relay with a fake nax ask (S1.5 2a)"
```

---

### Task 19: Docs, spec corrections and whole-slice verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` (§ "Why the relay works", §1.2, §3, §4.3,
  §5 rule line, §8)
- Modify: `docs/deployment/runner.md`

- [ ] **Step 1: Spec corrections (D255, D259, D283)**

- In the "Why the relay works" heading, replace "(verified at nax `c6ab5d52c`, 2026-10-02, released 0.83.2; still
  true at `df55f5da3`)" with "(verified at nax v0.83.2 `bcfcddb01`, released 2026-10-01, and main `a755a5464`,
  2026-10-03; `c6ab5d52c` and `df55f5da3` are main commits in between with the same protocol code)".
- In that section's trigger bullet, after "keeps a trigger silent with a chain present", add: "Two prompts are not
  trigger-guarded (story-size gate `precheck-runner.ts:139`, paused stories `run-setup-init.ts:227`); the runner answers
  them as a headless run behaves (plan D277)." In ruling A1, add "(see plan D277 for the two unguarded prompts)".
- Replace the sentence "The `request:` line is the ask summary and is not masked the way the command is." with
  "The `request:` line is the ask summary: masked, cut to 200 chars, and may span lines because it embeds the
  command (`tools/ask-request.ts:38-51`)."
- §1.2 `nax_bash_escalate` payload: remove `rule`; replace the bullet "The `request:` line is not stored anywhere (it
  is unmasked)." with "There is no `rule`: nax prints `reason ?? rule` on one line. `stage`, `storyId` and
  `featureName` come from nax's top-level request fields." and change the `rawDetail` bullet to "`rawDetail` is kept
  only when the runner could not parse `detail` (4.3), verbatim and capped."
- §3 `approval_request` payload: remove `rule`.
- §4.3: replace "The `request:` value is dropped." with "There must be exactly one split candidate, and its request
  text must match the command (plan D256); anything else is 'unparsed'." and "(with any `request:` line removed,
  truncated to the cap)" (it wraps across two lines in the spec) with "(verbatim, truncated to the cap)".
- §4.2 step 2: replace "answers `skip` to its `callbackUrl` at once and records a lifecycle `warn`" with "answers it at
  once as a headless run would (plan D277) and records a lifecycle entry".
- §5 bash row-expand bullet: remove "rule".
- §8: delete the two "To verify in the 2a plan" bullets and add:

```markdown
- 2a plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2a-approval-relay.md`, D255-D287): the `detail`
  format is identical in nax v0.83.2 and main; the relay needs nax >= 0.83.0 (the runner floor 0.83.1 already
  exceeds it); the `request:` line is masked, so `rawDetail` keeps it; the payload has no `rule`; the detail parser
  refuses ambiguous splits; the size-gate and paused-story prompts are answered as headless runs behave; relay state
  is per (job, epoch); a decide that finds the ask expired or its job gone commits that close and then answers 409;
  `APPROVAL_ANSWER` acks are stored as `outcome.delivery`; static-capability runners never offer the relay.
```

- [ ] **Step 2: Runner deployment doc**

Add a section to `docs/deployment/runner.md`:

```markdown
## Bash approvals (S1.5)

A job dispatched with `bashMode: gated` or `escalate` relays nax's bash approval asks to the koda approvals inbox.

- Upgrade the **API first**: it accepts protocol v1 and v2. A v2 runner against an older API gets 426 and stops.
- The runner reports the relay only with nax 0.83.0 or later. Placement never sends a gated/escalate job to a runner
  without it (misfit `approvals_relay`; a pinned dispatch to such a runner is refused).
- For each such job the runner listens on `127.0.0.1` on a free port and writes the address and a per-job secret into
  `~/.nax/profiles/koda-job-<id>.json` (mode 0600). Nothing listens on other interfaces.
- The repo's nax config needs `Bash(...)` allow rules for the stages that should run commands; a stage without one
  never gets the Bash tool and never asks.
- If the daemon is down when nax asks, nax denies the command (it is not queued). After a restart the receiver
  re-binds its port; if that port was taken meanwhile, pending asks time out and are denied.
- An unanswered ask is denied at the job's `approvalTimeoutSec` (default 600 s).
```

- [ ] **Step 3: Whole-slice verification**

Run each and confirm green; paste failures into the task, do not proceed past one:

```bash
bun run generate && git diff --exit-code openapi.json          # no drift after Task 10
cd apps/api && bun run lint && bun run type-check && bun run test:unit && bun run test:scoped test/integration/fleet
cd ../runner && bun run lint && bun run type-check && bun run test && bun run test:integration
cd ../cli && bun run lint && bun run type-check && bun run test
cd ../web && bun run lint && bun run type-check && bun run test
```

Expected: all PASS. (`test:unit` excludes integration; the `test:scoped` line runs the fleet integration set.)

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(fleet): S1.5 2a spec corrections and runner relay deployment notes"
```

- [ ] **Step 5: Whole-branch review**

Dispatch one reviewer over `main..HEAD` with the spec, this plan and the Review Focus list. Fix Critical and
Important findings (at most two fix rounds), park minors in the PR body.

---

## Appendix A: captured nax asks (`apps/runner/test/fixtures/nax-asks/v0.83.2.json`)

Each value is the full JSON body nax's webhook plugin POSTs (InteractionRequest plus `callbackUrl`), produced by nax's
own builder at v0.83.2 and main (byte-identical). Copy verbatim.

```json
{
  "a_simple": {
    "id": "ask-1f2e3d4c",
    "type": "choose",
    "featureName": "demo-feature",
    "storyId": "US-001",
    "stage": "execution",
    "summary": "Bash - approval required",
    "detail": "```\nbun run test\n```\nrequest: Bash command=bun run test\nruns in: /work/repo\nreason:  matched ask rule\nstage:   execution",
    "options": [
      {
        "key": "allow",
        "label": "Allow once"
      },
      {
        "key": "allow-remember",
        "label": "Allow + remember"
      },
      {
        "key": "deny",
        "label": "Deny"
      }
    ],
    "timeout": 600000,
    "fallback": "abort",
    "createdAt": 1790000000000,
    "metadata": {
      "approvalPrompt": true
    },
    "callbackUrl": "http://127.0.0.1:43210/nax/interact/ask-1f2e3d4c"
  },
  "b_two_secrets": {
    "id": "ask-1f2e3d4c",
    "type": "choose",
    "featureName": "demo-feature",
    "storyId": "US-001",
    "stage": "execution",
    "summary": "Bash - approval required",
    "detail": "```\ncurl -H \"Authorization: Bearer x\" https://api.example.com -d key=[REDACTED:openai] && echo [REDACTED:github]\n```\n2 secret value(s) masked; the approved command contains them\nrequest: Bash command=curl -H \"Authorization: Bearer x\" https://api.example.com -d key=[REDACTED:openai] && echo [REDACTED:github]\nruns in: /work/repo\nreason:  matched ask rule\nstage:   execution",
    "options": [
      {
        "key": "allow",
        "label": "Allow once"
      },
      {
        "key": "allow-remember",
        "label": "Allow + remember"
      },
      {
        "key": "deny",
        "label": "Deny"
      }
    ],
    "timeout": 600000,
    "fallback": "abort",
    "createdAt": 1790000000000,
    "metadata": {
      "approvalPrompt": true
    },
    "callbackUrl": "http://127.0.0.1:43210/nax/interact/ask-1f2e3d4c"
  },
  "c_multiline_fence": {
    "id": "ask-1f2e3d4c",
    "type": "choose",
    "featureName": "demo-feature",
    "storyId": "US-001",
    "stage": "execution",
    "summary": "Bash - approval required",
    "detail": "```\ncat > notes.md <<'EOF'\n```ts\nconsole.log(1)\n```\nEOF\nbun run test\n```\nrequest: Bash command=cat > notes.md <<'EOF'\n```ts\nconsole.log(1)\n```\nEOF\nbun run test\nruns in: /work/repo\nreason:  matched ask rule\nstage:   execution",
    "options": [
      {
        "key": "allow",
        "label": "Allow once"
      },
      {
        "key": "allow-remember",
        "label": "Allow + remember"
      },
      {
        "key": "deny",
        "label": "Deny"
      }
    ],
    "timeout": 600000,
    "fallback": "abort",
    "createdAt": 1790000000000,
    "metadata": {
      "approvalPrompt": true
    },
    "callbackUrl": "http://127.0.0.1:43210/nax/interact/ask-1f2e3d4c"
  },
  "d_longest_padding": {
    "id": "ask-1f2e3d4c",
    "type": "choose",
    "featureName": "demo-feature",
    "stage": "execution",
    "summary": "Bash - approval required",
    "detail": "```\nrm -rf build/\n```\nrequest: Bash command=rm -rf build/\nruns in: /Users/someone/very/long/path/to/repo/packages/pkg-a\nreason:  command 'rm -rf build/' is not covered by any granted Bash pattern in the 'unrestricted-lite' profile; escalating to a human\nstage:   execution",
    "options": [
      {
        "key": "allow",
        "label": "Allow once"
      },
      {
        "key": "deny",
        "label": "Deny"
      }
    ],
    "timeout": 600000,
    "fallback": "abort",
    "createdAt": 1790000000000,
    "metadata": {
      "approvalPrompt": true
    },
    "callbackUrl": "http://127.0.0.1:43210/nax/interact/ask-1f2e3d4c"
  },
  "e_no_command_write": {
    "id": "ask-1f2e3d4c",
    "type": "choose",
    "featureName": "demo-feature",
    "stage": "execution",
    "summary": "Bash - approval required",
    "detail": "request: Bash\nruns in: /work/repo\nreason:  matched ask rule\nstage:   review",
    "options": [
      {
        "key": "allow",
        "label": "Allow once"
      },
      {
        "key": "deny",
        "label": "Deny"
      }
    ],
    "timeout": 600000,
    "fallback": "abort",
    "createdAt": 1790000000000,
    "metadata": {
      "approvalPrompt": true
    },
    "callbackUrl": "http://127.0.0.1:43210/nax/interact/ask-1f2e3d4c"
  }
}
```
