# SPEC: Fleet S5a-B4 — Thread Web (Thread List, New Thread, Live Chat Page)

## Summary

koda gains the web side of brainstorm threads. A project member sees the project's threads at `/:project/threads`. A
DEVELOPER+ member opens one at `/:project/threads/new` against a fleet repo, with a feature, a cost cap and a native
model offered by an eligible runner. On `/:project/threads/:id` they chat with the agent: replies stream in live over
the per-thread SSE route, tool calls show as chips, questions show as cards, and the creator can stop a turn, end the
session, answer a question, raise the cap and archive the thread. Other members read the thread live without acting.
One small API story first exposes three facts the web cannot see today: why a send would be refused
(`sendRefusal` on `GET /:id`), the kill switch (`threadsEnabled` on the list), and each runner's `threadBackends` on the
project runner summaries.

This is feature B4 of fleet S5a phase B, the last one. Umbrella design:
`docs/superpowers/specs/2026-10-10-fleet-s5a-chat-threads-design.md` (§6.1, §6.3, §3.4, §2.5). API features already
merged: B1 `fleet-s5a-thread-core` (#256: routes, send, refusals), B2 `fleet-s5a-thread-ingest` (#262: fold, session,
content SSE). Runner: B3a #259, B3b #260.

## Motivation

The API and runner halves of phase B are merged, but no page reaches them, so threads cannot be used or live-checked
and koda-wk stays undeployed (fleet design doc §9.62). The web also lacks three facts: the API's 409 body carries only
translated text (no key), so the web cannot tell `threads.closing` (which it must retry) from any other refusal; the
kill switch is invisible, so the web cannot hide New thread; and project members cannot read runners' `threadBackends`,
so the web cannot offer a backend picker.

## Design

### Rulings that bind every story (user, 2026-10-12)

- **B4-R1 (API facts):** a first story in `apps/api` adds `sendRefusal` to `GET /projects/:slug/threads/:id`,
  `threadsEnabled` to the thread list response, and `threadBackends` to `RunnerSummaryDto`. The web never parses 409
  message text.
- **B4-R2 (E2E):** one Playwright journey against a protocol-v4 `ScriptedRunner` (create, send, live reply, Stop,
  read-only second member). Closing retry and question cards are covered by Jest.
- **B4-R3 (extras in scope):** tab title prefixed with `• ` while a turn runs; an effort select in the backend picker;
  an Active | Archived switch on the list.

Design decisions recorded with this spec:

- **B4-D1:** assistant message `content` renders as sanitized Markdown through `renderMarkdownOrEscape` (umbrella §6.1).
  Everything else a runner or agent wrote renders through `{{ }}` interpolation only, never `v-html`: user messages,
  `errorReason`, tool `name` / `input` / `preview`, question text and `session.reason`. US-006 updates the web
  context's "never `v-html`" line to name this one exception.
- **B4-D2:** all thread state the page shows comes from the API. The web derives display state (session label, composer
  state, tool chip state) in pure functions in `lib/thread-view.ts` and never re-implements the send checks: the
  composer's reason is `thread.sendRefusal`, plus the viewer-only case (not the creator).
