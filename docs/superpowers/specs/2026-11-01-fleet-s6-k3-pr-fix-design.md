# Fleet S6 K3: PR Fix Jobs (koda runs `nax bot fix`)

Status: DRAFT 2026-11-01. Follows K1 (`fleet-pr-review`, `fleet-auto-review`) and K2 (`fleet-review-decisions`,
`fleet-review-ingest`). Source plan: fleet design §9.122 ("koda runs `nax bot review|fix` on PR events under a bot
identity"). K1 and K2 built review only; this is the fix half.

## Intent

koda can already review a PR as the `koda-fleet` App, feed the project's settled decisions into that review, and
remember findings a human talked the bot out of. What it cannot do is act on the findings the review agreed with.
Today a person reads the bot's comments and fixes them by hand, or runs `nax bot fix` from their own machine under
their own login, outside koda's audit, budget and runner fleet.

K3 adds a `FIX` fleet job: one dispatch makes a runner review the PR's current head with the project's decisions,
then run `nax bot fix` on what that review agreed with, push the fix to the PR branch as the App, and report the
outcome back to koda. The user still merges (nax rule R5: one fix round, then the human decides).

The user handed the scope and shape to the designer ("proceed with your recommendation"), so every decision below
is a designer call unless marked as a standing rule.

### Standing rules that apply (from earlier koda and nax rulings)

- koda is agent-first: every action records actor, approval mode and approver; agents use API keys, no PATs.
- Every gated route goes through the P3 permission catalog and approval engine; no special-cased surface.
- nax bot rules: review and fix are separate commands (R2); fix works only on a PR nax can push to (R4); one fix
  round, then mark ready, the user merges (R5); fix acts on every finding and thread the review agreed with (R10);
  untrusted PRs are never executed (R11); fix resolves only threads the bot opened (R12).
- K2 user ruling: untrusted PRs never mint decisions.
- nax is public: koda-specific needs become generic nax features, never koda-named ones.

## Goals

1. A user or agent with `fleet.job.dispatch` on the project can dispatch `FIX` for an open GitHub PR on a
   registered repo, from REST, CLI, MCP and web (agent-first: no surface special-cased).
2. The fix acts only on a review of the PR's exact current head that received the project's decisions.
3. The push is made by the App through the job's brokered git token, never a person's credentials.
4. koda records what happened: the fix outcome, the pushed sha, cost, and the review artifact (so K2 ingest keeps
   working on the review that ran inside the fix job).
5. A FIX and a REVIEW of the same PR can never run at the same time.

## Non-goals (K3)

- **Automatic fix.** No poller, no fix-on-review toggle. Every FIX is an explicit dispatch. Revisit after K3 is
  live (auto-fix pushes code to branches unattended, so it needs its own trust discussion).
- **A post-push re-review inside the job.** See D4.
- **GitLab.** K1 reviews GitHub only; K3 follows.
- **Fork or cross-repo PRs.** nax refuses them (R4); koda does not try to work around that.
- **Any nax change required to ship K3.** One generic nax enhancement is filed as a follow-up (D4).
- **More than one fix round per dispatch.**

## Anti-goals (would make K3 a failure even if it technically works)

- The bot pushes to a PR because an outsider asked for it (a fork, or a non-writer's thread request). nax's trust
  classification refuses untrusted PRs and frames thread text as untrusted data; koda must not weaken either.
- A fix acts on a review that did not see the project's decisions, so it "fixes" something the team already ruled
  is not a defect.
- A push lands that koda cannot attribute to a dispatcher, an approval and a job.
- Two bot jobs race on one PR (a review posting while a fix pushes).

## Facts this design rests on (verified 2026-11-01)

- `nax bot fix <pr>` (nax `0.91.7-canary.11`) refuses unless a `bot-review.json` of the PR's exact current head
  exists under its own output dir (`loadLatestReview(runtime.outputDir, pr, headSha)` globs
  `bot/pr-<n>/*/bot-review.json`). koda gives every job its own output dir, so a review from an earlier REVIEW job
  is invisible to a FIX job.
- `nax bot fix` also refuses: a PR that is not open, a cross-repo head, an untrusted PR, a head with no review, no
  push access (`git push --dry-run`), and a base branch with no check commands (detected-only checks need `--trust`).
  It runs pre-run steps (install), one fix session, the repo gates, and pushes without force. Outcomes: `pushed`,
  `nothing`, `no-change`, `protected`, `gates-failed`, `push-rejected`, `setup-failed`, `cost-limit`, `refused`.
- After a `pushed` fix, `nax bot fix` by default re-reviews the new head and runs a ready pass. That re-review takes
  no `--decisions` (`BotFixOptions` omits it). `--no-rereview` skips it; the main fix graph still replies in agreed
  threads, resolves the bot's own threads and marks a draft ready.
- stdout contract: `nax bot fix: PR #<n> — pushed <sha7>` or `— nothing to fix` (exit 0); any other outcome prints
  its reason on stderr (exit 2). `nax bot review` prints `nax bot review: artifact <path>` only when it posted.
- Every fleet job's brokered GitHub token is `contents: write, pull_requests: write` on the job's repo
  (`GitHubAppClient.mintInstallationToken`), with no branch restriction. K1 REVIEW jobs already receive it.
- K1 gives REVIEW jobs the forge identity through `<jobDir>/forge-token` (0600, path in `NAX_FORGE_TOKEN_FILE`,
  nax deletes it at startup) plus `NAX_FORGE_LOGIN`. One file serves one nax process.
- K1 makes `review-pr-<n>` the REVIEW feature; the partial unique index `FleetJob_active_repo_feature_key` allows
  one active job per `(repoId, feature)`. K2 ingest reads the review artifact of a `COMPLETED` `REVIEW` job and
  finds the PR via `prNumberOfReviewFeature(job.feature)`.
- RUN and REVIEW are both dispatched under `fleet.job.dispatch` (project scope).

## Decisions

### D1. A new job kind `FIX`, shaped like `REVIEW`

- `FIX` joins `FleetJobKind`, the protocol kind names, the dispatch DTO `command` enum and the web kind.
- Dispatch body as for REVIEW: `{ repoId, command: FIX, prNumber, profiles, maxCostUsd, selectorLabels?,
  pinnedRunnerId? }`. GitHub-only, checked before `normalizeDispatch`, same 422 as REVIEW (`fix is GitHub-only`).
- `ref` = the repo default branch (detached checkout, as REVIEW); nax makes its own PR worktree.
- **Same feature as REVIEW: `review-pr-<n>`.** The existing active-feature index then blocks a FIX while a REVIEW
  of that PR is active and the reverse (goal 5), with no new index. The job's `command` tells them apart.
- Permission: `fleet.job.dispatch`, like RUN (which also pushes code). Approval mode comes from the project's
  policy for that key, as for every dispatch. *Alternative rejected: a separate `fleet.job.fix` key. It would let a
  project require human approval for agent fixes but not agent reviews; add it later if a project asks.*
- Budget: one `maxCostUsd` covers the whole job (review + fix). `FIX` joins `BUDGET_STOP_COMMANDS`.
- **Cost cap reaches nax through the job profile** *(builder-check call)*. `nax bot review|fix` take no cost flag;
  they read `bot.costLimit` from config. The runner already writes a per-job profile (`koda-job-<jobId>`), so it
  sets `bot.costLimit` there: for step 1, `maxCostUsd`; for step 2, `maxCostUsd` minus step 1's ledger cost (step 2
  is skipped as `FAILED`, reason `budget spent by review`, when nothing is left). This also closes a K1 gap: today a
  REVIEW job's `maxCostUsd` never reaches nax; K3 sets `bot.costLimit = maxCostUsd` for REVIEW too.
- **Assign shape** *(builder-check call)*: a FIX reuses the REVIEW `review` object unchanged
  (`{ prNumber, botLogin, decisions? }`); `buildAssignPayload` emits it for both commands, and the runner's
  `invalid review` check applies to both.

### D2. One job runs review, then fix

- The runner runs two nax steps in the job dir, in order:
  1. `nax bot review <pr> --full --decisions <review-decisions.json>` (the K1/K2 REVIEW argv plus `--full`),
  2. only when step 1 posted (its `artifact` line is on stdout): `nax bot fix <pr> --no-rereview`, with the same
     profiles.
- **Why `--full`** *(builder-check call)*: on a nax-workflow PR whose head was already reviewed, nax re-checks only
  the conversation (`reviewRange` -> `conversationOnly`). Earlier open bot threads are carried into `agreed` either
  way (`mergeEarlier`), but summary-only minors from the earlier review are not. `--full` makes the fix act on a
  complete review of the current head. It costs one full review on every FIX, which is accepted.
- Each step gets its own freshly written `forge-token` file (nax deletes it at startup) and the same
  `NAX_FORGE_LOGIN`.
- *Why not reuse the last REVIEW job's artifact:* it lives in another job's output dir, it is often for an older
  head, and copying it in would need a new runner download path. Re-reviewing costs about one review (≈ $0.03 on
  the sandbox) and guarantees the fix acts on the current head with the current decisions (anti-goal 2).
- Decisions: selected at dispatch exactly as K2 D3 and stored on `FleetJob.reviewDecisions`; the assign payload's
  `review` object carries them as for REVIEW.

### D3. Verdict and recorded outcome

The runner judges a finished FIX from `<jobDir>/nax.stdout` (nax runs detached, so there is no exit code):

| condition (checked in order) | job state | recorded |
|---|---|---|
| cancel requested | `CANCELLED` | |
| no `nax bot review: artifact` line | `FAILED`, reason `review not posted` | |
| a `nax bot fix: PR #<n> — pushed <sha7>` line | `COMPLETED` | fix outcome `pushed`, pushed sha, head branch |
| a `nax bot fix: PR #<n> — nothing to fix` line | `COMPLETED` | fix outcome `nothing`; when the line ends `; pushed advisor ledger <sha7>`, that sha is recorded too (an App push, so it must be attributed), but no follow-up REVIEW (no code changed) |
| otherwise | `FAILED`, `stateReason` = first line of nax's fix stderr, trimmed (falls back to `fix not pushed`) | |

- The pushed sha and head branch go in the job's existing result fields (`resultSha`, `resultBranch`) and the
  PR URL in `resultPrUrl`, so the job detail links the PR and commit the same way a RUN does. **The runner reads the
  full sha locally** *(builder-check call)* from the fix run's `nax-out/bot/pr-<n>/<runId>/bot-state.json`
  (`pushedSha`; the run dir is the one under the fix step, not the review step) and reports it with the result, as
  it reports a RUN's result from `status.json`. No bundle allowlist change. The 7-char stdout sha is never stored.
- **Head moved between step 1 and step 2:** nax refuses (no review of the new head); the job is `FAILED` with nax's
  reason. No retry: the user re-dispatches.
- A `FAILED` FIX notifies its requester through the existing job-outcome recorder, like any job. `gates-failed`,
  `protected`, `no-change` and refusals (untrusted, no push access, no checks) all surface as `FAILED` with nax's
  reason, so the user sees why nothing was pushed.

### D4. No re-review inside the job; a koda follow-up instead

- nax's built-in post-push re-review cannot take decisions, so it could raise again a finding the team settled
  (anti-goal 2). The job passes `--no-rereview`.
- After a FIX `COMPLETED` with outcome `pushed`, koda queues **one** follow-up `REVIEW` of the same PR (with
  decisions), as the system actor on behalf of the FIX's requester, with the FIX's profiles and `maxCostUsd`. It
  is a normal REVIEW job: it checks the new head, marks fixed threads, and its artifact is ingested by K2. It never
  queues a FIX (one round, R5).
- **Approval** *(builder-check call, K1-B precedent)*: the follow-up is part of the FIX the policy already
  approved, so it needs no second approval. It is dispatched under a new system writer key (name left to the
  builder, like `system.pr-review.dispatch`), actor `SYSTEM/<component>`, `onBehalfOf` the FIX requester, and its
  audit entry links the FIX job id. If the requester has since lost `fleet.job.dispatch` on the project, it is
  skipped and audited (the K1-B enabler re-check rule).
- If the follow-up cannot be queued (409 because a REVIEW is already active, budget paused, repo gone), it is
  skipped and audited; a K1-B auto-review of the new head covers the same ground when that is enabled. The
  follow-up records the reviewed head in `FleetPrReview` the way the poller does, so the poller does not review
  the same head twice.
- **Follow-up for nax (generic, filed after design approval):** `nax bot fix --decisions <path>`, passed to its
  re-review. When it ships, koda can drop `--no-rereview` and the follow-up REVIEW.

### D5. Review memory (K2) keeps working on FIX jobs

- The review that ran inside a FIX posted to the PR, so its `finding-withdrawn` events are as real as a REVIEW
  job's. K2 ingest reads the review artifact of a FIX job whenever the job's stdout has the review `artifact` line,
  **whatever the final state** (a fix whose gates failed still had a posted review). Same parsing, trust rule
  (untrusted never mints), idempotency and minting as K2.
- A `CANCELLED` FIX is read only when the review line is present (the review posted before the cancel).
- **Mechanics** *(builder-check call)*: the decision is made in the api from the bundle's `nax.stdout` slot (already
  collected for K2). The ingest gate today is `command === 'REVIEW' && state === 'COMPLETED'`
  (`bundle-ingest.service.ts:103`); K3 widens it to `REVIEW` in `COMPLETED`, or `FIX` in any terminal state whose
  stdout has the review `artifact` line. FAILED and CANCELLED jobs do upload a bundle when nax ran (checked on
  koda-wk 11-01); a FIX that failed before nax started has none and is simply not read.

