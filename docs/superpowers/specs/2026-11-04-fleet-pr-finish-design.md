# Fleet PR Finish: rulings on workflow drafts and the fix ready result (#372, #373)

Status: DRAFT 2026-11-04. Follows K1-K3 (`fleet-pr-review`, `fleet-review-decisions`, `fleet-pr-fix`). Closes #372
and #373 as one arc. Depends on one generic nax change: `nax bot review --rulings <file>` (nax PR #2784, branch
`feat/bot-review-caller-rulings` at `28f6b02d1`, reviewed + fix round 1, `check:all` green, open).

## Intent

A nax workflow RUN that cannot finish cleanly ends with a **draft PR** that carries open items: advisor rulings,
cannot-verify items, gates, out-of-scope stories, findings. Today nobody can finish that draft from koda. A human has
to reply on each item's GitHub thread with a keyword (`confirm:`, `waive:`, `override:`, `verified:`, `fixed <sha>`)
and run `nax bot review` + `nax bot fix` on their own machine (the `nax-finish` skill), outside koda's audit, budget
and runner fleet.

The user leaves most of these rulings to an agent ("agent also is a member, they can rule it"). So koda must let any
member, human or agent, rule on a draft's open items, keep each ruling visible, and run nax to record the rulings and
mark the PR ready.