- **B4-D3:** thread money arrives as `Decimal.toString()` strings (`costUsd` `'0'`, `maxCostUsd` `'5'`, `'1.25'`; the
  API's `mapThread`) and is shown with `usd()` as received; the browser never sums or re-rounds it (web context A7).
- **B4-D4:** i18n keys live under `fleet.threads.*` and the sidebar label under `nav.threads`, so the existing
  `tests/i18n/fleet-locale-parity.spec.ts` (`fleet` and `nav` trees) covers them with no change to that spec's code. That spec also bans `|` and `@` in every `fleet` message, so no thread text may contain either (the switch labels are two keys, `fleet.threads.list.active` and `fleet.threads.list.archived`).
- **B4-D6:** thread Markdown shows no remote images. `renderThreadMarkdown(content)` (`lib/thread-markdown.ts`, US-006)
  renders through `renderMarkdownOrEscape` and then removes every `img` element, so agent-steered text (repo content,
  prompt injection) cannot make the browser fetch a URL. Links stay (they need a click).
- **B4-D5:** native backends only. The picker offers models from eligible runners' `threadBackends.native`; ACP agents
  are phase D.

### Integration

Read-only (verified on koda main `6cd1dec1`):

- `apps/api/src/fleet/threads/thread-send-rules.ts` — `export type ThreadSendRefusal = 'disabled' | 'archived' |
  'costCap' | 'budgetPaused' | 'runnerOffline' | 'runnerOutdated' | 'closing' | 'turnRunning'`;
  `export function sendRefusal(state: ThreadSendState): ThreadSendRefusal | null`;
  `export const THREAD_MIN_PROTOCOL_VERSION = 4`.
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadRecord`, `ChatMessageRecord`,
  `ThreadSession { jobId; state: 'live' | 'closed' | 'failed'; resumed; contextReset; reason: string | null; at }`.
- `apps/api/src/live/thread-event-bus.ts` — `ThreadLiveEvent = { id; threadId; at } & ({ type: 'delta'; messageId;
  text } | { type: 'message'; messageId } | { type: 'question'; requestId; text } | { type: 'thread' })`. The API
  writes each event as an SSE frame whose event name is `type` and whose data is the JSON event
  (`apps/api/src/live/live-stream.ts`), after a `ready` frame; `ping` frames keep it alive.
- `apps/web/composables/useApi.ts` — `useApi()` returns `{ $api: { get, post, put, patch, delete } }`; a non-zero
  `ret` throws `ApiError` with `code` (the HTTP-like `ret`, 409 for a conflict); `extractApiError(err): string`.
- `apps/web/lib/project-event-stream.ts` — `EventSourceLike`, `ProjectEventStreamDeps { createEventSource, refreshAuth,
  setTimer, clearTimer }`, `EVENT_SOURCE_CLOSED = 2`, `MAX_TERMINAL_FAILURES = 5`, `backoffMs(attempt)`.
- `apps/web/server/api/projects/[slug]/events.get.ts` — the Nitro live route pattern (more specific than the catch-all
  `server/api/[...].ts`, aborts upstream on client close, passes a non-200 upstream status through).
- `apps/web/lib/markdown.ts` — `renderMarkdownOrEscape(markdown: string): string` (never throws).
- `apps/web/lib/fleet-analytics-format.ts` — `usd(s: string | null | undefined): string`, `tokenText(n: number): string`.
- `apps/web/lib/fleet-dispatch.ts` — `FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/` (same as the API's).
- `apps/web/lib/fleet-jobs.ts` — `canWorkOnFleet(role)` (DEVELOPER+).
- `apps/web/composables/useProjectViewerRole.ts` — `useProjectViewerRole(slug)` → the `useAsyncData` result; its `data.value` is `{ canManage, viewerRole }`, the argument `canWorkOnFleet` takes.
- `apps/web/composables/useAuth.ts` — `useAuth().user.value.id`.
- `apps/web/composables/useProjectMemberNames.ts` — `useProjectMemberNames(slug)` → `{ load, nameOf(userId) }`.
- `apps/web/composables/useProjectSkills.ts` — `list(slug)` → `ProjectSkillDto[]` (`name`, `enabled`,
  `source.resolvedSha`).
- `apps/web/composables/useFleetDispatchOptions.ts` — loads `GET /projects/:slug/fleet/repos` and
  `GET /projects/:slug/fleet/runners`.
- `apps/web/tests/helpers/mount-sfc.ts` — `mountSfc`; `apps/web/tests/helpers/fleet-harness.ts` — `uiStubs`,
  `enI18n()`.

Changed by this feature — the baseline exists only to locate the code; implement the target:

- `ThreadsService.get(projectId, id)` — Baseline: `Promise<ChatThreadRecord>`. Target:
  `Promise<ChatThreadDetail>` where `ChatThreadDetail = ChatThreadRecord & { sendRefusal: ThreadSendRefusal | null }`
  (in `chat-thread.domain.ts`). `messages()` keeps calling a lookup that does not compute the refusal.
- `ChatThreadRepository` — gains `sendRefusalOf(projectId: string, thread: ChatThreadRecord): Promise<ThreadSendRefusal
  | null>`, implemented in `PrismaChatThreadRepository` by calling the existing private `sendRefusalFor` with
  `{ id, status, runnerId, repoId, projectId, costUsd: new Prisma.Decimal(thread.costUsd), maxCostUsd: new
  Prisma.Decimal(thread.maxCostUsd) }` and the thread's current THREAD job (read without locks: `id`, `state`,
  `leaseEpoch`). It writes nothing.
- `ThreadsController` (`threads.controller.ts`) — `GET :id` documents `ThreadDetailDto`; `POST :id/archive` already
  answers `this.threads.get(...)`, so it carries `sendRefusal` too (`ThreadDetailDto`).
- `ThreadsService.list(...)` — Baseline: `Promise<{ items: ChatThreadRecord[] }>`. Target:
  `Promise<{ items: ChatThreadRecord[]; threadsEnabled: boolean }>`, `threadsEnabled` read from
  `fleetConfig.threadsEnabled` on every call.
- `RunnerSummaryDto` — Baseline fields: `id, name, os, arch, labels, enabled, online, profiles`. Target: plus
  `threadBackends: { native: string[]; acp: string[] }`, read from the stored `capabilities.threadBackends` when
  `protocolVersion >= THREAD_MIN_PROTOCOL_VERSION` and both arrays hold only strings; otherwise
  `{ native: [], acp: [] }`.
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — gains `ThreadDetailDto` (`ThreadDto` plus `sendRefusal`, enum of
  the eight refusals, nullable) used by `GET /:id`'s `@ApiResponse`; `ThreadListDto` gains `threadsEnabled: boolean`.
- `apps/web/server/utils/live-proxy.ts` — gains
  `buildThreadLiveUpstreamUrl(slug: string, threadId: string, apiInternalUrl: string): string | null` and
  `openThreadLiveUpstream(req: LiveProxyRequest & { threadId: string }): Promise<LiveProxyResult>` (an invalid slug or
  id → `{ kind: 'error', status: 400 }` without fetching; otherwise `openLiveUpstreamUrl`).
- `apps/web/layouts/default.vue` — the project WORK section gains a Threads link after Agents; `breadcrumbItems` gains
  thread paths.
- `apps/web/components/CommandPalette.vue` — the project entries gain `threads` after `project-agents`.
- `apps/web/tests/e2e/fixtures/scripted-runner.ts` — `ScriptedRunner.enroll` gains `opts.threads` and
  `opts.threadModel` (protocol 4); `putLog`'s stream union gains `'thread'`; `SyncCommand['type']` gains
  `THREAD_INPUT`, `THREAD_ANSWER`, `THREAD_STOP_TURN`, `THREAD_CLOSE`, `THREAD_PUBLISH`.
- `apps/web/playwright.config.ts` — the API web server env gains `FLEET_THREADS_ENABLED: 'true'`.

### API facts (US-001)

`GET /projects/:slug/threads/:id` answers `ChatThreadDetail`. `sendRefusal` is the first refusal of B1's ordered send
checks 3-10 for the thread's current state (kill switch, archived, cost cap, paused budget, runner offline, runner
below v4, closing, turn running) or null; it does not depend on the viewer (`threads.notCreator` stays a send-time
403). `POST /:id/archive` answers the same detail (it already returns `get`). Create, `PATCH /:id`, and list items keep the `ChatThreadRecord` shape. `GET /projects/:slug/threads` answers
`{ items, threadsEnabled }`. `GET /projects/:slug/fleet/runners` records gain `threadBackends`. After the contract
changes, `bun run generate` regenerates `openapi.json` and the CLI client (types only; no CLI command).

### Web data layer (US-002, US-003)

`lib/thread-types.ts` mirrors the DTOs: `ThreadDto` (with `session`, `pendingQuestion: { requestId; text; expiresAt } |
null`, `activeJob`, `tokens: { input; output; cacheRead; cacheWrite } | null`), `ThreadDetailDto` (`sendRefusal`),
`ChatMessageDto` (with `toolSummary: ToolSummaryEntry[] | null`, `errorReason`), `ToolSummaryEntry { callId: string;
name: string; input: string; isError: boolean | null; preview: string; decidedBy: string | null }`,
`ThreadSendRefusal`, `ThreadLiveEvent`, `ThreadBackend = { kind: 'native'; model?: string; effort?: string } | { kind:
'acp'; agent: 'claude' | 'codex'; model?: string; effort?: string }`, `ThreadSkillSource { sourceId; owner; repo; sha;
skills: { name; dir; description }[] }` (`ThreadDto.skills` is `ThreadSkillSource[]`; the header shows the flattened
skill names), `RunnerThreadBackends { native: string[]; acp: string[] }`, `SessionLabel`, `ComposerReason =
ThreadSendRefusal | 'readOnly'`. `FleetRunnerSummary` (`lib/fleet-types.ts`) gains `threadBackends:
RunnerThreadBackends` (US-005).

`lib/thread-view.ts` (pure, no Vue):

| Function | Behaviour |
|---|---|
| `applyDelta(messages, messageId, text): ChatMessageDto[] \| null` | a new array whose message `messageId` has `text` appended to `content`; null when no message has that id (the caller refetches) |
| `mergeMessages(current, incoming): ChatMessageDto[]` | union by `id`, `incoming` wins except that a message `streaming` on both sides keeps the longer `content` (an older in-flight GET never shortens streamed text), ascending `seq`; an optimistic entry (id `local:<clientMessageId>`) is dropped when `incoming` holds a message with its `clientMessageId`; optimistic entries sort after every real message |
| `refetchAfterSeq(messages): number` | `seq - 1` of the lowest-`seq` real message whose `status` is `pending` or `streaming`, else the highest real `seq`, else 0 |
| `isTurnRunning(messages): boolean` | a message (real or optimistic) has `status` `pending` or `streaming` |
| `sessionLabel(thread): SessionLabel` | `'starting'` when `activeJob.state` is QUEUED or ASSIGNED; `'closing'` when it is UPLOADING; `'live'` when it is RUNNING; else `'failed'` when `session.state` is `failed`; else `'closed'` when `session` is non-null; else `'none'` |
| `composerState(thread, messages, viewer: { userId; isCreator }): { canSend: boolean; reason: ComposerReason \| null }` | `reason` = `'readOnly'` when not the creator; else `thread.sendRefusal` when set; else `'turnRunning'` when `isTurnRunning(messages)` (the API sends no `thread` event when a turn starts, so `sendRefusal` can lag); else null; `canSend` = `reason === null` |
| `toolChipState(entry, messageStatus): 'running' \| 'ok' \| 'error' \| 'denied' \| 'unfinished'` | `'denied'` when `decidedBy === 'profile'`; else, when `isError === null`, `'running'` if `messageStatus` is `streaming` and `'unfinished'` otherwise; else `'error'` when `isError`; else `'ok'` |
| `newClientMessageId(): string` | a fresh id matching `/^[A-Za-z0-9_-]{1,64}$/` |
| `costText(thread): string` | `` `${usd(costUsd)} / ${usd(maxCostUsd)}` `` |

`lib/thread-event-stream.ts`: `parseThreadLiveEvent(type, raw): ThreadLiveEvent | null` (JSON object with a string
`id`, `threadId`, and the type's fields as strings; anything else null) and `createThreadEventStream(url, handlers,
deps: ProjectEventStreamDeps): { close(): void }` with `ThreadEventHandlers { onDelta, onMessage, onQuestion, onThread,
onResync, onLiveChange(live: boolean) }`. It listens for `delta`, `message`, `question`, `thread` and `ready`; drops an
event whose `id` it has seen (window 200); calls `onLiveChange(true)` on `ready`; on a reconnect after an error calls
`onResync` once the new connection opens; on a terminal failure (`readyState === EVENT_SOURCE_CLOSED`) calls
`onLiveChange(false)` and recovers like `createProjectEventStream` (refresh auth, `backoffMs`, give up after
`MAX_TERMINAL_FAILURES`). The Nitro route `server/api/projects/[slug]/threads/[id]/events.get.ts` mirrors the project
events route, calling `openThreadLiveUpstream` (slug rule as today; thread id `/^[A-Za-z0-9_-]{1,64}$/`; either invalid
→ 400 without calling upstream).

`lib/thread-controller.ts`: `createThreadController(deps: ThreadControllerDeps)` holds the page's state and is what
`useThread` wraps; deps are `{ api: { get, post, patch }, slug, threadId, openStream(handlers): () => void, setTimer,
clearTimer, now(): number }`. It returns `ThreadController = { thread: Ref<ThreadDetailDto | null>; messages:
Ref<ChatMessageDto[]>; live: Ref<boolean>; load; start; stop; send; stopTurn; endSession; answer; raiseCap; archive }`
(Vue `ref`s created by the controller; `live` starts false and turns false on any stream error, not only a terminal
one). Paths are built with `apiPath`; queries pass as `{ query: { afterSeq: '<n>', limit: '200' } }` with string values.
Behaviour:

- `load()`: `GET /projects/:slug/threads/:id`, then `GET .../messages` from `afterSeq` 0 with `limit` 200, repeating
  from the last `seq` while a page returns 200 items (at most 50 pages); the result is merged with `mergeMessages`, so
  an optimistic message survives a reload.
- `start()`: `openStream`. `onDelta` → `applyDelta`, or `refreshMessages()` when it returns null. `onMessage` →
  `refreshMessages()`. `onQuestion` and `onThread` → reload the thread. `onResync` → `load()`. `onLiveChange` sets
  `live`.
- `refreshMessages()`: `GET .../messages?afterSeq=<refetchAfterSeq(messages)>&limit=200`, merged with
  `mergeMessages`.
- **Polling fallback:** while `live` is false and `isTurnRunning(messages)`, every 2000 ms `refreshMessages()` and
  reload the thread; it stops when either condition ends. `stop()` of the controller clears it and closes the stream.
- `send(text)`: appends an optimistic message (`id: local:<cid>`, `role: user`, `status: pending`,
  `clientMessageId: cid`), then `POST .../messages { text, clientMessageId: cid }`; on success merges the returned
  `message`. On an `ApiError` with `code` 409 it reloads the thread: when `thread.sendRefusal === 'closing'` and less
  than 15000 ms have passed since the first attempt it retries after 2000 ms with the same `cid`; otherwise it removes
  the optimistic message and resolves `{ ok: false, error }`. Any other error removes the optimistic message and
  resolves `{ ok: false, error }`.
- `stopTurn()`, `endSession()`, `answer(requestId, text)`, `raiseCap(maxCostUsd: number)`, `archive()`: `POST .../stop`,
  `POST .../end-session`, `POST .../answer { requestId, text }`, `PATCH /:id { maxCostUsd }`, `POST .../archive`; each
  reloads the thread on success and resolves `{ ok: false, error }` on failure (the page toasts
  `extractApiError(error)`).

`composables/useThread.ts`: `useThread(slug, threadId): ThreadController`, wrapping the controller with `useApi`,
`useAuth().refresh` for the stream, browser timers and `EventSource` (`openStream` = `createThreadEventStream` over
`apiPath\`/api/projects/${slug}/threads/${threadId}/events\``); on mount (client only) it calls `load()` then
`start()`, on unmount `stop()`. `composables/useThreads.ts`: `useThreads(slug)` → `{ threads: Ref<ThreadDto[]>;
threadsEnabled: Ref<boolean>; status: Ref<'ACTIVE' | 'ARCHIVED'>; load(status = 'ACTIVE'): Promise<void> }`,
`GET /projects/:slug/threads` with `{ query: { status, size: '100' } }`.

