# Fleet S1.5 — Typed Approvals and the nax Approval Relay — Design

Builds C8 from the fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec", §9.3): typed approvals,
one approvals inbox, and a runner-hosted relay for nax's human-approval asks. It unlocks `bashMode: gated|escalate`
(S1 spec line 415) and fills the `BudgetIncident.approvalId` seam left by S1b (`2026-10-01-fleet-s1b-budgets-schedules-design.md`,
ruling B1). Where this document and S1 spec §9.3 disagree, this document wins.

## Goal

Let a human answer, from koda, the two decisions that end in a hard "no" today:

1. A budget hard stop pauses a scope and cancels its queued jobs. A human now chooses to keep it paused, or to raise
   the budget, resume, and re-queue the jobs the pause cancelled before they started.
2. A nax job in `gated` or `escalate` mode meets a shell command outside its grants and asks a human. The runner
   relays the ask to koda, a human allows or denies it in the web, and the answer reaches nax before its timeout.

## Success criteria

1. An unattended `escalate` RUN raises an ask, a developer allows it from the koda inbox, and the job continues;
   a denied ask makes nax refuse the command; an unanswered ask is denied at the job's `approvalTimeoutSec`.
2. A budget hard stop creates exactly one pending `budget_override_required` approval per policy. "Raise and resume"
   lifts the pause and re-queues the selected cancelled-before-start jobs; "Keep paused" leaves the pause.
3. A human learns of a pending approval from a badge in the web, and through a `fleet.approval.requested` project
   webhook they can point at a chat tool.
4. No failure path turns into an allow: every lost, late, truncated or undeliverable answer ends as a deny in nax.
5. A runner without the relay is never assigned a `gated` or `escalate` job.

## Rulings (user, 2026-10-02)

| # | Ruling |
|:--|:--|
| A1 | The relay carries **bash approval asks only**. nax trigger confirmations are **disabled** in the per-job profile, so runs behave as headless runs do today (see plan D277 for the two unguarded prompts). Relaying triggers is a later slice. |
| A2 | Notification is the **web inbox + badge** and an **outbound project webhook** (`fleet.approval.requested` / `fleet.approval.resolved`). No built-in chat integration. |
| A3 | The ask timeout is a **dispatch field** `approvalTimeoutSec` (default 600, range 30..3600), also on schedule templates. The runner writes it into the per-job nax profile; the approval shows a countdown to the same deadline. |
| A4 | "Raise and resume" **offers to re-queue** the jobs the pause cancelled before they started (checkbox list, all ticked by default). Jobs that were running are never re-run automatically (S1 manual-requeue rule). |
| A5 | Relay transport is **approach A**: asks go up as a new event type in `POST /fleet/runner/sync`; answers come down as a new `APPROVAL_ANSWER` command on the existing command channel. No new endpoints, auth or retry logic. |
| A6 | Bash asks are decided by **project DEVELOPER+**. Budget asks are decided by whoever may resume that policy today (S1b B3). Every project member can read the project inbox. |
| A7 | When the runner daemon is down, asks nax raises in that window are **denied** (nax's webhook POST fails, nax records `unavailable`). They are not queued. |
| A8 | The command text is **not** sent in outbound webhooks; it stays behind login. |
| A9 | A re-queue that fails on its own does **not** roll back the resume; per-job results are kept on the approval. |

Earlier rulings that still hold: single-instance API (in-process sweepers and bus), all runner git traffic brokered
(R5), `--max-cost` is the hard per-job cap (S1b B2), budget policy permissions (S1b B3).

### Why the relay works (verified at nax v0.83.2 `bcfcddb01`, released 2026-10-01, and main `a755a5464`,
2026-10-03; `c6ab5d52c` and `df55f5da3` are main commits in between with the same protocol code)

Paths are under `packages/nax/src` (`N/`) and `packages/nax-agent/src` (`A/`).

- `execution.bashApproval` is `raw | gated | escalate`, default `raw` (`A/config/bash-approval.ts:12,22`), root-only
  (`N/config/root-only-keys.ts:12`). `gated` refuses any command outside the stage's single `Bash(...)` allow rule but
  still asks a human on a matched `ask` rule; `escalate` turns a grant miss into an ask
  (`A/tools/policy-command-branch.ts:86`). A stage without a `Bash(...)` allow rule never gets the Bash tool and never
  asks (`N/config/inert-bash-stages.ts`).
