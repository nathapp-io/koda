# Fleet S1.5 — Typed Approvals and the nax Approval Relay — Design

Builds C8 from the fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec", §9.3): typed approvals,
one approvals inbox, and a runner-hosted relay for nax's human-approval asks. It unlocks `bashMode: gated|escalate`
(S1 spec line 415) and fills the `BudgetIncident.approvalId` seam left by S1b (`2026-10-01-fleet-s1b-budgets-schedules-design.md`,
ruling B1). Where this document and S1 spec §9.3 disagree, this document wins.

## Goal

Let a human answer, from koda, the two decisions that end in a hard "no" today:

1. A budget hard stop pauses a scope and cancels its queued jobs. A human now chooses to keep it paused, or to raise
   the budget, resume, and re-queue the jobs the stop cancelled before they started.
2. A nax job in `gated` or `escalate` mode meets a shell command outside its grants and asks a human. The runner
   relays the ask to koda, a human allows or denies it in the web, and the answer reaches nax before its timeout.

## Success criteria

1. An unattended `escalate` RUN raises an ask, a developer allows it from the koda inbox, and the job continues;
   a denied ask makes nax refuse the command; an unanswered ask is denied at the job's `approvalTimeoutSec`.
2. A budget hard stop creates exactly one pending `budget_override_required` approval per policy. "Raise and resume"
   lifts the pause and re-queues the selected cancelled-before-start jobs; "Keep paused" leaves the pause.
3. A human learns of a pending approval from a live badge in the web, and through a `fleet.approval.requested`
   project webhook they can point at a chat tool.
4. No failure path turns into an allow: every lost, late, or undeliverable answer ends as a deny in nax.
5. A runner without the relay is never assigned a `gated` or `escalate` job.

## Rulings (user, 2026-10-02)