Separately, a FIX job today records only `pushed`/`nothing` and the pushed sha. nax also replies on and resolves the
threads it fixed and runs a ready step (marked ready, or kept as a draft with a reason). koda drops all of that, so the
job page cannot say whether the PR is ready or why it is still a draft (#373).

## User rulings (2026-11-04)

1. One arc for #373 + #372.
2. Agents rule. No per-item human question in the default flow.
3. Agent rulings are **direct by default**; a project can switch them to **proposal** (approval policy), exactly like
   the memory write mode.
4. Rulings must never be invisible: each one is posted as a comment on the koda ticket of the work.
5. When the RUN has no ticket, koda **creates one at the first ruling** ("Finish draft PR #n (<feature>)").
   **Ticket lifecycle = option (b)** (user ruling after the builder check): the ticket is created `IN_PROGRESS` with a
   `TicketLink` to the PR; marking the PR ready only adds a comment; the existing PR-merge sync moves it to
   `VERIFY_FIX` on merge, and the normal verify-fix approval closes it. No new ticket transition. (koda's state machine
   has no CREATED -> CLOSED edge, so option (a), close on ready, would have needed a system-only bypass.)
6. The nax prerequisite is a generic `--rulings <file>` flag with these safeguards: an untrusted PR ignores the file;
   rulings bind to the PR head sha and the item; each applied ruling is echoed on its GitHub thread with provenance; a
   writer's GitHub reply made after the ruling wins.

### Standing rules that apply

- koda is agent-first: every action records actor, approval mode and approver; agents use API keys, no PATs.
- Every gated route goes through the P3 permission catalog and approval engine; no special-cased surface (REST, CLI,
  MCP, web all reach the same route).
- nax bot rules: review and fix are separate commands; one fix round per dispatch; the user merges (R5); untrusted PRs
  are never executed (R11).
- Workflow comments (non-GENERAL types) are immutable (review P2 A/ENH-1).
- nax is public: nothing koda-specific goes into nax.

## Facts this design rests on (verified 2026-11-04, nax `origin/main` 06ed1ba93, koda `c51cf74e`)

- **Settling items.** nax settles a workflow item only from a thread reply by a repository writer
  (`forge/access.ts` `hasWriteAccess`: GitHub collaborator permission `admin`/`write`). `nax workflow record` /
  `promote` serve only drafts published before nax 0.91.2. koda acts as the `koda-fleet` App, which is not a
  collaborator and whose comments nax treats as its own, so koda cannot rule through threads. Hence `--rulings`.
- **`--decisions` does not settle items.** It only stops repeat findings (K2).
- **koda already has the open items.** The bundle ingest parses the RUN's `result.json` into
  `FleetJob.workflow = { runId, outcome: 'ready'|'draft'|'local-only', workflowPassed, reasons, openItems[] }`
  (`fleet/ingest/parsers/workflow.parser.ts`); each item has `id`, `kind`, `issue`, `severity?`, `file?`, `line?`,
  `suggestion?`. `resultPrUrl` holds the draft PR.
- **The FIX job already runs both commands.** `buildNaxArgv` (`apps/runner/src/executor/nax-process.ts`): FIX =
  `nax bot review <pr> --full --profile ... [--decisions <file>]`, then `nax bot fix <pr> --no-rereview ...`.
- **The fix graph always runs its ready step.** In nax `bot/fix-run.ts` the graph goes `fix -> (nothing) ledger ->
  ready` and `push -> reply -> ready`; `--no-rereview` only skips the extra post-push review and ready-only pass in
  `fix-cycle.ts`. The ready step (`fix-report.ts` `readyStep`) marks a workflow draft ready only when its durable
  rulings and exact-head CI allow it. So a FIX whose review recorded rulings can mark the draft ready even when there
  is nothing to fix.
- **The fix state has the #373 fields.** nax writes `bot-state.json` with `pushedSha`, `replied`, `resolved`,
  `markedReady`, `readyHeld` (`bot/fix-steps.ts` `BotFixState`). The runner already opens that file for `pushedSha`
  (`apps/runner/src/verdict/fix-result.ts` `readPushedSha`).
- **The review artifact is already ingested.** `parseBotReview` (`fleet/ingest/parsers/bot-review.parser.ts`) reads
  `bot-review.json` (versions 1-3, `trusted`, `events`). The nax change adds `callerRulings` to it.
- **The API can read a PR head.** `GithubAppClient` reads `GET /repos/:o/:n/pulls/:n` (`headSha`, `draft`).
- **Decisions reach the runner through the assign payload** (`fleet/jobs/assign-payload.ts`, `decisions`), and the
  runner writes `review-decisions.json` (0600) and passes `--decisions`. The runner's nax probe gates `botReview` on
  `bot review --help` listing `--decisions` (`capabilities/nax-probe.ts`).
- **Tickets.** `Ticket.status` CREATED | VERIFIED | IN_PROGRESS | VERIFY_FIX | CLOSED | REJECTED; jobs link to
  tickets optionally through `FleetJobTicket`. `Comment.type` is a string; non-GENERAL comments are immutable
  (`comments.service.ts` `assertEditable`).

## Goals

1. **#373.** A FIX job records nax's ready result (`markedReady`, `readyHeld`) and the thread `replied` / `resolved`
   counts, and shows them next to the fix outcome (job page, REST, CLI).
2. **Open items.** A RUN whose workflow outcome is `draft` shows its open items, each with its current ruling.
3. **Ruling.** A member with the new permission rules on one open item: a keyword line plus evidence, through REST,
   MCP, CLI and web, under the approval engine (direct by default, proposal by project policy).
4. **Visible.** Each ruling becomes an immutable `RULING` comment on the work's ticket (created when missing), and nax
   echoes each applied ruling on the item's GitHub thread.
5. **Finish.** Dispatching a FIX on the draft's PR carries the pending rulings to `nax bot review --rulings`, so nax
   records them and the fix ready step marks the PR ready (or says why not). koda records which rulings were applied
   or skipped and why.
6. **Ticket follows the PR.** When a FIX reports `markedReady`, the ticket gets a comment; when the PR merges, the
   existing PR-merge sync moves the ticket to `VERIFY_FIX`.

## Non-goals

- Settling items any other way than nax's own ruling path (no `workflow record`/`promote`, no writing nax files).
- Legacy drafts (published before nax 0.91.2, no item index) and pipeline-mode escalations (`finish-audit/`).
- Rulings on PRs koda did not produce through a RUN (no workflow open items in koda for them).
- A koda-side LLM that drafts rulings. The ruler is whoever calls the route: a person, or an agent using MCP/CLI.
- Automatic Finish. Finish is an explicit FIX dispatch; auto-dispatch can come later.
- Fixing red CI or merge conflicts. A Finish reports them as the ready hold; a human or a later RUN fixes them.
- Merging. The user merges (R5).
- GitLab (K1-K3 are GitHub-only).
- Replacing K3's follow-up REVIEW with nax's own post-push re-review (now possible since `bot fix --decisions`
  exists); a separate decision.

## Anti-goals

- A ruling lands on a PR that koda cannot attribute to an actor, an approval mode and an approver.
- A ruling that exists only inside a file: not on the ticket and not on the GitHub thread.
- An untrusted PR is readied by rulings.
- A stale ruling (made for an earlier publish of the draft) settles a different item.
- An agent waives an item with no evidence text.

## Design

### D1. Ruling record

New model `FleetPrRuling`:

| Field | Notes |
|:--|:--|
| `id` | cuid |
| `projectId`, `repoId`, `prNumber` | the draft PR |
| `jobId` | the RUN job whose `workflow.openItems` holds the item |
| `itemId`, `itemKind` | from the open item |
| `text` | the ruling, first line a nax keyword; 1..2000 chars |
| `disposition` | parsed from the first line: `fixed` / `waived` / `overridden` / `confirmed` / `verified` |
| `actorType`, `actorId` | who ruled (USER or AGENT) |
| `approvalRequestId?` | when it went through proposal |
| `state` | `pending` (waiting for a Finish) / `applied` / `skipped` / `replaced` |
| `skipReason?` | nax's reason (`unknown-item`, `stale-key`, `already-settled`, `superseded-by-writer`, `ambiguous-item`, `echo-failed`, `recorder-failed`), or `untrusted-pr` from the file-level `ignored` |
| `appliedJobId?` | the FIX that applied or skipped it |
| `commentId?` | the ticket comment |
| `createdAt`, `updatedAt` | `createdAt` is the `at` nax compares with writer replies |

- One live ruling per `(jobId, itemId)`: a new ruling on the same item turns the earlier `pending` one into
  `replaced`. An `applied` ruling is history; a new ruling on that item is allowed (nax answers `already-settled` if
  the item is settled).
- No keyword-per-kind rule: nax records any keyword on any item kind (no such mapping in `bot/rulings.ts` or
  `workflow/item-threads.ts`), so koda enforces none and a caller ruling is exactly as strong as a writer reply. The
  web keyword select may suggest a default per kind (`waive` for an out-of-scope story, `verified` for cannot-verify,
  `fixed` for a gate) but offers all five.
- The keyword grammar is nax's (`workflow/ruling-keyword.ts`): `fixed <7-40 hex>[ — reason]`, `waive: <reason>`,
  `override: <reason>`, `confirm[: <reason>]`, `verified[: <reason>]`. koda copies the parser so a bad line is a 400,
  never a skipped ruling later. **Evidence rule (anti-goal 5):** `waive`, `override` and `confirm` need a non-empty
  reason in koda even where nax allows none.

### D2. Ruling route and permission

- `POST /fleet/jobs/:id/rulings` body `{ itemId, text }`. `GET /fleet/jobs/:id/rulings` lists them (with `fleet.job.read`).
- Pre-gate checks, so a ruling that cannot succeed never opens an approval request: the job exists in a project the
  caller can see (else 404); it is a RUN with `workflow.outcome = 'draft'` and a parseable GitHub `resultPrUrl`
  (else 409); `itemId` is in `workflow.openItems` (else 404); the text parses (else 400).
- New catalog key **`fleet.pr.rule`**: project scope, approvable, floor `none`, default `none`; granted to the roles
  that hold `fleet.job.dispatch`. Writes go through `ApprovalRouteGate.run` with a new route variant. With no policy
  the call is direct for users and agents (ruling 3); a project policy on `fleet.pr.rule` for type AGENT in mode
  `human` makes an agent's ruling a 202 with an approval request, written on approval as the agent.
- Audit: `fleet.pr.rule` entry with the job, item, disposition, actor, approval mode and approver.
- Surfaces: REST; CLI `koda fleet rulings <jobId>` and `koda fleet rule <jobId> <itemId> <text>`; an MCP/assistant
  tool derived from the catalog like the others; web (D6).

### D3. Ticket and visibility

- On a ruling write (after approval when held), koda finds the RUN's ticket through `FleetJobTicket`. When the RUN
  has several, it uses the oldest link *(designer call)*.
- When it has none, koda creates a TASK ticket in the project, title `Finish draft PR #<n> (<feature>)`, body linking
  the PR and the job, created by the ruling's actor, status **`IN_PROGRESS`** (allowed edge CREATED -> IN_PROGRESS,
  'NONE' comment; the RUN-dispatch start is the precedent), links it to the RUN with `FleetJobTicket`, and adds a
  `TicketLink` for the PR so the existing PR-merge sync (`vcs/vcs-pr-sync.service.ts`) moves it to `VERIFY_FIX` when
  the PR merges. Creation is idempotent per RUN (two concurrent first rulings create one ticket). The ticket needs no
  "created by koda" marker *(the earlier close rule that needed it is gone)*.