- With `--headless`, the chain is null only for `interaction.plugin: "cli"` (`N/interaction/init.ts:62`). The webhook
  plugin works headless. A null chain denies every ask.
- The webhook plugin POSTs the `InteractionRequest` plus `callbackUrl` to `interaction.config.url`, signed
  `X-Nax-Signature: hex(HMAC-SHA256(secret, rawBody))` (`N/interaction/plugins/webhook.ts:255-277`). The answer must be
  POSTed to `callbackUrl` (`http://127.0.0.1:<port>/nax/interact/<id>`, loopback only, `webhook.ts:452-456`), signed
  the same way, body `{ requestId, action, value?, respondedBy?, respondedAt }` with `respondedAt` a **number**
  (`webhook.ts:56-62`). An unknown id is dropped with 200. The callback may answer 429 (rate limit).
- An approval ask is `type: "choose"`, id `ask-<8hex>`, `metadata.approvalPrompt: true`. Options are `allow`, `deny`,
  and `allow-remember` **only when nax can remember that ask** (`N/interaction/ask-link-session.ts:187`). The command,
  an optional `N secret value(s) masked` footer, and padded `request:`, `runs in:`, `reason:` and `stage:` lines are
  flattened into `detail` (`ask-link-session.ts:164-201`). Only `action: "choose"` with a `value` among the offered
  permitting options permits (`N/interaction/chain.ts:133-137`, `ask-link-session.ts:39`); an `allow-remember` that
  was not offered is a deny.
- nax passes the command verbatim and untruncated so a human never approves unseen text
  (`A/permissions/types.ts:29-33`). The `request:` line is the ask summary: masked, cut to 200 chars, and may span
  lines because it embeds the command (`tools/ask-request.ts:38-51`).
- The ask timeout is `execution.approvalTimeout` (ms; default 600000, range 30000..3600000); a timeout is always a deny
  (`ask-link-session.ts:214`). Asks are serial per run.
- `allow-remember` writes to the approvals store under the run's `outputDir`. koda gives every job its own `outputDir`
  (per-job profile), so "remember" lasts for that job only.
- Every trigger call site is guarded by `ctx.interactionChain && isTriggerEnabled(...)` (e.g.
  `N/execution/cost-guard.ts:31`), and `isTriggerEnabled` returns a boolean setting as given (`N/interaction/triggers.ts:28-33`),
  so `interaction.triggers.<name>: false` keeps a trigger silent with a chain present. Two prompts are not
  trigger-guarded (story-size gate `precheck-runner.ts:139`, paused stories `run-setup-init.ts:227`); the runner answers
  them as a headless run behaves (plan D277). The nine names are in
  `N/interaction/types.ts:78-87` (`TriggerName`).
- Profiles deep-merge after the project config (`N/config/loader.ts:302`), so the per-job profile overrides any
  `interaction` block in the repo's config. `$VAR` resolution skips keys matching `url|secret|...`
  (`N/config/profile.ts:42,123`), so the profile carries literal values.
- nax writes `<outputDir>/approval-audit/<runId>.jsonl` with the structured ask, decision and `decidedBy`.

## Out of scope

- Relaying nax trigger confirmations (A1).
- Built-in Telegram, Slack or email (A2).
- koda-managed allow rules that persist across jobs.
- Comment threads on approvals; approval types beyond the two below; reopening a decided approval (after
  `keep_paused`, the budgets page resume is the only path).
- Live (SSE) updates for approvals with no project: there is no admin live channel; those rely on polling.
- Feeding decisions to the command-safety classifier or decision-proxy (S2 ingestion).
- A nax change to send structured ask fields. Parsing `detail` is the stopgap; a nax issue is optional and separate.
- A multi-instance sweeper or bus.

## 1. Model and lifecycle

### 1.1 `FleetApproval` (slice 1a; bash fields used from 2a)