| # | Ruling |
|:--|:--|
| A1 | The relay carries **bash approval asks only**. nax trigger confirmations (cost-warning, security-review, cost-exceeded, merge-conflict, max-retries, human-review, ...) are **disabled** in the per-job profile, so runs behave as headless runs do today. Relaying triggers is a later slice. |
| A2 | Notification is the **web inbox + live badge** and an **outbound project webhook** (`fleet.approval.requested` / `fleet.approval.resolved`). No built-in chat integration. |
| A3 | The ask timeout is a **dispatch field** `approvalTimeoutSec` (default 600, range 30..3600), also on schedule templates. The runner writes it into the per-job nax profile; the approval shows a countdown to the same deadline. |
| A4 | "Raise and resume" **offers to re-queue** the jobs the hard stop cancelled before they started (checkbox list, all ticked by default). Jobs that were running are never re-run automatically (S1 manual-requeue rule). |
| A5 | Relay transport is **approach A**: asks go up as a new event type in `POST /fleet/runner/sync`; answers come down as a new `APPROVAL_ANSWER` command on the existing command channel. No new endpoints, auth or retry logic. |
| A6 | Bash asks are decided by **project DEVELOPER+**. Budget asks are decided by whoever may resume that policy today (S1b B3). Every project member can read the project inbox. |
| A7 | When the runner daemon is down, asks nax raises in that window are **denied** (nax's webhook POST fails, nax records `unavailable`). They are not queued. |
| A8 | The command text is **not** sent in outbound webhooks; it stays behind login. |
| A9 | A re-queue that fails on its own does **not** roll back the resume; per-job results are returned. |

Earlier rulings that still hold: single-instance API (in-process sweepers and bus), all runner git traffic brokered
(R5), `--max-cost` is the hard per-job cap (S1b B2), budget policy permissions (S1b B3).

### Why the relay works (verified at nax `c6ab5d52c`, 2026-10-02, released 0.83.2)

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
  POSTed to `callbackUrl` (`http://127.0.0.1:<port>/nax/interact/<id>`, bound to loopback only, `webhook.ts:452-456`),
  signed the same way, body `{ requestId, action, value?, respondedBy?, respondedAt }`.
- An approval ask is `type: "choose"`, id `ask-<8hex>`, `metadata.approvalPrompt: true`, options
  `allow | allow-remember | deny`; the command, `runs in:`, `reason:` and `stage:` are flattened into `detail`
  (`N/interaction/ask-link-session.ts:164-201`). Only `action: "choose"` with `value` `allow` or `allow-remember` permits
  (`N/interaction/chain.ts:133-137`, `ask-link-session.ts:39`).
- The ask timeout is `execution.approvalTimeout` (ms; default 600000, range 30000..3600000); a timeout is always a deny
  (`ask-link-session.ts:214`). Asks are serial per run.
- `allow-remember` writes to the approvals store under the run's `outputDir`. koda gives every job its own `outputDir`
  (per-job profile), so "remember" lasts for that job only.
- Every trigger call site is guarded by `ctx.interactionChain && isTriggerEnabled(...)` (e.g.
  `N/execution/cost-guard.ts:31`), so `interaction.triggers.<name>: false` keeps a trigger silent with a chain present.
- Profiles deep-merge after the project config (`N/config/loader.ts:302`), so the per-job profile overrides any
  `interaction` block in the repo's config. `$VAR` resolution skips keys matching `url|secret|...`
  (`N/config/profile.ts:42,123`), so the profile carries literal values.
- nax writes `<outputDir>/approval-audit/<runId>.jsonl` with the structured ask, decision and `decidedBy`.

## Out of scope

- Relaying nax trigger confirmations (A1).
- Built-in Telegram, Slack or email (A2).
- koda-managed allow rules that persist across jobs.
- Comment threads on approvals; approval types beyond the two below.
- Feeding decisions to the command-safety classifier or decision-proxy (S2 ingestion).
- A nax change to send structured ask fields. Parsing `detail` is the stopgap; a nax issue is optional and separate.
- A multi-instance sweeper or bus.

## 1. Model and lifecycle (slice 1a, bash fields used from 2a)

### 1.1 `FleetApproval`

| Field | Type | Notes |
|:--|:--|:--|
| `id` | cuid | |
| `type` | String | `budget_override_required` \| `nax_bash_escalate` |
| `status` | String | `pending` \| `approved` \| `rejected` \| `expired` \| `cancelled` |
| `projectId` | String? | null for global and runner budget policies (admin inbox only) |
| `jobId`, `leaseEpoch` | String?, Int? | bash asks |
| `naxAskId` | String? | nax request id (`ask-<8hex>`), bash asks |
| `policyId` | String? | budget asks |
| `payload` | Json | see 1.2; never a secret |
| `requestedAt` | DateTime | |
| `expiresAt` | DateTime? | bash asks only |
| `decision` | String? | see 1.3 |
| `decidedById` | String? | user id when `resolvedBy = user` or `manual_resume` |
| `decidedAt` | DateTime? | set on any terminal status |
| `resolvedBy` | String? | `user` \| `timeout` \| `job_ended` \| `superseded` \| `manual_resume` \| `window_reset` |
| `comment` | String? | at most 1000 chars |
| `deliveryResult` | String? | bash: the `APPROVAL_ANSWER` ack (`ok` \| `rejected:<detail>`), see 4 |

Indexes: unique `(jobId, leaseEpoch, naxAskId)` (re-reported asks are idempotent); partial unique on `policyId` where
`status = 'pending'` (one pending override per policy); `(projectId, status, requestedAt)`; `(status, expiresAt)`.

`BudgetIncident.approvalId` is set on the `hard_stop` incident that raised the approval and on the `resumed`
incident a decision produces.

### 1.2 Payloads

- `nax_bash_escalate`: `{ command, root, stage, storyId, featureName, reason, rule, rawDetail? }`. `command` arrives
  secret-masked by nax. `rawDetail` is kept only when the runner could not parse `detail` (4.3). Caps: `command`
  4 KiB, whole payload 8 KiB.
- `budget_override_required`: `{ scopeType, scopeLabel, windowStart, spentUsd, amountUsd, cancelledJobIds[] }`.
  `cancelledJobIds` are the jobs `cancelForBudget` moved straight to CANCELLED (never started), at most 200.

### 1.3 Decisions

| Type | Decision | Status | Effect |
|:--|:--|:--|:--|
| bash | `allow` | approved | `APPROVAL_ANSWER { choice: "allow" }` |
| bash | `allow_for_job` | approved | `APPROVAL_ANSWER { choice: "allow-remember" }` |
| bash | `deny` | rejected | `APPROVAL_ANSWER { choice: "deny" }` |
| budget | `raise_budget_and_resume` | approved | needs `amountUsd`, optional `requeueJobIds[]`; `BudgetsService.resume()` then `requeue()` per id |
| budget | `keep_paused` | rejected | none; the pause stays |

### 1.4 Lifecycle rules

- A decision is a compare-and-set on `status = 'pending'`; the first one wins, the rest get 409.
- The expiry sweeper marks pending bash asks with `expiresAt <= now` as `expired` / `timeout`, matching nax's own
  timeout deny.
- When a job reaches a terminal state, or its lease epoch changes (cancel, crash, requeue), its pending asks become
  `cancelled` / `job_ended` and unacked `APPROVAL_ANSWER` commands are withdrawn.
- A resume from the budgets page closes the policy's pending approval as `approved` / `manual_resume`, decision
  `raise_budget_and_resume`, with no re-queue. A month rollover (`budget-sweeper.ts` window reset) closes it as
  `cancelled` / `window_reset`.
- A second hard stop on a policy with a pending approval reuses it (refreshes `spentUsd` and appends to
  `cancelledJobIds`); it does not create another.

### 1.5 Job and schedule fields

- `FleetJob.bashMode` accepts `raw | gated | escalate` (dispatch DTO, `dispatch-input.ts`, `assign-payload.ts`).
- New `FleetJob.approvalTimeoutSec Int @default(600)`, validated 30..3600; ignored for `raw`.
- `JobSchedule` gains `bashMode String @default("raw")` and `approvalTimeoutSec Int @default(600)`; the ticker copies
  both into each job it dispatches.
- `FleetJobDto` gains `bashMode` (already present), `approvalTimeoutSec` and `pendingApprovals` (count).
- PLAN jobs stay `raw` (dispatch rejects another mode for PLAN with 400).

### 1.6 Permissions (A6)

| Action | Who |
|:--|:--|
| Read project approvals | project member |
| Decide bash ask | project DEVELOPER+ (or global ADMIN) |
| Decide budget ask | as resume today: project ADMIN for project/repo policies, global ADMIN for all |
| Read/decide approvals with no project | global ADMIN |

## 2. API (slices 1a and 2a)

### 2.1 Module

`apps/api/src/fleet/approvals/`: `ApprovalsService`, `PrismaApprovalRepository`, `ProjectFleetApprovalsController`,
`FleetApprovalsController` (admin), `ApprovalExpirySweeper`, DTOs, domain types.

### 2.2 Creation

- Budget (1a): `budget-evaluator.hardStop()` creates or refreshes the approval in the hard-stop transaction, after
  `cancelForBudget`, and sets the incident's `approvalId`.
- Bash (2a): `job-report.processor.ts` handles the `approval_request` event in the report transaction. If the job is
  RUNNING on the reporting runner at that epoch with `bashMode != 'raw'`, it upserts the approval on
  `(jobId, leaseEpoch, naxAskId)` with `expiresAt = min(reportedDeadline, requestedAt + approvalTimeoutSec)`.
  Otherwise the event is still applied, and the approval is created `cancelled` / `job_ended` so the timeline is
  honest and no ghost ask appears. An ask whose deadline is already past is created `expired` / `timeout`.

### 2.3 Endpoints

- `GET /projects/:slug/fleet/approvals?status=&type=&jobId=` (standard `Paginated<T>`), `GET .../approvals/:id`.
- `POST /projects/:slug/fleet/approvals/:id/decide` body `{ decision, amountUsd?, requeueJobIds?, comment? }`.
- `GET /fleet/approvals`, `GET /fleet/approvals/:id`, `POST /fleet/approvals/:id/decide` (global ADMIN; all projects
  plus no-project approvals).
- `GET /fleet/approvals/pending-count` returns `{ total, byProject: { [slug]: n } }` over the caller's projects, plus
  no-project approvals for a global ADMIN.

Decide runs in one transaction: lock and check `pending`, check permission (1.6), validate the decision for the type,
apply the effect, write the status, record activity, publish live after commit.

- Bash: insert `APPROVAL_ANSWER` for the job's current `runnerId` and `leaseEpoch`, then `RunnerNotifier.notify`.
- Budget: `requeueJobIds` must be a subset of `payload.cancelledJobIds` (400 otherwise). `resume()` keeps its rules
  (409 not paused, 400 amount not above spend). Re-queues run after the resume commits, each through
  `FleetJobsService.requeue()`; failures are returned in `requeueResults[]` and do not roll back (A9).

Errors: 409 `fleet.approvalNotPending`; 400 `fleet.approvalDecisionInvalid`; 403 by role; 404 unknown or other project.

### 2.4 Expiry and cleanup

- `ApprovalExpirySweeper`: every 15 s, `sweepEnabled`-gated like the budget sweeper and schedule ticker.
- The job transition path (terminal state or epoch bump) cancels the job's pending asks; `withdrawPendingCommands`
  already withdraws unacked commands on requeue and covers `APPROVAL_ANSWER`.
- `BudgetsService.resume()` and the window-reset path in `budget-sweeper.ts` close the pending budget approval (1.4).

### 2.5 Live, webhooks, activity, CLI

- `LiveEvent` gains `{ type: 'fleet_approval', projectId, approvalId, status, at }`, content-free, published after
  commit on create and every status change. No-project approvals publish on a reserved admin channel that the admin
  inbox subscribes to.
- Outbound webhooks via `webhooks.dispatch(projectId, ...)`: `fleet.approval.requested` and
  `fleet.approval.resolved`, payload `{ approvalId, type, status, projectSlug, jobId?, policyId?, summary, expiresAt?,
  url }`. `summary` is the type plus scope or story, never the command (A8). Project-scoped approvals only.
- Activity (`entityType: 'approval'`): `approval.requested`, `approval.decided`, `approval.expired`,
  `approval.cancelled`.
- CLI: `koda fleet approvals list | show | decide`, generated from the OpenAPI contract.

## 3. Protocol (slice 2a)

- `FLEET_PROTOCOL_VERSION` 1 -> 2. The server accepts 1 and 2; a v1 runner never reports the relay capability.
- `RunnerCapabilities.approvals?: { relay: true }`. Placement treats `bashMode != 'raw'` as requiring it, through the
  existing capability-mismatch check (a misfit reason `approvals_relay`).
- `RunnerEventType` gains `approval_request`, payload
  `{ naxAskId, deadlineAt, command, root, stage, storyId, featureName, reason, rule, rawDetail? }` (caps as 1.2).
- `FleetCommandTypeName` gains `APPROVAL_ANSWER`, payload `{ approvalId, naxAskId, choice: 'allow' | 'allow-remember' | 'deny' }`.
- `AssignPayload.bashMode` widens to `'raw' | 'gated' | 'escalate'`; new `approvalTimeoutSec: number`.
- Ack details for `APPROVAL_ANSWER` (`rejected`): `ask_not_pending`, `job_not_running`, `callback_failed:<status>`.

## 4. Runner relay (slice 2a)

### 4.1 Per-job setup

Only for an ASSIGN with `bashMode` `gated` or `escalate`:

- Start an `ApprovalReceiver`: `Bun.serve` on `127.0.0.1`, port 0 (free port), with a fresh 32-byte random secret.
- `writeJobProfile` adds to `~/.nax/profiles/koda-job-<jobId>.json` (mode 0600, already last in the chain):
  `execution.bashApproval`, `execution.approvalTimeout = approvalTimeoutSec * 1000`,
  `interaction.plugin = "webhook"`, `interaction.config = { url: "http://127.0.0.1:<port>/ask", secret,
  requireSecret: true }`, and `interaction.triggers` with every known trigger set to `false` (A1).
- The job journal records the port and secret so a restarted daemon can re-bind after READOPT.
- `assign-parser.ts` accepts the three modes and `approvalTimeoutSec`.

### 4.2 Ask in

nax POSTs to `/ask`. The receiver:

1. Verifies `X-Nax-Signature` in constant time (401 on mismatch) and caps the body at 64 KiB (413).
2. If `metadata.approvalPrompt` is not true (a non-approval ask; should not happen with A1), answers `skip` to its
   `callbackUrl` at once and records a lifecycle `warn`.
3. Parses `detail` (4.3), keeps `id`, `callbackUrl` and `deadlineAt = createdAt + timeout`.
4. Journals the pending ask (`naxAskId`, `callbackUrl`, `deadlineAt`), appends an `approval_request` event to the job's
   outgoing report, and wakes an idle sync poll.
5. Answers nax 200; nax then waits on its own callback.

### 4.3 `detail` parser

Pure function over nax's flattened text: the first fenced block is the command; `request:`, `runs in:`, `reason:` and
`stage:` lines map to fields. Fixtures are real requests captured from nax 0.83.x. If parsing fails, the event carries
`rawDetail` (truncated to the cap) and empty fields, and the UI shows the raw text.

### 4.4 Answer down

`command-handler.ts` handles `APPROVAL_ANSWER`: look up the journalled ask; if absent, ack `rejected: ask_not_pending`;
if the job is not running, `rejected: job_not_running`; otherwise POST the signed
`{ requestId: naxAskId, action: "choose", value: choice, respondedBy: "koda", respondedAt }` to `callbackUrl` with a
10 s deadline. A 200 acks `ok` and clears the journal entry; anything else acks `rejected: callback_failed:<status>`.
Re-sent commands are no-ops through command idempotency.

### 4.5 Ask ends without koda; job end; restart

- nax ends a wait by itself on timeout or run end; the runner sends nothing extra. Server expiry and job-end cleanup
  (2.4) close the approval.
- On job end the receiver closes and the job's journalled asks are deleted.
- Daemon restart: nax keeps running (detached). Asks raised while the daemon is down are denied by nax (A7). On READOPT
  the receiver re-binds the journalled port and secret; pending asks from before the restart stay answerable. If the
  port is taken, the runner records a lifecycle `error`; pending asks then expire and new ones are denied.

## 5. Web (slices 1b and 2b)

- Inbox `/:project/fleet/approvals` (Pending default, All; type filter; Pending sorted by soonest expiry) and
  `/admin/fleet/approvals` (global ADMIN; all projects plus no-project). Rows: type chip, summary, job link,
  story/stage, requested time, countdown for bash asks.
- Row-expand panel:
  - Bash: masked command in a monospace block, root, stage, story, reason, rule; **Allow once**, **Allow for this
    job**, **Deny**; optional comment.
  - Budget: spent / amount / window; amount input (must exceed spend) and **Raise and resume**; checklist of
    cancelled jobs, all ticked; **Keep paused**.
  - Decided items: who, when, `resolvedBy`, delivery result, read-only.
- Header badge from `pending-count`: refresh on `fleet_approval` notices (debounced 300 ms), 60 s poll backstop,
  links to the current project's inbox (admin inbox for a global ADMIN outside a project).
- Job page: "Waiting for approval (N)" callout when `pendingApprovals > 0`; an Approvals timeline section.
- `BudgetBanner`: a "Review override" link when the policy has a pending approval.
- Dispatch form and schedule dialog: `bashMode` select with help text (gated/escalate need `Bash(...)` grants in the
  repo's nax config); `approvalTimeoutSec` in minutes, shown only for non-raw modes. PLAN keeps `raw`.
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
| Answer reaches the runner after nax timed out | nax drops the unknown id with 200; ack `ok`; approval already expired |
| Runner cannot reach nax's callback | ack `rejected: callback_failed`; `deliveryResult` shown on the approval; nax times out -> deny |
| `detail` unparseable | approval created with `rawDetail` |
| Decision after the epoch moved | command withdrawn; approval `cancelled` / `job_ended` |
| Two humans decide at once | compare-and-set; second gets 409 |

## 7. Testing

- API unit: approval state machine (compare-and-set, expiry, job-end cleanup, supersede, manual resume, window reset),
  decide permission matrix, decision validation per type, partial re-queue failure.
- API integration (real PG): hard stop -> approval -> raise and resume -> re-queue; report event -> approval ->
  decide -> command -> ack -> `deliveryResult`; sweeper expiry; idempotent re-report; webhooks; openapi contract.
- Runner unit: receiver HMAC accept and reject, body cap, `detail` parser on captured nax fixtures, journal re-bind,
  `APPROVAL_ANSWER` -> signed callback, every ack detail, profile overlay contents.
- Runner integration: a fake-nax fixture that POSTs a real-shaped ask and serves its own signed callback, against the
  mock koda server.
- Web unit: mappers, parser display, composables (mutation epoch), permission gating, i18n parity.
- E2E (Playwright): (1) budget hard stop on the scripted runner -> raise and resume with re-queue -> the job runs
  again; (2) an `escalate` job whose scripted runner raises an ask -> allowed in the web -> job completes and the ask is
  in its timeline; (3) an ask left to expire shows as expired.
- Live check (human-run, billed, approval at launch): one real `nax run` with `bashMode: escalate` on one runner
  against a local koda; one ask allowed, one denied; the job page and nax's `approval-audit` agree.

## 8. Delivery

| Slice | Content | Depends on |
|:--|:--|:--|
| 1a | `FleetApproval` model + migration, service, budget hard-stop wiring, manual-resume and window-reset closing, decide/list/count endpoints, sweeper shell, live variant, webhooks, activity, CLI. Budget asks only. | main |
| 1b | Inbox pages, badge, budget panel, `BudgetBanner` link, i18n, E2E (1). | 1a |
| 2a | Protocol v2, `approval_request` event, `APPROVAL_ANSWER`, `ApprovalReceiver` + profile overlay + journal, `bashMode` / `approvalTimeoutSec` through schema, DTOs, schedules, ASSIGN and runner parser, placement capability, job-end cleanup, `pendingApprovals`. | 1a |
| 2b | Bash panel, job-page callout and timeline, dispatch and schedule fields, jobs-list marker, E2E (2) and (3), live check. | 1b, 2a |

To verify in the 2a plan, not assumed:

- `interaction.triggers.<name>: false` silences the default-on triggers (`cost-warning`, `security-review`) with a
  webhook chain present.
- The `detail` text format is the same in released 0.83.2 and nax main.
- The minimum nax version the runner requires before reporting `approvals.relay`.