Component contracts (props / emits) the pages bind:

| Component | Props | Emits |
|---|---|---|
| `ThreadListTable` | `threads: ThreadDto[]`, `status`, `nameOf(userId): string \| null`, `slug` | — |
| `BackendPicker` | `models: string[]`, `model`, `effort` | `update:model`, `update:effort` |
| `ThreadHeader` | `thread: ThreadDetailDto`, `runners: FleetRunnerSummary[]` | — |
| `ThreadTimeline` | `thread`, `messages: ChatMessageDto[]`, `isCreator: boolean` | `answer(requestId, text)` |
| `ThreadMessage` | `message: ChatMessageDto` | — |
| `ThreadToolChip` | `entry: ToolSummaryEntry`, `messageStatus: string` | — |
| `ThreadQuestionCard` | `question: { requestId; text; expiresAt }`, `isCreator: boolean` | `answer(requestId, text)` |
| `ThreadComposer` | `composerState`, `turnRunning: boolean` | `send(text)`, `stop` |
| `ThreadControls` | `isCreator: boolean`, `canManage: boolean`, `sessionLabel`, `archived: boolean` | `endSession`, `raiseCap(value: number)`, `archive` |

The thread page binds each emit to the matching `useThread()` method and toasts `extractApiError(error)` for every
`{ ok: false, error }`.

### Pages (US-004 to US-007)

- **Navigation:** sidebar WORK section link `/:project/threads` (`nav.threads`, icon `MessagesSquare`) after Agents;
  palette entry `threads`; breadcrumbs `Koda / <project> / Threads` and, below it, `Threads` linked plus
  `fleet.threads.new.title` or the thread page leaf `fleet.threads.detail.title`.
- **`/:project/threads`:** Active | Archived switch (`status` query of the list route); rows: title (link), creator
  (`nameOf(createdById)`, else the id), `feat/<feature>`, backend label, session label, last activity, `costText`;
  New thread button (`fleet.threads.list.newThread`) shown only when `canWorkOnFleet(role)` and `threadsEnabled`; an empty state per status.
- **`/:project/threads/new`:** vee-validate + zod (`buildThreadCreateSchema(t)` in `lib/thread-create.ts`, messages as i18n keys like `buildDispatchSchema(t)`): repo (select of
  the project's fleet repos), base ref (optional, ≤ 255, placeholder the repo's default branch), feature (`FEATURE_RE`,
  no `..`, validated as typed), title (1..200, no control characters), cap (number, 0.0001..10000, at most 4 decimals,
  default 5), model (select), effort (select: default, `low`, `medium`, `high`, `xhigh`). `eligibleModels(runners)`
  = the sorted unique union of `threadBackends.native` over runners with `online && enabled`. With no eligible model the
  form shows `fleet.threads.new.noBackend` and submit is disabled. `toCreateThreadBody(values)` sends `{ repoId,
  feature, title, maxCostUsd: <number>, backend: { kind: 'native', model, effort? }, baseRef? }` (`baseRef` and
  `effort` only when set). A read-only list shows the project's enabled skills (name, first 7 characters of `source.resolvedSha`, nothing when it is null). Success navigates to
  the new thread; an `ApiError` is shown under the form with `extractApiError`.