### D6. Runner capability `botFix`

- The runner reports `botFix: true` only when `botReview` is true and `nax bot fix --help` output contains
  `--no-rereview`. Placement of a `FIX` requires both, checked in `capabilityMisfit` like `botReview`.
- Readopt after a runner restart: a FIX in step 1 or step 2 is watched while its process is alive and ours, and
  judged by D3 when it is gone. A restart between the two steps must not silently skip the fix: either the second
  step starts on readopt, or the job is judged `FAILED` with reason `interrupted before fix`. *(Builder picks which;
  the constraint is that the job never reports `COMPLETED` without a fix line.)*

### D7. Surfaces

- REST: the existing dispatch route accepts `FIX`. CLI: `koda fleet dispatch` gains PR options for both REVIEW and FIX
  (it has none today; K1 shipped REVIEW without a CLI flag). MCP: the dispatch tool accepts `FIX`. Web: the dispatch form gains `Fix PR`; a completed REVIEW
  job's detail offers a `Fix` action prefilled with its repo, PR and profiles.
- Job lists and detail show FIX with the PR number, the fix outcome and, for `pushed`, the commit link.
- Audit: dispatch is audited as `fleet.job.dispatch` (actor, approval mode, approver) like every job; the
  follow-up REVIEW as a system dispatch on behalf of the requester.