| Field | Type | Notes |
|:--|:--|:--|
| `id` | cuid | |
| `type` | String | `budget_override_required` \| `nax_bash_escalate` |
| `status` | String | `pending` \| `approved` \| `rejected` \| `expired` \| `cancelled` |
| `projectId` | String? | null for global and runner budget policies (admin inbox only) |
| `jobId`, `leaseEpoch` | String?, Int? | bash asks |
| `naxAskId` | String? | nax request id (`ask-<8hex>`), bash asks |
| `policyId` | String? | budget asks; no FK (the policy may be deleted, 1.4) |
| `payload` | Json | see 1.2; never a secret |
| `outcome` | Json? | decision side effects: budget `{ resumedAmountUsd, requeueResults[] }`; bash `{ delivery }` (4.4) |
| `requestedAt` | DateTime | |
| `expiresAt` | DateTime? | bash asks only |
| `decision` | String? | see 1.3 |
| `decidedById` | String? | user id when `resolvedBy` is `user` or `manual_resume` |
| `decidedAt` | DateTime? | set on any terminal status |
| `resolvedBy` | String? | `user` \| `timeout` \| `job_ended` \| `superseded` \| `manual_resume` \| `window_reset` \| `policy_deleted` |
| `comment` | String? | at most 1000 chars |

Indexes: unique `(jobId, leaseEpoch, naxAskId)` (re-reported asks are idempotent); partial unique on `policyId` where
`status = 'pending'` (one pending override per policy); `(projectId, status, requestedAt)`; `(status, expiresAt)`;
`(jobId, status)`.

`BudgetIncident.approvalId` (plain column, no FK, no index) is set on the `hard_stop` incident that raised the
approval and on the `resumed` incident a decision or manual resume produces.

### 1.2 Payloads

- `nax_bash_escalate`: `{ command, commandTruncated, maskedCount, root, stage, storyId, featureName, reason,
  options[], rawDetail? }`.
  - `command` arrives secret-masked by nax. The runner caps it at 12 KiB (under the 16 KiB sync event limit); on
    overflow it sends the prefix and `commandTruncated: true`.
  - `options` are the choices nax offered (`allow`, `deny`, and `allow-remember` when offered).
  - There is no `rule`: nax prints `reason ?? rule` on one line. `stage`, `storyId` and `featureName` come from
    nax's top-level request fields.
  - `rawDetail` is kept only when the runner could not parse `detail` (4.3), verbatim and capped.
- `budget_override_required`: `{ scopeType, scopeId, windowKind, windowStart, spentUsd, amountUsd }` at the time of
  the stop.

### 1.3 Decisions

| Type | Decision | Status | Allowed when | Effect |
|:--|:--|:--|:--|:--|
| bash | `allow` | approved | `!commandTruncated` | `APPROVAL_ANSWER { choice: "allow" }` |
| bash | `allow_for_job` | approved | `!commandTruncated` and `allow-remember` in `options` | `APPROVAL_ANSWER { choice: "allow-remember" }` |
| bash | `deny` | rejected | always | `APPROVAL_ANSWER { choice: "deny" }` |
| budget | `raise_budget_and_resume` | approved | policy still paused | needs `amountUsd`, optional `requeueJobIds[]` (1.5) |
| budget | `keep_paused` | rejected | always | none; the pause stays |

A decision outside the "allowed when" column answers 400 `fleet.approvalDecisionInvalid`.

### 1.4 Lifecycle rules

- **Lock order.** Every path that touches a budget approval locks the `BudgetPolicy` row first, then the approval row.
  Decide on a budget approval reads `policyId` unlocked, locks the policy, then locks the approval and re-checks
  `pending`. Bash approvals lock the job row first, then the approval.
- A decision is a compare-and-set on `status = 'pending'`; the first one wins, the rest get 409
  `fleet.approvalNotPending`.
- A bash decide with `expiresAt <= now` marks the approval `expired` / `timeout` and answers 409 (nax has already
  denied). The expiry sweeper (2.4) does the same for undecided asks.
- When a job leaves RUNNING (any transition: UPLOADING, a terminal state, or a requeue epoch bump), its pending asks
  become `cancelled` / `job_ended` (nax has exited or is exiting) and unacked `APPROVAL_ANSWER` commands are withdrawn.
