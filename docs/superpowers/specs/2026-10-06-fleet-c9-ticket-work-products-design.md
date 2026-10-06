# Fleet C9 — Ticket Work Products — Design

Builds the last S2b sub-project of the fleet plan: design doc §9.12 C9, "work products on tickets". S2b order
(ruling A1 of the (d) analytics spec): (d) analytics (done), (c) dashboard (done), (j) story graph (done),
**C9 ticket work products (this document)**. Closing it closes S2b.

This design **supersedes the S1 spec §9.4 shape** (`TicketWorkProduct` table + `FleetJob.ticketId?`); see C9-2.

## Goal

A fleet job is dispatched for one or more tickets, and its results show up on those tickets: the job's state,
branch, commit, PR and failure reason on the ticket page, the PR in the ticket's PR list with its live state, and
the ticket status following the work (RUN dispatched -> IN_PROGRESS, PR merged -> VERIFY_FIX). Nothing a job
produced has to be pasted into a ticket by hand.

## Success criteria

1. From a ticket page a DEVELOPER+ opens the dispatch form with that ticket preselected; the form accepts more
   tickets; the job is linked to every chosen ticket in the dispatch transaction.
2. A RUN dispatch moves each linked CREATED or VERIFIED ticket to IN_PROGRESS. A PLAN dispatch moves nothing.
3. Each linked ticket shows a "Fleet runs" card listing its jobs, read live from `FleetJob`, so late bundle-ingest
   corrections appear without any copy step.
4. A job that ends FAILED, ESCALATED or CRASHED leaves one system comment per attempt on each linked ticket, with the
   reason and a link to the job.
5. A job's PR appears in each linked ticket's PR list as an ordinary `pr` link, its state is kept current without a
   `VcsConnection`, and its merge moves an IN_PROGRESS ticket to VERIFY_FIX exactly once.
6. A fleet PR on another repo is never matched by the project's `VcsConnection` webhook or poll for the same PR
   number (regression test).
7. The PLAN -> RUN hand-off carries the PLAN's tickets to the RUN.

## Rulings (user, 2026-10-06)

| # | Ruling |
|---|---|
| C9-1 | **Dispatch from the ticket, many tickets per job** (option A, "can fix multiple tickets"): a `FleetJobTicket` join table, not `FleetJob.ticketId`. Entry points: Dispatch button on the ticket page (prefills) and a multi-ticket picker on the dispatch form. |
| C9-2 | **Join table + derived view + PR into `TicketLink`** (option A after a deeper read): no `TicketWorkProduct` table. The ticket page reads results from `FleetJob`; only the PR is written as a `TicketLink` (`source=fleet`) so it gets the existing PR list, PR state and merge -> VERIFY_FIX. Requires repo-scoped link matching and a fleet PR-state refresher. |
| C9-3 | **RUN dispatch moves tickets forward; failures only comment** (option A): CREATED/VERIFIED -> IN_PROGRESS on RUN dispatch; FAILED/ESCALATED/CRASHED -> system comment, no status change; CANCELLED -> nothing; no backward moves. |
| C9-4 | **Link at dispatch only** ("A first, extend only needed"): no linking of an existing job afterwards; unlink is allowed. |
| C9-5 | **No UI/UX design pass**: build from the existing tokens and components (UX redesign slices 0-6). |

## Ground truth (verified on main `ab672d48`)

- `FleetJob` has no ticket reference; nothing in `apps/api/src/fleet` touches tickets. Result fields already on the
  job: `resultBranch`, `resultSha`, `resultPrUrl`, `escalationReason`, `stateReason`, cost =
  `costSpentUsd + costCarriedUsd` (`prisma/schema.prisma:751-830`).
- Result fields arrive from runner sync events (`fleet/sync/event-payloads.ts:94-96`) and are filled late by bundle
  ingest when empty (`fleet/ingest/ingest-corrections.ts:41-44`, from nax finish-audit `*.result.json`/`last.json`).
- Every job state change goes through `JobTransitionsService.apply`. Terminal states: COMPLETED, FAILED, ESCALATED,
  CRASHED, CANCELLED (`fleet/jobs/job-state.ts:11`). Terminal sites: runner sync (`sync/sync.service.ts`, which
  already has an `afterTerminal` hook for PR attribution), silence sweeper -> CRASHED (`sync/fleet-sweeper.ts:55`),
  rejected re-adopt -> CRASHED (`sync/command-ack.processor.ts:84`), cancel (`jobs/fleet-jobs.service.ts`). Requeue
  (CRASHED|FAILED|CANCELLED -> QUEUED) bumps `leaseEpoch`.