- Every ruling posts one comment of a new immutable type **`RULING`** on that ticket, authored by the ruling's actor:
  `<itemId> (<kind>): <text>`.
- When a Finish applies or skips rulings (D5), koda adds one `RULING` comment from the system actor summarising the
  result: `Finish <jobId>: applied D-1 (confirmed), B3 (waived); skipped G-1 (superseded-by-writer)`.
- On GitHub, nax echoes each applied ruling on its thread (`Recorded: ... (caller ruling by <by>)`). `by` is
  `koda:<actorType>:<actor slug or name>` *(designer call; nax limits it to 100 chars)*.

### D4. Finish = a FIX dispatch that carries rulings

- No new job kind. "Finish" in the UI dispatches FIX for the draft's PR (`prNumber` from `resultPrUrl`), under the
  existing `fleet.job.dispatch` policy and the FIX/REVIEW mutual exclusion.
- **Which rulings:** every `pending` ruling for that `(repoId, prNumber)` whose `jobId` is the **latest RUN** for that
  PR *(builder-check call: a re-run that republishes the draft gets a new RUN job with its own open items; when it is
  ingested, the older RUN's `pending` rulings become `replaced`, so a ruling made for an earlier publish never
  reaches nax)*. Only a FIX carries rulings, never a REVIEW *(builder-check call: Finish stays an explicit act, the
  ready step needs a FIX anyway, and the K1-B auto-review is unaffected)*. A ruling made while a job is running waits
  for the next FIX.
