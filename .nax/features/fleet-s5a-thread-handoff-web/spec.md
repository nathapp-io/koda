# SPEC: Fleet S5a-C3 — Thread Handoff Web (Action Bar, Stale Banner, Commit Markers, PLAN/RUN Cards)

## Summary

The thread page gains the web half of the S5a write path and handoff. The thread creator gets an action bar with
**Publish** (commit the thread's written spec files on the runner), **Plan** (dispatch a PLAN job on `feat/<feature>`)
and **Run** (dispatch a RUN job). A **stale banner** offers **Discard unpublished changes** when the session started on
an old commit. The timeline shows one marker for the latest Publish/Discard result and one card each for the latest
PLAN and RUN job. The RUN card shows the nax workflow outcome (ready / draft / local-only), the PR link and the job
state. PLAN/RUN cards update live from the project event stream. The feature is web-only: it consumes the API that C2
(`fleet-s5a-thread-handoff`, #269) and workflow mode (`fleet-workflow-mode`, #274) already ship. It also folds in #266:
Playwright journeys for a THREAD job that crashes mid-turn and one that closes idle.

This is feature C3 of fleet S5a phase C, the last one. Umbrella design:
`docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` (§5, §6.2). Merged so far: C1
`fleet-s5a-thread-write` (#268, runner), C2 `fleet-s5a-thread-handoff` (#269, API), #271, #265, workflow mode (#274).

## Motivation

C1 and C2 are deployed and live-checked through the API only (fleet design doc §9.69): Publish, Plan, Run and Discard
were driven with `curl`. No page reaches them, so a creator cannot hand a brainstormed spec to nax from koda. The web
also cannot see any of C2's state: `apps/web/lib/thread-types.ts` lacks `writtenPaths`, `publishedSha`,
`specPublished`, `lastWrite`, `handoff` and `session.stale`. PLAN and RUN job transitions publish no thread event, so
even with the fields the page would not update while a job runs. #266 asks for a browser test of the #264 fix, which
only has unit and integration coverage.

## Design

### Rulings that bind every story (user, 2026-10-14)

- **C3-R1 (web only):** no API change and no migration. The timeline shows only what the thread detail already
  carries: the latest write result (`lastWrite`) and the latest PLAN and RUN (`handoff`). Older publishes and re-plans
  are not shown.
- **C3-R2 (action rules):** the action bar is shown only to the thread creator, only when the thread is not archived
  and threads are enabled. Each button is disabled with a visible reason, following the rules in "Action rules" below,
  which mirror the API's refusals. The API refuses Plan and Run with `threads.busy` while any job of the thread is
  active; the web disables both while a THREAD job is active (`sessionActive`). Discard is
  offered only in the stale banner, not in the action bar.
- **C3-R3 (RUN outcome):** the RUN card reads `workflow`, `resultPrUrl`, `costSpentUsd` and `escalationReason` from the
  job detail (`GET /projects/:slug/fleet/jobs/:id`). A failed detail fetch degrades the card to the state in
  `handoff`, with no error toast.
- **C3-R4 (#266 folded in):** the Playwright suite gains the crash-mid-turn and idle-close journeys from #266, plus the
  handoff and stale journeys.

Design decisions recorded with this spec:

- **C3-D1:** `ThreadDto.activeJob` is the thread's non-terminal THREAD job of any action (a session, or a PUBLISH /
  DISCARD action job); it carries no action field. The web treats "`activeJob` is non-null" as "a THREAD job is
  active" for Plan, Run and Discard (`sessionActive`), and reads a running turn the way `sessionLabel` and
  `isTurnRunning` already do for Publish.
- **C3-D2:** a 409 the bar did not predict (`threads.runnerOffline`, `threads.runnerOutdated`, `fleet.budgetPaused`,
  `threads.busy`, `fleet.dispatch` 422, a validation 400) is toasted with `extractApiError(error)`, as every other
  thread action is today. The web never parses an error message.
- **C3-D3:** the marker and card texts live under `fleet.threads.handoff.*` in `en.json` and `zh.json`. The existing
  `tests/i18n/fleet-locale-parity.spec.ts` checks the `fleet` tree's en/zh parity and bans `|` and `@` in every
  `fleet` message, so no new text may contain either (no vue-i18n plural forms). The disabled reasons and marker
  kinds render through dynamic keys, so `used-keys-exist.spec.ts` cannot see them; `tests/i18n/thread-handoff-keys.spec.ts`
  (US-003) and `tests/i18n/thread-handoff-marker-keys.spec.ts` (US-004) pin those key sets.
- **C3-D4:** money stays a string shown with `usd()` (web context A7). The Plan/Run dialogs send `maxCostUsd` as a
  number, as the dispatch form does.
- **C3-D5:** the job page does not link back to the thread, and the fleet jobs list stays unchanged.

### Integration

Read-only (verified on koda main `f6c21f4f`):

- `apps/api/src/fleet/threads/threads.controller.ts` — `POST projects/:slug/threads/:id/publish` (200,
  `{ jobId: string | null }`, no body), `POST .../discard` (200, `{ jobId: string }`, no body), `POST .../plan` (201,
  `DispatchResultDto`, body `PlanThreadDto`), `POST .../run` (201, `DispatchResultDto`, body `RunThreadDto`).
- `apps/api/src/fleet/threads/dto/thread-handoff.dto.ts` — `PlanThreadDto { profiles?: string[] (max 8, each max 64);
  maxCostUsd?: number (0.0001..10000, max 4 decimals) }`; `RunThreadDto` adds `bashMode?: 'raw' | 'gated' |
  'escalate'`. The API defaults `maxCostUsd` to 5 (`THREAD_HANDOFF_DEFAULT_MAX_COST_USD`) and the ref to
  `feat/<feature>`.
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — the wire types the web mirrors:
  `ThreadSession { jobId; state: 'live' | 'closed' | 'failed'; resumed; contextReset; reason: string | null; at;
  stale?: true }`; `ThreadWriteResult = { kind: 'published'; jobId; at; sha; paths: string[]; ignored: string[] } |
  { kind: 'publish_failed'; jobId; at; reason } | { kind: 'discarded'; jobId; at; sha } | { kind: 'discard_failed';
  jobId; at; reason }`; `ChatThreadHandoff { plan: ThreadHandoffJob | null; run: ThreadHandoffJob | null }` with
  `ThreadHandoffJob { jobId; state; stateReason: string | null }` (the latest PLAN / RUN of the thread by `queuedAt`).
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDto` carries `writtenPaths`, `publishedSha`,
  `specPublished`, `lastWrite`; `ThreadDetailDto` adds `sendRefusal` and `handoff`.
- `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` — `GET projects/:slug/fleet/jobs/:id` answers the full
  `FleetJobDto` including `workflow` (list pages null it).
- `apps/web/lib/fleet-types.ts` — `FleetJobDto` (`id`, `state`, `stateReason`, `queuedAt`, `costSpentUsd`,
  `escalationReason`, `resultPrUrl`, `workflow: FleetJobWorkflowDto | null`), `FleetJobWorkflowDto { runId; outcome:
  'ready' | 'draft' | 'local-only'; workflowPassed; reasons: string[]; openItems }`, `DispatchResultDto`, `BashMode`.
- `apps/web/lib/fleet-jobs.ts` — `isTerminalJobState(state: string): boolean` (COMPLETED, FAILED, ESCALATED, CRASHED,
  CANCELLED).
- `apps/web/lib/fleet-dispatch.ts` — `PROFILE_NAME_RE`, `RESERVED_PROFILE_PREFIX = 'koda-job-'`, `MAX_PROFILES = 8`,
  `MAX_COST_USD = 10_000`, and `buildDispatchSchema(t)`'s rules and i18n keys for profiles and max cost.
- `apps/web/lib/thread-view.ts` — `isTurnRunning(messages)`, `sessionLabel(thread)` (`'starting'` for an activeJob
  QUEUED/ASSIGNED, `'closing'` for UPLOADING, `'live'` for RUNNING).
- `apps/web/lib/project-event-stream.ts` — `LiveFleetJobEvent { id; type: 'fleet_job'; projectId; jobId; state; at }`,
  `ProjectEventHandlers { onFleetJob?; onResync; ... }`.
- `apps/web/composables/useProjectEvents.ts` — `useProjectEvents(slug, handlers)` (client-only, shared EventSource).
- `apps/web/composables/useApi.ts` — `ApiError` (`code` = the envelope `ret`), `extractApiError(err): string`.
- `apps/web/lib/fleet-analytics-format.ts` — `usd(s)`.
- `apps/web/components/fleet/FleetJobStateBadge.vue` (prop `state`), `FleetTokenListInput.vue` (`modelValue: string[]`,
  `testId`), `NativeSelect.vue` (v-model select for vee-validate `componentField`).
- i18n keys reused as they are: `fleet.state.<STATE>`, `fleet.jobs.workflow.outcome.{ready,draft,localOnly}`,
  `fleet.dispatch.profiles`, `fleet.dispatch.maxCost`, `fleet.dispatch.validation.{profilesMax,profileName,
  profileDuplicate,maxCost}`, `fleet.bash.modeLabel`, `fleet.bash.mode.{raw,gated,escalate}`.
- `apps/web/tests/helpers/mount-sfc.ts` — `mountSfc`, `loadSfc`, `webFile`; `tests/helpers/fleet-harness.ts` —
  `uiStubs`, `i18nStub`, `enI18n()`, `toastRecorder()`.
- `apps/api/src/fleet/ingest/bundle-reader.ts` — a bundle member at `workflow/result.json` is the workflow result the
  ingest folds into `FleetJob.workflow` (`bundle-ingest.workflow.spec.ts` holds a valid fixture).

Changed by this feature — the baseline exists only to locate the code; implement the target:

- `apps/web/lib/thread-types.ts` — Baseline: `ThreadSession` without `stale`, `ThreadDto` without the C2 fields,
  `ThreadDetailDto` with only `sendRefusal`. Target: `ThreadSession` gains `stale?: true`; new exported
  `ThreadWriteResult`, `ThreadHandoffJob { jobId: string; state: string; stateReason: string | null }`,
  `ThreadHandoff { plan: ThreadHandoffJob | null; run: ThreadHandoffJob | null }`; `ThreadDto` gains
  `writtenPaths: string[]`, `publishedSha: string | null`, `specPublished: boolean`,
  `lastWrite: ThreadWriteResult | null`; `ThreadDetailDto` gains `handoff: ThreadHandoff` (US-001).
- `apps/web/lib/thread-controller.ts` — Baseline: `ThreadController { thread, messages, live, load, start, stop, send,
  stopTurn, endSession, answer, raiseCap, archive }` with a private `reloadThread`. Target: plus
  `publish(): Promise<ThreadActionResult>`, `discard(): Promise<ThreadActionResult>`,
  `plan(body: ThreadHandoffBody): Promise<ThreadActionResult>`, `run(body: ThreadHandoffBody):
  Promise<ThreadActionResult>` and `reloadThread(): Promise<void>` (US-002).
- `apps/web/components/fleet/threads/ThreadTimeline.vue` — Baseline props `thread`, `messages`, `isCreator`. Target:
  plus optional `jobs: HandoffJobs` (default `{ plan: null, run: null }`) and optional `slug: string` (default `''`);
  it renders `buildThreadTimeline(messages, thread, jobs)` (US-004).
- `apps/web/pages/[project]/threads/[id].vue` — gains `ThreadActionBar` and `ThreadStaleBanner` (US-003), the
  `useThreadHandoffJobs` loader, the `fleet_job` subscription and the timeline's `jobs` / `slug` (US-005).
- `apps/web/tests/pages/threads-detail-handoff-page.spec.ts` — created by US-003 for its page ACs; once the page calls `useThreadHandoffJobs` and `useProjectEvents`, its mounts supply both through `globals`, and it gains the US-005 page tests (the `onFleetJob` / `onResync` handlers and the RUN card from the loader's jobs); the US-003 assertions stay as they are.
- `apps/web/tests/helpers/mount-sfc.ts` — `NUXT_AUTO_IMPORTS` gains `'useThreadHandoffJobs'` so page tests can supply
  it through `globals` (US-005).
- `apps/web/tests/e2e/fixtures/scripted-runner.ts` — `ScriptedRunner.enroll` merges `threadWrite: true` into the
  thread capabilities when `opts.threadWrite` is set (US-005).

### Action rules (US-001, US-003)

`lib/thread-handoff.ts` (pure, no Vue):

```ts
export type HandoffAction = 'publish' | 'plan' | 'run' | 'discard'
export type HandoffBlock =
  | 'nothingToPublish' | 'turnRunning' | 'handoffBusy' | 'notPublished'
  | 'sessionActive' | 'notPlanned' | 'planNotCompleted'
export interface HandoffActionState { enabled: boolean; reason: HandoffBlock | null }

export function isHandoffBusy(thread: ThreadDetailDto): boolean
export function handoffActionState(
  thread: ThreadDetailDto, messages: readonly ChatMessageDto[], action: HandoffAction,
): HandoffActionState
export function showActionBar(thread: ThreadDetailDto, isCreator: boolean): boolean   // US-003
export function showStaleBanner(thread: ThreadDetailDto): boolean                     // US-003
```

`isHandoffBusy` is true when `handoff.plan` or `handoff.run` is non-null and its `state` is not terminal
(`isTerminalJobState`). `handoffActionState` is an ordered pipeline: the first check that fails gives the reason, and
`enabled` is `reason === null`.

| Action | Checks, in order |
|---|---|
| `publish` | `writtenPaths` empty → `nothingToPublish`; `isHandoffBusy` → `handoffBusy`; `isTurnRunning(messages)` or `sessionLabel(thread)` is `starting` or `closing` → `turnRunning` |
| `plan` | `specPublished` false → `notPublished`; `isHandoffBusy` → `handoffBusy`; `activeJob` non-null → `sessionActive` |
| `run` | `handoff.plan` null → `notPlanned`; `isHandoffBusy` → `handoffBusy`; `handoff.plan.state` not `COMPLETED` → `planNotCompleted`; `activeJob` non-null → `sessionActive` |
| `discard` | `isHandoffBusy` → `handoffBusy`; `activeJob` non-null → `sessionActive` |

A live session (`activeJob` RUNNING, no turn running) does not block Publish: the API sends `THREAD_PUBLISH` to it.
`showActionBar` = `isCreator && thread.archivedAt === null && thread.sendRefusal !== 'disabled'`. `showStaleBanner` =
`thread.session?.stale === true`.

### Controller actions and the dialog form (US-002)

`lib/thread-controller.ts` gains, using the existing private `postAction` and `reloadThread`:

- `publish()` → `POST /projects/:slug/threads/:id/publish` with `{}`, then reload the thread.
- `discard()` → `POST .../discard` with `{}`, then reload the thread.
- `plan(body)` → `POST .../plan` with `body`, then reload the thread.
- `run(body)` → `POST .../run` with `body`, then reload the thread.
- `reloadThread()` becomes part of the returned `ThreadController` (the page calls it on a `fleet_job` event).

Each action resolves `{ ok: true }` on success and `{ ok: false, error }` with the thrown error on failure.

`lib/thread-handoff-form.ts`:

```ts
export function buildThreadHandoffSchema(t: Translate): z.ZodObject<...>   // { profiles, maxCostUsd, bashMode }
export type ThreadHandoffFormValues = z.infer<ReturnType<typeof buildThreadHandoffSchema>>
export const THREAD_HANDOFF_DEFAULTS: ThreadHandoffFormValues   // { profiles: [], maxCostUsd: 5, bashMode: 'raw' }
export interface ThreadHandoffBody { maxCostUsd: number; profiles?: string[]; bashMode?: BashMode }
export function toThreadHandoffBody(values: ThreadHandoffFormValues, command: 'PLAN' | 'RUN'): ThreadHandoffBody
```

- `profiles`: an array of at most `MAX_PROFILES` (`fleet.dispatch.validation.profilesMax`), each matching
  `PROFILE_NAME_RE` and not starting with `koda-job-` (`fleet.dispatch.validation.profileName`), no duplicates
  (`fleet.dispatch.validation.profileDuplicate`).
- `maxCostUsd`: `z.coerce.number()`, above 0, at most `MAX_COST_USD`, at most 4 decimals
  (`fleet.dispatch.validation.maxCost` for every failure).
- `bashMode`: `z.enum(['raw', 'gated', 'escalate'])`.
- `toThreadHandoffBody` always sends `maxCostUsd`; it sends `profiles` only when the list is non-empty, and `bashMode`
  only when `command` is `RUN`.

### Action bar, dialogs and the stale banner (US-003)

Components in `components/fleet/threads/`:

| Component | Props | Emits |
|---|---|---|
| `ThreadActionBar` | `thread: ThreadDetailDto`, `messages: ChatMessageDto[]`, `isCreator: boolean` | `publish`, `plan(body: ThreadHandoffBody)`, `run(body: ThreadHandoffBody)` |
| `ThreadPublishDialog` | `open: boolean`, `paths: string[]` | `update:open(value: boolean)`, `confirm` |
| `ThreadHandoffDialog` | `open: boolean`, `command: 'PLAN' \| 'RUN'` | `update:open(value: boolean)`, `submit(body: ThreadHandoffBody)` |
| `ThreadStaleBanner` | `thread: ThreadDetailDto`, `messages: ChatMessageDto[]`, `isCreator: boolean` | `discard` |

- `ThreadActionBar` (`data-testid="thread-action-bar"`) renders nothing when `showActionBar(thread, isCreator)` is
  false. Otherwise it renders three buttons, `thread-action-publish`, `thread-action-plan` and `thread-action-run`
  (labels `fleet.threads.handoff.actions.{publish,plan,run}`). Each button is disabled when its
  `handoffActionState(...)` is not enabled, and the reason text `fleet.threads.handoff.blocked.<reason>` shows beside
  it (`data-testid="thread-action-<action>-reason"`).
- Publish opens `ThreadPublishDialog` (title `fleet.threads.handoff.publishDialog.title`): it lists `writtenPaths`,
  one `data-testid="thread-publish-path"` item each, and its confirm button (`thread-publish-confirm`) emits
  `confirm`; the bar then emits `publish` and closes the dialog.
- Plan and Run open `ThreadHandoffDialog` with `command` `PLAN` or `RUN` (titles
  `fleet.threads.handoff.planDialog.title` / `runDialog.title`). It is a vee-validate form over
  `buildThreadHandoffSchema(t)` with initial values `THREAD_HANDOFF_DEFAULTS`: profiles (`FleetTokenListInput`,
  `testId` `thread-handoff-profiles`), max cost (`thread-handoff-max-cost`) and, for `RUN` only, bash mode
  (`NativeSelect` with the prop `testid="thread-handoff-bash-mode"`, labels `fleet.bash.mode.*`). A valid submit
  (`thread-handoff-submit`) emits `submit(toThreadHandoffBody(values, command))`; the bar re-emits it as `plan` or
  `run` and closes the dialog.
- `ThreadStaleBanner` (`data-testid="thread-stale-banner"`) renders only when `showStaleBanner(thread)`: the title
  `fleet.threads.handoff.stale.title` and body `fleet.threads.handoff.stale.body` for every viewer. For the creator it
  adds a Discard button (`thread-stale-discard`, `fleet.threads.handoff.actions.discard`), disabled with
  `fleet.threads.handoff.blocked.<reason>` when `handoffActionState(thread, messages, 'discard')` is not enabled. It
  opens a confirm dialog (`fleet.threads.handoff.discardDialog.{title,body,confirm}`) whose confirm
  (`thread-discard-confirm`) emits `discard`.
- The page renders `ThreadStaleBanner` and `ThreadActionBar` between `ThreadControls` and `ThreadTimeline`, and binds
  `publish` / `plan` / `run` / `discard` to the matching controller methods through the existing `runAction` (a
  `{ ok: false, error }` result is toasted with `extractApiError(error)`).
- Test harness: component tests register `FleetTokenListInput` with `loadSfc` in `components`, and the real
  `NativeSelect` through `mountSfc`'s `fleetComponents: ['FleetNativeSelect']` (the `uiStubs` select is inert); the dialog primitives come from `uiStubs`, which render their content when `open` is
  true.

### Timeline markers and job cards (US-004)

`lib/thread-timeline.ts` (pure):

```ts
export interface HandoffJobs { plan: FleetJobDto | null; run: FleetJobDto | null }
export type ThreadTimelineEntry =
  | { kind: 'message'; key: string; message: ChatMessageDto }
  | { kind: 'write'; key: string; write: ThreadWriteResult }
  | { kind: 'job'; key: string; command: 'PLAN' | 'RUN'; handoff: ThreadHandoffJob; job: FleetJobDto | null }
export function buildThreadTimeline(
  messages: readonly ChatMessageDto[], thread: ThreadDetailDto, jobs: HandoffJobs,
): ThreadTimelineEntry[]
export interface WriteMarkerView { key: string; params: Record<string, string | number>; paths: string[]; ignored: string[] }
export function writeMarkerView(write: ThreadWriteResult): WriteMarkerView
```

- Keys: a message entry's `key` is the message `id`; a write entry's is `write:<jobId>`; a job entry's is
  `job:<jobId>`.
- A job entry's `job` is `jobs.plan` (or `jobs.run`) only when that detail's `id` equals the handoff's `jobId`; a
  detail for another job is ignored (`null`).
- Anchors: a write entry anchors at `write.at`; a job entry anchors at `job.queuedAt` when its `job` is non-null, and
  has no anchor otherwise.
- Order: messages keep their given order. Each anchored marker goes immediately before the first message whose
  `createdAt` is strictly later than the anchor (compared with `Date.parse`), or after every message when none is.
  Markers without an anchor go after every message. Markers at the same position are ordered by anchor ascending
  (no anchor last), then write before PLAN before RUN.
- `writeMarkerView`:

| `write.kind` | `key` | `params` | `paths` / `ignored` |
|---|---|---|---|
| `published` | `fleet.threads.handoff.marker.published` | `{ sha: sha.slice(0, 7), count: paths.length }` | `write.paths` / `write.ignored` |
| `publish_failed`, reason `branch_moved` | `fleet.threads.handoff.marker.publishFailedBranchMoved` | `{}` | `[]` / `[]` |
| `publish_failed`, other reason | `fleet.threads.handoff.marker.publishFailed` | `{ reason }` | `[]` / `[]` |
| `discarded` | `fleet.threads.handoff.marker.discarded` | `{ sha: sha.slice(0, 7) }` | `[]` / `[]` |
| `discard_failed` | `fleet.threads.handoff.marker.discardFailed` | `{ reason }` | `[]` / `[]` |

Components:

| Component | Props | Emits |
|---|---|---|
| `ThreadWriteMarker` | `write: ThreadWriteResult` | — |
| `ThreadJobCard` | `command: 'PLAN' \| 'RUN'`, `handoff: ThreadHandoffJob`, `job: FleetJobDto \| null`, `slug: string` | — |

- `ThreadWriteMarker` (`data-testid="thread-write-marker"`) renders `t(view.key, view.params)`, and, when
  `view.paths` is non-empty, a collapsible list of the paths (`thread-write-marker-path`) plus the ignored paths under
  `fleet.threads.handoff.markerIgnored`. Every value renders through `{{ }}` interpolation, never `v-html`.
- `ThreadJobCard` (tests register `FleetJobStateBadge` with `loadSfc` in `components`; `data-testid="thread-job-card"`, `data-command` = the command) shows the title
  `fleet.threads.handoff.card.plan` or `card.run`, a `FleetJobStateBadge` of `job?.state ?? handoff.state`, the
  `handoff.stateReason` when non-null (`thread-job-card-reason`), `usd(job.costSpentUsd)` when `job` is non-null, and a
  link to `/<slug>/fleet/jobs/<handoff.jobId>` (`thread-job-card-link`, `fleet.threads.handoff.card.openJob`). A RUN
  card with a non-null `job` also shows: the workflow outcome badge (`thread-job-card-outcome`, text
  `fleet.jobs.workflow.outcome.{ready,draft,localOnly}`) and its `reasons` when `job.workflow` is non-null; the PR link
  (`thread-job-card-pr`, `href` = `resultPrUrl`, `target="_blank"`, `rel="noopener noreferrer"`, text
  `fleet.threads.handoff.card.pr`) when `resultPrUrl` is non-null; and `fleet.threads.handoff.card.needsYou` with
  `escalationReason` when the state is `ESCALATED`.
- `ThreadTimeline` keeps the question card and the context-reset marker first, then renders each entry of
  `buildThreadTimeline(messages, thread, jobs)` as a `ThreadMessage`, `ThreadWriteMarker` or `ThreadJobCard` (with
  `slug`), keyed by `key`.

### Live job details and page wiring (US-005)

`lib/thread-handoff-jobs.ts`:

```ts
export interface HandoffJobsDeps { api: { get: <T = unknown>(path: string) => Promise<T> }; slug: string }
export interface HandoffJobsController {
  jobs: Ref<HandoffJobs>
  sync: (handoff: ThreadHandoff) => Promise<void>
  refreshJob: (jobId: string) => Promise<void>
  isHandoffJob: (jobId: string) => boolean
}
export function createHandoffJobs(deps: HandoffJobsDeps): HandoffJobsController
```

- `sync(handoff)` records the handoff, then for each of `plan` and `run`: a null handoff entry sets that slot to
  `null`; an entry whose `jobId` and `state` equal the cached detail's `id` and `state` fetches nothing; any other entry
  fetches `GET /projects/:slug/fleet/jobs/:jobId` (path built with `apiPath`) and stores the result. On a failed fetch
  the slot keeps a cached detail with the same `id`, and is `null` otherwise; `sync` never rejects.
- `isHandoffJob(jobId)` is true when `jobId` equals the last synced `handoff.plan?.jobId` or `handoff.run?.jobId`.
- `refreshJob(jobId)` fetches the detail again and replaces its slot when `isHandoffJob(jobId)`; otherwise it does
  nothing. A failed fetch keeps the slot.
- `composables/useThreadHandoffJobs.ts`: `useThreadHandoffJobs(slug: string, thread: Ref<ThreadDetailDto | null>):
  HandoffJobsController` wires `createHandoffJobs` with `useApi().$api` and watches `thread.value?.handoff`
  (immediate), calling `sync` whenever it is non-null.
- The page calls `useThreadHandoffJobs(slug, controller.thread)` and `useProjectEvents(slug, { onFleetJob, onResync })`:
  `onFleetJob(event)` calls `controller.reloadThread()` and `handoffJobs.refreshJob(event.jobId)` when
  `handoffJobs.isHandoffJob(event.jobId)`, and does nothing otherwise; `onResync` calls `controller.reloadThread()`.
  The page passes `handoffJobs.jobs.value` and `slug` to `ThreadTimeline`.

### E2E journeys (US-005, C3-R4)

`tests/e2e/fleet-threads.e2e.spec.ts` gains four tests against the scripted v4 runner, each on its own thread and
feature. They are verified with `bun run test:e2e -- fleet-threads` in `apps/web`; Playwright specs are not nax
acceptance criteria.

1. **Crash mid-turn (#266):** after `text_delta` streams, the runner reports the THREAD job `FAILED`
   (`report(lease, [{ type: 'state', payload: { to: 'FAILED', reason: 'crashed' } }])`). Without a reload, the page's
   streaming indicator disappears, the message shows its errored marker, and `thread-stop` is gone.
2. **Idle close (#266):** after a completed turn, the runner uploads `session_closed { reason: 'idle' }` and reports
   `COMPLETED`. Without a reload, the session label leaves Live and `thread-end-session` is gone.
3. **Handoff:** the runner enrolls with `threadWrite: true`. During a session it uploads a `write_doc { path, bytes }` line for
   `.nax/features/<feature>/spec.md`; Publish becomes enabled and its dialog lists the path. Confirming delivers a
   `THREAD_PUBLISH` command; the runner uploads `published { sha, paths, ignored: [], specPresent: true }` and the
   write marker shows the short sha. After End session (the runner uploads `session_closed` and reports `COMPLETED`),
   Plan submits the dialog; the runner accepts the PLAN job's ASSIGN and reports `RUNNING` then `COMPLETED`, and the
   PLAN card shows Completed without a reload. Run submits; the runner uploads a tar bundle with a
   `workflow/result.json` whose outcome is `draft` (shape as in `bundle-ingest.workflow.spec.ts`) and reports
   `ESCALATED`; the RUN card shows the Draft outcome without a reload.
4. **Stale:** a session's `session_started` line carries `stale: true`; the banner shows, its Discard button is
   disabled with the `sessionActive` reason; after End session, Discard creates a DISCARD job; the runner uploads
   `discarded { tipSha }` and completes it, and the banner is gone.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Publish / Discard / Plan / Run answers 409, 422 or 400 | `{ ok: false, error }`; the page toasts `extractApiError(error)`; state reloads on the next event | US-002, US-003 |
| Plan/Run dialog values invalid | the form shows the `fleet.dispatch.validation.*` message; nothing is emitted | US-002, US-003 |
| `publish_failed` with `branch_moved` | the marker shows `publishFailedBranchMoved` (end the session and start a new one) | US-004 |
| Job detail fetch fails | the card shows `handoff.state` and `stateReason` only; no toast | US-004, US-005 |
| A cached job detail is for an older handoff job | ignored by the timeline (`job: null`) | US-004 |
| A `fleet_job` event for an unrelated job | ignored | US-005 |
| Project event stream reconnects | `onResync` reloads the thread | US-005 |

## Out of Scope

- Any API or migration change: a thread-jobs endpoint, `threadId` on job DTOs, a thread filter on the jobs list, or
  storing each write result as a timeline entry (C3-R1).
- Showing older publishes, discards, plans or runs than the latest of each kind (C3-R1).
- A link from the fleet job page back to its thread, and a THREAD label on the fleet jobs list (C3-D5).
- Moving a thread to another runner, and choosing the runner or the ref in the Plan/Run dialogs (the API pins the
  thread's runner and `feat/<feature>`).
- `approvalTimeoutSec` in the Run dialog; a gated or escalate RUN uses the API's default ask timeout.
- Live-updating the page's runner online dot.
- US-001 only: `plan` with a busy handoff, `run` fully enabled, `discard` with a busy handoff and `discard` enabled
  follow the Action rules table without a dedicated acceptance criterion.
- US-002 only: the `discard()` and `run()` failure results, and a `publish()` reload failure, follow `postAction`
  without a dedicated acceptance criterion.
- US-002 only: the schema's `profilesMax` failure, a non-number max cost and a max cost above 10000 follow the
  dispatch rules without a dedicated acceptance criterion.
- US-003 only: the action bar's absence for an archived thread and for `sendRefusal` `disabled` (AC1 pins the
  non-creator case of `showActionBar`), the page bindings of `run` and `discard` (they follow the `publish` and `plan`
  bindings), the disabled state of `thread-action-publish` beside its reason, the banner's
  `fleet.threads.handoff.blocked.<reason>` text beside a disabled Discard, the stale banner's absence when `session.stale` is absent, a read-only member seeing the banner without
  a Discard button, the Run button's disabled reasons, and closing a dialog without emitting follow the Design without
  a dedicated acceptance criterion.
- US-004 only: a thread with no write result and no handoff yielding only message entries, the PR link's
  `target="_blank"`, the job card's `thread-job-card-reason` line, the `discarded` and `discard_failed` marker views, the ESCALATED `needsYou` text, the PLAN card title,
  the cost text, the ignored-paths list and tie ordering between markers at one position follow the Design tables
  without a dedicated acceptance criterion.
- US-005 only: `refreshJob` failure keeping the slot, and `sync` setting a slot to `null` for a null handoff entry
  beyond the RUN case, follow the Design without a dedicated acceptance criterion.
- US-005 only: the four Playwright journeys are verified with `bun run test:e2e -- fleet-threads`, not as nax
  acceptance criteria.

## Stories

1. **US-001: Thread handoff types and action rules** — `Workdir: apps/web` — no dependencies.
2. **US-002: Controller actions and the Plan/Run form** — `Workdir: apps/web` — depends on US-001.
3. **US-003: Action bar, dialogs and the stale banner** — `Workdir: apps/web` — depends on US-002.
4. **US-004: Timeline write marker and PLAN/RUN cards** — `Workdir: apps/web` — depends on US-003.
5. **US-005: Live job details, page wiring and the E2E journeys** — `Workdir: apps/web` — depends on US-004.

US-003 to US-005 each edit `pages/[project]/threads/[id].vue` or `ThreadTimeline.vue`, so they run in order.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `apps/web/lib/thread-types.ts` — gains the C2 fields and types
- `apps/web/lib/thread-view.ts` — `isTurnRunning`, `sessionLabel`
- `apps/web/lib/fleet-jobs.ts` — `isTerminalJobState`
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — the wire types to mirror
- `apps/web/tests/lib/thread-view.spec.ts` — fixture pattern for `ThreadDetailDto`

**US-002**

- `apps/web/lib/thread-controller.ts` — `postAction`, `reloadThread`, `ThreadController`
- `apps/web/lib/fleet-dispatch.ts` — profile and max-cost rules and i18n keys
- `apps/web/tests/lib/thread-controller.spec.ts` — fake API and deps pattern
- `apps/web/lib/thread-types.ts` — extended by US-001

**US-003**

- `apps/web/pages/[project]/threads/[id].vue` — `runAction` and the component layout
- `apps/web/i18n/locales/en.json` — gains `fleet.threads.handoff` (actions, blocked, dialogs, stale)
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese
- `apps/web/lib/thread-handoff.ts` — created by US-001, gains `showActionBar` and `showStaleBanner` here
- `apps/web/lib/thread-handoff-form.ts` — created by US-002

**US-004**

- `apps/web/components/fleet/threads/ThreadTimeline.vue` — renders the timeline entries
- `apps/web/components/fleet/FleetJobStateBadge.vue` — the state badge
- `apps/web/tests/components/thread-timeline.spec.ts` — mount pattern
- `apps/web/i18n/locales/en.json` — gains `fleet.threads.handoff.marker`, `markerIgnored` and `card`
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese

**US-005**

- `apps/web/composables/useProjectEvents.ts` — `useProjectEvents(slug, handlers)`
- `apps/web/composables/useThread.ts` — the composable pattern (`useApi`, client-only)
- `apps/web/tests/helpers/mount-sfc.ts` — `NUXT_AUTO_IMPORTS` gains `useThreadHandoffJobs`
- `apps/web/tests/e2e/fixtures/scripted-runner.ts` — `enroll` gains `opts.threadWrite`
- `apps/web/lib/thread-timeline.ts` — created by US-004

### Creates

**US-001**

- `apps/web/lib/thread-handoff.ts`
- `apps/web/tests/lib/thread-handoff.spec.ts`

**US-002**

- `apps/web/lib/thread-handoff-form.ts`
- `apps/web/tests/lib/thread-handoff-form.spec.ts`
- `apps/web/tests/lib/thread-controller-handoff.spec.ts`

**US-003**

- `apps/web/components/fleet/threads/ThreadActionBar.vue`
- `apps/web/components/fleet/threads/ThreadPublishDialog.vue`
- `apps/web/components/fleet/threads/ThreadHandoffDialog.vue`
- `apps/web/components/fleet/threads/ThreadStaleBanner.vue`
- `apps/web/tests/components/thread-action-bar.spec.ts`
- `apps/web/tests/components/thread-stale-banner.spec.ts`
- `apps/web/tests/i18n/thread-handoff-keys.spec.ts`
- `apps/web/tests/pages/threads-detail-handoff-page.spec.ts`

**US-004**

- `apps/web/lib/thread-timeline.ts`
- `apps/web/components/fleet/threads/ThreadWriteMarker.vue`
- `apps/web/components/fleet/threads/ThreadJobCard.vue`
- `apps/web/tests/lib/thread-timeline.spec.ts`
- `apps/web/tests/components/thread-job-card.spec.ts`
- `apps/web/tests/components/thread-write-marker.spec.ts`
- `apps/web/tests/i18n/thread-handoff-marker-keys.spec.ts`

**US-005**

- `apps/web/lib/thread-handoff-jobs.ts`
- `apps/web/composables/useThreadHandoffJobs.ts`
- `apps/web/tests/lib/thread-handoff-jobs.spec.ts`
- `apps/web/tests/composables/useThreadHandoffJobs.spec.ts`

### Modifies

**US-003**

None. The two existing page tests register no `ThreadActionBar` or `ThreadStaleBanner`, so those render as
unresolved elements and read no C2 field; the page wiring is tested in `threads-detail-handoff-page.spec.ts`, which this story creates.

**US-004**

- `apps/web/tests/components/thread-timeline.spec.ts` — its `threadDetail()` fixture lacks `lastWrite` and `handoff`; once `ThreadTimeline` builds its entries with `buildThreadTimeline`, which reads `thread.handoff.plan`, the fixture gains `writtenPaths: []`, `publishedSha: null`, `specPublished: false`, `lastWrite: null` and `handoff: { plan: null, run: null }`, and the existing message-order assertions stay as they are; the new US-004 timeline test goes in its own `describe` block so its AC number does not collide with the file's US-006 names.
- `apps/web/tests/pages/threads-detail-page.spec.ts` — it mounts the real `ThreadTimeline`, which now reads `thread.handoff.plan` through `buildThreadTimeline`; its `threadDetail()` fixture gains `writtenPaths: []`, `publishedSha: null`, `specPublished: false`, `lastWrite: null` and `handoff: { plan: null, run: null }`, and the existing assertions stay as they are.

**US-005**

- `apps/web/tests/pages/threads-detail-page.spec.ts` — the page now calls `useProjectEvents` and `useThreadHandoffJobs`, which the harness injects as undefined; the mount's `globals` gain `useProjectEvents: () => undefined` and a `useThreadHandoffJobs` stub returning `{ jobs: ref({ plan: null, run: null }), sync, refreshJob, isHandoffJob: () => false }`, and the existing assertions stay as they are.
- `apps/web/tests/pages/threads-detail-actions-page.spec.ts` — the page now calls `useProjectEvents` and `useThreadHandoffJobs`, which the harness injects as undefined; the mount's `globals` gain `useProjectEvents: () => undefined` and the same `useThreadHandoffJobs` stub, and the existing assertions stay as they are.
- `apps/web/tests/helpers/mount-sfc.ts` — `NUXT_AUTO_IMPORTS` gains `'useThreadHandoffJobs'`; without it the harness never binds a test's `useThreadHandoffJobs` global and every thread page mount throws; no existing behaviour changes.
- `apps/web/tests/e2e/fixtures/scripted-runner.ts` — `ScriptedRunner.enroll` gains `opts.threadWrite`, which adds `threadWrite: true` to the thread capabilities; enrolments without it keep today's capabilities.
- `apps/web/tests/e2e/fleet-threads.e2e.spec.ts` — gains the four journeys of "E2E journeys"; the existing create/send/Stop/read-only test stays as it is.

### Seams

- US-001 → US-003: `handoffActionState` and `isHandoffBusy` are consumed by `ThreadActionBar` and
  `ThreadStaleBanner`; US-003 AC2, AC3 and AC10 mount the real components over thread fixtures and assert the reason
  text or the disabled state the real function produces.
- US-002 → US-003: `toThreadHandoffBody` and `THREAD_HANDOFF_DEFAULTS` are consumed by `ThreadHandoffDialog`; US-003
  AC6 and AC7 assert the emitted body. The controller's `publish` and `plan` are consumed by the page; US-003 AC14 and
  AC15 drive the page's `plan` and `publish` bindings.
- US-005 composable: `useThreadHandoffJobs`'s watch is the only link from the thread to the loader; US-005 AC15 drives
  it with a real `thread` ref.
- US-004 → US-005: `HandoffJobs` and the `ThreadTimeline` `jobs` prop are consumed by the page; US-005 AC14 asserts the
  page renders the RUN card from the loader's jobs.
- US-002 → US-005: `reloadThread` is consumed by the page's `onFleetJob` handler; US-005 AC11 and AC12 drive that
  handler.

## Acceptance Criteria

### US-001: Thread handoff types and action rules

- AC-1 [unit]: `isHandoffBusy` of a thread whose `handoff.run` has `state` `RUNNING` returns `true`.
- AC-2 [unit]: `isHandoffBusy` of a thread whose `handoff.plan` has `state` `COMPLETED` and whose `handoff.run` is
  `null` returns `false`.
- AC-3 [unit]: `handoffActionState(thread, [], 'publish')` for a thread with `writtenPaths: []` returns
  `{ enabled: false, reason: 'nothingToPublish' }`.
- AC-4 [unit]: `handoffActionState(thread, [], 'publish')` for a thread with `writtenPaths: ['.nax/features/f/spec.md']`
  and `handoff.plan.state` `QUEUED` returns `{ enabled: false, reason: 'handoffBusy' }`.
- AC-5 [unit]: `handoffActionState(thread, messages, 'publish')` for a thread with one written path, an idle handoff,
  and a message whose `status` is `streaming` returns `{ enabled: false, reason: 'turnRunning' }`.
- AC-6 [unit]: `handoffActionState(thread, [], 'publish')` for a thread with one written path, an idle handoff and
  `activeJob: { id: 'j1', state: 'UPLOADING' }` returns `{ enabled: false, reason: 'turnRunning' }`.
- AC-7 [unit]: `handoffActionState(thread, [], 'publish')` for a thread with one written path, an idle handoff and
  `activeJob: { id: 'j1', state: 'RUNNING' }` returns `{ enabled: true, reason: null }`.
- AC-8 [unit]: `handoffActionState(thread, [], 'plan')` for a thread with `specPublished: false` and a non-null
  `activeJob` returns `{ enabled: false, reason: 'notPublished' }`.
- AC-9 [unit]: `handoffActionState(thread, [], 'plan')` for a thread with `specPublished: true`, an idle handoff and
  a non-null `activeJob` returns `{ enabled: false, reason: 'sessionActive' }`.
- AC-10 [unit]: `handoffActionState(thread, [], 'plan')` for a thread with `specPublished: true`, `handoff:
  { plan: null, run: null }` and `activeJob: null` returns `{ enabled: true, reason: null }`.
- AC-11 [unit]: `handoffActionState(thread, [], 'run')` for a thread with `handoff.plan: null` returns
  `{ enabled: false, reason: 'notPlanned' }`.
- AC-12 [unit]: `handoffActionState(thread, [], 'run')` for a thread whose `handoff.plan.state` is `QUEUED` returns
  `{ enabled: false, reason: 'handoffBusy' }`.
- AC-13 [unit]: `handoffActionState(thread, [], 'run')` for a thread whose `handoff.plan.state` is `FAILED` and whose
  `handoff.run` is `null` returns `{ enabled: false, reason: 'planNotCompleted' }`.
- AC-14 [unit]: `handoffActionState(thread, [], 'run')` for a thread whose `handoff.plan.state` is `COMPLETED`,
  `handoff.run` is `null` and `activeJob` is non-null returns `{ enabled: false, reason: 'sessionActive' }`.
- AC-15 [unit]: `handoffActionState(thread, [], 'discard')` for a thread with an idle handoff and a non-null
  `activeJob` returns `{ enabled: false, reason: 'sessionActive' }`.

### US-002: Controller actions and the Plan/Run form

- AC-1 [unit]: `createThreadController({ slug: 'web', threadId: 'th1', ... }).publish()` calls the fake API's `post`
  with path `/projects/web/threads/th1/publish` and body `{}`.
- AC-2 [unit]: after `publish()` resolves `{ ok: true }`, the controller's `thread` ref holds the detail the fake API's
  `get` returned for `/projects/web/threads/th1`.
- AC-3 [unit]: `discard()` calls the fake API's `post` with path `/projects/web/threads/th1/discard` and body `{}`.
- AC-4 [unit]: `plan({ maxCostUsd: 5 })` calls the fake API's `post` with path `/projects/web/threads/th1/plan` and
  body `{ maxCostUsd: 5 }`.
- AC-5 [unit]: `run({ maxCostUsd: 2, bashMode: 'gated' })` calls the fake API's `post` with path
  `/projects/web/threads/th1/run` and body `{ maxCostUsd: 2, bashMode: 'gated' }`.
- AC-6 [unit]: `plan({ maxCostUsd: 5 })` whose `post` rejects with an `ApiError` of `code` 409 resolves
  `{ ok: false, error }` where `error` is that same `ApiError` instance.
- AC-7 [unit]: `reloadThread()` on the returned controller calls the fake API's `get` with
  `/projects/web/threads/th1` and sets `thread` to its result.
- AC-8 [unit]: `THREAD_HANDOFF_DEFAULTS` equals `{ profiles: [], maxCostUsd: 5, bashMode: 'raw' }`.
- AC-9 [unit]: `toThreadHandoffBody(THREAD_HANDOFF_DEFAULTS, 'PLAN')` returns `{ maxCostUsd: 5 }`.
- AC-10 [unit]: `toThreadHandoffBody({ profiles: ['native-ds', 'workflow'], maxCostUsd: 2.5, bashMode: 'gated' },
  'RUN')` returns `{ maxCostUsd: 2.5, profiles: ['native-ds', 'workflow'], bashMode: 'gated' }`.
- AC-11 [unit]: `toThreadHandoffBody({ profiles: ['native-ds'], maxCostUsd: 2.5, bashMode: 'gated' }, 'PLAN')`
  returns `{ maxCostUsd: 2.5, profiles: ['native-ds'] }`.
- AC-12 [unit]: `buildThreadHandoffSchema(t)` parsing `{ profiles: [], maxCostUsd: 0.00001, bashMode: 'raw' }` fails
  with an issue whose message is the translation of `fleet.dispatch.validation.maxCost`.
- AC-13 [unit]: `buildThreadHandoffSchema(t)` parsing `{ profiles: ['koda-job-x'], maxCostUsd: 5, bashMode: 'raw' }`
  fails with an issue whose message is the translation of `fleet.dispatch.validation.profileName`.
- AC-14 [unit]: `buildThreadHandoffSchema(t)` parsing `{ profiles: ['a', 'a'], maxCostUsd: 5, bashMode: 'raw' }` fails
  with an issue whose message is the translation of `fleet.dispatch.validation.profileDuplicate`.
- AC-15 [unit]: `buildThreadHandoffSchema(t)` parsing `THREAD_HANDOFF_DEFAULTS` succeeds.

### US-003: Action bar, dialogs and the stale banner

- AC-1 [unit]: `ThreadActionBar` mounted with `isCreator: false` over a thread with written paths renders no element
  with `data-testid="thread-action-bar"`.
- AC-2 [unit]: `ThreadActionBar` mounted with `isCreator: true` over a thread with `writtenPaths: []` renders
  `thread-action-publish-reason` with the text of `fleet.threads.handoff.blocked.nothingToPublish`.
- AC-3 [unit]: `ThreadActionBar` mounted with `isCreator: true` over a thread with `specPublished: false` renders
  `thread-action-plan-reason` with the text of `fleet.threads.handoff.blocked.notPublished`.
- AC-4 [unit]: clicking an enabled `thread-action-publish` over a thread with `writtenPaths: ['a.md', 'b.md']` renders
  two `thread-publish-path` items with the texts `a.md` and `b.md`.
- AC-5 [unit]: clicking `thread-publish-confirm` in the open publish dialog makes `ThreadActionBar` emit `publish`
  exactly once.
- AC-6 [unit]: opening the Plan dialog from an enabled `thread-action-plan` and clicking `thread-handoff-submit` with
  the default values makes `ThreadActionBar` emit `plan` with `{ maxCostUsd: 5 }`.
- AC-7 [unit]: opening the Run dialog from an enabled `thread-action-run`, selecting `gated` in
  `thread-handoff-bash-mode` and submitting makes `ThreadActionBar` emit `run` with
  `{ maxCostUsd: 5, bashMode: 'gated' }`.
- AC-8 [unit]: `ThreadHandoffDialog` mounted open with `command: 'PLAN'` renders no element with
  `data-testid="thread-handoff-bash-mode"`.
- AC-9 [unit]: `ThreadStaleBanner` mounted over a thread whose `session.stale` is `true` renders an element with
  `data-testid="thread-stale-banner"` containing the text of `fleet.threads.handoff.stale.title`.
- AC-10 [unit]: `ThreadStaleBanner` mounted with `isCreator: true` over a stale thread with a non-null `activeJob`
  renders the `thread-stale-discard` button with the `disabled` attribute set.
- AC-11 [unit]: `ThreadStaleBanner` mounted with `isCreator: true` over a stale thread with `activeJob: null` and an
  idle handoff emits `discard` exactly once after `thread-stale-discard` then `thread-discard-confirm` are clicked.
- AC-12 [unit]: in both `en.json` and `zh.json`, the keys under `fleet.threads.handoff.blocked` are exactly
  `nothingToPublish`, `turnRunning`, `handoffBusy`, `notPublished`, `sessionActive`, `notPlanned` and
  `planNotCompleted`, each with a non-empty text.
- AC-13 [unit]: `ThreadHandoffDialog` mounted open with `command: 'RUN'`, max cost set to `0` and
  `thread-handoff-submit` clicked emits no `submit` event.
- AC-14 [unit]: on the thread page mounted with a stubbed `useThread`, the action bar's `plan` emit with
  `{ maxCostUsd: 5 }` calls the stubbed controller's `plan` with `{ maxCostUsd: 5 }`.
- AC-15 [unit]: on the thread page mounted with a stubbed `useThread` whose `publish` resolves
  `{ ok: false, error: new ApiError(409, 'Runner offline') }`, the action bar's `publish` emit makes the toast recorder
  receive the error `Runner offline`.

### US-004: Timeline write marker and PLAN/RUN cards

- AC-1 [unit]: `buildThreadTimeline` of messages created at `10:00` and `10:05` and a thread whose `lastWrite` is a
  `published` result at `10:02` returns entries whose `kind`s are `['message', 'write', 'message']`.
- AC-2 [unit]: `buildThreadTimeline` of messages created at `10:00` and `10:05`, a thread whose `handoff.plan.jobId` is
  `p1`, and `jobs.plan` with `id` `p1` and `queuedAt` `10:06` returns entries whose `kind`s are
  `['message', 'message', 'job']`.
- AC-3 [unit]: `buildThreadTimeline` of a thread whose `handoff.run.jobId` is `r1` and `jobs.run: null` returns a last
  entry with `kind` `job`, `command` `RUN` and `job` `null`.
- AC-4 [unit]: `buildThreadTimeline` of a thread whose `handoff.plan.jobId` is `p2` and `jobs.plan` with `id` `p1`
  returns the PLAN entry with `job` `null`.
- AC-5 [unit]: `writeMarkerView` of `{ kind: 'published', sha: 'abcdef1234567', paths: ['a.md', 'b.md'], ignored: [],
  ... }` returns `key` `fleet.threads.handoff.marker.published` and `params` `{ sha: 'abcdef1', count: 2 }`.
- AC-6 [unit]: `writeMarkerView` of `{ kind: 'publish_failed', reason: 'branch_moved', ... }` returns `key`
  `fleet.threads.handoff.marker.publishFailedBranchMoved`.
- AC-7 [unit]: `writeMarkerView` of `{ kind: 'publish_failed', reason: 'repo_busy', ... }` returns `key`
  `fleet.threads.handoff.marker.publishFailed` and `params` `{ reason: 'repo_busy' }`.
- AC-8 [unit]: `ThreadJobCard` mounted with `command: 'RUN'` and a `job` whose `workflow.outcome` is `draft` renders
  `thread-job-card-outcome` with the text of `fleet.jobs.workflow.outcome.draft`.
- AC-9 [unit]: `ThreadJobCard` mounted with `command: 'RUN'` and a `job` whose `resultPrUrl` is
  `https://github.com/acme/app/pull/9` renders `thread-job-card-pr` with that `href`.
- AC-10 [unit]: `ThreadJobCard` mounted with `command: 'RUN'` and a non-null `resultPrUrl` renders
  `thread-job-card-pr` with `rel` `noopener noreferrer`.
- AC-11 [unit]: `ThreadJobCard` mounted with `job: null` and `handoff: { jobId: 'r1', state: 'FAILED', stateReason:
  'no prd.json produced' }` renders the text of `fleet.state.FAILED`.
- AC-12 [unit]: `ThreadJobCard` mounted with `slug: 'web'` and `handoff.jobId` `r1` renders `thread-job-card-link`
  with `href` `/web/fleet/jobs/r1`.
- AC-13 [unit]: `ThreadTimeline` mounted with two messages at `10:00` and `10:05` and a thread whose `lastWrite` is a
  `published` result at `10:02` renders the `thread-write-marker` element after the first `thread-message` and before
  the second in document order.
- AC-14 [unit]: `ThreadWriteMarker` mounted with a `published` result whose `paths` are `['<b>a.md</b>']` renders one
  `thread-write-marker-path` item whose text content is the literal string `<b>a.md</b>` (interpolated, not parsed as
  HTML).
- AC-15 [unit]: in both `en.json` and `zh.json`, the keys under `fleet.threads.handoff.marker` are exactly
  `published`, `publishFailed`, `publishFailedBranchMoved`, `discarded` and `discardFailed`, each with a non-empty
  text.

### US-005: Live job details, page wiring and the E2E journeys

- AC-1 [unit]: `createHandoffJobs({ slug: 'web', api })` then `sync({ plan: { jobId: 'p1', state: 'RUNNING',
  stateReason: null }, run: null })` calls `api.get` with `/projects/web/fleet/jobs/p1`.
- AC-2 [unit]: after that `sync` resolves, `jobs.value.plan` is the object `api.get` returned.
- AC-3 [unit]: two `sync` calls with the same `plan` entry (`jobId` `p1`, `state` `RUNNING`) after the first fetch
  returned a detail with `id` `p1` and `state` `RUNNING` call `api.get` once in total.
- AC-4 [unit]: a `sync` with `plan` `{ jobId: 'p1', state: 'COMPLETED' }` after a cached detail with `id` `p1` and
  `state` `RUNNING` calls `api.get` with `/projects/web/fleet/jobs/p1` again.
- AC-5 [unit]: a `sync` with `run: null` after a cached RUN detail sets `jobs.value.run` to `null`.
- AC-6 [unit]: a `sync` with `plan` `{ jobId: 'p9', state: 'QUEUED' }` whose `api.get` rejects resolves and leaves
  `jobs.value.plan` `null`.
- AC-7 [unit]: after `sync` with `plan.jobId` `p1`, `isHandoffJob('p1')` returns `true`.
- AC-8 [unit]: after `sync` with `plan.jobId` `p1` and `run: null`, `isHandoffJob('other')` returns `false`.
- AC-9 [unit]: after `sync` with `plan.jobId` `p1`, `refreshJob('p1')` calls `api.get` with
  `/projects/web/fleet/jobs/p1` once more.
- AC-10 [unit]: after `sync` with `plan.jobId` `p1`, `refreshJob('other')` does not call `api.get`.
- AC-11 [unit]: on the thread page mounted with a `useThreadHandoffJobs` stub whose `isHandoffJob('r1')` is `true`,
  invoking the `onFleetJob` handler the page passed to `useProjectEvents` with `{ jobId: 'r1', state: 'COMPLETED', ... }`
  calls the stubbed controller's `reloadThread` once.
- AC-12 [unit]: on the same page, invoking that `onFleetJob` handler with `{ jobId: 'zz', ... }`, for which
  `isHandoffJob` returns `false`, does not call `reloadThread`.
- AC-13 [unit]: on the same page, invoking the `onResync` handler the page passed to `useProjectEvents` calls
  `reloadThread` once.
- AC-14 [unit]: the thread page mounted with a thread whose `handoff.run.jobId` is `r1` and a `useThreadHandoffJobs`
  stub whose `jobs.value.run` is a job `r1` with `workflow.outcome` `draft` renders `thread-job-card-outcome` with the
  text of `fleet.jobs.workflow.outcome.draft`.

- AC-15 [unit]: `useThreadHandoffJobs('web', thread)` loaded with a stubbed `useApi` global, then `thread.value` set to
  a detail whose `handoff.run` is `{ jobId: 'r1', state: 'RUNNING', stateReason: null }`, calls the stubbed `$api.get`
  with `/projects/web/fleet/jobs/r1`.

Verification note: the four Playwright journeys in "E2E journeys" run with `bun run test:e2e -- fleet-threads` in
`apps/web` (needs the e2e Postgres on port 5433); they are not nax acceptance criteria.