- `TicketLink` (`schema.prisma:249-265`): `url`, `provider`, `externalRef` (`owner/repo#N`), `prState`, `prNumber`,
  `prUpdatedAt`, `linkType` (url|pr|commit|branch), `@@unique([ticketId, url])`.
- PR-state sync is single-repo: `VcsPrSyncService.syncPrStatus` queries `getPullRequestStatus(prNumber)` on the
  project's one `VcsConnection`; the webhook matches links by `(projectId, prNumber)` only
  (`vcs/prisma-vcs.repository.ts:255`). Correct today (one connection = one repo), wrong once fleet PRs from other
  repos are in `TicketLink`.
- `updateTicketLinkWithPrState` is a conditional update that never overwrites `merged` and returns `'updated'` only for
  the writer that changed the row (`vcs/prisma-vcs.repository.ts:288-297`). The merged auto-transition
  (`VcsPrSyncService.handleMergedPrAutoTransition` -> `applyMergedPrTransition`) moves IN_PROGRESS -> VERIFY_FIX with a
  FIX_REPORT comment and a `VCS_PR_MERGED` activity; today it runs before the conditional update.
- Ticket transitions: CREATED -> IN_PROGRESS and VERIFIED -> IN_PROGRESS need no comment
  (`tickets/state-machine/ticket-transitions.ts`). Transition to VERIFIED fires `createPrForTicket` (classic flow);
  transitions to IN_PROGRESS do not.
- System comments already exist: "Merged PR" is written with `authorUserId = authorAgentId = null`.
- The `koda-fleet` GitHub App has no webhooks; `GitHubAppClient` mints installation tokens and comments on PRs
  (`fleet/git-broker/github-app-client.ts`). GitLab fleet repos use `GitLabTokenSource`.
- Ticket live events are content-free, fanned out from the `TicketEvent` outbox via `TICKET_ACTION_TO_LIVE`
  (`live/live-event.ts:20`), action `TICKET_UPDATED` -> `updated`.
- The dispatch page is `/<project>/fleet/dispatch`, prefilled from the query by `dispatchPrefillFromQuery`
  (`apps/web/lib/fleet-dispatch.ts:102`); the PLAN -> RUN hand-off (#221) is a link with query prefill.

## Out of scope

- Linking an existing or scheduled job to a ticket after dispatch (C9-4; add when needed).
- Using the ticket description as the PLAN spec; PLAN still takes `planFrom`, a spec path in the repo.
- The classic VERIFIED -> `createPrForTicket` flow and a fleet RUN on the same ticket can each open a PR (draft
  `KEY-N-...` branch vs `feat/<feature>`). Left as is; filed as a follow-up issue when this spec merges.
- `branch`/`commit`/`artifact` `TicketLink` rows for fleet jobs: the Fleet runs card shows branch and sha, and the job
  page holds logs and the bundle.
- Notifications beyond the ticket comment and live event (#208 covers delivery).

## 1. Data

One migration `<ts>_fleet_ticket_work_products`. No Prisma enums (repo rule); string columns with value comments,
constants in `apps/api/src/common/enums.ts`.

```prisma
model FleetJobTicket {
  jobId         String
  ticketId      String
  notifiedEpoch Int?     // last leaseEpoch whose failure comment was written (§3.2)
  createdAt     DateTime @default(now())

  job    FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  ticket Ticket   @relation(fields: [ticketId], references: [id], onDelete: Cascade)

  @@id([jobId, ticketId])
  @@index([ticketId])
}

model TicketLink {
  // ... existing fields
  source String  @default("vcs") // vcs | fleet
  jobId  String?                 // set on fleet PR links
  job    FleetJob? @relation(fields: [jobId], references: [id], onDelete: SetNull)
  @@index([jobId])
}
```

Existing `TicketLink` rows become `source = vcs` by the default. Soft-deleted tickets (`deletedAt`) are excluded from
every read and from every effect.

## 2. API

### 2.1 Dispatch

`POST /projects/:slug/fleet/jobs` (`DispatchFleetJobDto`) gains `ticketRefs?: string[]`:

- At most 20, deduplicated, each a ticket ref (`KEY-N`, parsed by `parseTicketRef`).
- Each must resolve to a ticket of this project, not deleted, status not CLOSED or REJECTED. Otherwise 400 naming the
  first bad ref, through the existing `fleet.dispatchInput` message (`Invalid dispatch: ticket <REF>`). Refs are
  upper-cased before parsing (`web-1` = `WEB-1`).
- Rows are inserted in the dispatch transaction; a failed dispatch (409 duplicate feature, budget paused, 404, 422)
  leaves none.
- Permission unchanged: `CREATE FleetJob` (DEVELOPER+).

### 2.2 Reads

- `FleetJobDto` gains `tickets: Array<{ ref: string; title: string; status: string }> | null`: populated on job
  detail, `null` on lists (same convention as `postRun`).
- New `GET /projects/:slug/tickets/:ref/fleet-jobs` (project member, `READ FleetJob`): the ticket's linked jobs,
  newest `queuedAt` first, at most 50. Each item (`TicketFleetJobDto`): `id`, `command`, `feature`, `state`,
  `stateReason`, `escalationReason`, `resultBranch`, `resultSha`, `resultPrUrl`, `costUsd`
  (`costSpentUsd + costCarriedUsd`), `queuedAt`, `finishedAt`. Read live from `FleetJob`; nothing copied.

### 2.3 Unlink

New `DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId` (DEVELOPER+, `CREATE FleetJob`), 204; 404 when not linked.
In one transaction: delete the `FleetJobTicket` row and the `TicketLink` rows on this ticket with `source = fleet` and
this `jobId`. The PR on the forge is untouched. Past status changes and comments stay (history). Emits a ticket
`updated` live event.

## 3. Lifecycle effects

A new `FleetJobTicketEffects` service (in a new `fleet/tickets/` module) owns every ticket-side effect. All effects
run **after** the job's own transaction commits, are best-effort per ticket (an error is logged and the next ticket
proceeds), never fail the dispatch or the sync, and never run for a job with no linked tickets.

### 3.1 RUN dispatch -> IN_PROGRESS

After a RUN dispatch commits, for each linked ticket whose status is CREATED or VERIFIED: transition to IN_PROGRESS via
`TicketTransitionsService` as the requester's principal (so activity, outbound webhooks, `TicketEvent` and live events
come from the normal path). PLAN dispatch: no transition. A ticket that changed status between validation and the
effect is skipped (the transition validator rejects it; logged at debug).