- **Head binding:** when the runner claims a FIX that has pending rulings, the API reads the PR head through the App and puts
  `{ headSha, rulings: [{ item, ruling, by, at }] }` into the assign payload (like `decisions`). Reading at assign
  time, not dispatch time, keeps the window to the review short. If someone pushes between the read and nax's
  review, nax answers `head-mismatch`, nothing is applied, and the rulings stay `pending` for the next Finish.
- **Runner:** writes `review-rulings.json` (0600, removed at cleanup and in the attempt wipe, like the decisions file)
  in nax's format and adds `--rulings <path>` to the `bot review` argv. The nax probe adds a `botRulings` capability
  (`bot review --help` lists `--rulings`). A job with rulings is placed only on a runner with `botRulings`; a job
  without rulings is unaffected (REVIEW placement does not change).
- **nax file format (as implemented):** `{ version: 1, headSha: <40 hex>, rulings: [{ item, key?, ruling, by, at }] }`;
  `item` matches `^[A-Za-z0-9._:-]{1,64}$`, `key` (optional) is the index key `w-<id>.<8 hex>`, `ruling` 1..2000 chars
  whose first line parses as a keyword, `by` 1..100 chars without newlines, `at` an ISO datetime with offset; at most
  100 rulings, one per item, file at most 262,144 bytes. An invalid file fails the command (`BOT_RULINGS_INVALID`), so
  the API and runner must only ever send what they validated. koda sends `item` only (it does not hold the index key).
- **Results:** the bundle ingest reads `callerRulings` from the review artifact (`applied: [{ item, disposition }]`,
  `skipped: [{ item, reason }]`, `ignored?`) and moves each sent ruling to `applied` or `skipped` with `skipReason`
  and `appliedJobId`. A ruling sent but absent from both lists stays `pending`. `ignored: untrusted-pr` marks every
  sent ruling `skipped`; `ignored: head-mismatch` leaves them `pending` and records the reason on the job. A skip with
  `echo-failed` or `recorder-failed` (nax could not post the echo or stopped before reaching it, so the item stays
  open) moves the ruling back to `pending` so the next Finish retries it *(designer call)*. `ambiguous-item` (two open
  threads share the id) is a terminal skip shown to the ruler. nax rejects an `at` more than 5 minutes in the future,
  so the API stamps `at` from its own clock (`createdAt`).

### D5. Fix ready result (#373) and ticket close

- The runner extends `readPushedSha` into a fix-state read: `pushedSha`, `replied`, `resolved`, `markedReady`,
  `readyHeld` (each type-checked, unknown values dropped; `readyHeld` clipped to 500 chars). It sends them in the job
  snapshot next to `fixOutcome`.
