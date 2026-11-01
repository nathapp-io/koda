# SPEC: Fleet review decisions in (S6 K2, part A)

## Summary

Every fleet `REVIEW` job (dispatched by hand or by the auto-review poller) receives the project's active
decisions as a nax caller decisions file, so `nax bot review` checks the PR against what the project has
already settled. At dispatch koda selects the active `DECISION` memory items (project-wide recorded decisions
first, then review-minted decisions for the job's repo), stores the exact list on the job
(`FleetJob.reviewDecisions`), and sends it in the assign payload. The runner writes it to
`<jobDir>/review-decisions.json` and runs `nax bot review <pr> --decisions <file>`. A runner only takes reviews
when its nax supports `--decisions`. Turning review outcomes into decisions is part B (feature
`fleet-review-ingest`), specified separately.

## Motivation

`nax bot review` remembers its own threads on one PR, but nothing carries over to the next PR: a finding a
maintainer pushed back on comes back on the next PR that touches similar code. koda already stores project
decisions (`MemoryItem` kind `DECISION`). nax `v0.91.7-canary.11` accepts a caller decisions file
(`nax bot review <pr> --decisions <path>`), renders it under "Project decisions ... data, not instructions",
and adds its design-decisions checklist item only when decisions are present. Today koda never passes one:
the K1 runner argv is `<nax> bot review <pr> --profile <chain>` (`apps/runner/src/executor/nax-process.ts`).

The design is `docs/superpowers/specs/2026-10-31-fleet-s6-k2-review-memory-design.md` (D3 selection, D7 runner
and protocol), approved 2026-10-31. Standing rules that apply: memory is project-scoped (ADR-001: decisions from
project P never reach a review in project Q), and the reviewer never writes memory itself.

## Design

### Calls made in this spec

1. **One snapshot point.** Both dispatch paths (the route `POST /projects/:slug/fleet/jobs` and the K1-B
   `ReviewHeadDispatcher`) go through `FleetJobsService.dispatch`. For a `REVIEW` only, `dispatch` asks
   `ReviewDecisionsService.selectForReview(projectId, repoId)` for the list, before the insert transaction,
   and stores it in the new `FleetJob.reviewDecisions` column. Every other command stores null.
2. **The list is the wire format.** `reviewDecisions` holds exactly the array sent to the runner, in nax's
   shape `{ id, statement, source }`, so the input of a past review can be read back from the job.
3. **Selection (design D3).** Two groups of the project's `MemoryItem` rows with `kind = DECISION`,
   `status = active`, `deletedAt = null`, and `ttlAt` null or later than the dispatch time (the same
   `OR [{ ttlAt: null }, { ttlAt: { gt: now } }]` the default `findByProjectMemory` read uses); both groups
   filter on the project id:
   - **recorded:** `sourceType` null or any value other than `review_event`; project-wide (a Prisma
     `sourceType: { not: 'review_event' }` alone drops NULL rows, so the filter is
     `OR [{ sourceType: null }, { sourceType: { not: 'review_event' } }]`);
   - **review-minted:** `sourceType = review_event` and `subject = repo:<repoId>` (only this job's repo).
   Recorded fill first, then review-minted, each ordered `updatedAt` desc then `id` desc, 100 in total
   (nax's cap). A review-minted row never pushes out a recorded one.
4. **Entry shape.** `id` = the memory item id; `source` = `koda:memory/<id>`; `statement` =
   `<predicate>: <object>`, or the predicate alone when `object` is null or empty. **"Characters" means UTF-16
   code units (JS `string.length`), as nax's zod `.max(2000)` counts.** A statement longer than 2000 code units
   is cut to its first 1997 code units plus `...`; when the 1997th code unit is a high surrogate, the cut takes
   1996 instead, so no lone surrogate is left.
5. **Byte cap.** When `Buffer.byteLength(JSON.stringify({ version: 1, decisions }))` is above 262,144 (nax's
   file cap), entries are dropped from the end of the ordered list until it fits. The runner writes exactly
   that compact serialization (call 7), so the file size equals the measured size.
6. **Wire.** `AssignPayload.review` gains optional `decisions`. `buildAssignPayload` adds it only when the
   job's `reviewDecisions` is a non-empty array; an empty list or null sends no `decisions` key.
7. **Runner file.** When `assign.review.decisions` is non-empty, `HostExecutor.spawn` writes
   `<jobDir>/review-decisions.json` as `JSON.stringify({ version: 1, decisions })` (no indentation, no trailing
   newline, mode `0600`) **before** the token file, and `buildNaxArgv` appends `--decisions <that absolute path>`
   after `--profile <chain>`. No file and no flag otherwise. The file holds no secret, so it is removed only by
   the attempt wipe (`ATTEMPT_FILES`), not by cleanup. *(Deliberate divergence from the design doc, which
   names the file `decisions.json` and removes it at cleanup: the `review-` prefix keeps it apart from nax's
   own `workflow/decisions.jsonl`, and nothing secret needs a cleanup.)*
8. **Probe.** The runner reports `botReview: true` only when, in addition to the K1 checks,
   `bot review --help` stdout contains `--decisions`. A nax without it stops being placed for reviews instead
   of failing every review on an unknown flag.
9. **Runner validation.** `parseAssign` checks `review.decisions` against nax's limits (at most 100 entries;
   `id` matching `^[A-Za-z0-9._:-]{1,64}$` and unique; `statement` a string of 1..2000 characters; `source`
   absent or a string of at most 200 characters). A violation is `bad('review')`.
10. **Old rows.** A job row written before this feature has `reviewDecisions` null and behaves as an empty
    list.
11. **Old runners.** A runner built before this feature still reports `botReview: true` (its probe never
    checked `--decisions`) and its `parseAssign` copies only `prNumber` and `botLogin`, so it would run the
    review without decisions. koda-wk's runner runs from the same checkout as the API build, so the two are
    deployed together; no separate capability flag is added.

### Wire shape

The assign payload's `review` object for a job with two decisions:

```json
{
  "prNumber": 42,
  "botLogin": "koda-fleet[bot]",
  "decisions": [
    { "id": "cmd1", "statement": "auth: tokens live in Redis, not Postgres", "source": "koda:memory/cmd1" },
    { "id": "cmd2", "statement": "review-finding:f-ab12: Not a defect: ...", "source": "koda:memory/cmd2" }
  ]
}
```

The file the runner writes, `<jobDir>/review-decisions.json`:

```json
{ "version": 1, "decisions": [ { "id": "cmd1", "statement": "auth: tokens live in Redis, not Postgres", "source": "koda:memory/cmd1" } ] }
```

### Integration

Read-only (verified at koda `main` `1fe8d458`):

- `FleetJobsService.dispatch(actorId, projectId, dto, opts)` (`apps/api/src/fleet/jobs/fleet-jobs.service.ts:77`):
  loads the repo, rejects a non-GitHub `REVIEW`, runs `normalizeDispatch`, then inserts inside
  `txManager.run`. `ReviewHeadDispatcher` (`apps/api/src/fleet/reviews/review-head-dispatcher.ts:101`) calls it
  with `auditKey: 'system.pr-review.dispatch'`.
- `PrismaMemoryItemRepository` (`apps/api/src/memory/prisma-memory-item.repository.ts`), registered and exported
  by `MemoryModule` (`apps/api/src/memory/memory.module.ts`); `MemoryItem` domain type
  (`apps/api/src/memory/memory-item-repository.ts`). Nothing reachable from `MemoryModule` imports a fleet
  module (`fleet/assistant/assistant.module.ts:50`), so `FleetJobsModule` may import it.
- `MemoryKind.DECISION` (`apps/api/src/common/enums.ts`).
- The API may import `@nathapp/fleet-protocol` with `import type` only; protocol edits ride an `apps/api` story.
- `writeReviewToken` / `ATTEMPT_FILES` / `HostExecutor.spawn` (`apps/runner/src/executor/review-token.ts`,
  `apps/runner/src/executor/host-executor.ts:58,159`): the K1 token file pattern this story mirrors.
- `PlacementService` (`apps/api/src/fleet/jobs/placement.service.ts:204-210`): re-reads the job with `findById`,
  calls `buildAssignPayload`, and writes the ASSIGN `FleetCommand` with that payload.
- `FakeNaxCli` (`apps/runner/test/helpers/fake-nax-cli.ts`): `botReview` answer for `bot review --help`.

Changed. The baseline locates the code; implement the target.

- `packages/fleet-protocol/src/index.ts` (types only) — Baseline: `review?: { prNumber: number; botLogin: string }`.
  Target: `review?: { prNumber: number; botLogin: string; decisions?: ReviewDecision[] }` with exported
  `interface ReviewDecision { id: string; statement: string; source?: string }`.
- New `apps/api/src/memory/review-decisions.ts`: `REVIEW_EVENT_SOURCE = 'review_event'`,
  `MAX_REVIEW_DECISIONS = 100`, `MAX_DECISION_STATEMENT = 2000`, `MAX_DECISIONS_FILE_BYTES = 262144`,
  `reviewRepoSubject(repoId): string` (`repo:<repoId>`), and the pure
  `buildReviewDecisions(recorded: MemoryItem[], reviewMinted: MemoryItem[]): ReviewDecision[]` applying calls
  3-5 to rows already filtered and ordered by the repository.
- `PrismaMemoryItemRepository` gains `findReviewDecisionRows(projectId, repoId, take): Promise<{ recorded:
  MemoryItem[]; reviewMinted: MemoryItem[] }>` (both groups, filtered and ordered per call 3, at most `take` each).
- New `apps/api/src/memory/review-decisions.service.ts`: `ReviewDecisionsService.selectForReview(projectId,
  repoId): Promise<ReviewDecision[]>`, provided and exported by `MemoryModule`.
- `FleetJob` (`apps/api/prisma/schema.prisma`): adds `reviewDecisions Json?`; migration
  `20261117090000_fleet_review_decisions`.
- `NewFleetJob` / `FleetJobRecord` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`): optional
  `reviewDecisions?: ReviewDecision[] | null`. In `prisma-fleet-job.repository.ts`, `toJob` casts the JSON
  column to `ReviewDecision[] | null`; `createJob` omits the key when `reviewDecisions` is undefined, writes
  `Prisma.DbNull` for an explicit null, and writes an array as `as unknown as Prisma.InputJsonValue` (the
  pattern the file's `update` uses for `stories` and `postRun`). `dispatch` passes the key only for `REVIEW`.
- `ReviewDecision` is imported with `import type` from `@nathapp/fleet-protocol` (the API's protocol rule).
- `FleetJobsService` constructor — Baseline: ends with `private readonly audit: AuditRecorder`. Target: adds a
  last parameter `private readonly reviewDecisions: ReviewDecisionsService`. `FleetJobsModule` imports `MemoryModule`.
- `buildAssignPayload` (`apps/api/src/fleet/jobs/assign-payload.ts`): call 6.
- `FleetJobDto` (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`): adds `reviewDecisions` (array of
  `{ id, statement, source }` or null), filled by `FleetJobDto.from`; `summary` sets it to null.
- `parseAssign` (`apps/runner/src/supervisor/assign-parser.ts:154`, review check near line 179): call 9; the parsed
  `review` keeps `decisions` when present (an empty array is accepted and kept).
- `buildNaxArgv` (`apps/runner/src/executor/nax-process.ts`) — Baseline: `buildNaxArgv(naxCommand, assign)`.
  Target: `buildNaxArgv(naxCommand, assign, opts: { decisionsPath?: string } = {})`; a `REVIEW` with
  `opts.decisionsPath` appends `'--decisions', opts.decisionsPath`.
- New `apps/runner/src/executor/review-decisions-file.ts`: `REVIEW_DECISIONS_FILE = 'review-decisions.json'`,
  `writeReviewDecisions(jobDir, decisions): Promise<string>` (mode `0600`, returns the path).
- `HostExecutor.spawn`: call 7. `ATTEMPT_FILES` adds `review-decisions.json`.
- The nax probe's private `botReview` (`apps/runner/src/capabilities/nax-probe.ts:258`): call 8.

### Failure Handling

| Situation | Behaviour |
|:--|:--|
| The project has no active decisions | The job stores `[]`; the assign has no `decisions` key; no file, no flag. |
| A statement longer than 2000 characters | Cut to 1997 characters plus `...`. |
| The encoded list exceeds 262,144 bytes | Entries dropped from the end until it fits. |
| The decisions query throws at dispatch | The dispatch fails (500); no job is inserted. |
| An assign with an invalid `review.decisions` | `parseAssign` rejects it with `bad('review')`. |
| Writing `review-decisions.json` fails | `spawn` throws (the job FAILS with `spawn failed: <message>`); no token file is written; nax is not started. |
| The token is missing, or nax fails to start, after `review-decisions.json` was written | The decisions file stays until the next attempt wipe (it holds no secret). |
| nax on the runner lacks `--decisions` | The probe omits `botReview`; reviews stay QUEUED with misfit `bot_review`. |

## Out of Scope

- Turning `bot-review.json` events into `DECISION` items, the GitHub permission check, and the retire route; those are part B (feature `fleet-review-ingest`).
- Path-scoped decision selection; `MemoryItem` has no file paths, so every eligible decision is sent up to the cap.
- Mapping forge logins to koda users.
- Showing the decisions sent on the web job page; the API job detail exposes them.
- A CLI command for the decisions sent; the generated CLI client is regenerated but no command is added.
- Recomputing the decisions on requeue; a requeued `REVIEW` keeps the list stored at dispatch.
- A runner capability flag for decisions support; a runner built before this feature drops `review.decisions`, so the runner and the API are deployed together (call 11).
- Removing `review-decisions.json` at job cleanup; it holds no secret and the attempt wipe removes it.
- Decisions for `RUN`, `PLAN`, thread or config jobs; only `REVIEW` jobs carry them.
- GitLab reviews; K1 reviews GitHub repos only.

## Stories

This is one capability (decisions into reviews) in 6 stories, split per package and along seams.

### US-001 — Build the decisions list from memory rows

Workdir: apps/api. No dependencies.

Adds the protocol `ReviewDecision` type and `review.decisions`, and the pure `review-decisions.ts` module
(constants, `reviewRepoSubject`, `buildReviewDecisions`) applying calls 3-5.

### US-002 — Select a review's decisions

Workdir: apps/api. Depends on US-001.

`PrismaMemoryItemRepository.findReviewDecisionRows` and `ReviewDecisionsService.selectForReview`, provided and
exported by `MemoryModule`.

### US-003 — Snapshot the decisions on dispatch and send them

Workdir: apps/api. Depends on US-002.

The `FleetJob.reviewDecisions` column and migration, the domain fields, `FleetJobsService.dispatch` storing the
snapshot for `REVIEW`, `FleetJobsModule` importing `MemoryModule`, `buildAssignPayload` sending
`review.decisions`, `FleetJobDto.reviewDecisions`; regenerates `openapi.json` and the CLI client (`bun run
generate` from the repo root). Run `bun run db:generate` in `apps/api` after the schema and migration edits (the
Prisma client under `apps/api/src/generated/prisma/` is git-ignored and must be regenerated before `toJob` and
`createJob` type-check). Only the root `openapi.json` is tracked and changes; the CLI client regenerates into the
git-ignored `apps/cli/src/generated/`. The `FleetJobsModule` -> `MemoryModule` import is exercised by the existing
`apps/api/src/fleet/jobs/fleet-jobs.module.spec.ts` compile test.

### US-004 — The runner accepts decisions in the assign

Workdir: apps/runner. Depends on US-001.

`parseAssign` validates `review.decisions` per call 9 ("characters" = UTF-16 code units, JS `string.length`).

### US-005 — The runner's argv and probe know `--decisions`

Workdir: apps/runner. Depends on US-004.

`buildNaxArgv` takes `decisionsPath`; the nax probe requires `--decisions` in `bot review --help`.

### US-006 — The runner writes the decisions file

Workdir: apps/runner. Depends on US-005.

`review-decisions-file.ts`; `HostExecutor.spawn` writes the file before the token file and passes its path to
`buildNaxArgv`; `ATTEMPT_FILES` gains `review-decisions.json`.

### Context Files

**US-001**

- `packages/fleet-protocol/src/index.ts` — the protocol `review` type this story widens.
- `apps/api/src/memory/memory-item-repository.ts` — the `MemoryItem` domain type.
- `apps/api/src/common/enums.ts` — `MemoryKind`.

**US-002**

- `apps/api/src/memory/prisma-memory-item.repository.ts` — the repository this story extends.
- `apps/api/src/memory/memory.module.ts` — providers and exports.
- `apps/api/src/memory/memory.module.spec.ts` — DI wiring test pattern.
- `apps/api/test/integration/fleet/fleet-review-dispatch.integration.spec.ts` — PG integration test setup.

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.ts` — `dispatch`.
- `apps/api/src/fleet/jobs/fleet-jobs.module.ts` — imports.
- `apps/api/src/fleet/jobs/assign-payload.ts` — `buildAssignPayload`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobDto.from` and `summary`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `toJob`, `createJob`.
- `apps/api/src/fleet/jobs/fleet-jobs.module.spec.ts` — the module compile test that exercises the new import.

**US-004**

- `apps/runner/src/supervisor/assign-parser.ts` — `parseAssign`.
- `apps/runner/src/supervisor/assign-parser.spec.ts` — existing `parseAssign` tests.

**US-005**

- `apps/runner/src/executor/nax-process.ts` — `buildNaxArgv`.
- `apps/runner/src/capabilities/nax-probe.ts` — the nax probe.
- `apps/runner/test/helpers/fake-nax-cli.ts` — `FakeNaxCli` answers.

**US-006**

- `apps/runner/src/executor/host-executor.ts` — `spawn`, `ATTEMPT_FILES`, `HostExecutorDeps.spawnNax`.
- `apps/runner/src/executor/review-token.ts` — the mode-restricted file pattern.
- `apps/runner/test/unit/host-executor.spec.ts` — spawn test pattern with an injected `spawnNax`.

### Creates

**US-001**

- `apps/api/src/memory/review-decisions.ts` — constants, `reviewRepoSubject`, `buildReviewDecisions`.
- `apps/api/src/memory/review-decisions.spec.ts` — unit tests.

**US-002**

- `apps/api/src/memory/review-decisions.service.ts` — `ReviewDecisionsService`.
- `apps/api/test/integration/memory/review-decisions.integration.spec.ts` — PG tests of the selection.

**US-003**

- `apps/api/prisma/migrations/20261117090000_fleet_review_decisions/migration.sql` — adds `FleetJob.reviewDecisions`.
- `apps/api/test/integration/fleet/fleet-review-decisions-dispatch.integration.spec.ts` — dispatch route tests.

**US-006**

- `apps/runner/src/executor/review-decisions-file.ts` — `REVIEW_DECISIONS_FILE`, `writeReviewDecisions`.
- `apps/runner/src/executor/review-decisions-file.spec.ts` — unit tests.

### Modifies

**US-002**

- `apps/api/src/memory/memory.module.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.

**US-003**

- `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts` — its three `new FleetJobsService(...)` calls (lines 36, 108, 160) pass the constructor arguments positionally and stop type-checking once the constructor gains its last `reviewDecisions` parameter; each call gains a trailing `{ selectForReview: vi.fn().mockResolvedValue([]) } as never`, and every existing assertion is unchanged; the file also gains the story's `dispatch` unit tests.
- `apps/api/src/fleet/jobs/fleet-jobs.config-requeue.spec.ts` — its `new FleetJobsService(...)` call (line 39) passes the constructor arguments positionally and stops type-checking once the constructor gains its last `reviewDecisions` parameter; it gains a trailing `{ selectForReview: vi.fn().mockResolvedValue([]) } as never`, and every existing assertion is unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-handoff.spec.ts` — its `new FleetJobsService(...)` call (line 12) passes the constructor arguments positionally and stops type-checking once the constructor gains its last `reviewDecisions` parameter; it gains a trailing `{ selectForReview: vi.fn().mockResolvedValue([]) } as never`, and every existing assertion is unchanged.
- `apps/api/src/fleet/jobs/fleet-jobs.thread-requeue.spec.ts` — its `new FleetJobsService(...)` call (line 28) passes the constructor arguments positionally and stops type-checking once the constructor gains its last `reviewDecisions` parameter; it gains a trailing `{ selectForReview: vi.fn().mockResolvedValue([]) } as never`, and every existing assertion is unchanged.

- `apps/api/src/fleet/jobs/assign-payload.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.
- `openapi.json` — the expected output of `bun run generate`: `FleetJobDto` gains `reviewDecisions`; no other schema changes.

**US-004**

- `apps/runner/src/supervisor/assign-parser.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.

**US-005**

- `apps/runner/src/executor/nax-process.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.
- `apps/runner/src/capabilities/nax-probe.spec.ts` — the test `US-004: advertises K0 only when bot review exists and rejects ambient token env` (line 67) stubs `bot review --help` with stdout `help`, which no longer yields `botReview: true` once the probe requires `--decisions`; its stub stdout becomes `--decisions <path>  Caller decisions file`, and its `botReview` and env assertions are unchanged; the file also gains tests for this story's probe acceptance criteria.

**US-006**

- `apps/runner/test/unit/host-executor.spec.ts` — adds tests for this story's acceptance criteria; every existing assertion is unchanged.

### Seams

- `buildReviewDecisions` / `reviewRepoSubject` (US-001) are used by `ReviewDecisionsService.selectForReview`
  (US-002); the US-002 integration ACs run `selectForReview` against seeded rows and assert the returned list.
- `ReviewDecisionsService.selectForReview` (US-002) is used by `FleetJobsService.dispatch` (US-003); the US-003
  route ACs dispatch through `POST /api/projects/:slug/fleet/jobs` and assert the stored `reviewDecisions`.
- `AssignPayload.review.decisions` (US-001, filled by US-003) is read by `parseAssign` (US-004) and
  `HostExecutor.spawn` (US-006); the US-006 spawn ACs drive `spawn` with an injected `spawnNax` and assert the
  argv and the written file.
- `buildNaxArgv`'s `decisionsPath` (US-005) is passed by `HostExecutor.spawn` (US-006); asserted through the argv
  the injected `spawnNax` records.

## Acceptance Criteria

### US-001 — Build the decisions list from memory rows

- `[unit]` `reviewRepoSubject('r1')` returns `repo:r1`.
- `[unit]` `buildReviewDecisions` given one recorded row with id `m1`, predicate `auth` and object `tokens live in Redis` returns `[{ id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' }]`.
- `[unit]` `buildReviewDecisions` given one recorded row whose `object` is null returns an entry whose `statement` equals the row's predicate.
- `[unit]` `buildReviewDecisions` given one recorded row whose `object` is the empty string returns an entry whose `statement` equals the row's predicate.
- `[unit]` `buildReviewDecisions` given a row whose `<predicate>: <object>` is 2500 ASCII characters returns an entry whose `statement` has `length` 2000, ends with `...`, and starts with the first 1997 characters of `<predicate>: <object>`.
- `[unit]` `buildReviewDecisions` given a row whose `<predicate>: <object>` is exactly 2000 code units returns that text unchanged as the `statement`.
- `[unit]` `buildReviewDecisions` given a row whose `<predicate>: <object>` is 2500 code units of emoji (each a surrogate pair) returns an entry whose `statement` has `length` at most 2000 and contains no lone surrogate.
- `[unit]` `buildReviewDecisions` given recorded rows `m1`, `m2` and review-minted rows `v1`, `v2` returns ids in the order `m1`, `m2`, `v1`, `v2`.
- `[unit]` `buildReviewDecisions` given 100 recorded rows and 5 review-minted rows returns exactly the 100 recorded entries.
- `[unit]` `buildReviewDecisions` given 98 recorded rows and 5 review-minted rows returns 100 entries whose last two are the first two review-minted rows.
- `[unit]` `buildReviewDecisions` given 100 recorded rows whose statements are each 2000 three-byte characters returns a list whose `Buffer.byteLength(JSON.stringify({ version: 1, decisions }))` is at most 262,144.
- `[unit]` `buildReviewDecisions` given 100 recorded rows whose statements are each 2000 three-byte characters returns fewer than 100 entries, forming a prefix of the full 100-entry ordered list (entries are dropped only from the end).
- `[unit]` `buildReviewDecisions` given no rows returns `[]`.

### US-002 — Select a review's decisions

- `[integration]` `ReviewDecisionsService.selectForReview(P, R1)` returns an entry whose `id` is the id of an active `DECISION` row of project P with `sourceType` `decision_event`.
- `[integration]` `selectForReview(P, R1)` returns an entry whose `id` is the id of an active `DECISION` row of project P with `sourceType` null.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `DECISION` row of project Q with `sourceType` `decision_event`.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `DECISION` row of project Q with `sourceType` `review_event` and subject `repo:R1`.
- `[integration]` `selectForReview(P, R1)` returns no entry for a `DECISION` row of project P whose `status` is `superseded`.
- `[integration]` `selectForReview(P, R1)` returns no entry for a `DECISION` row of project P whose `status` is `rejected`.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `DECISION` row of project P whose `deletedAt` is set.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `DECISION` row of project P whose `ttlAt` is one hour in the past.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `FACT` row of project P.
- `[integration]` `selectForReview(P, R1)` returns an entry whose `id` is the id of an active `DECISION` row of project P with `sourceType` `review_event` and subject `repo:R1`.
- `[integration]` `selectForReview(P, R1)` returns no entry for an active `DECISION` row of project P with `sourceType` `review_event` and subject `repo:R2`.
- `[integration]` `selectForReview(P, R1)` given two recorded rows of project P with `updatedAt` 10:00 and 11:00 returns the 11:00 row's id first.
- `[integration]` `selectForReview(P, R1)` given a recorded row of project P with `updatedAt` 09:00 and a review-minted row for R1 with `updatedAt` 12:00 returns the recorded row's id first.
- `[integration]` `selectForReview(P, R1)` given 101 recorded rows of project P returns 100 entries.
- `[unit]` a testing module importing `MemoryModule` with the global stub providers resolves `ReviewDecisionsService`.

### US-003 — Snapshot the decisions on dispatch and send them

- `[integration]` `POST /api/projects/:slug/fleet/jobs` with `{ command: 'REVIEW', repoId, prNumber: 42, maxCostUsd: 1 }` for a project with one active recorded decision `m1` (predicate `auth`, object `tokens live in Redis`) stores the job with `reviewDecisions` equal to `[{ id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' }]`.
- `[integration]` `POST /api/projects/:slug/fleet/jobs` with `{ command: 'REVIEW', repoId, prNumber: 43, maxCostUsd: 1 }` for a project with no active decisions stores `reviewDecisions` equal to `[]`.
- `[integration]` `POST /api/projects/:slug/fleet/jobs` with a `RUN` body for a project with one active decision stores `reviewDecisions` null.
- `[integration]` a `REVIEW` with one active recorded decision `m1`, dispatched through `POST /api/projects/:slug/fleet/jobs` while a runner with `botReview: true` and the job's profile is online, produces an ASSIGN `FleetCommand` whose `payload.review.decisions` has one entry with id `m1`.
- `[integration]` `GET /api/projects/:slug/fleet/jobs/:id` for a `REVIEW` job dispatched with one active recorded decision `m1` answers a body whose `reviewDecisions` has one entry with id `m1`.
- `[integration]` `GET /api/projects/:slug/fleet/jobs` listing a `REVIEW` job dispatched with one active recorded decision answers `reviewDecisions` null for that job.
- `[unit]` `FleetJobsService.dispatch` for a `REVIEW` calls `selectForReview` once with the project id and the repo id.
- `[unit]` `FleetJobsService.dispatch` for a `RUN` never calls `selectForReview`.
- `[unit]` `FleetJobsService.dispatch` for a `REVIEW` whose `selectForReview` rejects rejects with that error and never calls `createJob`.
- `[unit]` `buildAssignPayload` for a `REVIEW` job whose `reviewDecisions` holds one entry returns `review.decisions` equal to that one-entry array.
- `[unit]` `buildAssignPayload` for a `REVIEW` job whose `reviewDecisions` is `[]` returns a `review` object with no `decisions` key.
- `[unit]` `buildAssignPayload` for a `REVIEW` job whose `reviewDecisions` is null returns a `review` object with no `decisions` key.
- `[unit]` `FleetJobDto.from` for a record with `reviewDecisions` absent returns `reviewDecisions` null.

### US-004 — The runner accepts decisions in the assign

- `[unit]` `parseAssign` accepts a `REVIEW` payload whose `review.decisions` is `[{ id: 'm1', statement: 's', source: 'koda:memory/m1' }]` and returns it with that `decisions` array.
- `[unit]` `parseAssign` accepts a `REVIEW` payload whose `review.decisions` is `[]` and returns a `review` whose `decisions` is `[]`.
- `[unit]` `parseAssign` accepts a `REVIEW` payload whose `review` has no `decisions` key and returns a `review` with no `decisions` key.
- `[unit]` `parseAssign` accepts a `REVIEW` payload whose `review.decisions` has exactly 100 entries, one with a 64-character id, a statement of `length` 2000 and a source of 200 characters.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has 101 entries.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry with id `bad id`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry with a 65-character id.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has two entries with id `m1`.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry whose `statement` is the empty string.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry whose `statement` has `length` 2001.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry whose `statement` is the number 5.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry whose `source` is 201 characters.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` has an entry that is the string `m1` rather than an object.
- `[unit]` `parseAssign` rejects a `REVIEW` payload whose `review.decisions` is an object rather than an array.

### US-005 — The runner's argv and probe know `--decisions`

- `[unit]` `buildNaxArgv(['nax'], assign, { decisionsPath: '/jobs/j1/review-decisions.json' })` for a `REVIEW` assign with jobId `j1`, `review.prNumber` 42 and profiles `['native-ds']` returns `['nax', 'bot', 'review', '42', '--profile', 'native-ds,koda-job-j1', '--decisions', '/jobs/j1/review-decisions.json']`.
- `[unit]` `buildNaxArgv(['nax'], assign)` for a `REVIEW` assign with jobId `j1`, `review.prNumber` 42 and no options returns an argv without `--decisions`.
- `[unit]` the nax probe reports `botReview: true` when `bot review --help` exits 0 with stdout containing `--decisions` and `--version` with `NAX_FORGE_TOKEN=probe` exits 1 with stderr containing `NAX_FORGE_TOKEN is not supported`.
- `[unit]` the nax probe omits `botReview` when `bot review --help` exits 0 with stdout `usage: nax bot review <pr>` and `--version` with `NAX_FORGE_TOKEN=probe` exits 1 with stderr containing `NAX_FORGE_TOKEN is not supported`.

### US-006 — The runner writes the decisions file

- `[unit]` `writeReviewDecisions(jobDir, [{ id: 'm1', statement: 's' }])` creates `<jobDir>/review-decisions.json` whose parsed content equals `{ version: 1, decisions: [{ id: 'm1', statement: 's' }] }` and returns its path.
- `[unit]` the file `writeReviewDecisions(jobDir, [{ id: 'm1', statement: 's' }])` creates has mode `0600`.
- `[unit]` the file `writeReviewDecisions(jobDir, decisions)` creates has a byte size equal to `Buffer.byteLength(JSON.stringify({ version: 1, decisions }))`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose `assign.review.decisions` has one entry `m1` calls the injected `spawnNax` with an argv ending in `'--decisions', '<jobDir>/review-decisions.json'`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose `assign.review.decisions` has one entry `m1` leaves `<jobDir>/review-decisions.json` holding `{ version: 1, decisions: [<entry m1>] }`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose `assign.review` has no `decisions` key calls `spawnNax` with an argv without `--decisions`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose `assign.review` has no `decisions` key leaves no `<jobDir>/review-decisions.json`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job whose `assign.review.decisions` is `[]` calls `spawnNax` with an argv without `--decisions`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job with one decision, where writing `review-decisions.json` fails, rejects and never calls `spawnNax`.
- `[unit]` `HostExecutor.spawn` for a `REVIEW` job with one decision, where writing `review-decisions.json` fails, leaves no `<jobDir>/forge-token`.
- `[unit]` the attempt wipe in `HostExecutor.prepare` removes a `<jobDir>/review-decisions.json` left by an earlier attempt.