### 3.2 Terminal -> failure comment

`onTerminal(jobId)` is called after commit from the two places that can end a job FAILED, ESCALATED or CRASHED: sync
`afterTerminal` (runner reports, re-adopt reject, assign reject) and the silence sweeper. Server-side cancels end
CANCELLED before a runner ran anything, so they produce neither a comment nor a PR. For FAILED, ESCALATED and CRASHED:

1. Claim per ticket: `UPDATE "FleetJobTicket" SET "notifiedEpoch" = :epoch WHERE "jobId" = :job AND "ticketId" = :t
   AND ("notifiedEpoch" IS NULL OR "notifiedEpoch" < :epoch)`. Only the claimant (count 1) continues, so a retried hook
   never comments twice and a requeued attempt (higher epoch) comments again.
2. Write a GENERAL comment with null author: `Fleet <RUN|PLAN> job <link> ended <STATE>: <reason>`, where reason is
   `escalationReason` for ESCALATED, else `stateReason`, truncated to 500 chars; the link is the web job page path.
3. Record `COMMENT_ADDED` in the `TicketEvent` outbox (live `commented`).

COMPLETED and CANCELLED write no comment. `onTerminal` then runs §3.3 for any state.

### 3.3 PR link

`upsertPrLinks(jobId)`: when the job has a `resultPrUrl`, for each linked ticket:

- Parse the URL against the job's `FleetRepo` (reuse `prNumberFor` from `fleet/sync/pr-attribution.service.ts`); a URL
  that does not belong to the job's repo is ignored (logged).
- If a `TicketLink` with this `(ticketId, url)` exists: set `jobId` only (a `vcs` link keeps `source = vcs`).
- Else create `{ linkType: 'pr', source: 'fleet', jobId, provider, prNumber, externalRef: 'owner/repo#N',
  prState: 'open', prUpdatedAt: now }`.
- Emit `TICKET_UPDATED` when a row was created.

Called from `onTerminal` and after bundle ingest corrections fill `resultPrUrl` (`ingest-corrections.ts`). Idempotent
through the unique `(ticketId, url)`.

### 3.4 Fleet PR-state refresher

`FleetPrStateRefresher` (in `fleet/tickets/`), a `setInterval` started in `onModuleInit` like `FleetSweeper`, every
`FLEET_PR_REFRESH_MS` (new fleet config, default 600 000, min 60 000):