- `FleetJob` gains `fixReady` (jsonb, nullable): `{ markedReady: boolean, readyHeld?: string, replied?: number,
  resolved?: number }`. Null for non-FIX jobs and for a FIX whose state file has none of these.
- The job DTO, web job page and CLI `koda fleet job <id>` show: `Marked ready`, or `Kept as draft: <readyHeld>`, plus
  `replied N, resolved M`.
- When a FIX of PR `n` completes with `markedReady: true`, koda adds one system comment `PR #<n> marked ready by FIX
  <jobId>` to the ticket of each RUN whose `resultPrUrl` is that PR. No status change: the PR-merge sync moves the
  ticket when the PR merges, and a human approves `VERIFY_FIX` as for any ticket (user ruling, option b).

### D6. Web

- RUN job page with `workflow.outcome = 'draft'`: an **Open items** table (id, kind, severity, file:line, issue,
  suggestion, current ruling with actor and state, skip reason). Each row has a ruling input (keyword select +
  reason/sha field) for members with `fleet.pr.rule`. A **Finish** button (members with `fleet.job.dispatch`)
  dispatches the FIX and links to it.
- FIX job page: the D5 ready result next to the fix outcome.
- The ticket page needs no change beyond rendering the `RULING` comment type (immutable, no edit control).

## Failure handling

| Case | Behaviour |
|:--|:--|
| Ruling on a job that is not a draft RUN, or whose PR URL is not GitHub | 409 before the gate |
| `itemId` not in the job's open items | 404 before the gate |
| Text does not parse, or a reason-requiring keyword has no reason | 400 naming `text` |
| Caller lacks `fleet.pr.rule` / not a member | 403 / 404, as other fleet routes |
| Agent in a project whose `fleet.pr.rule` AGENT policy is `human` | 202 with the approval request; ruling, ticket and comment are written on approval |
| Ticket creation or comment fails after the ruling row is written | the ruling write fails as a whole (one transaction) |
| PR head cannot be read at assign time | the job runs without rulings; rulings stay `pending`; job records `rulings-not-sent: head-unreadable` |
| No runner has `botRulings` | the FIX/REVIEW with rulings stays queued with the existing "no capable runner" state |
| nax reports `head-mismatch` | nothing applied; rulings stay `pending`; reason on the job |
| nax reports `untrusted-pr` | every sent ruling `skipped` |
| A writer replied on GitHub after the ruling | that ruling `skipped: superseded-by-writer` |
| Review artifact missing or invalid | sent rulings stay `pending`; existing ingest error handling |
| Fix state file missing or unreadable | `fixReady` null; outcome as today |

### D7. Stale rulings and tickets *(builder-check calls)*

- A newer RUN for the same PR turns the older RUN's `pending` rulings into `replaced` (D4).
- A PR readied, merged or closed outside koda leaves `pending` rulings as they are: they are sent only if someone
  dispatches a FIX, and nax then answers `already-settled` or the FIX fails on a closed PR. No sweeper.
- An `applied` ruling is never re-sent.

## Rollout

- nax: merge and release `--rulings` (canary is enough); install on the runner host; restart the runner so the probe
  sees `botRulings`.
- koda: one migration (`FleetPrRuling`, `FleetJob.fixReady`), catalog key, runner change. Deploy
  the API before the runner (the payload field is optional).
- Live check: a sandbox RUN that escalates to a draft, an agent ruling (direct) and a proposal-mode ruling, Finish,
  PR marked ready, ticket comment; merge -> ticket `VERIFY_FIX`; a writer reply after a ruling (`superseded-by-writer`); a push between assign and
  review (`head-mismatch`).

## Left to the builder

- Names: the route variant, the CLI subcommand layout, the MCP tool name.
- Story split (expected: api+runner core, then web, then cli; #373 can be its own first story set).
- Whether `FleetPrRuling` links to the ticket comment by id or by lookup.

## Open checks for the spec (verify before writing ACs)

- That the open-item ids in `result.json` `verdict.openItems` are the ids in the PR's item index (nax renders the
  index from the same verdict). If not, the ruling route must take the index id, and the RUN ingest must carry it.
- That the nax branch merges unchanged after its code review; adjust D4 if the format changes.