- **`/:project/threads/:id`:** `ThreadHeader` (title, `feat/<feature>`, backend label, runner name and online dot from
  the project runner summaries, skill names, `costText`, `tokenText(input + output)`, session label);
  `ThreadTimeline` of `ThreadMessage` (assistant: `renderThreadMarkdown(content)`; user: plain text; a streaming
  indicator while `status === 'streaming'`; an end marker for `errored`, `cancelled`, `timed_out` and `interrupted` (`fleet.threads.detail.status.<status>`) with `errorReason` as plain text; tool chips), a context-reset marker
  when `session.contextReset`, and `ThreadQuestionCard` for `pendingQuestion`. `useHead` title: the thread title,
  prefixed `• ` while `isTurnRunning(messages)`.
- **Composer and controls (US-007):** the composer and the answer input validate with vee-validate + a zod schema (trimmed text, non-empty, at most 32768 UTF-8 bytes, the API's limit). `ThreadComposer` for the creator: a textarea where Enter sends and Shift+Enter
  inserts a newline; Send disabled with the reason text `fleet.threads.refusal.<reason>` when `composerState` refuses;
  Stop shown while `isTurnRunning`. Non-creators see `fleet.threads.composer.readOnly` instead. `ThreadControls`: End
  session (creator, `sessionLabel === 'live'`), Raise cap (creator, a dialog with the same cap rule), Archive (creator
  or `canManage`, confirm dialog; hidden when archived). `ThreadQuestionCard` shows an answer input and Send to the
  creator only.

### E2E journey (US-007)

`tests/e2e/fleet-threads.e2e.spec.ts` (B4-R2), against the e2e API started with `FLEET_THREADS_ENABLED: 'true'`:
`ScriptedRunner.enroll(adminToken, name, { threads: true, threadModel })` enrolls at protocol 4 (the `threads` branch
of `protocolVersion` wins over `logs` and `relay`) with the default e2e capabilities plus `threadBackends: { native:
[threadModel], acp: [] }`, and heartbeats. `threadModel` is unique per run (`e2e-model-<suffix>`) so no other scripted
runner of the suite matches the THREAD job. `SyncCommand['type']` gains the five thread command types. The admin (a project member of the seeded
fleet project) opens `/<project>/threads/new`, creates a thread on the seeded repo with model `threadModel`, and sends
`hello` from the thread page. The test reads the job id from `GET /projects/:slug/threads/:id` (`activeJob.id`) and the
user message id from `GET .../messages`; the runner takes the THREAD job's ASSIGN (`acceptAssign(jobId)`), reports `RUNNING`, and
uploads `thread` lines with `putLog(lease, 'thread', ...)`: `session_started { resumed: false }`, `input_consumed
{ messageId }`, `turn_start { turnId: 't1' }`, `text_delta { turnId: 't1', round: 0, text: 'Hello from the runner' }`.
The page shows `Hello from the runner` without a reload and a Stop button; clicking Stop delivers a
`THREAD_STOP_TURN` command to the runner (`takeCommand`). The runner then uploads `turn_end` (`status: 'cancelled'`,
`output: ''`, zero usage and cost). A second user, created with `createUser` and added as a VIEWER with
`addProjectMember`, opens the same thread, sees `Hello from the runner`, and sees `fleet.threads.composer.readOnly`
instead of a textarea. Verified with `bun run test:e2e -- fleet-threads` in `apps/web`; Playwright specs are not
nax acceptance criteria.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Send answers 409 and the reloaded thread says `closing` | retry every 2000 ms with the same `clientMessageId`, up to 15000 ms | US-003 |
| Send answers 409 with any other refusal, or another error | optimistic message removed; `{ ok: false, error }`; the composer shows the reloaded `sendRefusal` | US-003 |
| SSE refused or dropped (429, network, 401) | `live` false; polling every 2000 ms while a turn runs; resync on reconnect | US-002, US-003 |
| A `delta` for a message the page does not hold | refetch messages after `refetchAfterSeq` | US-003 |
| Malformed SSE event data | ignored | US-002 |
| Invalid slug or thread id on the Nitro SSE route | 400, upstream never called | US-002 |
| Kill switch off | New thread hidden; `sendRefusal 'disabled'` shown in the composer | US-001, US-004, US-007 |
| No eligible runner model | create form shows `noBackend`, submit disabled | US-005 |
| Create answers 409 (feature taken, disabled) or 400 | `extractApiError` text under the form; no navigation | US-005 |
| Stop / end session / answer / cap / archive fails | toast `extractApiError(error)`; state reloaded on the next event | US-003, US-007 |
| Runner capabilities without `threadBackends`, or protocol below 4 | `threadBackends` `{ native: [], acp: [] }` | US-001 |

## Out of Scope

- Publish, Plan, Run, the action bar, "Discard unpublished changes", commit markers and PLAN/RUN job cards belong to
  phase C.
- ACP backends (Claude, Codex) in the picker and on the page belong to phase D; the picker offers native models only.
- Turn-finished notifications, thread search, transcript export, editing a past message, thread delete and a CLI.
- Rendering reasoning (`thinking_delta`) or compaction; the API does not store them.
- `sendRefusal` on list items, on create and on `PATCH /:id` responses; only `GET /:id` and `POST /:id/archive` carry it.
- A per-viewer refusal on the API (`threads.notCreator` stays a send-time 403); the web hides acting controls from
  non-creators itself.
- Moving a thread between runners and choosing a runner on create (placement picks it).
- Regenerating `apps/web/AGENTS.md`, `CLAUDE.md` and the other generated agent files after the US-006 context edit is
  done by hand after merge (`nax generate`).
- US-002 only: the Nitro route's JWT expiry close and heartbeat re-check are the API's (`createLiveStream`); the route
  adds none and has no acceptance criterion for them.
- US-003 only: a thread whose `pendingQuestion.expiresAt` has passed still shows the card until the API clears it.
- US-003 only: the controller's give-up after `MAX_TERMINAL_FAILURES` leaves polling as the only update path; it has no
  dedicated acceptance criterion beyond the `live` false case.
- US-004 only: list paging beyond the first 100 threads.
- US-005 only: checking on the client that `feature` is unused by another ACTIVE thread; the API answers 409.
- US-006 only: the runner online dot follows the runner summaries loaded with the page; it does not live-update.
- US-002 only: `applyDelta` returning null for an unknown id (US-003 AC3 drives that path); the remaining classes of each view function (`sessionLabel` for `starting`, `live`, `failed`, `closed`
  and `none`; `toolChipState` for `running`, `error` and `ok`; `refetchAfterSeq` with no in-flight message or no
  message; `parseThreadLiveEvent` for malformed data; `newClientMessageId`'s format) follow the table in Design and
  have no dedicated acceptance criterion.
- US-003 only: reloading the thread on `onThread` / `onQuestion`, the polling stop once no turn runs, `stopTurn`,
  `endSession` and `archive` routes, and the controller's `stop()` cleanup follow the Design text without a dedicated
  acceptance criterion.
- US-004 only: the `emptyActive` state, the palette entry's position and non-empty `zh` texts follow the same rules as
  the pinned cases.
- US-005 only: the other schema classes (feature `-bad` or empty, empty title or one with a control character, cap 0
  or above 10000, the default cap 5), the disabled-runner exclusion in `eligibleModels`, disabled skills being left
  out, and staying on the page after a failed create have no dedicated acceptance criterion.
- US-006 only: the errored marker label, a non-streaming message showing no indicator, the tool chip's `input`, and the
  title without `• ` when no turn runs have no dedicated acceptance criterion.
- US-007 only: the page bindings of `stop`, `raiseCap`, `archive` and `answer` follow the component contract table like `endSession` (AC5) without a dedicated acceptance criterion; a disabled Send button beside the refusal text has none either.
- US-007 only: clearing the textarea after a send, the Stop button's absence when no turn runs, End session's absence
  for a closed session, and Raise cap's validation message text have no dedicated acceptance criterion.
- US-002 only: the Nitro route file `server/api/projects/[slug]/threads/[id]/events.get.ts` is a thin wrapper over
  `openThreadLiveUpstream` (as the project events route is) with no unit acceptance criterion; the US-007 E2E journey
  reaches it (the live reply appears without a reload).
- US-003 only: no polling while `live` is true, and the `{ ok: false, error }` result of `answer` and `raiseCap`, follow
  the Design without a dedicated acceptance criterion; the page toasts every `{ ok: false }` the same way.
- US-003 only: a refetch that lands between a fold's commit and its published `delta` can show that text twice until
  the next `message` event (at the latest the `turn_end`) refetches the message; accepted.
- US-005 only: effort values other than `low`, `medium`, `high` and `xhigh` (the API accepts any `/^[a-z]{1,16}$/`).
- US-006 only: the token count text and the backend label have no dedicated acceptance criterion.
- US-007 only: Raise cap with `0` showing the validation message and emitting nothing has no dedicated acceptance
  criterion.
- THREAD jobs listed on the fleet jobs page show their raw command (`fleet.command` keeps its four pinned values); a
  `THREAD` label there is a later change.
- US-007 only: the E2E journey covers create, send, live reply, Stop and a read-only member; closing retry, question
  answer, context reset and archive are covered by component and controller tests only.

## Stories

1. **US-001: Web-facing thread facts** — `Workdir: apps/api` — no dependencies.
2. **US-002: Thread client core: types, view logic, event stream, SSE route** — `Workdir: apps/web` — depends on
   US-001 (the types mirror its DTO fields).
3. **US-003: Thread controller and composables** — `Workdir: apps/web` — depends on US-002.
4. **US-004: Thread list page and navigation** — `Workdir: apps/web` — depends on US-003.
5. **US-005: New thread page** — `Workdir: apps/web` — depends on US-004 (navigation and breadcrumbs).
6. **US-006: Thread page: header and timeline** — `Workdir: apps/web` — depends on US-005.
7. **US-007: Composer, session controls and the E2E journey** — `Workdir: apps/web` — depends on US-006.

### Context Files

> Existing files to read or change, or files an upstream dependency creates (annotated).

**US-001**

- `apps/api/src/fleet/threads/threads.service.ts` — `get` returns `ChatThreadDetail`; `list` adds `threadsEnabled`
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts` — private `sendRefusalFor`; gains `sendRefusalOf`
- `apps/api/src/fleet/threads/domain/chat-thread.domain.ts` — `ChatThreadDetail`, `sendRefusalOf` on the interface
- `apps/api/src/fleet/threads/dto/thread.dto.ts` — `ThreadDetailDto`, `ThreadListDto.threadsEnabled`
- `apps/api/src/fleet/runners/dto/runner-summary.dto.ts` — `threadBackends`
- `apps/api/src/fleet/threads/threads.controller.ts` — `GET :id` / `POST :id/archive` document `ThreadDetailDto`

**US-002**

- `apps/web/lib/project-event-stream.ts` — `EventSourceLike`, deps, backoff and terminal-failure rules to mirror
- `apps/web/server/api/projects/[slug]/events.get.ts` — the Nitro live route to mirror
- `apps/web/server/utils/live-proxy.ts` — gains `buildThreadLiveUpstreamUrl` and `openThreadLiveUpstream`
- `apps/web/lib/fleet-analytics-format.ts` — `usd`, `tokenText`
- `apps/web/tests/lib/project-event-hub.spec.ts` — the `FakeEventSource` pattern (a local, non-exported class; US-002 defines its own)

**US-003**

- `apps/web/composables/useProjectEvents.ts` — client-only mount/unmount and `useAuth().refresh` pattern
- `apps/web/composables/useApi.ts` — `ApiError.code`, `extractApiError`
- `apps/web/lib/thread-view.ts` — created by US-002
- `apps/web/lib/thread-event-stream.ts` — created by US-002
- `apps/web/lib/thread-types.ts` — created by US-002

**US-004**

- `apps/web/layouts/default.vue` — WORK section link and `breadcrumbItems`
- `apps/web/components/CommandPalette.vue` — project entries
- `apps/web/composables/useProjectMemberNames.ts` — creator names
- `apps/web/lib/fleet-jobs.ts` — `canWorkOnFleet`
- `apps/web/composables/useThreads.ts` — created by US-003

**US-005**

- `apps/web/pages/[project]/fleet/dispatch.vue` — form, repo select and ref field pattern
- `apps/web/lib/fleet-dispatch.ts` — `FEATURE_RE` and the zod schema pattern
- `apps/web/composables/useFleetDispatchOptions.ts` — repos and runner summaries
- `apps/web/composables/useProjectSkills.ts` — enabled skills
- `apps/web/lib/fleet-types.ts` — `FleetRunnerSummary` gains `threadBackends`

**US-006**

- `apps/web/lib/markdown.ts` — `renderMarkdownOrEscape`
- `apps/web/components/TicketActivity.vue` — the `v-html` of sanitized Markdown pattern
- `.nax/mono/apps/web/context.md` — the "never `v-html`" line gains the assistant-message exception (B4-D1)
- `apps/web/composables/useThread.ts` — created by US-003
- `apps/web/lib/thread-view.ts` — created by US-002

**US-007**

- `apps/web/tests/e2e/fixtures/scripted-runner.ts` — `enroll` gains `opts.threads` / `opts.threadModel`; `putLog` gains `'thread'`; `SyncCommand['type']` gains the thread commands
- `apps/web/playwright.config.ts` — API env `FLEET_THREADS_ENABLED: 'true'`
- `apps/web/tests/e2e/fleet-logs.e2e.spec.ts` — ScriptedRunner `acceptAssign` / `report` / `putLog` journey pattern
- `apps/web/tests/e2e/fixtures/api-client.ts` — `login`, `createUser`, `addProjectMember`, `E2E_ADMIN`
- `apps/web/pages/[project]/threads/[id].vue` — created by US-006, gains the composer and controls

### Creates

> New files each story authors.

**US-001**

- `apps/api/src/fleet/threads/thread-detail.spec.ts` — `ThreadsService.get` / `list` over a fake repository (unit)
- `apps/api/test/integration/fleet/thread-web-facts.integration.spec.ts` — `GET /:id` refusals, list flag, runner summaries

**US-002**

- `apps/web/lib/thread-types.ts`
- `apps/web/lib/thread-view.ts`
- `apps/web/lib/thread-event-stream.ts`
- `apps/web/server/api/projects/[slug]/threads/[id]/events.get.ts`
- `apps/web/tests/lib/thread-view.spec.ts`
- `apps/web/tests/lib/thread-event-stream.spec.ts`
- `apps/web/tests/server/thread-live-proxy.spec.ts`

**US-003**

- `apps/web/lib/thread-controller.ts`
- `apps/web/composables/useThread.ts`
- `apps/web/composables/useThreads.ts`
- `apps/web/tests/lib/thread-controller.spec.ts`

**US-004**

- `apps/web/pages/[project]/threads/index.vue`
- `apps/web/components/fleet/threads/ThreadListTable.vue`
- `apps/web/tests/components/thread-list-table.spec.ts`
- `apps/web/tests/layouts/default-threads-nav.spec.ts`

**US-005**

- `apps/web/pages/[project]/threads/new.vue`
- `apps/web/lib/thread-create.ts`
- `apps/web/components/fleet/threads/BackendPicker.vue`
- `apps/web/tests/lib/thread-create.spec.ts`
- `apps/web/tests/components/thread-backend-picker.spec.ts`

**US-006**

- `apps/web/pages/[project]/threads/[id].vue`
- `apps/web/components/fleet/threads/ThreadHeader.vue`
- `apps/web/components/fleet/threads/ThreadTimeline.vue`
- `apps/web/components/fleet/threads/ThreadMessage.vue`
- `apps/web/components/fleet/threads/ThreadToolChip.vue`
- `apps/web/components/fleet/threads/ThreadQuestionCard.vue`
- `apps/web/lib/thread-markdown.ts` — `renderThreadMarkdown`
- `apps/web/tests/components/thread-timeline.spec.ts`

**US-007**

- `apps/web/components/fleet/threads/ThreadComposer.vue`
- `apps/web/components/fleet/threads/ThreadControls.vue`
- `apps/web/tests/components/thread-composer.spec.ts`
- `apps/web/tests/e2e/fleet-threads.e2e.spec.ts` — the B4-R2 journey (verified with `bun run test:e2e -- fleet-threads` in `apps/web`)

### Modifies

**US-001**

- `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts` — the closed-world `expect(dto).toEqual({ id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, profiles: ['alpha', 'zeta'] })` gains `threadBackends: { native: [], acp: [] }`, because `RunnerSummaryDto.from` now always returns `threadBackends` (empty for that record, which reports none). The other fields are unchanged.
- `apps/api/test/integration/fleet/runner-views.integration.spec.ts` — the key list `['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']` for a project runner summary gains `'threadBackends'` (sorted after `'profiles'`), because the summary now carries it. The other keys are unchanged.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the `RunnerSummaryDto` schema property list `['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']` gains `'threadBackends'`, because the DTO gains that property. The `RepoCheckResultDto` assertion is unchanged.
- `openapi.json` — regenerated by `bun run generate` for `ThreadDetailDto`, `ThreadListDto.threadsEnabled` and `RunnerSummaryDto.threadBackends`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — additive cases, because the api testing rule requires endpoint changes to be reflected here: the thread detail route answers a `sendRefusal` field, the thread list route answers `threadsEnabled`, and project runner summary records carry `threadBackends`. Existing cases unchanged.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` from the new OpenAPI document; never hand-edited.

**US-002**

None. The story adds new `lib/`, `server/` and test files; `live-proxy.ts` gains an export without changing the existing builders.

**US-003**

None. The story adds new files only.

**US-004**

- `apps/web/i18n/locales/en.json` — gains `nav.threads`, `fleet.threads.list.*`, `fleet.threads.session.*` (one key per `SessionLabel`), `fleet.threads.new.title` and `fleet.threads.detail.title`, because the layout's breadcrumbs name the last two as literal `t()` keys and the used-keys-exist i18n spec requires every literal key to exist; existing keys unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same leaf paths as the English locale file, so the fleet locale-parity spec still sees equal `fleet` and `nav` trees.
- `apps/web/tests/helpers/mount-sfc.ts` — `NUXT_AUTO_IMPORTS` (and its defaults map) gains `useThread` and `useThreads`, so a page that auto-imports them can be mounted and the test can override them through `globals` (precedent: `useProjectSkills`, #254). Existing names unchanged.

**US-005**

- `apps/web/i18n/locales/en.json` — gains the rest of `fleet.threads.new.*` (US-004 added `title`); existing keys unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same leaf paths as the English locale file.

**US-006**

- `.nax/mono/apps/web/context.md` — the line "Run logs and other runner- or agent-written text render through `{{ }}` interpolation only, never `v-html`" gains the one exception of B4-D1: thread assistant message content renders through `renderThreadMarkdown` (sanitized, images removed); every other runner or agent text stays interpolation-only.
- `apps/web/i18n/locales/en.json` — gains the rest of `fleet.threads.detail.*` (US-004 added `title`) and `fleet.threads.tool.*`; existing keys unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same leaf paths as the English locale file.

**US-007**

- `apps/web/i18n/locales/en.json` — gains `fleet.threads.composer.*`, `fleet.threads.refusal.*` (one key per `ThreadSendRefusal` value plus `readOnly`) and `fleet.threads.controls.*`; existing keys unchanged.
- `apps/web/i18n/locales/zh.json` — gains the same leaf paths as the English locale file.

### Seams

- SEAM-1 (US-001 → US-003): `sendRefusal` on `GET /:id` drives the controller's closing retry; US-003 ACs give the
  fake `api.get` a thread with `sendRefusal: 'closing'` and assert the retry.
- SEAM-2 (US-002 → US-003): `createThreadEventStream` is what `useThread` passes as `openStream`; US-003 ACs drive the
  controller through the handlers object `openStream` receives.
- SEAM-3 (US-003 → US-004, US-006): `useThreads` and `useThread` are the pages' only API path; page and component ACs
  stub them (or mount components with props) and never call `$fetch`.
- SEAM-4 (US-001 → US-005): `RunnerSummaryDto.threadBackends` feeds `eligibleModels`; US-005 ACs pass runner summaries
  carrying `threadBackends`.

## Acceptance Criteria

Unless stated otherwise, US-001 integration ACs boot the API with `app.get(FLEET_CFG).threadsEnabled = true`, use a
project `web` with member `dev` (DEVELOPER) who created thread T on fleet repo `web-app` with `maxCostUsd` 5 and
`costUsd` 0, no runner pinned and no THREAD job, and call routes as `dev`. An AC that sets `app.get(FLEET_CFG).threadsEnabled` restores it in a `finally` (or `afterEach`) so no other spec sees the change. Web ACs build fixtures in the test: a
`ThreadDto` `t` (id `th1`, title `Auth spec`, feature `add-auth`, `createdById` `u1`, `costUsd` `'0'`, `maxCostUsd`
`'5'`, `session` null, `activeJob` null, `pendingQuestion` null, `sendRefusal` null) and messages built from
`{ id, seq, role, status, content }` with the other fields null.

### US-001: Web-facing thread facts (`Workdir: apps/api`)

1. [integration] `GET /api/projects/web/threads/T` answers 200 with `sendRefusal` null.
2. [integration] With `app.get(FLEET_CFG).threadsEnabled = false`, `GET /api/projects/web/threads/T` answers 200 with `sendRefusal` `'disabled'`.
3. [integration] After T is archived, `GET /api/projects/web/threads/T` answers `sendRefusal` `'archived'`.
4. [integration] With T's `costUsd` set to 5 (equal to `maxCostUsd`), `GET /api/projects/web/threads/T` answers `sendRefusal` `'costCap'`.
5. [integration] With a THREAD job of T in UPLOADING, `GET /api/projects/web/threads/T` answers `sendRefusal` `'closing'`.
6. [integration] With a THREAD job of T in RUNNING at lease epoch 1 and a `THREAD_CLOSE` `FleetCommand` for it at epoch 1, `GET /api/projects/web/threads/T` answers `sendRefusal` `'closing'`.
7. [integration] With a `pending` user message in T and its THREAD job RUNNING, `GET /api/projects/web/threads/T` answers `sendRefusal` `'turnRunning'`.
8. [integration] With T's `costUsd` at 5, `GET /api/projects/web/threads/T` called by a VIEWER member answers `sendRefusal` `'costCap'` (the refusal does not depend on the viewer).
9. [integration] With `app.get(FLEET_CFG).threadsEnabled = false`, `GET /api/projects/web/threads` answers 200 with `threadsEnabled` false.
10. [unit] `ThreadsService.list` over a fake repository answers `{ items, threadsEnabled }` with `threadsEnabled` read from the config object at call time (changing the config between two calls changes the flag).
11. [unit] `RunnerSummaryDto.from` for a record with `protocolVersion` 4 and `capabilities.threadBackends` `{ native: ['m1', 'm2'], acp: [] }` returns `threadBackends` `{ native: ['m1', 'm2'], acp: [] }`.
12. [unit] `RunnerSummaryDto.from` for a record with `protocolVersion` 3 and the same stored `threadBackends` returns `threadBackends` `{ native: [], acp: [] }`.
13. [unit] `RunnerSummaryDto.from` for a record with `protocolVersion` 4 whose `capabilities.threadBackends.native` is `[1]` (not strings) returns `threadBackends` `{ native: [], acp: [] }`.
14. [integration] `GET /api/projects/web/fleet/runners` by `dev` lists a runner enrolled at protocol 4 with capabilities `threadBackends` `{ native: ['m1'], acp: [] }` with `threadBackends` `{ native: ['m1'], acp: [] }`.
15. [unit] The committed `openapi.json` (read as the fleet OpenAPI contract spec reads it) gives `ThreadDetailDto` a `sendRefusal` property and `ThreadListDto` a `threadsEnabled` property.

### US-002: Thread client core: types, view logic, event stream, SSE route (`Workdir: apps/web`)

1. [unit] `applyDelta` over messages `[{ id: 'a', content: 'He' }]` with `('a', 'llo')` returns an array whose message `a` has content `Hello`.
2. [unit] `openThreadLiveUpstream` for slug `web`, thread id `th1`, cookie `koda_token=x` and an injected `fetchImpl` calls `fetchImpl` once with the URL `buildThreadLiveUpstreamUrl('web', 'th1', apiInternalUrl)` returns and the header `cookie: koda_token=x`.
3. [unit] `mergeMessages` of current `[{ id: 'local:c1', clientMessageId: 'c1', status: 'pending' }]` with incoming `[{ id: 'm5', seq: 5, clientMessageId: 'c1', status: 'pending' }]` returns exactly `[m5]`.
4. [unit] `mergeMessages` of current `[{ id: 'm1', seq: 1 }, { id: 'local:c2', clientMessageId: 'c2' }]` with incoming `[{ id: 'm2', seq: 2 }]` returns ids in the order `m1`, `m2`, `local:c2`.
5. [unit] `refetchAfterSeq` of messages with seqs 1 (`complete`), 2 (`streaming`) and 3 (`pending`) returns 1.
6. [unit] `sessionLabel` of a thread whose `activeJob.state` is `UPLOADING` returns `'closing'`.
7. [unit] `composerState(t, [], { userId: 'u2', isCreator: false })` with `t.sendRefusal` null returns `{ canSend: false, reason: 'readOnly' }`.
8. [unit] `composerState(t, [{ id: 'm1', seq: 1, role: 'assistant', status: 'streaming', content: '' }], { userId: 'u1', isCreator: true })` with `t.sendRefusal` null returns `{ canSend: false, reason: 'turnRunning' }`.
9. [unit] `toolChipState({ isError: null, decidedBy: null }, 'cancelled')` returns `'unfinished'`.
10. [unit] `parseThreadLiveEvent('delta', '{"id":"e1","threadId":"th1","at":"x","type":"delta","messageId":"m1","text":"hi"}')` returns an event with `messageId` `m1` and `text` `hi`.
11. [unit] `createThreadEventStream` over a `FakeEventSource` calls `onLiveChange(true)` when a `ready` frame arrives.
12. [unit] `createThreadEventStream` calls `onDelta` once when two `delta` frames carry the same `id`.
13. [unit] `createThreadEventStream` calls `onLiveChange(false)` when the `FakeEventSource` reports an error with `readyState` 2.
14. [unit] `createThreadEventStream` calls `onResync` once when the connection that replaces a failed one opens.
15. [unit] `openThreadLiveUpstream` with thread id `../x` and an injected `fetchImpl` resolves `{ kind: 'error', status: 400 }` and never calls `fetchImpl`.

### US-003: Thread controller and composables (`Workdir: apps/web`)

1. [unit] `createThreadController` `load()`, with a fake `api.get` answering the thread, a first messages page of 200 items and a second page of 3, ends holding 203 messages.
2. [unit] After `start()`, calling the `onDelta` handler that `openStream` received with `{ messageId: 'm2', text: 'x' }` for a held message `m2` appends `x` to `m2` without any `api.get` call.
3. [unit] Calling `onDelta` for a `messageId` not held calls `api.get` for `/projects/web/threads/th1/messages` with `afterSeq` equal to `refetchAfterSeq` of the held messages.
4. [unit] Calling `onResync` calls `api.get` for `/projects/web/threads/th1/messages` with `afterSeq` 0.
5. [unit] With `onLiveChange(false)` called and a held `streaming` message, advancing the fake timer by 2000 ms calls `api.get` for the messages route once.
6. [unit] `useThread('web', 'th1')` mounted in a component with a stubbed global `EventSource` opens one `EventSource` at `/api/projects/web/threads/th1/events` (the production `openStream` is `createThreadEventStream`).
7. [unit] `send('hi')` holds a `pending` user message with id `local:<cid>` before `api.post` resolves.
8. [unit] `send('hi')` posts `{ text: 'hi', clientMessageId: <cid> }` to `/projects/web/threads/th1/messages`, where `<cid>` is the optimistic message's `clientMessageId`.
9. [unit] When `api.post` resolves `{ message: { id: 'm9', seq: 9, clientMessageId: <cid> }, jobId: null }`, the held messages contain `m9` and no `local:` entry.
10. [unit] When `api.post` rejects with `ApiError` code 409 and the reloaded thread has `sendRefusal: 'closing'`, the controller posts again with the same `clientMessageId` after the fake timer advances 2000 ms.
11. [unit] When every reload answers `sendRefusal: 'closing'` and the fake clock passes 15000 ms since the first attempt, `send` resolves `{ ok: false }` with no `local:` message held.
12. [unit] When `api.post` rejects with `ApiError` code 409 and the reloaded thread has `sendRefusal: 'turnRunning'`, `send` resolves `{ ok: false }` after exactly one post.
13. [unit] `answer('q1', 'yes')` posts `{ requestId: 'q1', text: 'yes' }` to `/projects/web/threads/th1/answer`.
14. [unit] `raiseCap(8)` patches `/projects/web/threads/th1` with `{ maxCostUsd: 8 }`.
15. [unit] `useThreads('web')` with a stubbed `$api.get` resolving `{ items: [t], threadsEnabled: false }` exposes `threadsEnabled` false after `load()`.

### US-004: Thread list page and navigation (`Workdir: apps/web`)

1. [unit] Rendering `layouts/default.vue` with project slug `web` produces a link to `/web/threads`, placed after the `/web/agents` link and before the Knowledge section label.
2. [unit] The command palette with `projectSlug` `web` offers an entry `threads` whose action navigates to `/web/threads`.
3. [unit] `breadcrumbItems` for path `/web/threads` is `Koda`, `web`, then the `nav.threads` label without a link.
4. [unit] `breadcrumbItems` for path `/web/threads/th1` is `Koda`, `web`, `nav.threads` linked to `/web/threads`, then the `fleet.threads.detail.title` label.
5. [unit] Mounting `ThreadListTable` with threads `[t]` renders a link to `/web/threads/th1` with text `Auth spec`.
6. [unit] Mounting `ThreadListTable` with threads `[t]` and a `nameOf` returning `Dana` for `u1` shows the creator `Dana`.
7. [unit] Mounting `ThreadListTable` with a thread whose `nameOf` result is null shows the raw `createdById` `u1`.
8. [unit] Mounting `ThreadListTable` with threads `[t]` shows the cost text `$0 / $5`.
9. [unit] Mounting `ThreadListTable` with a thread whose `activeJob.state` is `RUNNING` shows the `fleet.threads.session.live` label.
10. [unit] Mounting `ThreadListTable` with no threads and `status` `ARCHIVED` shows `fleet.threads.list.emptyArchived`.
11. [unit] The list page shows the New thread link to `/web/threads/new` when the viewer role is `DEVELOPER` and `threadsEnabled` is true.
12. [unit] The list page hides the New thread link when `threadsEnabled` is false, even for a project ADMIN.
13. [unit] The list page hides the New thread link for a `VIEWER` when `threadsEnabled` is true.
14. [unit] Switching the list page to Archived calls `useThreads` `load` with `status` `ARCHIVED`.
15. [unit] The list page with a stubbed `useThreads` holding `[t]` renders a `ThreadListTable` row linking to `/web/threads/th1`.

### US-005: New thread page (`Workdir: apps/web`)

1. [unit] `buildThreadCreateSchema(t)` rejects feature `a..b`.
2. [unit] `buildThreadCreateSchema(t)` rejects a 201-character title.
3. [unit] `buildThreadCreateSchema(t)` rejects cap `1.23456` (more than 4 decimals).
4. [unit] `toCreateThreadBody({ repoId: 'r1', feature: 'add-auth', title: 'Auth spec', maxCostUsd: '5', model: 'm1', effort: '', baseRef: '' })` returns exactly `{ repoId: 'r1', feature: 'add-auth', title: 'Auth spec', maxCostUsd: 5, backend: { kind: 'native', model: 'm1' } }`.
5. [unit] `toCreateThreadBody` with `effort` `high` returns `backend` `{ kind: 'native', model: 'm1', effort: 'high' }`.
6. [unit] `toCreateThreadBody` with `baseRef` `develop` returns `baseRef` `develop`.
7. [unit] `eligibleModels` over runners `[{ online: true, enabled: true, threadBackends: { native: ['m2', 'm1'], acp: [] } }, { online: true, enabled: true, threadBackends: { native: ['m1'], acp: [] } }]` returns `['m1', 'm2']`.
8. [unit] `eligibleModels` over one runner with `online` false and `threadBackends.native` `['m3']` returns `[]`.
9. [unit] Mounting `BackendPicker` with `models` `['m1']` renders an effort select whose options are default, `low`, `medium`, `high` and `xhigh`.
10. [unit] Mounting `BackendPicker` with `models` `[]` shows `fleet.threads.new.noBackend`.
11. [unit] The new thread page keeps its submit button disabled when no runner offers a model.
12. [unit] Submitting the new thread page with valid values posts `toCreateThreadBody(values)` to `/projects/web/threads`.
13. [unit] After the create post resolves a thread with id `th9`, the new thread page navigates to `/web/threads/th9`.
14. [unit] When the create post rejects with an `ApiError`, the new thread page shows `extractApiError(error)`.
15. [unit] The new thread page lists an enabled project skill `spec-review` with the first 7 characters of its `source.resolvedSha`.

### US-006: Thread page: header and timeline (`Workdir: apps/web`)

1. [unit] Mounting `ThreadMessage` with an assistant message whose content is `**bold**` renders a `strong` element with text `bold`.
2. [unit] Mounting `ThreadMessage` with an assistant message whose content is `<img src=x onerror=alert(1)>` renders no element with an `onerror` attribute.
3. [unit] Mounting `ThreadMessage` with a user message whose content is `<b>hi</b>` renders the literal text `<b>hi</b>` and no `b` element.
4. [unit] Mounting `ThreadMessage` with an `errored` message whose `errorReason` is `<i>crashed</i>` renders the literal text `<i>crashed</i>` and no `i` element.
5. [unit] Mounting `ThreadMessage` with a `streaming` assistant message shows the streaming indicator.
6. [unit] Mounting `ThreadToolChip` with `{ name: 'search_repo', isError: true, decidedBy: 'profile' }` shows the `fleet.threads.tool.denied` label.
7. [unit] Clicking a collapsed `ThreadToolChip` whose `preview` is `<b>x</b>` shows the literal text `<b>x</b>`.
8. [unit] Mounting `ThreadTimeline` with a thread whose `session.contextReset` is true shows the `fleet.threads.detail.contextReset` marker.
9. [unit] Mounting `ThreadTimeline` with a thread whose `pendingQuestion` is `{ requestId: 'q1', text: 'Which DB?', expiresAt: '2026-10-12T10:00:00Z' }` shows the text `Which DB?`.
10. [unit] Mounting `ThreadHeader` with `t` (`runnerId` `r1`) and runner summaries `[{ id: 'r1', name: 'wk-mac', online: true }]` shows `wk-mac` with the `fleet.common.online` label.
11. [unit] Mounting `ThreadHeader` with `t` shows the cost text `$0 / $5`.
12. [unit] Mounting `ThreadMessage` with an assistant message whose content is `![x](https://evil.example/a.png)` renders no `img` element.
13. [unit] Mounting `ThreadHeader` with `t` whose `skills` are `[{ sourceId: 's1', owner: 'o', repo: 'r', sha: 'abc', skills: [{ name: 'spec-review', dir: 'skills/spec-review', description: '' }, { name: 'spec-writing', dir: 'skills/spec-writing', description: '' }] }]` shows both skill names.
14. [unit] The thread page with a stubbed `useThread` holding `t` and one assistant message `Hi there` renders `ThreadHeader` with the title `Auth spec` and `ThreadTimeline` with the text `Hi there`.
15. [unit] The thread page sets the document title to `• Auth spec` while a held message is `streaming`.

### US-007: Composer, session controls and the E2E journey (`Workdir: apps/web`)

1. [unit] Mounting `ThreadComposer` for the creator and pressing Enter in a textarea holding `hello` emits `send` with `hello`.
2. [unit] Mounting `ThreadComposer` for the creator and pressing Shift+Enter emits no `send`.
3. [unit] Mounting `ThreadComposer` for the creator and pressing Enter in a whitespace-only textarea emits no `send`.
4. [unit] Mounting `ThreadComposer` with `composerState` `{ canSend: false, reason: 'closing' }` shows the `fleet.threads.refusal.closing` text.
5. [unit] The thread page for the creator with a stubbed `useThread`, when `ThreadControls` emits `endSession`, calls `useThread().endSession` once.
6. [unit] Mounting `ThreadComposer` for a non-creator (`reason` `readOnly`) shows `fleet.threads.composer.readOnly` and renders no textarea.
7. [unit] Mounting `ThreadComposer` with `turnRunning` true and clicking Stop emits `stop`.
8. [unit] Mounting `ThreadControls` for the creator with `sessionLabel` `'live'` and clicking End session emits `endSession`.
9. [unit] Mounting `ThreadControls` for a viewer who is neither the creator nor a project manager renders no End session, Raise cap or Archive control.
10. [unit] Mounting `ThreadControls` for a project manager (`canManage` true) who is not the creator shows Archive.
11. [unit] In `ThreadControls`, confirming the Raise cap dialog with `8` emits `raiseCap` with the number 8.
12. [unit] The thread page for the creator with a stubbed `useThread`, typing `hello` in the `ThreadComposer` textarea and pressing Enter calls `useThread().send` with `hello`.
13. [unit] Mounting `ThreadQuestionCard` for the creator, typing `Postgres` and pressing Send emits `answer` with `('q1', 'Postgres')`.
14. [unit] Mounting `ThreadQuestionCard` for a non-creator renders no answer input.
15. [unit] The thread page shows a toast with `extractApiError(error)` when `useThread().send` resolves `{ ok: false, error }`.