- Select `TicketLink` rows with `source = fleet`, `prNumber` not null, `prState` not in (merged, closed), ticket not
  deleted, joined to the job's `FleetRepo`; group by repo.
- Fetch PR state: GitHub via new `GitHubAppClient.getPullRequest(installationId, owner, name, number)` (installation
  token, `GET /repos/{o}/{r}/pulls/{n}` -> `{ state, merged, draft, mergedBy, mergeSha, url }`); GitLab via
  `GET /projects/:id/merge_requests/:iid` with the `GitLabTokenSource` token.
- Map state like `VcsPrSyncService.mapPrState`; a 404 marks the link `closed`; any other error skips the link.
- For a change to `merged`: run the shared merge step (§3.5). Other changes: `updateTicketLinkWithPrState`.
- One repo's failure does not stop the others. At most one run at a time (skip a tick while running).

### 3.5 Merge step, shared and gated

Extract `applyMergedPr(link, prStatus)` used by `VcsPrSyncService`, `VcsWebhookService` and the refresher:

1. `updateTicketLinkWithPrState(link.id, 'merged')`.
2. Only if it returned `'updated'` and the ticket is IN_PROGRESS: `applyMergedPrTransition` (VERIFY_FIX, FIX_REPORT
   comment, `VCS_PR_MERGED` activity).

This reverses today's order (transition, then update) so that when the VCS path and the fleet refresher both see one
merge (fleet repo = connection repo), exactly one transition and one comment happen.

### 3.6 Repo-scoped VCS matching

- Webhook lookup `findTicketLinkByPrNumber(projectId, prNumber)` becomes
  `findTicketLinkForConnectionPr(projectId, connection, prNumber)`: match `externalRef = '<repoOwner>/<repoName>#N'`
  (case-insensitive), or `externalRef IS NULL AND prNumber = N AND source = 'vcs'` for legacy rows.
- `findActiveTicketLinksWithPrs(projectId)` applies the same filter, so the VCS poll never asks the connection's repo
  about another repo's PR number.
- Fleet links on the connection's own repo still match (same `externalRef`), so they also get webhook speed.

## 4. Web

- **Ticket page** (`pages/[project]/tickets/[ref].vue`): a **Dispatch** button in the ticket actions (DEVELOPER+,
  hidden when the project has no fleet repo), linking to
  `/<project>/fleet/dispatch?tickets=<REF>&feature=<slug>&command=PLAN`, where `<slug>` = lower-case
  `<key>-<number>-<title>` reduced to `[a-z0-9-]`, at most 48 chars.