## How the parts fit

```
dispatch FIX (REST / CLI / MCP / web)   feature review-pr-<n>, decisions selected (K2 D3)
  -> runner with botFix
     step 1: nax bot review <n> --decisions file        (posts review, writes bot-review.json)
     step 2: nax bot fix <n> --no-rereview               (fix session, gates, push as App, replies, ready)
  -> verdict from nax.stdout (D3) -> job COMPLETED/FAILED + resultSha/resultBranch/resultPrUrl
  -> bundle ingest: review artifact -> K2 events/mint (D5)
  -> pushed? queue one follow-up REVIEW with decisions (D4)
```

## Constraints

- No change to the git broker or token scopes; the existing write token is enough.
- No new permission key; no new table unless the builder needs one for the fix outcome (prefer existing job fields).
- Token handling follows K1 exactly (file per nax process, 0600, removed on spawn failure, cleanup and attempt wipe).
- Tests follow repo conventions (unit + integration on the real test DB for api; FakeNaxCli for runner).

## Left to the builder (spec writer)

- How the runner sequences the two nax steps (one detached wrapper or two spawns) within the D6 restart rule.
- Where the `pushed` / `nothing` outcome of a COMPLETED FIX is stored (a new nullable column vs reusing an existing
  field); failures use the existing `stateReason`.
- The exact CLI flag names, web placement of the `Fix` action, and i18n keys.
- How the follow-up REVIEW is wired (job-outcome event listener vs the ingest path), and its audit key name.
- Feature split (likely: api kind + dispatch + follow-up; runner capability + steps + verdict; ingest; web/CLI/MCP).