- A hard stop creates the approval. If a pending approval for the policy exists (it should not: every path that clears
  a pause closes it), it is closed `cancelled` / `superseded` first.
- A resume from the budgets page closes the policy's pending approval as `approved` / `manual_resume`, decision
  `raise_budget_and_resume`, with no re-queue. A month rollover (`budget-sweeper.ts` window reset) closes it as
  `cancelled` / `window_reset`. Deleting the policy (`BudgetsService.remove` or the sweeper's orphan delete) closes it
  as `cancelled` / `policy_deleted`. Each close runs in the same transaction as the change that caused it.
- If the `hard_stop` incident insert conflicts (same window and amount as an earlier stop, after a manual resume
  without a raise), the approval is still created; there is then no new incident row to stamp, and no hard-stop
  webhook (as today), but `fleet.approval.requested` is still sent.

### 1.5 Re-queue candidates

The jobs offered for re-queue are not stored; they are read when the approval is shown or decided:
`state = CANCELLED`, `cancelReason = 'budget:<policyId>'`, `startedAt IS NULL` (cancelled before this attempt
started), `finishedAt >= approval.requestedAt`, oldest first, at most 200 (the response says when more exist). This
covers both the jobs the hard stop cancelled and the jobs placement cancelled later during the pause
(`PlacementService.cancelForPause`, same reason). A job that someone already requeued drops out. `requeueJobIds` must
be a subset of the candidates at decide time (400 otherwise). Candidates can belong to several projects (global and
runner policies); each is re-queued in its own project.

### 1.6 Job and schedule fields (slice 2a)

- `FleetJob.bashMode` accepts `raw | gated | escalate` (dispatch DTO, `dispatch-input.ts`, `assign-payload.ts`).
  PLAN jobs stay `raw` (400 otherwise).
- New `FleetJob.approvalTimeoutSec Int @default(600)`, validated 30..3600; ignored for `raw`.
- `JobSchedule` gains `bashMode String @default("raw")` and `approvalTimeoutSec Int @default(600)`; the ticker copies
  both into each job it dispatches. A scheduled non-raw job raises asks that may sit until timeout; that is accepted,
  and the schedule dialog warns about it.
- `FleetJobDto` gains `approvalTimeoutSec` and `pendingApprovals` (count; list pages use one grouped count query).

### 1.7 Permissions (A6)

| Action | Who |
|:--|:--|
| Read project approvals | project member |
| Decide bash ask | project DEVELOPER+ (or global ADMIN) |
| Decide budget ask | as resume today: project ADMIN for project/repo policies, global ADMIN for all |
| Read/decide approvals with no project | global ADMIN |
| Pending count | any signed-in user, over their memberships (plus no-project approvals for a global ADMIN) |

## 2. API

### 2.1 Module

`apps/api/src/fleet/approvals/`. To avoid a DI cycle (budgets and jobs code must close approvals; deciding needs
budgets and jobs), it is two modules:

- `ApprovalStoreModule`: repository plus `ApprovalCloser`, a narrow port with `openBudget`, `closeForPolicy` and (2a)
  `closeForJob`. It depends only on Prisma, activity and webhooks, so `BudgetsModule` and `FleetJobsModule` can
  import it.
- `ApprovalsModule`: `ApprovalsService` (list, get, decide, count), controllers, and (2a) `ApprovalExpirySweeper`.
  It imports the store, `BudgetsModule` and `FleetJobsModule`.

### 2.2 Creation

- Budget (1a): `BudgetEvaluator.hardStop()` calls `ApprovalCloser.openBudget` in the hard-stop transaction and stamps
  the incident's `approvalId` when the incident was inserted.
- Bash (2a): `job-report.processor.ts` handles the `approval_request` event in the report transaction, after the lease
  fence passes (a stale epoch is rejected before anything is applied, as today). If the job is RUNNING with
  `bashMode != 'raw'`, it upserts the approval on `(jobId, leaseEpoch, naxAskId)` with
  `expiresAt = min(deadlineAt, requestedAt + approvalTimeoutSec)`. A same-epoch job that is no longer RUNNING (or is
  `raw`) gets the approval created `cancelled` / `job_ended`. An ask whose deadline is already past is created
  `expired` / `timeout`.

### 2.3 Endpoints

- `GET /projects/:slug/fleet/approvals?status=&type=&jobId=` (standard `Paginated<T>`), `GET .../approvals/:id`
  (budget approvals include `requeueCandidates[]` and `requeueCandidatesTruncated`).
- `POST /projects/:slug/fleet/approvals/:id/decide` body `{ decision, amountUsd?, requeueJobIds?, comment? }`.
- `GET /fleet/approvals`, `GET /fleet/approvals/:id`, `POST /fleet/approvals/:id/decide`: global ADMIN; all projects
  plus no-project approvals.
- `GET /fleet/approval-counts`: any signed-in user; `{ total, unscoped, projects: [{ projectId, slug, pending }] }`
  over the caller's memberships, `unscoped` (no-project approvals) only for a global ADMIN, else 0.

Decide on a **budget** approval:

1. T1 (one transaction, lock order 1.4): check `pending` and permission (1.7), validate the decision. For
   `raise_budget_and_resume`, validate `requeueJobIds` against the candidates and call
   `BudgetsService.resume(actorId, route, policyId, amountUsd, now, { approvalId })`, where `route` is
   `{ kind: 'project', projectId }` for project and repo policies and `{ kind: 'admin' }` for global and runner ones,
   whichever prefix the request came through. `resume` keeps its rules (409 not paused, 400 amount not above spend)
   and stamps `approvalId` on its `resumed` incident. Write the status, decision and activity. Commit.
2. T2..n: one `FleetJobsService.requeue(actorId, job.projectId, jobId)` per selected id, each in its own transaction.
   Failures are collected, not thrown (A9).
3. Store `outcome = { resumedAmountUsd, requeueResults: [{ jobId, ok, error? }] }` on the approval, publish live,
   return the approval with the results.

Decide on a **bash** approval (2a): one transaction (lock job, then approval), CAS, insert `APPROVAL_ANSWER` for the
job's current `runnerId` and `leaseEpoch`, then `RunnerNotifier.notify` after commit.

Errors: 409 `fleet.approvalNotPending`; 400 `fleet.approvalDecisionInvalid` and `fleet.approvalInput`; 403 by role;
404 `fleet.approvals` (unknown, other project, or a no-project approval on a project route).

### 2.4 Expiry and cleanup (2a)

- `ApprovalExpirySweeper`: every 15 s, `sweepEnabled`-gated like the budget sweeper and schedule ticker; expires
  pending bash asks with `expiresAt <= now`. Budget approvals never expire, so 1a has no sweeper.
- `JobTransitionsService` calls `ApprovalCloser.closeForJob` whenever a job leaves RUNNING (1.4);
  `withdrawPendingCommands` already withdraws unacked commands on requeue and terminal transitions and covers
  `APPROVAL_ANSWER`.

### 2.5 Live, webhooks, activity, CLI

- `LiveEvent` gains `{ type: 'fleet_approval', projectId, approvalId, status, at }`, content-free, published after
  commit on create and every status change, for approvals with a `projectId` only (the bus and SSE route are
  per project). The web client parses and listens for it.
- Outbound webhooks via `webhooks.dispatch(projectId, ...)` inside the triggering transaction:
  `fleet.approval.requested` and `fleet.approval.resolved`, payload `{ approvalId, type, status, decision?,
  resolvedBy?, projectId, jobId?, policyId?, expiresAt?, path }`. `path` is the web path of the inbox item
  (`/<slug>/fleet/approvals?id=<id>`); koda has no public base URL setting. No command text and no `request:` text
  (A8). Project-scoped approvals only.
- Activity (`entityType: 'approval'`): `approval.requested`, `approval.decided`, `approval.expired`,
  `approval.cancelled`. Payload keys never match the activity secret pattern (`/token|secret|key|password|credential/i`).
- CLI: `koda fleet approval list | show | decide`, on the generated client.

## 3. Protocol (slice 2a)

Deploy order: server first (a v2 runner against a v1-only server gets 426).

- `FLEET_PROTOCOL_VERSION` 1 -> 2; `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2]`. A v1 runner never reports the relay
  capability.
- `RunnerCapabilities.approvals?: { relay: true }`; `parseCapabilitiesCore` keeps it.
- Placement treats `bashMode != 'raw'` as requiring it: new `MisfitReason` `approvals_relay`, in `PERMANENT_MISFITS`
  (a pinned dispatch to such a runner is 422), with web labels and the OpenAPI enum.
- `RunnerEventType` gains `approval_request` (sync parser `EVENT_TYPES`, `interpretEvent` effect), payload
  `{ naxAskId, deadlineAt, command, commandTruncated, maskedCount, root, stage, storyId, featureName, reason,
  options[], rawDetail? }` (caps as 1.2). `JobReportProcessor`'s live output widens to `LiveEvent[]`.
- `FleetCommandTypeName` gains `APPROVAL_ANSWER`, payload `{ approvalId, naxAskId, choice: 'allow' | 'allow-remember' | 'deny' }`.
- `AssignPayload.bashMode` widens to `'raw' | 'gated' | 'escalate'`; new `approvalTimeoutSec: number`.
- Ack details for `APPROVAL_ANSWER` (`rejected`): `ask_not_pending`, `job_not_running`, `callback_failed:<status>`.
  The ack is stored in the approval's `outcome.delivery`.

## 4. Runner relay (slice 2a)

### 4.1 Per-job setup

Only for an ASSIGN with `bashMode` `gated` or `escalate`:

- Start an `ApprovalReceiver`: `Bun.serve` on `127.0.0.1`, port 0 (free port), with a fresh 32-byte random secret.
- `writeJobProfile` adds to `~/.nax/profiles/koda-job-<jobId>.json`: `execution.bashApproval`,
  `execution.approvalTimeout = approvalTimeoutSec * 1000`, `interaction.plugin = "webhook"`,
  `interaction.config = { url: "http://127.0.0.1:<port>/ask", secret, requireSecret: true }`, and
  `interaction.triggers` with all nine `TriggerName`s set to `false` (A1; a runner test pins the list against nax's
  type). The profile now holds a secret, so it (and its temp file) is written with mode 0600; that is new.
- The journal gains an `approval_receivers` table (`jobId`, `port`, `secret`) and a `pending_asks` table (`jobId`,
  `naxAskId`, `callbackUrl`, `deadlineAt`), created with `CREATE TABLE IF NOT EXISTS` like the existing schema.
- `assign-parser.ts` accepts the three modes and `approvalTimeoutSec`.

### 4.2 Ask in

nax POSTs to `/ask`. The receiver:

1. Verifies `X-Nax-Signature` in constant time (401 on mismatch) and caps the body at 64 KiB (413).
2. If `metadata.approvalPrompt` is not true (a non-approval ask; should not happen with A1), answers it at
   once as a headless run would (plan D277) and records a lifecycle entry.
3. Parses `detail` (4.3); keeps `id`, `callbackUrl`, `options` and `deadlineAt = createdAt + timeout`.
4. Journals the pending ask, appends an `approval_request` event to the job's outgoing report, and wakes an idle sync
   poll.
5. Answers nax 200; nax then waits on its own callback.

### 4.3 `detail` parser

Pure function over nax's flattened text, parsed from the end: the trailing `stage:`, `reason:`, `runs in:` and
`request:` lines (any padding after the colon), then an optional `N secret value(s) masked` line (`maskedCount`),
then the fenced block before them is the command, whatever fences it contains. There must be exactly one split
candidate, and its request text must match the command (plan D256); anything else is 'unparsed'.
Fixtures are real requests captured from nax 0.83.x. If parsing fails, the event carries `rawDetail` (verbatim,
truncated to the cap) and empty fields, and the UI shows the raw text.

### 4.4 Answer down

`command-handler.ts` handles `APPROVAL_ANSWER`: look up the journalled ask; if absent, ack `rejected: ask_not_pending`;
if the job is not running, `rejected: job_not_running`; otherwise POST the signed
`{ requestId: naxAskId, action: "choose", value: choice, respondedBy: "koda", respondedAt: Date.now() }` to
`callbackUrl` with a 10 s deadline. A 200 acks `ok` and clears the journal entry; anything else (including 429)
acks `rejected: callback_failed:<status>`. Re-sent commands are no-ops through command idempotency.

### 4.5 Ask ends without koda; job end; restart

- nax ends a wait by itself on timeout or run end; the runner sends nothing extra. Server expiry and job-end cleanup
  (2.4) close the approval.
- On job end the receiver closes and the job's journalled receiver and asks are deleted.
- Daemon restart: nax keeps running (detached). Asks raised while the daemon is down are denied by nax (A7). On READOPT
  the receiver re-binds the journalled port and secret; pending asks from before the restart stay answerable. If the
  port is taken, the runner records a lifecycle `error`; pending asks then expire and new ones are denied.

## 5. Web (slices 1b and 2b)

- Inbox `/:project/fleet/approvals` (Pending default, All; type filter; Pending sorted by soonest expiry; `?id=` opens
  that row) and `/admin/fleet/approvals` (global ADMIN; all projects plus no-project). Rows: type chip, summary, job
  link, story/stage, requested time, countdown for bash asks.
- Row-expand panel:
  - Bash: masked command in a monospace block (with "N secret values masked" when `maskedCount > 0`), root, stage,
    story, reason. **Allow once**, **Allow for this job** (only when offered), **Deny**; optional comment. A
    truncated command shows a notice and only **Deny**. Unparsed asks show `rawDetail`.
  - Budget: spent / amount / window; amount input (must exceed spend) and **Raise and resume**; checklist of
    re-queue candidates, all ticked ("and N more" when truncated); **Keep paused**.
  - Decided items: who, when, `resolvedBy`, `outcome` (re-queue results or delivery result), read-only.
- Header badge from `GET /fleet/approval-counts`: refresh on `fleet_approval` notices (debounced 300 ms), 60 s poll
  backstop, links to the current project's inbox (admin inbox for a global ADMIN outside a project).
- Job page: "Waiting for approval (N)" callout when `pendingApprovals > 0`; an Approvals timeline section.
- `BudgetBanner`: a "Review override" link when the policy has a pending approval.
- Dispatch form and schedule dialog: `bashMode` select with help text (gated/escalate need `Bash(...)` grants in the
  repo's nax config; on a schedule, asks may sit until timeout); `approvalTimeoutSec` in minutes, shown only for
  non-raw modes. PLAN keeps `raw`.
- Jobs list: a "needs approval" marker next to the state badge.
- `useFleetApprovals(scope)` with a module-level mutation epoch (D224 pattern, applied from the start);
  `useApprovalCountdown`; pure mappers in `lib/fleet-approvals.ts`.
- Decide controls are **hidden, not disabled**, for users who may not use them; a read-only line instead.
- 409 on decide: toast the server message and reload the row.
- i18n `fleet.approvals.*` in en and zh; parity spec gains type, status, decision and resolvedBy enums.

## 6. Failure behaviour

| Failure | Outcome |
|:--|:--|
| Daemon down when nax asks | nax POST fails -> deny / `unavailable` (A7) |
| Ask reaches koda after its deadline | created `expired`; nax already denied |
| Decide after `expiresAt`, before the sweep | 409, approval marked `expired` |
| Answer reaches the runner after nax timed out | not sent; ack `rejected: ask_expired` (2b D302); approval already expired |
| Runner cannot reach nax's callback, or 429 | ack `rejected: callback_failed:<status>` shown on the approval; no retry; nax times out -> deny |
| Command over 12 KiB | `commandTruncated`; only Deny is allowed |
| `allow-remember` not offered by nax | "Allow for this job" hidden; the API refuses it (400) |
| `detail` unparseable | approval created with `rawDetail` |
| Decision after the job left RUNNING | approval already `cancelled` / `job_ended`; 409 |
| Two humans decide at once | compare-and-set; second gets 409 |
| Policy deleted while an override is pending | approval `cancelled` / `policy_deleted` |
| One re-queue fails during raise-and-resume | resume stays; failure recorded in `outcome.requeueResults` |

## 7. Testing

- API unit: approval state machine (compare-and-set, expiry, job-end cleanup, supersede, manual resume, window reset,
  policy delete), decide permission matrix, decision validation per type, candidate query rules, partial re-queue
  failure.
- API integration (real PG): hard stop -> approval -> raise and resume -> re-queue (including a job placement
  cancelled during the pause); lock order under a concurrent evaluate and decide; report event -> approval -> decide ->
  command -> ack -> `outcome.delivery`; sweeper expiry; idempotent re-report; webhooks; openapi contract.
- Runner unit: receiver HMAC accept and reject, body cap, `detail` parser on captured nax fixtures (padding, masked
  footer, a command containing a fence), truncation, journal re-bind, `APPROVAL_ANSWER` -> signed callback with a
  numeric `respondedAt`, every ack detail, profile overlay contents and mode 0600, the trigger list against nax's
  `TriggerName`.
- Runner integration: a fake-nax fixture that POSTs a real-shaped ask and serves its own signed callback, against the
  mock koda server.
- Web unit: mappers, parser display, composables (mutation epoch), permission gating, option-gated buttons, i18n parity.
- E2E (Playwright): (1) budget hard stop on the scripted runner -> raise and resume with re-queue -> the job runs
  again; (2) an `escalate` job whose scripted runner raises an ask -> allowed in the web -> job completes and the ask is
  in its timeline; (3) an ask left to expire shows as expired.
- Live check (human-run, billed, approval at launch): one real `nax run` with `bashMode: escalate` on one runner
  against a local koda; one ask allowed, one denied; the job page and nax's `approval-audit` agree.

## 8. Delivery

| Slice | Content | Depends on |
|:--|:--|:--|
| 1a | `FleetApproval` model + migration, store module + `ApprovalCloser`, budget hard-stop wiring, close on manual resume / window reset / policy delete, re-queue candidates, decide / list / get / counts endpoints, live variant, webhooks, activity, CLI. Budget asks only; no sweeper. | main |
| 1b | Inbox pages, badge, budget panel, `BudgetBanner` link, i18n, E2E (1). | 1a |
| 2a | Protocol v2, `approval_request` event, `APPROVAL_ANSWER`, `ApprovalReceiver` + profile overlay + journal tables, `bashMode` / `approvalTimeoutSec` through schema, DTOs, schedules, ASSIGN and runner parser, placement capability, expiry sweeper, job-leaves-RUNNING cleanup, `pendingApprovals`. | 1a |
| 2b | Bash panel, job-page callout and timeline, dispatch and schedule fields, jobs-list marker, E2E (2) and (3), live check. | 1b, 2a |

- 2a plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2a-approval-relay.md`, D255-D287): the `detail`
  format is identical in nax v0.83.2 and main; the relay needs nax >= 0.83.0 (the runner floor 0.83.1 already
  exceeds it); the `request:` line is masked, so `rawDetail` keeps it; the payload has no `rule`; the detail parser
  refuses ambiguous splits; the size-gate and paused-story prompts are answered as headless runs behave; relay state
  is per (job, epoch); a decide that finds the ask expired or its job gone commits that close and then answers 409;
  `APPROVAL_ANSWER` acks are stored as `outcome.delivery`; static-capability runners never offer the relay.
- 2b plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2b-bash-approvals-web.md`, D288-D306): no API
  change; bash asks are decided by DEVELOPER+ in the inbox only (the job page links there); a cut or unreadable ask is
  deny-only and the panel hides its buttons when the countdown reaches 0; the delivery line re-fetches the open row on
  each reload because acks have no live event; web timeouts are minutes with 2 decimals (exact round trip of stored
  seconds), the CLI takes seconds; a raw schedule PATCH omits the timeout; the runner refuses answers past nax's
  deadline (`ask_expired`).

- 1a plan notes (`docs/superpowers/plans/2026-10-02-fleet-s1-5-slice-1a-approvals-core.md`, D226-D238): two modules
  (store + approvals); the hard stop opens the approval before inserting its incident; the resume route follows the
  policy scope; an omitted `requeueJobIds` re-queues nothing; counts live at `GET /fleet/approval-counts`; bash
  approvals answer 400 until 2a.
- 1b plan notes (`docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-1b-approvals-web.md`, D239-D254): Pending tab is
  one page of 100 sorted by expiry; one shared EventSource per project per tab (page + header badge); the open
  approval is re-fetched only when its status changes; re-queue results are shown only for inbox raises (a manual
  resume's `[]` is not "none selected"); the banner link reads the project's pending overrides (no API change).