- **`components/TicketFleetRuns.vue`** (new; `TicketProperties.vue` is already 465 lines), between the header and
  `TicketActivity`, hidden when empty. One row per job: command, state chip (existing fleet chip), feature, branch,
  short sha, PR link with state chip (from the ticket's links), reason when FAILED/ESCALATED/CRASHED, cost, relative
  time; row links to the job page; **Unlink** (DEVELOPER+, confirm dialog). Reloads on ticket and `fleet_job` live
  events for its jobs.
- **`TicketProperties.vue`**: a small "via fleet" mark on PR links with `source = fleet` (`TicketLinkResponseDto`
  gains `source` and `jobId`).
- **Dispatch page** (`fleet/dispatch.vue`, `lib/fleet-dispatch.ts`): a **Tickets** multi-select (search by ref or title,
  open tickets only, max 20), prefilled from `?tickets=` (comma-separated), sent as `ticketRefs`.
- **PLAN -> RUN hand-off** (#221 link): adds `tickets=` from the PLAN job's `tickets`.
- **Job page**: a "Tickets" row (ref, title, status chip, link) when `tickets` is non-empty.
- i18n en + zh for every new label; locale parity enforced by the existing check.

## 5. CLI

- `koda fleet dispatch --ticket <REF>` (repeatable) -> `ticketRefs`.
- `koda ticket show <REF>` prints a "Fleet runs" section from the new endpoint.
- Generated client regenerated; `bun run generate` leaves no diff.

## 6. Testing

- **Unit:** ref validation (other project, deleted, CLOSED, REJECTED, > 20, duplicates); RUN moves CREATED/VERIFIED
  only, PLAN moves none; which terminal states comment; `notifiedEpoch` claim (retry = no second comment, requeue =
  new comment); reason selection and truncation; PR link upsert incl. existing `vcs` link and foreign-repo URL;
  `externalRef` matching incl. legacy null row and a `fleet` link on another repo; refresher state mapping, 404 ->
  closed, per-repo error isolation, no overlapping runs; `applyMergedPr` gating; dispatch DTO and web prefill helpers.
- **Integration (DB-mode Postgres):** dispatch writes links atomically (failed dispatch leaves none); unlink removes the
  join row and the fleet PR link only; **regression:** a fleet link `owner2/repo2#5` is untouched by a connection
  webhook for PR #5; VCS path + refresher on one merge -> one transition, one FIX_REPORT comment; migration applies on a
  DB with existing `TicketLink` rows.
- **E2E (web):** Dispatch from a ticket prefills tickets and feature; a seeded linked job (FAILED with reason, and
  COMPLETED with PR) renders in the Fleet runs card; Unlink removes it; the PR shows "via fleet".
- **Live check on koda-wk** after slice 2 (billed; approval at launch): on `koda-fleet-sandbox`, two tickets ->
  Dispatch PLAN from one, add the second, hand off to RUN; both tickets go IN_PROGRESS and show the PR; merge the PR;
  both go VERIFY_FIX within one refresher cycle.

## 7. Slices

Sequential PRs, each cut from `main` after the previous merges.

| Slice | Scope |
|---|---|
| 1a | Migration; `ticketRefs` on dispatch; ticket fleet-jobs GET/DELETE; `FleetJobDto.tickets`; §3.1 status move; §3.2 failure comments wired to every terminal site; live events; CLI `--ticket` + `ticket show`; contract regen. |
| 1b | §3.3 PR links (terminal + ingest corrections); §3.4 refresher + `GitHubAppClient.getPullRequest` + GitLab MR fetch; §3.5 gated merge step; §3.6 repo-scoped matching; `TicketLinkResponseDto.source/jobId`. |
| 2 | Web: Dispatch button, `TicketFleetRuns`, "via fleet" mark, Tickets picker, hand-off `tickets=`, job page Tickets row, i18n, E2E. |

## Decisions

| # | Decision |
|---|---|
| D448 | Many-to-many `FleetJobTicket(jobId, ticketId)` with composite key; supersedes `FleetJob.ticketId?` (S1 spec §9.4). |
| D449 | No `TicketWorkProduct` table: job results are read live from `FleetJob`; only PRs become `TicketLink` rows (`source=fleet`, `jobId`). Branch/commit/artifact are shown from the job, not stored on the ticket. |
| D450 | `ticketRefs` validated before the dispatch transaction and linked inside it: same project, not deleted, not CLOSED/REJECTED, max 20, upper-cased; 400 `fleet.dispatchInput` names the bad ref. |
| D451 | Ticket effects run after commit, best-effort per ticket, never fail dispatch or sync. |
| D452 | RUN dispatch: CREATED/VERIFIED -> IN_PROGRESS via `TicketTransitionsService` as the requester. PLAN: none. No backward moves. |
| D453 | Failure comment for FAILED/ESCALATED/CRASHED, once per attempt, claimed by `FleetJobTicket.notifiedEpoch < leaseEpoch`. Null author, GENERAL type, reason truncated to 500. |
| D454 | `onTerminal` called after commit from sync `afterTerminal` and the sweeper (the only paths to FAILED/ESCALATED/CRASHED), not from inside `JobTransitionsService.apply` (which runs in the transaction). |
| D455 | PR link upsert on `(ticketId, url)`; an existing `vcs` link only gains `jobId`; URL must belong to the job's `FleetRepo`; also called after ingest corrections. |
| D456 | Fleet PR state refreshed by a fleet-side poller through the GitHub App / GitLab token, `FLEET_PR_REFRESH_MS` default 10 min, min 1 min; independent of `VcsConnection`. |
| D457 | Shared `applyMergedPr`: conditional `merged` update first, transition only for the writer that won; fixes double transition when two paths see one merge. |
| D458 | VCS webhook and poll match by the connection's `externalRef`; legacy null-ref rows match by number only when `source=vcs`. |
| D459 | Unlink deletes the join row and that job's `source=fleet` links on that ticket; history (status changes, comments) stays. |
| D460 | `GET .../tickets/:ref/fleet-jobs` returns at most 50, newest first; `FleetJobDto.tickets` null on lists. |
| D461 | Web: new `TicketFleetRuns` component; Dispatch button prefills `tickets`, `feature` slug (max 48) and `command=PLAN`; hand-off carries `tickets`. |
