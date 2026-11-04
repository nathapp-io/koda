# Fleet Flow: from a settled spec set to ready PRs, with one approval

Status: DRAFT 2026-11-04. Brainstormed with the user 2026-11-04. Follows S5a (brainstorm threads), S6 K1-K3
(review, decisions, fix) and Arc A `fleet-pr-finish` (#390, merged, not deployed). Depends on nax pieces
designed in nax `docs/superpowers/specs/2026-11-04-nax-chat-acp-subagents-design.md`.

## Intent

The user wants one brainstorm to turn into ready PRs while they do something else. They stay hands-on for the
brainstorm. After that, koda should carry the work through spec review, plan, PRD review, run, PR review, fix and
finish, and come back to them only for:

- the **one approval** that lets the flow spend money, given once the spec set is settled (or given in advance
  with a per-thread tickbox);
- a **genuine ambiguity**: a question whose answer changes what gets built and that the spec, brainstorm or
  code does not settle;
- a **merge**, between the features of a design that was split into several specs;
- a **stop**: a failed step or check, or the cost cap reached.

koda already has every building block, but each is started by hand: a thread's Publish, Plan and Run buttons,
`REVIEW` and `FIX` jobs, auto-review, and Arc A's agent rulings. What is missing is the thing that chains them,
plus the two review steps on a second model. That is the **flow**.

koda is the right home because the work spans hours or days (waiting on merges) and must survive any chat
closing. It already has the runner, budgets, the approval engine, notifications, tickets and an audit trail
that records actor, approval mode and approver on every action.

## Goals

- **G1. A flow record.** One flow holds an ordered list of features from one design, each with its spec path and
  dependencies, the branch and head sha the spec set was settled at, the role models, a cost cap, and its state.
- **G2. Two entries, one flow.**
  - **Thread entry:** a koda brainstorm thread that published its spec set offers **Start flow**.
  - **nax entry:** `nax chat` sends a flow through a koda API (agent key), pointing at a pushed branch.
  Both create the same record and run the same steps.
- **G3. One approval, asked once.** A new flow is `PENDING` until a human with permission approves it in koda.
  The approval covers every step of every feature within the cost cap.
- **G4. Per-thread pre-approval.** A tickbox on a thread, "auto-approve the flow from this thread", with a
  required cost cap. Only a human can tick it. A flow from that thread starts without asking again.
- **G5. The steps, per feature:** spec review (once for the set) → `PLAN` → PRD review → `RUN` → `REVIEW` →
  `FIX` → finish (Arc A rulings, ready). Review steps run on the `reviewer` role's model; the supervisor role
  drives and reports.
- **G6. Multi-feature with merge waits.** Features run in order. A feature that depends on an earlier one starts
  only after that feature's PR is merged. Features marked independent may start from main without waiting.
- **G7. Ambiguity escalation.** Review steps sort each finding as already answered (fix the spec), minor (decide
  and record as the flow's call) or ambiguous (pause and ask the user). Questions arrive as one batch.
- **G8. Status.** A flow page shows each feature's current step, its jobs, its PR, and cost spent against the cap.

## Non-goals

- A project-wide auto-approve setting (deferred by the user 2026-11-04).
- Merging, releasing or deploying. The flow ends each feature at a ready PR (or a draft with a reason), and
  waits for the human to merge.
- Stacked PRs (building feature N on feature N-1's branch). Considered and rejected for now: it forces rebases
  after every fix and plans against code that later changes.
- Restarting a stopped flow in place. A stopped flow can be **cloned** into a new pending flow, which needs a new
  approval.
- Changing how `PLAN`, `RUN`, `REVIEW`, `FIX` or Arc A's finish behave as jobs. The flow dispatches them as
  they are.
- Brainstorming itself. The thread entry starts after Publish; the nax entry after the chat settles the specs.

## Anti-goals

- A billed step that starts without a recorded human approval: a decision on the flow's approval request, or a
  pre-approval tick on the flow's thread. An agent can propose a flow and can tick nothing.
- A flow that keeps spending after something went wrong. Any failed job, failed check or cap reached stops the
  flow and notifies the user. It never retries on its own.
- Questions drip-fed one at a time, or minor calls escalated as if they were ambiguous. The user's time is the
  thing this protects.
- A flow that runs a spec set different from the one approved. A change to any spec after approval sends the
  flow back to `PENDING`.

## User rulings (2026-11-04)

1. koda owns the always-on flow; nax provides ACP subagents, a headless agent command and the send-to-koda tool.
2. Brainstorm happens in both places: koda threads and `nax chat`.
3. One approval card, after the spec set is settled. koda always asks at least once, unless the thread's
   pre-approval tickbox is ticked.
4. Per-thread tickbox only; project-wide auto-approve deferred.
5. Between dependent features, the flow pauses until the user merges, then resumes by itself (Claude's
   recommendation, accepted).
6. The supervisor may run on a cheaper model; judgment steps (spec review, PRD review, classifying findings) use
   the reviewer role's model. Implementer and test-writer models are not changed by the flow.

## Design

### Flow record

A new `FleetFlow` model (names are the builder's; the fields are the requirement):

- `projectId`, `repoId`, optional `threadId` (thread entry), `createdBy` (actor), `entry` (`THREAD` | `NAX`);
- `branch`, `specSha` (head sha the spec set was settled at);
- `features`: ordered `{ feature, specPath, dependsOn: string[], state, currentStep, jobIds, prNumber? }`;
- `roles`: `{ reviewer: <model or profile alias>, supervisor: <model or profile alias> }`, passed to jobs as
  profiles;
- `costCapUsd`, `spentUsd` (from the flow's jobs' recorded costs);
- `state`: `PENDING` → `APPROVED` → `RUNNING` ↔ `WAITING_MERGE` | `WAITING_ANSWER` → `COMPLETED` | `STOPPED`;
- `approval`: `{ mode: "REQUEST" | "PRE_APPROVED", approverId, approvedAt, approvalRequestId? }`
  (`PRE_APPROVED` only from a thread tickbox);
- `stopReason`, `endedAt`.

Every state change is an audit event with actor, approval mode and approver, as for every koda action.

### Entries

- **Thread entry.** A thread whose spec set is published (`specPublished`) shows **Start flow**. The form lists
  the features found in the published docs (one per `.nax/features/<f>/spec.md` written by the thread), their
  order and dependencies (prefilled from the design doc when it declares them; editable), role models and a cost
  cap. Submitting creates a `PENDING` flow, or an `APPROVED` one if the thread's pre-approval tickbox is ticked
  and the cap is within the tick's cap.
- **nax entry.** `POST /fleet/flows` with an agent key: `{ remoteUrl, branch, specSha, features, roles,
  costCapUsd }`. koda resolves `remoteUrl` to a fleet repo the key's agent can reach (else 404), and verifies the
  sha exists on the branch. A flow from the nax entry is always `PENDING`: per ruling 4, the thread tickbox is
  the only pre-approval, and a nax-sent flow has no thread.

### Approval

- `PENDING` raises an approval request through the existing approval engine under a new approvable key,
  `fleet.flow.start`. The request shows every feature, step, role model and the cost cap. The decision is the
  flow's one approval.
- The **pre-approval tickbox** lives on the thread. Ticking it records `{ userId, at, costCapUsd }` on the
  thread, as an audited action under a new permission key (`fleet.thread.preapprove`). It can be unticked any
  time before a flow starts. It covers one flow only: once a flow from the thread starts, the tick is consumed.
- An approved flow whose spec set changes (new sha with spec changes, or a feature added) returns to `PENDING`
  and asks again. A change outside the spec paths does not.

### Steps

**Who does what (my call).** Step order is deterministic: koda's flow service reacts to job completions and
dispatches the next job; no model decides what runs next. The **reviewer** role runs every judgment step: spec
review, PRD review, classifying findings, and the follow-up job that applies `answered` and `minor` fixes to the
spec. The **supervisor** role, the cheap model, writes the human-facing text: the status summary on the flow
page, the stop reason, and the batched questions posted on the ticket. Each billed step is a fleet job, so it
counts against the flow's cap and koda's budgets.

**Roles reach the runner** through the per-job profile koda already writes (`koda-job-<id>`): koda puts
`agent.modelAliases.reviewer` and `.supervisor` there, so `nax agents run` resolves them on any runner.

1. **Spec review (once, for the set).** A new job kind, `AGENT`, runs `nax agents run <reviewer agent> --task
   "<task>"` (nax design, section 3). The task names every spec path and asks for each spec's `/spec-review`
   findings plus cross-spec consistency (a rule fixed in one spec but used differently in another, an
   undeclared dependency). No new skill flag is needed. (My call: one job over a new `--set` mode in the
   spec-review skill, which lives in a separate repo; the builder may split it into one job per spec if one job
   is too large.) koda always runs this step, including for flows from the nax entry.
2. Per feature, in order:
   1. `PLAN` (existing).
   2. **PRD review:** `AGENT` job, `/spec-review --prd <spec>`.
   3. `RUN` (existing), with the flow's remaining cap as `maxCostUsd`.
   4. `REVIEW` and `FIX` (existing), on the PR the run published.
   5. **Finish:** Arc A's rulings by agent, then the ready step.
   6. `WAITING_MERGE` until the PR merges (the existing PR-merge sync), unless no later feature depends on it.
3. `COMPLETED` when every feature has a merged PR, or a ready PR with nothing depending on it.

### Review verdicts and escalation

- An `AGENT` review job's task asks for a verdict in a fixed JSON shape at the end of its output:
  `{ "findings": [ { "id", "class": "answered" | "minor" | "ambiguous", "summary", "fix"?, "question"? } ] }`.
  koda parses it; an output with no parseable verdict fails the step.
- `answered` and `minor` findings are applied by a follow-up `AGENT` job that edits the spec on the flow branch
  and commits. Each `minor` call is appended to the spec under "Flow's calls" so the user can check it later.
- `ambiguous` findings move the flow to `WAITING_ANSWER`. All of a step's questions are posted together as one
  comment on the flow's ticket (created at the first question if there is none, as Arc A does for rulings), with
  a notification. The user answers on the ticket. The answers are applied like `answered` findings. If they
  change the spec set, the flow returns to `PENDING`; if not, it continues without a new approval.

### Cost cap (my call)

- The cap is checked **between jobs**: before dispatching a job, koda compares `spentUsd` with `costCapUsd` and
  stops the flow if the cap is reached. It never kills a running job.
- Inside a `RUN`, the cap is hard: the job gets `--max-cost` set to the remaining cap (the runner already
  passes `--max-cost` from `maxCostUsd`).
- `AGENT`, `PLAN`, `REVIEW` and `FIX` jobs may report no cost. A job with unknown cost counts as 0 against the
  cap, and the flow page shows `cap excludes N jobs with unknown cost`, so the user can see the cap is partial.
  The same is true of the nax chat chain today.

### Independent features (my call)

An independent feature branches from main **at the moment it starts**. If its `RUN` or a later job fails on a
conflict with another open PR, the flow stops like any other failure. It never rebases on its own.

### Stops

The flow moves to `STOPPED`, posts the reason on its ticket and notifies the user when: a job ends `FAILED`,
`CANCELLED` or lost; a verdict cannot be parsed; the cost cap is reached when a job ends with steps remaining;
the PR is closed unmerged; a human stops it. Running jobs are not cancelled by a stop; the flow just starts
nothing more.

### Status page

`/projects/:id/flows/:flowId`: features in order with their current step, job links, PR link and state, the
cost spent against the cap, open questions, the approval record, and a Stop button. The thread page links to
its flow. nax chat shows the koda URL the send returned.

## Constraints

- One active `RUN` per repo clone on a runner, as today (`nax.lock`). The flow never runs two features'
  runs at once on one runner.
- Approval and audit follow the P3 permission design: new routes are approvable keys, and every action records
  actor, approval mode and approver.
- nax prerequisites, in order: ACP subagents and `acp:` aliases; `nax agents run`; then `nax-flow__send` (built
  against this design's create-flow endpoint). Arc A must be deployed (it needs the nax release with
  `--rulings`).
- **Releases are the user's.** nax releases are maintainer-initiated. The plan lists which nax version each koda
  feature needs. A koda feature that needs an unreleased nax piece waits until the user releases it; the
  build order is: flow record and approval, then everything that does not need `nax agents run`, then the
  `AGENT` job and review steps after that release.

## Left to the builder

- Model and table names, and whether features are a child table or JSON.
- Whether spec edits from review run as the same `AGENT` job or a follow-up one.
- How the thread form discovers features and dependencies from the published docs.
- Splitting into features. A sensible split: (a) flow record, states and approval (including the tickbox);
  (b) the `AGENT` job kind on the runner; (c) single-feature steps and stops; (d) verdicts and escalation;
  (e) multi-feature order and merge waits; (f) the flow page; (g) the nax entry endpoint.
