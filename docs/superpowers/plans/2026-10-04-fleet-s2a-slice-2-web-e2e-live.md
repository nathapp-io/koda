# Fleet S2a Slice 2 — Log Viewer, E2E and Live Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project member reads a job's complete run log, stdout and stderr in the web, live while the job runs and
afterwards, filtered server-side by level, story, stage, role and text. The job page links the logs and shows when
retention removed the bundle. Two Playwright journeys and an unbilled live check, with a real daemon process and two
SIGKILLs, prove the whole path. Slice 2 also folds in the two runner hardening minors deferred from #200.

**Architecture:** The web has no generated client, so the 1c read routes get hand-written types (`lib/fleet-log-types.ts`)
and a thin composable (`useFleetJobLogs`). The viewer logic sits in three framework-free modules:
- `fleet-log-query`: the URL query, filters and the entries query.
- `fleet-log-view`: rows, cursors, eviction at 5,000 rows, notices and row rendering data.
- `fleet-log-viewer`: one request at a time, growth notices coalesced, 429 backoff and 410.

The page `pages/[project]/fleet/jobs/[id]/logs.vue` only binds them to refs, the route and `fleet_log` live events.
This forces the job page to move from `[id].vue` to `[id]/index.vue`. The E2E uses a protocol v3 scripted runner that
calls the real upload route and uploads a real tar.gz. The live check runs `koda-runner run` as its own process
against the runner integration harness (built API, fake forge, fake nax).

**Tech Stack:** Nuxt 3 + Vue 3 + Tailwind/shadcn (web), Jest + the `mountSfc` harness (web unit), Playwright (E2E),
Bun + `bun:test` (runner), `tar-stream` 3 (E2E fixture, already an API dependency).

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md`: §4 (web), §8 (slice 2 tests: web unit, E2E
(1)(2), live check), §9 slice 2, success criteria 1-6. Rulings L1, L7, R9, R12, R14. Slices 1a (#199), 1b (#200) and
1c (#201) are merged on `main` (`4e7bb7bf`): the upload route, the runner `LogShipper`, the read routes
(`GET /projects/:slug/fleet/jobs/:id/logs`, `.../logs/:stream/entries`, `.../logs/:stream/raw`), retention and
`fleet_log` live events all exist. Slice 2 changes no API code.

## Global Constraints

- Streams are exactly `run | stdout | stderr`. Levels in order are `debug < info < warn < error`. Entries `limit` max is
  `500`. The API caps `storyId`/`stage`/`role` at 128 characters and `q` at 256.
- Spec §4.1: at most **5,000 rows** in the DOM. "Load earlier" (backward) and "Load more" (forward) evict from the
  other end.
- Spec §4.1 / criterion 3: a filtered page that returns no entries and is not `atEnd` shows "Searched up to {scannedTo}
  of {size} — Keep searching". The viewer **never auto-loops past one request per click**.
- Spec §4.1: on a 429, back off **2 s, 4 s, 8 s** and show a quiet "Rate limited, retrying".
- Spec §4.1: filters live in the URL query; a change resets the cursor.
- Spec §4.1: follow mode is on by default while the job runs. Scrolling up turns it off; "Jump to latest" turns it on.
- Spec §4.1: download is a plain anchor to the proxied `raw?download=1` URL. Never use `$api.download`, which buffers a
  Blob.
- Spec §4.1: every label and notice lives in `apps/web/i18n/locales/{en,zh}.json`, kept in parity.
- Fleet messages must not contain `|` or `@`. They are vue-i18n plural/linked syntax, and
  `tests/i18n/fleet-locale-parity.spec.ts` rejects them.
- Log text is untrusted: render it only through `{{ }}` interpolation, never `v-html` (the "escape all log text" carry
  from #201).
- Release gate D320 (from 1b): no runner release that contains 1b until 1c **and this slice** are deployed. Deploy
  order is API first, then the web.
- Web tests: `cd apps/web && bunx jest <paths>` (the whole suite: `bun run test`), `bun run lint`,
  `bun run type-check`. Runner tests: `cd apps/runner && bun test <paths>`, the unit suite `bun run test`, lint
  `bun run lint`, types `bunx tsc --noEmit -p .`. Never run a bare `bun test` at the repo root.
- E2E and the live check reset a local test database (`prisma migrate reset --force` on `koda_e2e` and
  `koda_runner_test`, both on the docker test Postgres at :5433). Prisma refuses that from an AI agent without the
  user's consent. **Ask the user first.** Run with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact
  consent message>"`.
- No emojis in source. No `console.log` in `apps/web` source. Build new objects and arrays; local accumulators inside
  one function are the only mutation, as the snippets show.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D350 (slice 1c ended at D349).

| # | Decision | Why |
|:--|:--|:--|
| D350 | Runner (#200 deferred minor): a 2xx ack whose `size` is **below `entry.acked`** marks the stream `diverged` (lifecycle warn, bundle fills it). It never rewinds `acked`. | The server's stream only grows (slice 1a). A smaller size is a server fault, and rewinding would re-send bytes the server already holds. |
| D351 | Runner (#200 deferred minor): a `final=1` PUT answered `appended`/`duplicate`/`offset` with `size >= sentFrom + sentBytes` (every byte held, `complete` not given) sets `acked = size` and **backs off**. It never re-sends final at once. The drain deadline bounds it. | A non-conforming server would otherwise hot-loop the final PUT. |
| D352 | `pages/[project]/fleet/jobs/[id].vue` moves to `pages/[project]/fleet/jobs/[id]/index.vue`. The viewer is `[id]/logs.vue`. | In Nuxt, a sibling `[id].vue` becomes the **parent** route of `[id]/logs.vue` and would need a `<NuxtPage>`. URLs do not change. |
| D353 | The web's log DTOs are hand-written in a new `lib/fleet-log-types.ts`, mirroring `apps/api/src/fleet/logs/dto/fleet-job-log.dto.ts`. `lib/fleet-types.ts` (397 lines) is left alone. | `.nax/mono/apps/web/context.md`: the web uses no generated client. Many small files. |
| D354 | Viewer logic is three framework-free modules: `fleet-log-query` (URL and API query), `fleet-log-view` (pure state and rendering data) and `fleet-log-viewer` (the async controller). The page is binding only. | The cursor, follow and backoff rules are the risky part. Pure functions and an injected `fetchPage`/`sleep` make each one testable without a DOM. |
| D355 | A viewer is bound to one (stream, attempt, filters). `activeEpoch` is fixed when the viewer starts and is sent on every request. A requeue never switches the open viewer: the list reload adds the new attempt to the picker. A `fleet_log` for another attempt or stream never fetches. | Spec §4.1 "attempt picker (default latest)". A silent switch mid-read would interleave two attempts' rows. |
| D356 | Follow is on at open when `isActiveJobState(job.state)` (QUEUED through UPLOADING), not only RUNNING. A follow fetch reads forward from the tail with `limit=500` and chains while the page is not `atEnd`. Exception (criterion 3): a **filtered** page with no entries stops the chain and offers Keep searching. A `fleet_log` that arrives during a request is coalesced into **one** follow-up fetch. | The runner's drain uploads during UPLOADING too. Chaining catches up a burst without a request per event. The filtered stop keeps a rare filter from scanning 128 windows unasked. |
| D357 | The job page's bundle button reads "Bundle expired" (disabled) when the **latest attempt** in the log list has an expired stream (retention removes an attempt's logs and bundle together, spec §5), or once a download answered 410. No API change (`FleetJobDto` stays). | Spec §4.2 asks for "Expired"; the list route already carries `expired`. A v1/v2 job learns it from the 410. |
| D358 | **Spec corrections (§4.1 notices):** the expired notice reads "This log was deleted after the retention window" (no `{days}`; the web cannot read `FLEET_LOG_RETENTION_DAYS`). The truncated notice shows the stored size ("Truncated at {size}") instead of a fixed "256 MiB" (`FLEET_LOG_MAX_BYTES` is configurable). | Both values live only in API config; the API's own 410 message has the same wording. |
| D359 | Text filters apply on `change` (Enter or blur), not per keystroke; the level applies on select. Values from the URL are trimmed and cut to the API limits (128/256). An unknown stream or level, or an epoch that is not a whole number, falls back to the default. | Each filter change reopens the viewer (one request). A hand-edited URL must never put the page into a 400 loop. |
| D360 | The live check is `apps/runner/test/live/log-shipping.live.spec.ts`, gated on `KODA_DB_TESTS=1 KODA_LOG_LIVE=1`. It reuses the integration `World` (built API, fake forge, git front) and runs `bun src/main.ts --home <home> run`: the real CLI entry, as its own OS process. The fake nax gains `FAKE_NAX_PACE_MS` (sleep plus heartbeat between 64 KiB batches) and `FAKE_NAX_STDIO_BYTES` (stdout and stderr written alongside, through fd 1/2). `World` exposes `adminToken`; the harness exports `HARNESS_ADMIN`; `FEATURES` gains `lv`. The finish-path crash may end the job ESCALATED ("push failed": nax pushed while no daemon served its git socket), as the integration finish-path test already accepts. | Spec §8 live check: "real koda-runner … stub nax … kill and restart mid-run, and once more after the stub exits". The compiled binary is the same code; the spec's "viewer filters work" is checked on the entries route the viewer calls. `KODA_LOG_LIVE_KEEP=1` leaves the stack up for a manual look in the browser. |
| D361 | E2E fixture: `ScriptedRunner.enroll(token, name, { logs: true })` speaks protocol 3; `putLog(lease, stream, offset, text, final?)` calls the real upload route with `X-Content-SHA256`; `uploadTarBundle(lease, members)` builds a real tar.gz with `tar-stream` (`apps/web` devDependency `^3.2.2`, the API's version). | Spec §8: "a v3 enroll option, `putLog`, and a real tar.gz bundle writer (`tar-stream` in the fixture)". |
| D362 | `FleetJobTimeline` gains optional `logAttempts`/`logsHref` props (defaults keep other callers unchanged). It renders one "Full log of attempt N" link per attempt that has stored streams; this includes a v1/v2 attempt the bundle fallback filled. The section gets `id="timeline"`, the anchor the legacy notice links to. | Spec §4.2. A bundle-filled v1/v2 attempt has a full log, so it is linked too. |
| D363 | The job page loads the log list as secondary data (a failure is silent; the header "Logs" link still works) and on every live reload. A `fleet_log` for an attempt it has not listed triggers its debounced live reload; growth of a known attempt does not. | `fleet_log` arrives up to once a second per stream. Reloading the job page on each would be a request storm. |
| D364 | 429 is recognised as `ApiError.code === 429`: `ThrottleAppException` sends `ret: 429`, and `useApi` turns the envelope into `ApiError(ret)`. The controller duck-types `code` (else `status`), so `lib/` never imports a composable. 410 (`FleetLogExpiredException`, `ret: 410`) is matched the same way. | Verified in `@nathapp/nestjs-common` `throttle-app.exception.js` and `apps/api/src/fleet/logs/log-read.exceptions.ts`. |

## Review Focus

1. **A burst of `fleet_log` events while a follow fetch is in flight.** Exactly one follow-up fetch from the new tail.
   Never two requests with the same cursor, never a lost tail. Pinned in Task 5 ("coalesced into exactly one follow-up
   fetch") and Task 7 (page: events for other jobs, streams and attempts never fetch).
2. **Following a filtered view of a large, growing log.** The viewer must not scan the whole log unasked. A filtered
   empty page that is not at the end stops the chain and shows Keep searching; each click is one request. Pinned in
   Task 5 and Task 7.
3. **Hostile or odd log content** (markup, very long lines, cut fragments, lines that are not JSON). Everything
   renders as text, a cut line is labelled, and `data` is shown as indented JSON. Pinned in Task 6 (the `<img onerror>`
   test) and Task 4 (row helpers).
4. **A hand-edited or stale URL** (unknown stream, `level=trace`, `epoch=-1`, 300-character story). The page opens with
   defaults and the request never answers 400. Pinned in Task 3.
5. **A requeue while the viewer is open.** The viewer stays on its attempt, the new attempt appears in the picker, and
   only that attempt's own events drive its fetches. Pinned in Task 7 ("a fleet_log for this job, attempt and stream
   fetches …; others are ignored") and Task 3 (the epoch is always sent once known).

## File Map

**apps/runner**
- Modify `src/logs/log-shipper.ts` (`apply`), `src/logs/log-shipper.spec.ts` (Task 1).
- Modify `test/fixtures/fake-nax.ts`, `test/integration/harness/world.ts`, `test/integration/harness/index.ts`.
  Create `test/live/log-shipping.live.spec.ts` (Task 10).

**apps/web**
- Create `lib/fleet-log-types.ts`, `composables/useFleetJobLogs.ts` (Task 2); `lib/fleet-log-query.ts` (Task 3);
  `lib/fleet-log-view.ts` (Task 4); `lib/fleet-log-viewer.ts` (Task 5); `components/fleet/FleetLogRows.vue`,
  `components/fleet/FleetLogFilters.vue`, `components/fleet/FleetLogNotices.vue` (Task 6);
  `pages/[project]/fleet/jobs/[id]/logs.vue` (Task 7); `lib/fleet-job-logs-link.ts` (Task 8);
  `tests/e2e/fleet-logs.e2e.spec.ts` (Task 9).
- Move `pages/[project]/fleet/jobs/[id].vue` to `pages/[project]/fleet/jobs/[id]/index.vue` (Task 7), then modify it
  (Task 8).
- Modify `lib/project-event-stream.ts`, `lib/project-event-hub.ts` (Task 2); `i18n/locales/{en,zh}.json` (Task 6);
  `components/fleet/FleetJobTimeline.vue` (Task 8); `tests/e2e/fixtures/scripted-runner.ts`, `package.json` (Task 9).
- Tests: create `tests/composables/useFleetJobLogs.spec.ts`, `tests/lib/fleet-log-query.spec.ts`,
  `tests/lib/fleet-log-view.spec.ts`, `tests/lib/fleet-log-viewer.spec.ts`,
  `tests/components/fleet-log-components.spec.ts`, `tests/pages/fleet-job-logs-page.spec.ts`,
  `tests/lib/fleet-job-logs-link.spec.ts`, `tests/components/fleet-job-timeline-logs.spec.ts`. Modify
  `tests/lib/project-event-stream-fleet.spec.ts`, `tests/lib/project-event-hub.spec.ts`,
  `tests/i18n/fleet-locale-parity.spec.ts`, `tests/helpers/mount-sfc.ts`, `tests/pages/fleet-job-detail.spec.ts`,
  `tests/pages/fleet-budget-banner-placement.spec.ts`.

**repo root:** `bun.lock` (one line), `docs/deployment/runner.md`, `.nax/mono/apps/{runner,web}/context.md` and their
generated `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`codex.md` (Task 11).

---

### Task 1: Runner shipper hardening: no rewind, no final hot loop (D350, D351)

**Files:**
- Modify: `apps/runner/src/logs/log-shipper.ts` (`apply`, the `case 'ack':` branch)
- Test: `apps/runner/src/logs/log-shipper.spec.ts`

**Interfaces:**
- Consumes: `LogShipper` (slice 1b). The spec's `setup()`, `job()`, `fakeLogServer` overrides (`t.server.overrides`),
  `t.notes` and `t.clock` helpers already sit at the top of the spec.
- Produces: no new names. Behaviour only: lifecycle `warn` "…holds less of the <stream> log than it acked before…",
  and a backoff after a final PUT that the server acks without `complete`.

- [ ] **Step 1: Write the failing tests**

In `log-shipper.spec.ts`, inside `describe('the answer table (spec §2.4, plan D323)', …)`, insert this test directly
**before** `test('offset or duplicate with a size above the local file: diverged, lifecycle warn, no further PUT (R6)', …)`:

```ts
  test('an ack below what the server already acked is diverged, never a rewind (S2a slice 2 D350)', async () => {
    const t = setup();
    const j = await job('rewind');
    await writeFile(j.sources.stdoutPath, 'a\nb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\n');
    t.server.overrides.push({ status: 200, outcome: 'appended', size: 1 });
    await appendFile(j.sources.stdoutPath, 'c\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0]).toMatchObject({ level: 'warn' });
    expect(t.notes[0].message).toContain('less of the stdout log');
    await appendFile(j.sources.stdoutPath, 'd\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls.filter((c) => c.stream === 'stdout').map((c) => c.offset)).toEqual([0, 4]);
  });
```

Inside `describe('drain, stop and close (spec §2.4 R5)', …)`, insert this test directly **before**
`test('drain during an in-flight PUT: final goes only after that window is acked and the rest is read (Review focus 1)', …)`:

```ts
  test('a final PUT answered with a plain ack backs off instead of re-sending final at once (S2a slice 2 D351)', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('final-ack');
    await writeFile(j.sources.stdoutPath, 'a\n');                   // only stdout exists: the override is its final PUT
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'duplicate', size: 2 });
    const drained = t.shipper.drain('j1', 1, 120_000);
    await waitFor(() => t.server.calls.some((c) => c.stream === 'stdout' && c.final));
    await Bun.sleep(30);
    expect(t.server.calls.filter((c) => c.stream === 'stdout' && c.final)).toHaveLength(1);
    t.clock.advance(500);
    expect(await drained).toBe('drained');
    expect(t.server.isComplete('j1:1:stdout')).toBe(true);
    expect(t.server.calls.filter((c) => c.stream === 'stdout' && c.final)).toHaveLength(2);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/logs/log-shipper.spec.ts`
Expected: 2 fail. The rewind test times out in `waitFor` (no lifecycle note: the old code rewinds `acked` to 1 and
re-sends). The final test sees 2 final PUTs before the clock advances (the old code re-sends at once).

- [ ] **Step 3: Implement**

In `log-shipper.ts`, `apply()`, `case 'ack':`. Keep the existing `action.size > sent.fileSize` divergence check
first. Add the rewind check before the "no progress" backoff, and the final check after it:

```ts
      case 'ack':
        if (action.size > sent.fileSize) {
          this.diverge(entry, `the server holds more of the ${entry.stream} log than the file (${action.size} > ${sent.fileSize} bytes); the bundle fills it`);
          return;
        }
        if (action.size < entry.acked) {
          // S2a slice 2 D350: the server's stream only grows; a smaller size is a server fault, never a rewind.
          this.diverge(entry, `the server holds less of the ${entry.stream} log than it acked before (${action.size} < ${entry.acked} bytes); the bundle fills it`);
          return;
        }
        if (action.size <= sent.sentFrom && sent.sentBytes > 0 && !sent.final && action.size === entry.acked) {
          this.backoff(entry, `no progress: the server answered size ${action.size} for bytes at ${sent.sentFrom}`);
          return;
        }
        if (sent.final && action.size >= sent.sentFrom + sent.sentBytes) {
          // S2a slice 2 D351: every byte is held but final was not accepted; re-sending at once would hot-loop.
          entry.acked = action.size;
          this.backoff(entry, `final was not accepted: the server answered size ${action.size} without complete`);
          return;
        }
        entry.acked = action.size;
        entry.failures = 0;
        entry.dirty = true;
        return;
```

- [ ] **Step 4: Run the shipper tests and the runner suite**

Run: `cd apps/runner && bun test src/logs/ && bun run test && bun run lint && bunx tsc --noEmit -p .`
Expected: PASS (`src/logs/` 41 pass; the whole unit suite green; lint and types clean).

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/logs/log-shipper.ts apps/runner/src/logs/log-shipper.spec.ts
git commit -m "fix(runner): log shipper never rewinds and never hot-loops a final PUT (S2a D350, D351)"
```

---

### Task 2: Web log types, `useFleetJobLogs`, and the `fleet_log` live event

**Files:**
- Create: `apps/web/lib/fleet-log-types.ts`, `apps/web/composables/useFleetJobLogs.ts`
- Modify: `apps/web/lib/project-event-stream.ts`, `apps/web/lib/project-event-hub.ts`
- Test: `apps/web/tests/composables/useFleetJobLogs.spec.ts` (create),
  `apps/web/tests/lib/project-event-stream-fleet.spec.ts`, `apps/web/tests/lib/project-event-hub.spec.ts`

**Interfaces:**
- Consumes: `apiPath` (`~/lib/api-path`), `useApi().$api.get`, `useRuntimeConfig().public.apiBaseUrl` (`'/api'`).
  The API's `fleet_log` event (`apps/api/src/live/live-event.ts`, `LiveFleetLogEvent`) is sent as the SSE event name
  `fleet_log`.
- Produces:
  - `LOG_STREAMS`, `LogStream`, `LOG_LEVELS`, `LogLevel`, `isLogStream(v)`, `isLogLevel(v)`,
    `FleetJobLogStreamDto`, `FleetJobLogAttemptDto`, `FleetJobLogListDto`, `FleetJobLogEntryDto` and
    `FleetJobLogEntriesDto` (`~/lib/fleet-log-types`).
  - `useFleetJobLogs(slug, jobId)`, which returns `{ list(): Promise<FleetJobLogListDto>, entries(stream, query: Record<string,string>):
    Promise<FleetJobLogEntriesDto>, downloadHref(stream, leaseEpoch): string }`.
  - `LiveFleetLogEvent`, `parseFleetLogEvent(raw)` and `ProjectEventHandlers.onFleetLog?` (`~/lib/project-event-stream`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/composables/useFleetJobLogs.spec.ts`:

```ts
import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { join } from 'path'

const composablePath = join(__dirname, '../..', 'composables', 'useFleetJobLogs.ts')
const g = globalThis as Record<string, unknown>

describe('useFleetJobLogs (S2a §3)', () => {
  beforeEach(() => {
    g.useRuntimeConfig = () => ({ public: { apiBaseUrl: '/api' } })
  })

  test('list and entries call the read routes with encoded segments and the given query', async () => {
    const get = jest.fn(async () => ({}))
    g.useApi = () => ({ $api: { get } })
    const { useFleetJobLogs } = await import(composablePath)
    const logs = useFleetJobLogs('my proj', 'j/1')

    await logs.list()
    await logs.entries('stdout', { direction: 'backward', limit: '200' })

    expect(get).toHaveBeenNthCalledWith(1, '/projects/my%20proj/fleet/jobs/j%2F1/logs')
    expect(get).toHaveBeenNthCalledWith(2, '/projects/my%20proj/fleet/jobs/j%2F1/logs/stdout/entries', { query: { direction: 'backward', limit: '200' } })
  })

  test('downloadHref is a proxied raw download URL for one attempt', async () => {
    g.useApi = () => ({ $api: { get: jest.fn() } })
    const { useFleetJobLogs } = await import(composablePath)
    expect(useFleetJobLogs('web', 'j1').downloadHref('run', 2))
      .toBe('/api/projects/web/fleet/jobs/j1/logs/run/raw?download=1&leaseEpoch=2')
  })
})
```

In `apps/web/tests/lib/project-event-stream-fleet.spec.ts`, add `parseFleetLogEvent,` after `parseFleetJobEvent,` and
`type LiveFleetLogEvent,` after `type LiveFleetJobEvent,` in the import list. Append at the end of the file:

```ts
const logEvent = (id: string, over: Partial<LiveFleetLogEvent> = {}): LiveFleetLogEvent => ({
  id, type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 120, complete: false, at: '2026-10-04T00:00:00.000Z', ...over,
})

describe('fleet_log notices (S2a §2.3)', () => {
  test('parses a notice for each stream', () => {
    for (const stream of ['run', 'stdout', 'stderr'] as const) {
      expect(parseFleetLogEvent(JSON.stringify(logEvent('e1', { stream })))).toEqual(logEvent('e1', { stream }))
    }
    expect(parseFleetLogEvent(JSON.stringify(logEvent('e1', { complete: true, size: 0, leaseEpoch: 0 })))).toBeTruthy()
  })

  test.each([
    ['not JSON', 'not json'],
    ['another type', JSON.stringify({ ...logEvent('e1'), type: 'fleet_job' })],
    ['an unknown stream', JSON.stringify({ ...logEvent('e1'), stream: 'plan' })],
    ['a negative size', JSON.stringify({ ...logEvent('e1'), size: -1 })],
    ['a fractional epoch', JSON.stringify({ ...logEvent('e1'), leaseEpoch: 1.5 })],
    ['a string complete', JSON.stringify({ ...logEvent('e1'), complete: 'true' })],
    ['a missing job id', JSON.stringify({ ...logEvent('e1'), jobId: undefined })],
  ])('rejects %s', (_label, raw) => {
    expect(parseFleetLogEvent(raw)).toBeNull()
  })

  test('delivers fleet_log events once each, only when a handler is given', () => {
    const onFleetLog = jest.fn()
    const source = open({ onFleetLog, onResync: () => undefined })
    source.emit('fleet_log', logEvent('e1'))
    source.emit('fleet_log', logEvent('e1'))
    source.emit('fleet_log', logEvent('e2', { size: 240 }))
    expect(onFleetLog.mock.calls.map(([e]) => (e as LiveFleetLogEvent).size)).toEqual([120, 240])

    const silent = open({ onResync: () => undefined })
    expect(silent.listenerTypes()).not.toContain('fleet_log')
  })
})
```

In `apps/web/tests/lib/project-event-hub.spec.ts`, insert before `test('a resync reaches every subscriber', …)`:

```ts
  test('fleet_log reaches only the subscribers that handle it (S2a §4.2)', () => {
    const { h, sources } = hub()
    const viewer = { onFleetLog: jest.fn(), onResync: jest.fn() }
    const badge = { onFleetApproval: jest.fn(), onResync: jest.fn() }
    h.subscribe('/u', viewer)
    h.subscribe('/u', badge)
    sources[0].emit('fleet_log', { id: 'e3', type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'stdout', size: 5, complete: false, at: 'x' })
    expect(viewer.onFleetLog).toHaveBeenCalledTimes(1)
    expect(badge.onFleetApproval).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/composables/useFleetJobLogs.spec.ts tests/lib/project-event-stream-fleet.spec.ts tests/lib/project-event-hub.spec.ts`
Expected: FAIL. The composable cannot be found, `parseFleetLogEvent` is not exported, and the hub test's
`onFleetLog` is never called.

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-log-types.ts`:

```ts
/** Fleet S2a (spec §3): the log read routes' shapes, mirrored from apps/api `fleet-job-log.dto.ts`. */
export const LOG_STREAMS = ['run', 'stdout', 'stderr'] as const
export type LogStream = typeof LOG_STREAMS[number]

/** Minimum-level order, lowest first (spec §3.3). */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]

export const isLogStream = (value: unknown): value is LogStream => (LOG_STREAMS as readonly unknown[]).includes(value)
export const isLogLevel = (value: unknown): value is LogLevel => (LOG_LEVELS as readonly unknown[]).includes(value)

export interface FleetJobLogStreamDto {
  stream: LogStream
  sizeBytes: number
  complete: boolean
  truncated: boolean
  source: 'stream' | 'bundle'
  expired: boolean
  updatedAt: string
}

export interface FleetJobLogAttemptDto {
  leaseEpoch: number
  legacySampled: boolean
  streams: FleetJobLogStreamDto[]
}

export interface FleetJobLogListDto {
  /** Latest attempt first. */
  attempts: FleetJobLogAttemptDto[]
}

/** A parsed nax LogEntry, an unparsed run line, or a stdout/stderr line (1c D339). */
export interface FleetJobLogEntryDto {
  offset: number
  length: number
  unparsed?: boolean
  truncatedLine?: boolean
  text?: string
  timestamp?: string
  level?: string
  stage?: string
  storyId?: string
  sessionRole?: string
  message?: string
  data?: unknown
}

export interface FleetJobLogEntriesDto {
  /** Ascending by offset in both directions. */
  entries: FleetJobLogEntryDto[]
  nextCursor: number
  scannedFrom: number
  scannedTo: number
  atEnd: boolean
  size: number
  complete: boolean
  truncated: boolean
}
```

Create `apps/web/composables/useFleetJobLogs.ts`:

```ts
import { apiPath } from '~/lib/api-path'
import type { FleetJobLogEntriesDto, FleetJobLogListDto, LogStream } from '~/lib/fleet-log-types'

/** Fleet S2a §3: the log read routes of one job. Every call goes through useApi; nothing here holds page state. */
export function useFleetJobLogs(slug: string, jobId: string) {
  const { $api } = useApi()
  const config = useRuntimeConfig()
  const base = apiPath`/projects/${slug}/fleet/jobs/${jobId}/logs`

  const list = (): Promise<FleetJobLogListDto> => $api.get<FleetJobLogListDto>(base)

  const entries = (stream: LogStream, query: Record<string, string>): Promise<FleetJobLogEntriesDto> =>
    $api.get<FleetJobLogEntriesDto>(`${base}${apiPath`/${stream}/entries`}`, { query })

  /** Spec §4.1: a plain anchor through the Nuxt /api proxy, which streams; never $api.download (it buffers a Blob). */
  const downloadHref = (stream: LogStream, leaseEpoch: number): string =>
    `${String(config.public.apiBaseUrl)}${base}${apiPath`/${stream}/raw`}?download=1&leaseEpoch=${leaseEpoch}`

  return { list, entries, downloadHref }
}
```

In `apps/web/lib/project-event-stream.ts`, make three changes. First, add after `LiveFleetApprovalEvent` and extend
the handlers:

```ts
/** S2a §2.3: content-free log growth of one stream of one attempt; the viewer fetches from its cursor. */
export interface LiveFleetLogEvent {
  id: string
  type: 'fleet_log'
  projectId: string
  jobId: string
  leaseEpoch: number
  stream: 'run' | 'stdout' | 'stderr'
  size: number
  complete: boolean
  at: string
}

/** All event handlers except the resync are optional; a page subscribes to what it shows. */
export interface ProjectEventHandlers {
  onEvent?: (event: LiveTicketEvent) => void
  onFleetJob?: (event: LiveFleetJobEvent) => void
  onFleetApproval?: (event: LiveFleetApprovalEvent) => void
  onFleetLog?: (event: LiveFleetLogEvent) => void
  onResync: () => void
}
```

Second, add the parser directly before `export function createProjectEventStream(`:

```ts
const FLEET_LOG_STREAMS: readonly string[] = ['run', 'stdout', 'stderr']
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function parseFleetLogEvent(raw: string): LiveFleetLogEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<LiveFleetLogEvent> | null
    if (!value || typeof value !== 'object') return null
    if (value.type !== 'fleet_log' || typeof value.id !== 'string' || typeof value.jobId !== 'string') return null
    if (!isCount(value.leaseEpoch) || !isCount(value.size) || typeof value.complete !== 'boolean') return null
    if (!FLEET_LOG_STREAMS.includes(value.stream as string)) return null
    return value as LiveFleetLogEvent
  }
  catch {
    return null
  }
}
```

Third, in `open()`, add after the `fleet_approval` listener block and before `es.onerror = () => {`:

```ts
    const onFleetLog = handlers.onFleetLog
    if (onFleetLog) {
      es.addEventListener('fleet_log', (ev) => {
        const event = parseFleetLogEvent(ev.data)
        if (event && isNew(event.id)) onFleetLog(event)
      })
    }
```

In `apps/web/lib/project-event-hub.ts`, add to `fanOut` after the `onFleetApproval` line:

```ts
    onFleetLog: (event) => { for (const e of current(url)) e.handlers.onFleetLog?.(event) },
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && bunx jest tests/composables/useFleetJobLogs.spec.ts tests/lib/project-event-stream-fleet.spec.ts tests/lib/project-event-hub.spec.ts tests/lib/project-event-stream.spec.ts`
Expected: PASS (49 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-log-types.ts apps/web/composables/useFleetJobLogs.ts apps/web/lib/project-event-stream.ts \
  apps/web/lib/project-event-hub.ts apps/web/tests/composables/useFleetJobLogs.spec.ts \
  apps/web/tests/lib/project-event-stream-fleet.spec.ts apps/web/tests/lib/project-event-hub.spec.ts
git commit -m "feat(web): log read types, useFleetJobLogs and the fleet_log live event (S2a slice 2)"
```

---

### Task 3: Viewer URL, filters and the entries query (`fleet-log-query`)

**Files:**
- Create: `apps/web/lib/fleet-log-query.ts`
- Test: `apps/web/tests/lib/fleet-log-query.spec.ts` (create)

**Interfaces:**
- Consumes: `isLogLevel`, `isLogStream`, `LogLevel`, `LogStream` (Task 2).
- Produces:
  - `LogFilters { level: LogLevel | null; storyId; stage; role; q }`, where `''` means not set.
  - `LogViewParams { stream; epoch: number | null; filters }` and `EMPTY_LOG_FILTERS`.
  - `parseLogViewQuery(query)` and `logViewQuery(params): Record<string,string>`.
  - `effectiveFilters(stream, filters)` and `hasActiveFilter(stream, filters)`.
  - `EntriesPageRequest { direction; cursor?; limit }`.
  - `entriesQuery(params, epoch: number | null, page): Record<string,string>`.
  - URL keys: `stream`, `epoch`, `level`, `story`, `stage`, `role`, `q`. API keys: `direction`, `limit`, `cursor`,
    `leaseEpoch`, `level`, `storyId`, `stage`, `role`, `q`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-log-query.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import {
  EMPTY_LOG_FILTERS, entriesQuery, hasActiveFilter, logViewQuery, parseLogViewQuery, type LogViewParams,
} from '~/lib/fleet-log-query'

const params = (over: Partial<LogViewParams> = {}): LogViewParams => ({ stream: 'run', epoch: null, filters: EMPTY_LOG_FILTERS, ...over })

describe('parseLogViewQuery (spec §4.1 URL filters)', () => {
  test('an empty query is the run stream, latest attempt, no filters', () => {
    expect(parseLogViewQuery({})).toEqual(params())
  })

  test('reads every field, taking the first value of an array and trimming', () => {
    expect(parseLogViewQuery({ stream: 'stderr', epoch: '2', level: 'warn', story: [' US-001 ', 'US-002'], stage: 'run', role: 'implementer', q: ' Boom ' }))
      .toEqual(params({ stream: 'stderr', epoch: 2, filters: { level: 'warn', storyId: 'US-001', stage: 'run', role: 'implementer', q: 'Boom' } }))
  })

  test('unknown stream or level and a bad epoch fall back to defaults instead of failing', () => {
    expect(parseLogViewQuery({ stream: 'plan', level: 'trace', epoch: '-1' })).toEqual(params())
    expect(parseLogViewQuery({ epoch: '1.5' }).epoch).toBeNull()
    expect(parseLogViewQuery({ epoch: '9999999999' }).epoch).toBeNull()
    expect(parseLogViewQuery({ epoch: null }).epoch).toBeNull()
  })

  test('over-long values are cut to the API limits, so a hand-edited URL never answers 400', () => {
    const p = parseLogViewQuery({ story: 'x'.repeat(300), q: 'y'.repeat(300) })
    expect(p.filters.storyId).toHaveLength(128)
    expect(p.filters.q).toHaveLength(256)
  })
})

describe('logViewQuery', () => {
  test('round-trips through parseLogViewQuery, omitting defaults', () => {
    const p = params({ stream: 'stdout', epoch: 0, filters: { ...EMPTY_LOG_FILTERS, q: 'err' } })
    expect(logViewQuery(p)).toEqual({ stream: 'stdout', epoch: '0', q: 'err' })
    expect(parseLogViewQuery(logViewQuery(p))).toEqual(p)
    expect(logViewQuery(params())).toEqual({})
  })
})

describe('entriesQuery (spec §3.3)', () => {
  const run = params({ filters: { level: 'info', storyId: 'US-1', stage: 'verify', role: 'tester', q: 'x' } })

  test('the run stream sends every set filter, the epoch and the page', () => {
    expect(entriesQuery(run, 3, { direction: 'forward', cursor: 120, limit: 200 })).toEqual({
      direction: 'forward', limit: '200', cursor: '120', leaseEpoch: '3', level: 'info', storyId: 'US-1', stage: 'verify', role: 'tester', q: 'x',
    })
  })

  test('stdout/stderr send only q; no cursor and no epoch are omitted', () => {
    expect(entriesQuery({ ...run, stream: 'stderr' }, null, { direction: 'backward', limit: 200 }))
      .toEqual({ direction: 'backward', limit: '200', q: 'x' })
  })

  test('hasActiveFilter ignores run-only filters on stdout/stderr', () => {
    const levelOnly = { ...EMPTY_LOG_FILTERS, level: 'warn' as const }
    expect(hasActiveFilter('run', levelOnly)).toBe(true)
    expect(hasActiveFilter('stdout', levelOnly)).toBe(false)
    expect(hasActiveFilter('stdout', { ...EMPTY_LOG_FILTERS, q: 'a' })).toBe(true)
    expect(hasActiveFilter('run', EMPTY_LOG_FILTERS)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-query.spec.ts`
Expected: FAIL with "Cannot find module '~/lib/fleet-log-query'".

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-log-query.ts`:

```ts
import { isLogLevel, isLogStream, type LogLevel, type LogStream } from '~/lib/fleet-log-types'

/** Run-stream filters (spec §3.3); stdout/stderr use `q` only. An empty string is "not set". */
export interface LogFilters {
  level: LogLevel | null
  storyId: string
  stage: string
  role: string
  q: string
}

/** Everything the viewer URL carries (spec §4.1: filters live in the URL query). */
export interface LogViewParams {
  stream: LogStream
  /** null: the latest attempt (the list's first, else the job's current epoch). */
  epoch: number | null
  filters: LogFilters
}

export const EMPTY_LOG_FILTERS: LogFilters = { level: null, storyId: '', stage: '', role: '', q: '' }
/** The API caps these at 128 (story, stage, role) and 256 (q) characters (1c `LogEntriesQuery`). */
const MAX_FIELD = 128
const MAX_Q = 256

type QueryValue = string | null | undefined | ReadonlyArray<string | null>

/** A route query value: the first string of an array, trimmed; anything else is ''. */
function first(value: QueryValue): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

function epochOf(value: QueryValue): number | null {
  const raw = first(value)
  if (!/^\d{1,9}$/.test(raw)) return null
  return Number(raw)
}

/** Lenient: an unknown stream or level, or a bad epoch, falls back to the default instead of failing the page. */
export function parseLogViewQuery(query: Record<string, QueryValue>): LogViewParams {
  const stream = first(query.stream)
  const level = first(query.level)
  return {
    stream: isLogStream(stream) ? stream : 'run',
    epoch: epochOf(query.epoch),
    filters: {
      level: isLogLevel(level) ? level : null,
      storyId: first(query.story).slice(0, MAX_FIELD),
      stage: first(query.stage).slice(0, MAX_FIELD),
      role: first(query.role).slice(0, MAX_FIELD),
      q: first(query.q).slice(0, MAX_Q),
    },
  }
}

/** The URL query for the params: only set values; the default stream is omitted. */
export function logViewQuery(p: LogViewParams): Record<string, string> {
  const pairs: Array<[string, string]> = [
    ['stream', p.stream === 'run' ? '' : p.stream],
    ['epoch', p.epoch === null ? '' : String(p.epoch)],
    ['level', p.filters.level ?? ''],
    ['story', p.filters.storyId],
    ['stage', p.filters.stage],
    ['role', p.filters.role],
    ['q', p.filters.q],
  ]
  return Object.fromEntries(pairs.filter(([, value]) => value.length > 0))
}

/** stdout/stderr ignore the run-only filters (spec §3.3), so they never reach the API or count as active. */
export function effectiveFilters(stream: LogStream, filters: LogFilters): LogFilters {
  return stream === 'run' ? filters : { ...EMPTY_LOG_FILTERS, q: filters.q }
}

export function hasActiveFilter(stream: LogStream, filters: LogFilters): boolean {
  const f = effectiveFilters(stream, filters)
  return f.level !== null || f.storyId !== '' || f.stage !== '' || f.role !== '' || f.q !== ''
}

export interface EntriesPageRequest {
  direction: 'forward' | 'backward'
  /** Omitted: forward from 0, backward from the visible end. */
  cursor?: number
  limit: number
}

/** The entries route query (spec §3.3). The epoch is always sent once known, so a requeue never switches attempts. */
export function entriesQuery(p: LogViewParams, epoch: number | null, page: EntriesPageRequest): Record<string, string> {
  const f = effectiveFilters(p.stream, p.filters)
  const pairs: Array<[string, string]> = [
    ['direction', page.direction],
    ['limit', String(page.limit)],
    ['cursor', page.cursor === undefined ? '' : String(page.cursor)],
    ['leaseEpoch', epoch === null ? '' : String(epoch)],
    ['level', f.level ?? ''],
    ['storyId', f.storyId],
    ['stage', f.stage],
    ['role', f.role],
    ['q', f.q],
  ]
  return Object.fromEntries(pairs.filter(([, value]) => value.length > 0))
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-query.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-log-query.ts apps/web/tests/lib/fleet-log-query.spec.ts
git commit -m "feat(web): log viewer URL filters and entries query (S2a slice 2 D359)"
```

---

### Task 4: Viewer state, notices and row data (`fleet-log-view`)

**Files:**
- Create: `apps/web/lib/fleet-log-view.ts`
- Test: `apps/web/tests/lib/fleet-log-view.spec.ts` (create)

**Interfaces:**
- Consumes: `FleetJobLogEntriesDto`, `FleetJobLogEntryDto`, `FleetJobLogStreamDto` (Task 2).
- Produces:
  - `MAX_LOG_ROWS = 5000`.
  - `LogView { rows; head; atStart; tail; atEnd; size; complete; truncated; searching: { direction; scannedFrom;
    scannedTo } | null }`.
  - `openedView(page)`, `withLater(view, page)` and `withEarlier(view, page)`.
  - `LogNoticeKey = 'expired' | 'legacy' | 'bundle' | 'truncated' | 'incomplete'` and `LogNotice { key; size? }`.
  - `logNotices({ summary, legacySampled, view, jobTerminal, expired })` and `formatBytes(n)`.
  - `LogRowView`, a discriminated union on `kind: 'entry' | 'text'`.
  - `logRowView(stream, entry)`, `logTime(iso)`, `levelVariant(level)` and `isNearBottom(el, slack = 24)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-log-view.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import type { FleetJobLogEntriesDto, FleetJobLogEntryDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'
import { formatBytes, isNearBottom, levelVariant, logNotices, logRowView, logTime, MAX_LOG_ROWS, openedView, withEarlier, withLater } from '~/lib/fleet-log-view'

/** Lines of 10 bytes each: line i spans [10 i, 10 i + 10). */
const line = (i: number): FleetJobLogEntryDto => ({ offset: i * 10, length: 10, text: `line ${i}` })
const lines = (from: number, to: number): FleetJobLogEntryDto[] => Array.from({ length: to - from }, (_, k) => line(from + k))
const page = (over: Partial<FleetJobLogEntriesDto>): FleetJobLogEntriesDto => ({
  entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: false, size: 0, complete: false, truncated: false, ...over,
})

describe('openedView (spec §4.1 opening)', () => {
  test('backward from the end: head is the page cursor, tail the visible end', () => {
    const v = openedView(page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, atEnd: false, size: 85 }))
    expect(v).toMatchObject({ head: 50, atStart: false, tail: 80, atEnd: true, size: 85, searching: null })
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70])
  })

  test('a filtered opening that matched nothing and is not at offset 0 offers backward searching', () => {
    const v = openedView(page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 80, atEnd: false, size: 80 }))
    expect(v.searching).toEqual({ direction: 'backward', scannedFrom: 40, scannedTo: 80 })
  })
})

describe('withLater / withEarlier', () => {
  const opened = openedView(page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, size: 80 }))

  test('a forward page appends, moves tail, takes the newest size/complete/truncated', () => {
    const v = withLater(opened, page({ entries: lines(8, 10), nextCursor: 100, scannedFrom: 80, scannedTo: 100, atEnd: true, size: 100, complete: true }))
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80, 90])
    expect(v).toMatchObject({ tail: 100, atEnd: true, complete: true, size: 100, head: 50 })
  })

  test('a forward page never duplicates a row already shown (an overlapping refetch)', () => {
    const v = withLater(opened, page({ entries: lines(7, 9), nextCursor: 90, atEnd: true, size: 90 }))
    expect(v.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80])
  })

  test('a forward page that matched nothing before the end offers forward searching from scannedTo', () => {
    const v = withLater(opened, page({ entries: [], nextCursor: 2_097_232, scannedFrom: 80, scannedTo: 2_097_232, atEnd: false, size: 9_000_000 }))
    expect(v.searching).toEqual({ direction: 'forward', scannedFrom: 80, scannedTo: 2_097_232 })
    expect(v.tail).toBe(2_097_232)
  })

  test('a backward page prepends and moves head; atStart follows the page', () => {
    const v = withEarlier(opened, page({ entries: lines(0, 5), nextCursor: 0, scannedFrom: 0, scannedTo: 50, atEnd: true, size: 80 }))
    expect(v.rows.map((r) => r.offset)).toEqual([0, 10, 20, 30, 40, 50, 60, 70])
    expect(v).toMatchObject({ head: 0, atStart: true, tail: 80, atEnd: true })
  })

  test(`past ${MAX_LOG_ROWS} rows a forward page evicts from the start and re-opens Load earlier`, () => {
    const full = { ...opened, rows: lines(0, MAX_LOG_ROWS), head: 0, atStart: true, tail: MAX_LOG_ROWS * 10 }
    const v = withLater(full, page({ entries: lines(MAX_LOG_ROWS, MAX_LOG_ROWS + 3), nextCursor: (MAX_LOG_ROWS + 3) * 10, atEnd: true }))
    expect(v.rows).toHaveLength(MAX_LOG_ROWS)
    expect(v.rows[0].offset).toBe(30)
    expect(v).toMatchObject({ head: 30, atStart: false })
  })

  test(`past ${MAX_LOG_ROWS} rows a backward page evicts from the end and re-opens Load more`, () => {
    const full = { ...opened, rows: lines(3, MAX_LOG_ROWS + 3), head: 30, atStart: false, tail: (MAX_LOG_ROWS + 3) * 10, atEnd: true }
    const v = withEarlier(full, page({ entries: lines(0, 3), nextCursor: 0, atEnd: true }))
    expect(v.rows).toHaveLength(MAX_LOG_ROWS)
    expect(v.rows[v.rows.length - 1].offset).toBe((MAX_LOG_ROWS - 1) * 10)
    expect(v).toMatchObject({ tail: MAX_LOG_ROWS * 10, atEnd: false, head: 0, atStart: true })
  })
})

describe('logNotices (spec §4.1)', () => {
  const summary = (over: Partial<FleetJobLogStreamDto> = {}): FleetJobLogStreamDto => ({
    stream: 'run', sizeBytes: 100, complete: true, truncated: false, source: 'stream', expired: false, updatedAt: 'x', ...over,
  })
  const base = { summary: summary(), legacySampled: false, view: null, jobTerminal: true, expired: false }

  test('a complete streamed log has no notice', () => {
    expect(logNotices(base)).toEqual([])
  })

  test('each notice on its own', () => {
    expect(logNotices({ ...base, summary: summary({ source: 'bundle' }) })).toEqual([{ key: 'bundle' }])
    expect(logNotices({ ...base, summary: summary({ truncated: true, complete: false }) })).toEqual([{ key: 'truncated' }])
    expect(logNotices({ ...base, summary: summary({ complete: false, sizeBytes: 42 }) })).toEqual([{ key: 'incomplete', size: 42 }])
    expect(logNotices({ ...base, summary: null, legacySampled: true })).toEqual([{ key: 'legacy' }])
  })

  test('expired (row or a 410) hides every other notice', () => {
    expect(logNotices({ ...base, summary: summary({ expired: true, source: 'bundle' }) })).toEqual([{ key: 'expired' }])
    expect(logNotices({ ...base, summary: null, expired: true })).toEqual([{ key: 'expired' }])
  })

  test('incomplete only once the job is terminal; the fresher page wins over the list', () => {
    expect(logNotices({ ...base, summary: summary({ complete: false }), jobTerminal: false })).toEqual([])
    expect(logNotices({ ...base, summary: summary({ complete: false }), view: { size: 7, complete: true, truncated: false } })).toEqual([])
    expect(logNotices({ ...base, summary: null, view: { size: 7, complete: false, truncated: false } })).toEqual([{ key: 'incomplete', size: 7 }])
  })
})

describe('formatBytes', () => {
  test.each([[0, '0 B'], [1023, '1023 B'], [1536, '1.5 KiB'], [268_435_456, '256.0 MiB']])('%d -> %s', (n, s) => {
    expect(formatBytes(n)).toBe(s)
  })
})

describe('row helpers (spec §4.1 rows)', () => {
  test('a parsed run entry keeps its fields as text; data becomes indented JSON', () => {
    const row = logRowView('run', { offset: 5, length: 9, timestamp: '2026-10-04T10:11:12.000Z', level: 'warn', stage: 's', storyId: 'US-1', sessionRole: 'r', message: 'm', data: { a: 1 } })
    const d = new Date('2026-10-04T10:11:12.000Z')
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(row).toEqual({
      kind: 'entry', offset: 5, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, timestamp: '2026-10-04T10:11:12.000Z',
      level: 'warn', stage: 's', storyId: 'US-1', role: 'r', message: 'm', data: '{\n  "a": 1\n}',
    })
  })

  test('an unparsed run line, a cut line and a stdout line are text rows', () => {
    expect(logRowView('run', { offset: 0, length: 4, unparsed: true, text: 'abc' })).toEqual({ kind: 'text', offset: 0, text: 'abc', unparsed: true, cut: false })
    expect(logRowView('run', { offset: 0, length: 4, unparsed: true, truncatedLine: true, text: 'abc' })).toMatchObject({ cut: true })
    expect(logRowView('stdout', { offset: 0, length: 4, text: 'abc' })).toEqual({ kind: 'text', offset: 0, text: 'abc', unparsed: false, cut: false })
  })

  test('logTime is empty for a missing or broken timestamp; no data is null, not "undefined"', () => {
    expect(logTime(undefined)).toBe('')
    expect(logTime('yesterday')).toBe('')
    expect(logRowView('run', { offset: 0, length: 1, level: 'info' })).toMatchObject({ data: null, time: '', message: '' })
  })

  test('levelVariant per level; isNearBottom within the slack', () => {
    expect(['error', 'warn', 'info', 'debug'].map(levelVariant)).toEqual(['destructive', 'default', 'secondary', 'outline'])
    expect(isNearBottom({ scrollTop: 880, clientHeight: 100, scrollHeight: 1000 })).toBe(true)
    expect(isNearBottom({ scrollTop: 800, clientHeight: 100, scrollHeight: 1000 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-view.spec.ts`
Expected: FAIL with "Cannot find module '~/lib/fleet-log-view'".

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-log-view.ts`:

```ts
import type { FleetJobLogEntriesDto, FleetJobLogEntryDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'

/** Spec §4.1: at most this many rows in the DOM; loading past it evicts from the other end. */
export const MAX_LOG_ROWS = 5000

/** What the viewer has loaded of one stream of one attempt, and where its next pages start. */
export interface LogView {
  rows: readonly FleetJobLogEntryDto[]
  /** Backward cursor: the start of the earliest scanned line. */
  head: number
  /** No line before `head`. */
  atStart: boolean
  /** Forward cursor: the end of the last scanned complete line. */
  tail: number
  /** No complete line after `tail` (yet, while the stream grows). */
  atEnd: boolean
  size: number
  complete: boolean
  truncated: boolean
  /** The last page matched nothing and did not reach its boundary: offer "Keep searching" (spec §4.1, criterion 3). */
  searching: { direction: 'forward' | 'backward'; scannedFrom: number; scannedTo: number } | null
}

const endOf = (row: FleetJobLogEntryDto): number => row.offset + row.length

const searchingOf = (direction: 'forward' | 'backward', page: FleetJobLogEntriesDto): LogView['searching'] =>
  page.entries.length === 0 && !page.atEnd ? { direction, scannedFrom: page.scannedFrom, scannedTo: page.scannedTo } : null

/** The first page: backward from the visible end (spec §4.1 "Opening"). */
export function openedView(page: FleetJobLogEntriesDto): LogView {
  return {
    rows: page.entries,
    head: page.nextCursor,
    atStart: page.atEnd,
    tail: page.scannedTo,
    atEnd: true,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('backward', page),
  }
}

/** A forward page: append after the last row; evict from the start past MAX_LOG_ROWS. */
export function withLater(view: LogView, page: FleetJobLogEntriesDto): LogView {
  const last = view.rows.length > 0 ? endOf(view.rows[view.rows.length - 1]) : -1
  const merged = [...view.rows, ...page.entries.filter((e) => e.offset >= last)]
  const kept = merged.length > MAX_LOG_ROWS ? merged.slice(merged.length - MAX_LOG_ROWS) : merged
  const evicted = kept.length < merged.length
  return {
    ...view,
    rows: kept,
    head: evicted ? kept[0].offset : view.head,
    atStart: evicted ? false : view.atStart,
    tail: Math.max(view.tail, page.nextCursor),
    atEnd: page.atEnd,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('forward', page),
  }
}

/** A backward page: prepend before the first row; evict from the end past MAX_LOG_ROWS (follow is then off). */
export function withEarlier(view: LogView, page: FleetJobLogEntriesDto): LogView {
  const first = view.rows.length > 0 ? view.rows[0].offset : Number.POSITIVE_INFINITY
  const merged = [...page.entries.filter((e) => endOf(e) <= first), ...view.rows]
  const kept = merged.length > MAX_LOG_ROWS ? merged.slice(0, MAX_LOG_ROWS) : merged
  const evicted = kept.length < merged.length
  return {
    ...view,
    rows: kept,
    head: Math.min(view.head, page.nextCursor),
    atStart: page.atEnd,
    tail: evicted ? endOf(kept[kept.length - 1]) : view.tail,
    atEnd: evicted ? false : view.atEnd,
    size: page.size,
    complete: page.complete,
    truncated: page.truncated,
    searching: searchingOf('backward', page),
  }
}

export type LogNoticeKey = 'expired' | 'legacy' | 'bundle' | 'truncated' | 'incomplete'

export interface LogNotice {
  key: LogNoticeKey
  size?: number
}

export interface LogNoticeInput {
  /** The list route's row for this attempt and stream, when it has one. */
  summary: FleetJobLogStreamDto | null
  legacySampled: boolean
  /** The latest entries page (fresher than the list), when one loaded. */
  view: Pick<LogView, 'size' | 'complete' | 'truncated'> | null
  jobTerminal: boolean
  /** A read answered 410. */
  expired: boolean
}

/** Spec §4.1 notices, in display order. An expired stream shows only that. */
export function logNotices(input: LogNoticeInput): LogNotice[] {
  if (input.expired || input.summary?.expired === true) return [{ key: 'expired' }]
  const complete = input.view?.complete ?? input.summary?.complete ?? false
  const truncated = input.view?.truncated ?? input.summary?.truncated ?? false
  const size = input.view?.size ?? input.summary?.sizeBytes ?? 0
  const notices: LogNotice[] = []
  if (input.legacySampled) notices.push({ key: 'legacy' })
  if (input.summary?.source === 'bundle') notices.push({ key: 'bundle' })
  if (truncated) notices.push({ key: 'truncated' })
  else if (input.jobTerminal && !complete && !input.legacySampled) notices.push({ key: 'incomplete', size })
  return notices
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const

/** 1536 -> "1.5 KiB"; bytes stay whole. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]}`
}

/** One rendered row: a parsed nax LogEntry, or a text line (stdout/stderr, or an unparsed run line). */
export type LogRowView =
  | { kind: 'entry'; offset: number; time: string; timestamp: string; level: string; stage: string; storyId: string; role: string; message: string; data: string | null }
  | { kind: 'text'; offset: number; text: string; unparsed: boolean; cut: boolean }

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local HH:MM:SS of an ISO timestamp; '' when it does not parse. */
export function logTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `data` as indented JSON, for the expand panel; null when the entry has none. */
function dataText(data: unknown): string | null {
  if (data === undefined) return null
  try {
    return JSON.stringify(data, null, 2) ?? String(data)
  }
  catch {
    return String(data)
  }
}

/** Spec §4.1 rows. Every value is plain text; the template renders it with `{{ }}` only (never v-html). */
export function logRowView(stream: string, e: FleetJobLogEntryDto): LogRowView {
  if (stream !== 'run' || e.unparsed === true || e.level === undefined) {
    return { kind: 'text', offset: e.offset, text: e.text ?? '', unparsed: stream === 'run', cut: e.truncatedLine === true }
  }
  return {
    kind: 'entry', offset: e.offset, time: logTime(e.timestamp), timestamp: e.timestamp ?? '', level: e.level,
    stage: e.stage ?? '', storyId: e.storyId ?? '', role: e.sessionRole ?? '', message: e.message ?? '', data: dataText(e.data),
  }
}

/** Badge variant per level. */
export function levelVariant(level: string): 'destructive' | 'default' | 'secondary' | 'outline' {
  if (level === 'error') return 'destructive'
  if (level === 'warn') return 'default'
  if (level === 'info') return 'secondary'
  return 'outline'
}

/** Spec §4.1: scrolling away from the bottom turns follow off; within `slack` px counts as the bottom. */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-view.spec.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-log-view.ts apps/web/tests/lib/fleet-log-view.spec.ts
git commit -m "feat(web): log viewer rows, cursors, 5,000-row eviction and notices (S2a §4.1, D358)"
```

---

### Task 5: Viewer controller: follow, coalescing, Keep searching, 429 and 410 (`fleet-log-viewer`)

**Files:**
- Create: `apps/web/lib/fleet-log-viewer.ts`
- Test: `apps/web/tests/lib/fleet-log-viewer.spec.ts` (create)

**Interfaces:**
- Consumes: `EntriesPageRequest` (Task 3); `openedView`, `withEarlier`, `withLater`, `LogView` (Task 4);
  `FleetJobLogEntriesDto` (Task 2).
- Produces:
  - Constants: `LOG_PAGE_LIMIT = 200`, `FOLLOW_PAGE_LIMIT = 500`, `RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000]`.
  - `LogViewerState { view: LogView | null; loading; follow; rateLimited; expired; error: string | null }`.
  - `LogViewerDeps { fetchPage(page): Promise<FleetJobLogEntriesDto>; sleep(ms); filtered: boolean;
    onChange(state); describeError(err) }`.
  - `createLogViewer(deps, { follow })`, which returns `LogViewer { open, loadEarlier, loadMore, keepSearching,
    onGrowth, setFollow(on), jumpToLatest, dispose }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/lib/fleet-log-viewer.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import type { EntriesPageRequest } from '~/lib/fleet-log-query'
import type { FleetJobLogEntriesDto, FleetJobLogEntryDto } from '~/lib/fleet-log-types'
import { createLogViewer, FOLLOW_PAGE_LIMIT, LOG_PAGE_LIMIT, type LogViewerState } from '~/lib/fleet-log-viewer'

const line = (i: number): FleetJobLogEntryDto => ({ offset: i * 10, length: 10, text: `l${i}` })
const lines = (from: number, to: number): FleetJobLogEntryDto[] => Array.from({ length: to - from }, (_, k) => line(from + k))
const page = (over: Partial<FleetJobLogEntriesDto>): FleetJobLogEntriesDto => ({
  entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false, ...over,
})
const apiError = (code: number): Error & { code: number } => Object.assign(new Error(`ret ${code}`), { code })

function deferred<T>() {
  let resolve = (_v: T): void => undefined
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** A viewer over scripted answers; each fetchPage call takes the next answer (a page, an error, or a deferred). */
function harness(answers: Array<FleetJobLogEntriesDto | Error | Promise<FleetJobLogEntriesDto>>, opts: { follow?: boolean; filtered?: boolean } = {}) {
  const calls: EntriesPageRequest[] = []
  const states: LogViewerState[] = []
  const sleeps: number[] = []
  const viewer = createLogViewer({
    fetchPage: async (p) => {
      calls.push(p)
      const next = answers.shift()
      if (next === undefined) throw new Error('unexpected fetch')
      if (next instanceof Error) throw next
      return next
    },
    sleep: async (ms) => { sleeps.push(ms) },
    filtered: opts.filtered ?? false,
    onChange: (s) => { states.push(s) },
    describeError: (e) => (e as Error).message,
  }, { follow: opts.follow ?? true })
  const last = (): LogViewerState => states[states.length - 1]
  return { viewer, calls, states, sleeps, last }
}

const opening = page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, atEnd: false, size: 80 })

describe('createLogViewer (spec §4.1)', () => {
  test('open reads backward from the visible end and shows the rows', async () => {
    const h = harness([opening])
    await h.viewer.open()
    expect(h.calls).toEqual([{ direction: 'backward', limit: LOG_PAGE_LIMIT }])
    expect(h.last()).toMatchObject({ loading: false, follow: true, error: null })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([50, 60, 70])
  })

  test('growth while following fetches forward from the tail', async () => {
    const h = harness([opening, page({ entries: lines(8, 9), nextCursor: 90, atEnd: true, size: 90 })])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls[1]).toEqual({ direction: 'forward', cursor: 80, limit: FOLLOW_PAGE_LIMIT })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80])
  })

  test('growth notices during a request are coalesced into exactly one follow-up fetch', async () => {
    const slow = deferred<FleetJobLogEntriesDto>()
    const h = harness([opening, slow.promise, page({ entries: lines(9, 10), nextCursor: 100, atEnd: true, size: 100 })])
    await h.viewer.open()
    const first = h.viewer.onGrowth()
    await h.viewer.onGrowth()
    await h.viewer.onGrowth()
    slow.resolve(page({ entries: lines(8, 9), nextCursor: 90, atEnd: true, size: 90 }))
    await first
    expect(h.calls.map((c) => c.cursor)).toEqual([undefined, 80, 90])
    expect(h.last().view?.rows).toHaveLength(5)
  })

  test('following catches up a burst page by page until atEnd', async () => {
    const h = harness([
      opening,
      page({ entries: lines(8, 9), nextCursor: 90, atEnd: false, size: 200 }),
      page({ entries: lines(9, 20), nextCursor: 200, atEnd: true, size: 200 }),
    ])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls.map((c) => c.cursor)).toEqual([undefined, 80, 90])
    expect(h.last().view?.tail).toBe(200)
  })

  test('a filtered follow stops on an empty page that is not at the end and offers Keep searching (criterion 3)', async () => {
    const h = harness([opening, page({ entries: [], nextCursor: 2_000_080, scannedFrom: 80, scannedTo: 2_000_080, atEnd: false, size: 9_000_000 })], { filtered: true })
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(2)
    expect(h.last().view?.searching).toEqual({ direction: 'forward', scannedFrom: 80, scannedTo: 2_000_080 })
  })

  test('Keep searching sends exactly one request in the searching direction', async () => {
    const backward = page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 80, atEnd: false, size: 80 })
    const h = harness([backward, page({ entries: lines(1, 2), nextCursor: 10, scannedFrom: 10, scannedTo: 40, atEnd: false, size: 80 })], { filtered: true, follow: false })
    await h.viewer.open()
    expect(h.last().view?.searching?.direction).toBe('backward')
    await h.viewer.keepSearching()
    expect(h.calls[1]).toEqual({ direction: 'backward', cursor: 40, limit: LOG_PAGE_LIMIT })
    expect(h.last().view?.searching).toBeNull()
  })

  test('with follow off, growth does nothing; Load more fetches one forward page', async () => {
    const h = harness([opening, page({ entries: lines(8, 9), nextCursor: 90, atEnd: false, size: 200 })], { follow: false })
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(1)
    await h.viewer.loadMore()
    expect(h.calls[1]).toEqual({ direction: 'forward', cursor: 80, limit: LOG_PAGE_LIMIT })
    expect(h.last().view?.atEnd).toBe(false)
  })

  test('Load earlier reads backward from the head and is a no-op at the start', async () => {
    const h = harness([opening, page({ entries: lines(0, 5), nextCursor: 0, scannedFrom: 0, scannedTo: 50, atEnd: true, size: 80 })])
    await h.viewer.open()
    await h.viewer.loadEarlier()
    expect(h.calls[1]).toEqual({ direction: 'backward', cursor: 50, limit: LOG_PAGE_LIMIT })
    await h.viewer.loadEarlier()
    expect(h.calls).toHaveLength(2)
    expect(h.last().view?.atStart).toBe(true)
  })

  test('429 backs off 2 s, 4 s, 8 s with a quiet flag, and recovers', async () => {
    const h = harness([apiError(429), apiError(429), apiError(429), opening])
    await h.viewer.open()
    expect(h.sleeps).toEqual([2000, 4000, 8000])
    expect(h.states.some((s) => s.rateLimited)).toBe(true)
    expect(h.last()).toMatchObject({ rateLimited: false, error: null })
    expect(h.last().view).not.toBeNull()
  })

  test('a fourth 429 gives up with an error and no further request', async () => {
    const h = harness([apiError(429), apiError(429), apiError(429), apiError(429)])
    await h.viewer.open()
    expect(h.calls).toHaveLength(4)
    expect(h.last()).toMatchObject({ rateLimited: false, error: 'ret 429', loading: false })
  })

  test('410 marks the stream expired, clears the rows and stops following', async () => {
    const h = harness([opening, apiError(410)])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.last()).toMatchObject({ expired: true, view: null, follow: false, error: null })
  })

  test('any other failure is an error; the next action clears it', async () => {
    const h = harness([new Error('boom'), opening])
    await h.viewer.open()
    expect(h.last()).toMatchObject({ error: 'boom', view: null })
    await h.viewer.open()
    expect(h.last()).toMatchObject({ error: null })
  })

  test('Jump to latest reopens at the end with follow on', async () => {
    const h = harness([opening, page({ entries: lines(20, 22), nextCursor: 200, scannedFrom: 200, scannedTo: 220, atEnd: false, size: 220 })], { follow: false })
    await h.viewer.open()
    await h.viewer.jumpToLatest()
    expect(h.calls[1]).toEqual({ direction: 'backward', limit: LOG_PAGE_LIMIT })
    expect(h.last()).toMatchObject({ follow: true })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([200, 210])
  })

  test('after dispose a pending answer changes nothing', async () => {
    const slow = deferred<FleetJobLogEntriesDto>()
    const h = harness([slow.promise])
    const opened = h.viewer.open()
    const seen = h.states.length
    h.viewer.dispose()
    slow.resolve(opening)
    await opened
    expect(h.states).toHaveLength(seen)
  })

  test('setFollow(false) from a scroll, then growth sends nothing', async () => {
    const h = harness([opening])
    await h.viewer.open()
    h.viewer.setFollow(false)
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(1)
    expect(h.last().follow).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-viewer.spec.ts`
Expected: FAIL with "Cannot find module '~/lib/fleet-log-viewer'".

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-log-viewer.ts`:

```ts
import type { EntriesPageRequest } from '~/lib/fleet-log-query'
import type { FleetJobLogEntriesDto } from '~/lib/fleet-log-types'
import { openedView, withEarlier, withLater, type LogView } from '~/lib/fleet-log-view'

/** Rows per user-driven page (the API default). */
export const LOG_PAGE_LIMIT = 200
/** Rows per follow page: catching up a burst takes fewer requests (API max 500). */
export const FOLLOW_PAGE_LIMIT = 500
/** Spec §4.1: on 429 wait 2 s, 4 s, 8 s, then give up with an error. */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2000, 4000, 8000]

export interface LogViewerState {
  view: LogView | null
  loading: boolean
  follow: boolean
  rateLimited: boolean
  /** A read answered 410: the stream was deleted by retention. */
  expired: boolean
  error: string | null
}

export interface LogViewerDeps {
  /** One entries request for the viewer's stream, attempt and filters. */
  fetchPage: (page: EntriesPageRequest) => Promise<FleetJobLogEntriesDto>
  sleep: (ms: number) => Promise<void>
  /** Any filter is active: an empty follow page then stops instead of scanning on (criterion 3). */
  filtered: boolean
  onChange: (state: LogViewerState) => void
  describeError: (err: unknown) => string
}

export interface LogViewer {
  open: () => Promise<void>
  loadEarlier: () => Promise<void>
  loadMore: () => Promise<void>
  keepSearching: () => Promise<void>
  /** A fleet_log for this stream and attempt (or a resync): fetch forward while following. */
  onGrowth: () => Promise<void>
  setFollow: (on: boolean) => void
  /** Reopen at the end with follow on (spec §4.1 "Jump to latest"). */
  jumpToLatest: () => Promise<void>
  dispose: () => void
}

/** ApiError carries the envelope `ret` (429, 410) as `code`; a bare fetch error carries `status`. */
function errorCode(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const e = err as { code?: unknown; status?: unknown }
  if (typeof e.code === 'number') return e.code
  return typeof e.status === 'number' ? e.status : undefined
}

/**
 * Spec §4.1 viewer behaviour, framework-free: one request at a time, growth notices coalesced into one follow-up
 * fetch, user actions ignored while a request runs. The page owns one viewer per (stream, attempt, filters).
 */
export function createLogViewer(deps: LogViewerDeps, initial: { follow: boolean }): LogViewer {
  let state: LogViewerState = { view: null, loading: false, follow: initial.follow, rateLimited: false, expired: false, error: null }
  let disposed = false
  let growthPending = false

  const set = (patch: Partial<LogViewerState>): void => {
    state = { ...state, ...patch }
    if (!disposed) deps.onChange(state)
  }

  async function request(page: EntriesPageRequest): Promise<FleetJobLogEntriesDto | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await deps.fetchPage(page)
        if (disposed) return null
        if (state.rateLimited) set({ rateLimited: false })
        return result
      }
      catch (err: unknown) {
        if (disposed) return null
        const code = errorCode(err)
        if (code === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
          set({ rateLimited: true })
          await deps.sleep(RATE_LIMIT_BACKOFF_MS[attempt])
          if (disposed) return null
          continue
        }
        if (code === 410) set({ expired: true, view: null, follow: false, rateLimited: false })
        else set({ error: deps.describeError(err), rateLimited: false })
        return null
      }
    }
  }

  async function exclusive(task: () => Promise<void>): Promise<void> {
    if (state.loading || disposed) return
    set({ loading: true, error: null })
    try {
      await task()
    }
    finally {
      if (!disposed) set({ loading: false })
    }
    if (growthPending && !disposed) {
      growthPending = false
      await exclusive(followForward)
    }
  }

  /** Forward from the tail until the end, or until a filtered page matches nothing (then "Keep searching"). */
  async function followForward(): Promise<void> {
    while (state.follow && state.view && !disposed) {
      const from = state.view.tail
      const page = await request({ direction: 'forward', cursor: from, limit: FOLLOW_PAGE_LIMIT })
      if (!page || !state.view) return
      set({ view: withLater(state.view, page) })
      if (page.atEnd || page.nextCursor <= from) return
      if (page.entries.length === 0 && deps.filtered) return
    }
  }

  const open = (): Promise<void> => exclusive(async () => {
    const page = await request({ direction: 'backward', limit: LOG_PAGE_LIMIT })
    if (page) set({ view: openedView(page) })
  })

  const loadEarlier = (): Promise<void> => exclusive(async () => {
    const view = state.view
    if (!view || view.atStart) return
    const page = await request({ direction: 'backward', cursor: view.head, limit: LOG_PAGE_LIMIT })
    if (page && state.view) set({ view: withEarlier(state.view, page) })
  })

  const loadMore = (): Promise<void> => exclusive(async () => {
    const view = state.view
    if (!view) return
    const page = await request({ direction: 'forward', cursor: view.tail, limit: LOG_PAGE_LIMIT })
    if (page && state.view) set({ view: withLater(state.view, page) })
  })

  const keepSearching = (): Promise<void> => (state.view?.searching?.direction === 'backward' ? loadEarlier() : loadMore())

  async function onGrowth(): Promise<void> {
    if (!state.follow || !state.view || disposed) return
    if (state.loading) {
      growthPending = true
      return
    }
    await exclusive(followForward)
  }

  async function jumpToLatest(): Promise<void> {
    if (state.loading || disposed) return
    set({ follow: true, view: null })
    await open()
  }

  return {
    open,
    loadEarlier,
    loadMore,
    keepSearching,
    onGrowth,
    setFollow: (on) => { if (state.follow !== on) set({ follow: on }) },
    jumpToLatest,
    dispose: () => { disposed = true },
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && bunx jest tests/lib/fleet-log-viewer.spec.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-log-viewer.ts apps/web/tests/lib/fleet-log-viewer.spec.ts
git commit -m "feat(web): log viewer controller with follow, coalescing and 429 backoff (S2a §4.1, D356, D364)"
```

---

### Task 6: Log rows, filters and notices components, and the i18n keys

**Files:**
- Create: `apps/web/components/fleet/FleetLogRows.vue`, `apps/web/components/fleet/FleetLogFilters.vue`,
  `apps/web/components/fleet/FleetLogNotices.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`,
  `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/web/tests/components/fleet-log-components.spec.ts` (create)

**Interfaces:**
- Consumes: `logRowView`, `levelVariant`, `formatBytes`, `LogNotice` (Task 4); `EMPTY_LOG_FILTERS`, `hasActiveFilter`,
  `LogFilters` (Task 3); `isLogLevel`, `LOG_LEVELS`, `LogStream`, `FleetJobLogEntryDto` (Task 2). It uses the
  auto-imported `Badge`, `Button`, `Input`, `NuxtLink` and `FleetNativeSelect` (`components/fleet/NativeSelect.vue`,
  v-model protocol, `testid` prop).
- Produces:
  - `FleetLogRows` with props `{ stream: string; rows: readonly FleetJobLogEntryDto[] }` and test ids
    `fleet-log-row` (with `data-offset`), `fleet-log-entry`, `fleet-log-level`, `fleet-log-data`,
    `fleet-log-unparsed`, `fleet-log-cut` and `fleet-log-text`.
  - `FleetLogFilters` with props `{ stream; filters; stories: readonly string[] }` and emit `update(filters)`. Test ids
    are `fleet-log-filter-{level,story,stage,role,text,clear}`; the level select's `testid` is `fleet-log-filter-level`.
  - `FleetLogNotices` with props `{ notices; timelineHref; truncatedAt: number }` and test ids
    `fleet-log-notice-<key>` and `fleet-log-notice-timeline`.
  - i18n keys `fleet.logs.*`, `fleet.jobs.actions.{bundleExpired,logs}` and `fleet.jobs.timeline.logs`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/components/fleet-log-components.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { computed, nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { EMPTY_LOG_FILTERS, type LogFilters } from '../../lib/fleet-log-query'
import type { FleetJobLogEntryDto } from '../../lib/fleet-log-types'
import type { LogNotice } from '../../lib/fleet-log-view'

const globals = { ref, computed, useI18n: () => enI18n() }

describe('FleetLogRows (spec §4.1)', () => {
  const rows: FleetJobLogEntryDto[] = [
    { offset: 0, length: 120, timestamp: '2026-10-04T10:11:12.000Z', level: 'warn', stage: 'verify', storyId: 'US-002', sessionRole: 'implementer', message: 'tests failed', data: { failed: 3 } },
    { offset: 120, length: 40, level: 'info', message: 'no data here' },
    { offset: 160, length: 30, unparsed: true, text: 'not json at all' },
    { offset: 190, length: 1_048_576, unparsed: true, truncatedLine: true, text: 'x'.repeat(20) },
  ]
  const mount = (stream: string, list: FleetJobLogEntryDto[] = rows) =>
    mountSfc(webFile('components', 'fleet', 'FleetLogRows.vue'), { props: { stream, rows: list }, globals, components: uiStubs })

  test('a run entry shows level, stage, story, role and message; data opens on click', async () => {
    const m = mount('run')
    const first = m.find('[data-testid="fleet-log-row"]')[0]
    const text = m.textOf(first)
    for (const part of ['WARN', '[verify]', '[US-002]', 'implementer', 'tests failed']) expect(text).toContain(part)
    expect(m.find('[data-testid="fleet-log-data"]')).toHaveLength(0)
    const entry = m.find('[data-testid="fleet-log-entry"]')[0]
    ;(entry.props.onClick as () => void)()
    await nextTick()
    expect(m.textOf(m.find('[data-testid="fleet-log-data"]')[0])).toContain('"failed": 3')
    ;(entry.props.onClick as () => void)()
    await nextTick()
    expect(m.find('[data-testid="fleet-log-data"]')).toHaveLength(0)
    m.unmount()
  })

  test('an entry without data cannot be expanded', () => {
    const m = mount('run')
    expect(m.find('[data-testid="fleet-log-entry"]')[1].props.disabled).toBe(true)
    m.unmount()
  })

  test('unparsed run lines are tagged, a cut line says so', () => {
    const m = mount('run')
    expect(m.find('[data-testid="fleet-log-unparsed"]')).toHaveLength(2)
    expect(m.find('[data-testid="fleet-log-cut"]')).toHaveLength(1)
    expect(m.text()).toContain('not json at all')
    m.unmount()
  })

  test('stdout lines are plain text with no unparsed tag', () => {
    const m = mount('stdout', [{ offset: 0, length: 6, text: 'hello' }])
    expect(m.textOf(m.find('[data-testid="fleet-log-text"]')[0])).toBe('hello')
    expect(m.find('[data-testid="fleet-log-unparsed"]')).toHaveLength(0)
    m.unmount()
  })

  test('markup in a log line is text, never HTML (escape all log text)', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const m = mount('stdout', [{ offset: 0, length: 30, text: hostile }])
    expect(m.find('img')).toHaveLength(0)
    expect(m.text()).toContain(hostile)
    m.unmount()
  })
})

describe('FleetLogFilters (spec §4.1)', () => {
  function mount(stream: string, filters: LogFilters = EMPTY_LOG_FILTERS) {
    const updates: LogFilters[] = []
    const m = mountSfc(webFile('components', 'fleet', 'FleetLogFilters.vue'), {
      props: { stream, filters, stories: ['US-001', 'US-002'], onUpdate: (f: LogFilters) => updates.push(f) },
      globals, components: uiStubs,
    })
    const fire = (id: string, value: string) => (m.find(`[data-testid="${id}"]`)[0].props.onChange as (e: unknown) => void)({ target: { value } })
    const pick = (value: string) => (m.find('[data-stub="fleet-select"]')[0].props['onUpdate:modelValue'] as (v: string) => void)(value)
    return { m, updates, fire, pick }
  }

  test('the run stream offers level, story (with suggestions), stage, role and text', () => {
    const { m } = mount('run')
    expect(m.find('[data-stub="fleet-select"]')[0].props.testid).toBe('fleet-log-filter-level')
    for (const id of ['story', 'stage', 'role', 'text']) expect(m.find(`[data-testid="fleet-log-filter-${id}"]`)).toHaveLength(1)
    expect(m.find('option').map((o) => o.props.value)).toEqual(expect.arrayContaining(['US-001', 'US-002']))
    m.unmount()
  })

  test('stdout/stderr offer text only', () => {
    const { m } = mount('stderr')
    expect(m.find('[data-testid="fleet-log-filter-text"]')).toHaveLength(1)
    expect(m.find('[data-stub="fleet-select"]')).toHaveLength(0)
    expect(m.find('[data-testid="fleet-log-filter-story"]')).toHaveLength(0)
    m.unmount()
  })

  test('a changed field emits the whole filter set once, trimmed; an unchanged value emits nothing', () => {
    const { m, updates, fire, pick } = mount('run')
    fire('fleet-log-filter-story', ' US-002 ')
    fire('fleet-log-filter-stage', '')
    pick('warn')
    expect(updates).toEqual([{ ...EMPTY_LOG_FILTERS, storyId: 'US-002' }, { ...EMPTY_LOG_FILTERS, level: 'warn' }])
    m.unmount()
  })

  test('Clear shows only with an active filter and emits empty filters', () => {
    const plain = mount('run')
    expect(plain.m.find('[data-testid="fleet-log-filter-clear"]')).toHaveLength(0)
    plain.m.unmount()
    const { m, updates } = mount('run', { ...EMPTY_LOG_FILTERS, q: 'boom' })
    ;(m.find('[data-testid="fleet-log-filter-clear"]')[0].props.onClick as () => void)()
    expect(updates).toEqual([EMPTY_LOG_FILTERS])
    m.unmount()
  })
})

describe('FleetLogNotices (spec §4.1)', () => {
  const mount = (notices: LogNotice[]) => mountSfc(webFile('components', 'fleet', 'FleetLogNotices.vue'), {
    props: { notices, timelineHref: '/p/fleet/jobs/j1#timeline', truncatedAt: 268_435_456 }, globals, components: uiStubs,
  })

  test('renders each notice with its numbers', () => {
    const m = mount([{ key: 'bundle' }, { key: 'truncated' }, { key: 'incomplete', size: 1536 }])
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-bundle"]')[0])).toContain('Filled from the bundle')
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-truncated"]')[0])).toContain('256.0 MiB')
    expect(m.textOf(m.find('[data-testid="fleet-log-notice-incomplete"]')[0])).toContain('1.5 KiB received')
    m.unmount()
  })

  test('the legacy notice links to the timeline; expired says retention', () => {
    const legacy = mount([{ key: 'legacy' }])
    expect(legacy.find('[data-testid="fleet-log-notice-timeline"]')[0].props.to).toBe('/p/fleet/jobs/j1#timeline')
    legacy.unmount()
    const expired = mount([{ key: 'expired' }])
    expect(expired.text()).toContain('deleted after the retention window')
    expired.unmount()
  })

  test('nothing to say renders nothing', () => {
    const m = mount([])
    expect(m.find('[data-testid="fleet-log-notices"]')).toHaveLength(0)
    m.unmount()
  })
})
```

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add to the `ENUMS` map after the
`'fleet.approvals.type': [...]` line (the notices and tabs are rendered through dynamic keys):

```ts
  'fleet.logs.streams': ['run', 'stdout', 'stderr'],
  'fleet.logs.notice': ['bundle', 'truncated', 'incomplete', 'expired', 'legacy'],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/components/fleet-log-components.spec.ts tests/i18n`
Expected: FAIL. The component files do not exist, and the parity spec finds no `fleet.logs.streams`.

- [ ] **Step 3: Implement**

Create `apps/web/components/fleet/FleetLogRows.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FleetJobLogEntryDto } from '~/lib/fleet-log-types'
import { levelVariant, logRowView } from '~/lib/fleet-log-view'

const props = defineProps<{ stream: string; rows: readonly FleetJobLogEntryDto[] }>()
const { t } = useI18n()

/** Offsets of run rows whose `data` is open. */
const expanded = ref<ReadonlySet<number>>(new Set())
const views = computed(() => props.rows.map((row) => logRowView(props.stream, row)))

function toggle(offset: number): void {
  const next = new Set(expanded.value)
  if (next.has(offset)) next.delete(offset)
  else next.add(offset)
  expanded.value = next
}
</script>

<template>
  <ol class="divide-y divide-border font-mono text-xs" data-testid="fleet-log-rows">
    <li v-for="row in views" :key="row.offset" :data-offset="row.offset" data-testid="fleet-log-row">
      <template v-if="row.kind === 'entry'">
        <button
          type="button"
          class="flex w-full flex-wrap items-baseline gap-2 px-2 py-1 text-left hover:bg-muted/50"
          :disabled="row.data === null"
          :aria-expanded="row.data === null ? undefined : expanded.has(row.offset)"
          data-testid="fleet-log-entry"
          @click="toggle(row.offset)"
        >
          <span class="text-muted-foreground" :title="row.timestamp">{{ row.time }}</span>
          <Badge :variant="levelVariant(row.level)" data-testid="fleet-log-level">{{ row.level.toUpperCase() }}</Badge>
          <span v-if="row.stage" class="text-muted-foreground" data-testid="fleet-log-stage">[{{ row.stage }}]</span>
          <span v-if="row.storyId" class="text-muted-foreground" data-testid="fleet-log-story">[{{ row.storyId }}]</span>
          <span v-if="row.role" class="text-muted-foreground" data-testid="fleet-log-role">{{ row.role }}</span>
          <span class="whitespace-pre-wrap break-all" data-testid="fleet-log-message">{{ row.message }}</span>
        </button>
        <pre v-if="row.data !== null && expanded.has(row.offset)" class="overflow-x-auto bg-muted/40 px-2 py-1" data-testid="fleet-log-data">{{ row.data }}</pre>
      </template>
      <div v-else class="flex items-baseline gap-2 px-2 py-1">
        <span v-if="row.unparsed" class="shrink-0 text-muted-foreground" data-testid="fleet-log-unparsed">{{ t('fleet.logs.tags.unparsed') }}</span>
        <span v-if="row.cut" class="shrink-0 text-muted-foreground" data-testid="fleet-log-cut">{{ t('fleet.logs.tags.cut') }}</span>
        <span class="whitespace-pre-wrap break-all" data-testid="fleet-log-text">{{ row.text }}</span>
      </div>
    </li>
  </ol>
</template>
```

Create `apps/web/components/fleet/FleetLogFilters.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { EMPTY_LOG_FILTERS, hasActiveFilter, type LogFilters } from '~/lib/fleet-log-query'
import { isLogLevel, LOG_LEVELS, type LogStream } from '~/lib/fleet-log-types'

const props = defineProps<{ stream: LogStream; filters: LogFilters; stories: readonly string[] }>()
const emit = defineEmits<{ update: [filters: LogFilters] }>()
const { t } = useI18n()

const active = computed(() => hasActiveFilter(props.stream, props.filters))
const levelOptions = computed(() => [
  { value: '', label: t('fleet.logs.filters.anyLevel') },
  ...LOG_LEVELS.map((level) => ({ value: level, label: level })),
])

const valueOf = (event: Event): string => ((event.target as HTMLInputElement | HTMLSelectElement | null)?.value ?? '').trim()

/** Text fields apply on change (Enter or blur), not per keystroke: each change resets the cursor and refetches. */
function set(field: 'storyId' | 'stage' | 'role' | 'q', event: Event): void {
  const value = valueOf(event)
  if (value !== props.filters[field]) emit('update', { ...props.filters, [field]: value })
}

function setLevel(value: string): void {
  const level = isLogLevel(value) ? value : null
  if (level !== props.filters.level) emit('update', { ...props.filters, level })
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-3" data-testid="fleet-log-filters">
    <template v-if="stream === 'run'">
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.level') }}</span>
        <FleetNativeSelect :model-value="filters.level ?? ''" :options="levelOptions" testid="fleet-log-filter-level" @update:model-value="setLevel($event)" />
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.story') }}</span>
        <Input :model-value="filters.storyId" list="fleet-log-stories" class="h-9 w-36" data-testid="fleet-log-filter-story" @change="set('storyId', $event)" />
        <datalist id="fleet-log-stories">
          <option v-for="story in stories" :key="story" :value="story" />
        </datalist>
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.stage') }}</span>
        <Input :model-value="filters.stage" class="h-9 w-32" data-testid="fleet-log-filter-stage" @change="set('stage', $event)" />
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.role') }}</span>
        <Input :model-value="filters.role" class="h-9 w-32" data-testid="fleet-log-filter-role" @change="set('role', $event)" />
      </label>
    </template>
    <label class="space-y-1 text-xs">
      <span class="text-muted-foreground">{{ t('fleet.logs.filters.text') }}</span>
      <Input :model-value="filters.q" class="h-9 w-56" data-testid="fleet-log-filter-text" @change="set('q', $event)" />
    </label>
    <Button v-if="active" variant="ghost" size="sm" data-testid="fleet-log-filter-clear" @click="emit('update', EMPTY_LOG_FILTERS)">
      {{ t('fleet.logs.filters.clear') }}
    </Button>
  </div>
</template>
```

Create `apps/web/components/fleet/FleetLogNotices.vue`:

```vue
<script setup lang="ts">
import { formatBytes, type LogNotice } from '~/lib/fleet-log-view'

defineProps<{ notices: readonly LogNotice[]; timelineHref: string; truncatedAt: number }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="notices.length > 0" class="space-y-2" data-testid="fleet-log-notices">
    <p v-for="notice in notices" :key="notice.key" class="rounded-md border border-border px-3 py-2 text-sm" :data-testid="`fleet-log-notice-${notice.key}`">
      <template v-if="notice.key === 'incomplete'">{{ t('fleet.logs.notice.incomplete', { size: formatBytes(notice.size ?? 0) }) }}</template>
      <template v-else-if="notice.key === 'truncated'">{{ t('fleet.logs.notice.truncated', { size: formatBytes(truncatedAt) }) }}</template>
      <template v-else-if="notice.key === 'legacy'">
        {{ t('fleet.logs.notice.legacy') }}
        <NuxtLink :to="timelineHref" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-log-notice-timeline">{{ t('fleet.logs.legacyLink') }}</NuxtLink>
      </template>
      <template v-else>{{ t(`fleet.logs.notice.${notice.key}`) }}</template>
    </p>
  </div>
</template>
```

The locale files mix compact and expanded JSON, so edit them by hand; do not re-serialize them.

In `en.json`:
- In `fleet.jobs.actions`, change `"bundle": "Download bundle"` to
  `"bundle": "Download bundle",` and add `"bundleExpired": "Bundle expired",` and `"logs": "Logs"`.
- In `fleet.jobs.timeline`, change `"unknown": "Unknown event {type}"` to `"unknown": "Unknown event {type}",` and add
  `"logs": "Full log of attempt {epoch}"`.
- Directly before `    "dispatch": {` (the `fleet.dispatch` block), insert:

```json
    "logs": {
      "title": "Logs",
      "back": "Back to job",
      "streams": { "run": "Run log", "stdout": "stdout", "stderr": "stderr" },
      "attempt": "Attempt",
      "attemptOption": "Attempt {epoch}",
      "filters": { "level": "Minimum level", "anyLevel": "Any level", "story": "Story", "stage": "Stage", "role": "Role", "text": "Text", "clear": "Clear filters" },
      "tags": { "unparsed": "unparsed", "cut": "line cut" },
      "empty": "No log lines yet",
      "emptyFiltered": "No matching lines in what was searched",
      "loadEarlier": "Load earlier",
      "loadMore": "Load more",
      "jumpToLatest": "Jump to latest",
      "following": "Following",
      "searching": { "forward": "Searched up to {scanned} of {size}", "backward": "Searched back to {scanned} of {size}", "keep": "Keep searching" },
      "rateLimited": "Rate limited, retrying",
      "download": "Download",
      "notice": {
        "bundle": "Filled from the bundle (the live upload did not finish)",
        "truncated": "Truncated at {size}; download the bundle for the full log",
        "incomplete": "Log incomplete ({size} received)",
        "expired": "This log was deleted after the retention window",
        "legacy": "Sampled live log from an older runner; the full log appears after the run."
      },
      "legacyLink": "See the sampled lines in the timeline"
    },
```

In `zh.json`, make the same three edits. In `fleet.jobs.actions`: `"bundleExpired": "产物包已过期",`, `"logs": "日志"`.
In `fleet.jobs.timeline`: `"logs": "第 {epoch} 次尝试的完整日志"`. Before `    "dispatch": {`:

```json
    "logs": {
      "title": "日志",
      "back": "返回任务",
      "streams": { "run": "运行日志", "stdout": "stdout", "stderr": "stderr" },
      "attempt": "尝试",
      "attemptOption": "第 {epoch} 次尝试",
      "filters": { "level": "最低级别", "anyLevel": "任意级别", "story": "故事", "stage": "阶段", "role": "角色", "text": "文本", "clear": "清除筛选" },
      "tags": { "unparsed": "未解析", "cut": "行被截断" },
      "empty": "还没有日志行",
      "emptyFiltered": "已搜索的部分中没有匹配的行",
      "loadEarlier": "加载更早",
      "loadMore": "加载更多",
      "jumpToLatest": "跳到最新",
      "following": "跟随中",
      "searching": { "forward": "已搜索到 {scanned} / {size}", "backward": "已向前搜索到 {scanned} / {size}", "keep": "继续搜索" },
      "rateLimited": "请求过于频繁，正在重试",
      "download": "下载",
      "notice": {
        "bundle": "已从产物包补全（实时上传未完成）",
        "truncated": "已在 {size} 处截断；完整日志请下载产物包",
        "incomplete": "日志不完整（已收到 {size}）",
        "expired": "此日志已在保留期满后删除",
        "legacy": "来自旧版运行器的采样实时日志；完整日志在运行结束后出现。"
      },
      "legacyLink": "在时间线中查看采样行"
    },
```

(No message contains `|`: the job subtitle is built in the page template, D-constraint above.)

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && bunx jest tests/components/fleet-log-components.spec.ts tests/i18n`
Expected: PASS (all i18n suites plus 12 component tests, no Vue warnings in the output).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/fleet/FleetLogRows.vue apps/web/components/fleet/FleetLogFilters.vue \
  apps/web/components/fleet/FleetLogNotices.vue apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json \
  apps/web/tests/components/fleet-log-components.spec.ts apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(web): log rows, filters and notices with en/zh copy (S2a §4.1)"
```

---

### Task 7: The viewer page `/[project]/fleet/jobs/[id]/logs` (and the job page move, D352)

**Files:**
- Move: `apps/web/pages/[project]/fleet/jobs/[id].vue` → `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`
- Create: `apps/web/pages/[project]/fleet/jobs/[id]/logs.vue`
- Modify: `apps/web/tests/helpers/mount-sfc.ts` (`NUXT_AUTO_IMPORTS`), `apps/web/tests/pages/fleet-job-detail.spec.ts`,
  `apps/web/tests/pages/fleet-budget-banner-placement.spec.ts` (the moved path)
- Test: `apps/web/tests/pages/fleet-job-logs-page.spec.ts` (create)

**Interfaces:**
- Consumes everything from Tasks 2-6, plus:
  - `useFleetJobs(slug).get`, `useRoute`, `useRouter().replace` and `useI18n`.
  - `useProjectEvents(slug, handlers)`, `createDebouncer` (`~/lib/debounce`) and `extractApiError` (`~/composables/useApi`).
  - `isActiveJobState` and `isTerminalJobState` (`~/lib/fleet-jobs`).
- Produces the route `/<slug>/fleet/jobs/<id>/logs?stream=&epoch=&level=&story=&stage=&role=&q=` and these test ids:
  - `fleet-log-tab-<stream>`, `fleet-log-attempt` (select), `fleet-log-download` and `fleet-log-back`.
  - `fleet-log-following`, `fleet-log-jump`, `fleet-log-scroller`, `fleet-log-earlier` and `fleet-log-more`.
  - `fleet-log-searching`, `fleet-log-keep-searching`, `fleet-log-empty`, `fleet-log-rate-limited` and
    `fleet-log-error`.

- [ ] **Step 1: Move the job page and fix the two specs that read it**

```bash
mkdir -p "apps/web/pages/[project]/fleet/jobs/[id]"
git mv "apps/web/pages/[project]/fleet/jobs/[id].vue" "apps/web/pages/[project]/fleet/jobs/[id]/index.vue"
```

In `tests/pages/fleet-job-detail.spec.ts` and `tests/pages/fleet-budget-banner-placement.spec.ts`, change
`read('pages', '[project]', 'fleet', 'jobs', '[id].vue')` to `read('pages', '[project]', 'fleet', 'jobs', '[id]', 'index.vue')`.

In `tests/helpers/mount-sfc.ts`, append `'useFleetJobLogs'` to `NUXT_AUTO_IMPORTS` (after `'useProjectMemberNames'`),
so a mounted page can receive it as a global.

Run: `cd apps/web && bunx jest tests/pages/fleet-job-detail.spec.ts tests/pages/fleet-budget-banner-placement.spec.ts`
Expected: PASS (nothing else references the old path; `grep -rn "jobs', '\[id\].vue'" apps/web/tests` prints nothing).

- [ ] **Step 2: Write the failing page test**

Create `apps/web/tests/pages/fleet-job-logs-page.spec.ts`:

```ts
import { afterEach, describe, expect, jest, test } from '@jest/globals'
import * as Vue from 'vue'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { mountSfc, webFile, type FakeNode } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import * as apiModule from '../../composables/useApi'
import { ApiError } from '../../composables/useApi'
import type { FleetJobLogEntriesDto, FleetJobLogListDto } from '../../lib/fleet-log-types'
import type { LiveFleetLogEvent, ProjectEventHandlers } from '../../lib/project-event-stream'

const pageFile = webFile('pages', '[project]', 'fleet', 'jobs', '[id]', 'logs.vue')

const page = (over: Partial<FleetJobLogEntriesDto> = {}): FleetJobLogEntriesDto => ({
  entries: [{ offset: 0, length: 40, level: 'info', message: 'started', storyId: 'US-001', stage: 'run' }],
  nextCursor: 0, scannedFrom: 0, scannedTo: 40, atEnd: true, size: 40, complete: false, truncated: false, ...over,
})
const list = (over: Partial<FleetJobLogListDto> = {}): FleetJobLogListDto => ({
  attempts: [{ leaseEpoch: 1, legacySampled: false, streams: [{ stream: 'run', sizeBytes: 40, complete: false, truncated: false, source: 'stream', expired: false, updatedAt: 'x' }] }],
  ...over,
})
const logEvent = (over: Partial<LiveFleetLogEvent> = {}): LiveFleetLogEvent => ({
  id: `e${Math.random()}`, type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 80, complete: false, at: 'x', ...over,
})

function mountPage(opts: { state?: string; list?: FleetJobLogListDto; entries?: Array<FleetJobLogEntriesDto | Error>; query?: Record<string, string> } = {}) {
  const route = reactive({ params: { project: 'koda', id: 'j1' }, query: { ...(opts.query ?? {}) } as Record<string, string>, fullPath: '/koda/fleet/jobs/j1/logs' })
  const replace = jest.fn(async ({ query }: { query: Record<string, string> }) => {
    route.query = query
    route.fullPath = `/koda/fleet/jobs/j1/logs?${new URLSearchParams(query).toString()}`
  })
  const answers = [...(opts.entries ?? [page()])]
  const entries = jest.fn(async (_stream: string, _query: Record<string, string>) => {
    const next = answers.shift() ?? page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 40 })
    if (next instanceof Error) throw next
    return next
  })
  let handlers: ProjectEventHandlers | null = null
  const job = { id: 'j1', feature: 'login', command: 'RUN', state: opts.state ?? 'RUNNING', leaseEpoch: 1, stories: [{ id: 'US-001' }, { id: 'US-002' }] }
  const app = mountSfc(pageFile, {
    components: uiStubs,
    alias: { '~/composables/useApi': apiModule },
    globals: {
      ref, computed, watch, nextTick, onMounted: Vue.onMounted, onBeforeUnmount: Vue.onBeforeUnmount,
      definePageMeta: () => undefined,
      useRoute: () => route,
      useRouter: () => ({ replace }),
      useI18n: () => enI18n(),
      useFleetJobs: () => ({ get: jest.fn(async () => job) }),
      useFleetJobLogs: () => ({
        list: jest.fn(async () => opts.list ?? list()),
        entries,
        downloadHref: (stream: string, epoch: number) => `/api/dl/${stream}/${epoch}`,
      }),
      useProjectEvents: (_slug: string, h: ProjectEventHandlers) => { handlers = h },
    },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
      await nextTick()
    }
  }
  const byId = (id: string): FakeNode[] => app.find(`[data-testid="${id}"]`)
  const click = (id: string): void => (byId(id)[0].props.onClick as () => void)()
  const fire = (event: LiveFleetLogEvent): void => handlers?.onFleetLog?.(event)
  return { app, route, replace, entries, settle, byId, click, fire }
}

afterEach(() => { jest.useRealTimers() })

describe('Job logs page (spec §4.1)', () => {
  test('opens the latest attempt backward from the end and follows a running job', async () => {
    const p = mountPage()
    await p.settle()
    expect(p.entries).toHaveBeenCalledWith('run', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.app.text()).toContain('started')
    expect(p.byId('fleet-log-following')).toHaveLength(1)
    expect(p.byId('fleet-log-download')[0].props.href).toBe('/api/dl/run/1')
    p.app.unmount()
  })

  test('a fleet_log for this job, attempt and stream fetches forward from the tail; others are ignored', async () => {
    const p = mountPage({ entries: [page(), page({ entries: [{ offset: 40, length: 40, level: 'warn', message: 'later' }], nextCursor: 80, scannedFrom: 40, scannedTo: 80, size: 80 })] })
    await p.settle()
    p.fire(logEvent({ jobId: 'other' }))
    p.fire(logEvent({ stream: 'stdout' }))
    p.fire(logEvent({ leaseEpoch: 2 }))
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(1)
    p.fire(logEvent())
    await p.settle()
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'forward', limit: '500', cursor: '40', leaseEpoch: '1' })
    expect(p.app.text()).toContain('later')
    p.app.unmount()
  })

  test('a tab switch and a filter change go through the URL and reopen with the new query', async () => {
    const p = mountPage({ entries: [page(), page({ entries: [{ offset: 0, length: 6, text: 'hello' }] }), page()] })
    await p.settle()
    p.click('fleet-log-tab-stdout')
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { stream: 'stdout' } })
    expect(p.entries).toHaveBeenLastCalledWith('stdout', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.app.text()).toContain('hello')
    ;(p.byId('fleet-log-filter-text')[0].props.onChange as (e: unknown) => void)({ target: { value: 'boom' } })
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { stream: 'stdout', q: 'boom' } })
    expect(p.entries).toHaveBeenLastCalledWith('stdout', { direction: 'backward', limit: '200', leaseEpoch: '1', q: 'boom' })
    p.app.unmount()
  })

  test('a filtered page with no match offers one Keep searching request per click (criterion 3)', async () => {
    const empty = page({ entries: [], nextCursor: 1000, scannedFrom: 1000, scannedTo: 3_098_152, atEnd: false, size: 3_098_152 })
    const p = mountPage({ query: { level: 'error' }, state: 'COMPLETED', entries: [empty, page({ entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 1000, atEnd: true })] })
    await p.settle()
    expect(p.app.textOf(p.byId('fleet-log-searching')[0])).toContain('Searched back to 1000 B of 3.0 MiB')
    p.click('fleet-log-keep-searching')
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(2)
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'backward', limit: '200', cursor: '1000', leaseEpoch: '1', level: 'error' })
    expect(p.byId('fleet-log-searching')).toHaveLength(0)
    expect(p.byId('fleet-log-empty')).toHaveLength(1)
    p.app.unmount()
  })

  test('scrolling up turns follow off; Jump to latest reopens following', async () => {
    const p = mountPage({ entries: [page(), page()] })
    await p.settle()
    const scroller = p.byId('fleet-log-scroller')[0] as FakeNode & Record<string, number>
    Object.assign(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 })
    ;(scroller.props.onScroll as () => void)()
    await p.settle()
    expect(p.byId('fleet-log-following')).toHaveLength(0)
    p.click('fleet-log-jump')
    await p.settle()
    expect(p.entries).toHaveBeenCalledTimes(2)
    expect(p.byId('fleet-log-following')).toHaveLength(1)
    p.app.unmount()
  })

  test('a terminal job with an incomplete stream says so; an expired stream (410) shows only the expired notice', async () => {
    const incomplete = mountPage({ state: 'CRASHED' })
    await incomplete.settle()
    expect(incomplete.byId('fleet-log-notice-incomplete')).toHaveLength(1)
    expect(incomplete.byId('fleet-log-following')).toHaveLength(0)
    incomplete.app.unmount()

    const expired = mountPage({ state: 'COMPLETED', entries: [new ApiError(410, 'This log was deleted after the retention window')] })
    await expired.settle()
    expect(expired.byId('fleet-log-notice-expired')).toHaveLength(1)
    expect(expired.byId('fleet-log-notice-incomplete')).toHaveLength(0)
    expect(expired.byId('fleet-log-scroller')).toHaveLength(0)
    expired.app.unmount()
  })

  test('two attempts show a picker; choosing one puts its epoch in the URL', async () => {
    const two = list({ attempts: [
      { leaseEpoch: 2, legacySampled: false, streams: [] },
      { leaseEpoch: 1, legacySampled: true, streams: [] },
    ] })
    const p = mountPage({ list: two, entries: [page(), page()] })
    await p.settle()
    const picker = p.app.find('[data-stub="fleet-select"]').find((n) => n.props.testid === 'fleet-log-attempt') as FakeNode
    expect(picker.props['model-value']).toBe('2')
    ;(picker.props['onUpdate:modelValue'] as (v: string) => void)('1')
    await p.settle()
    expect(p.replace).toHaveBeenLastCalledWith({ query: { epoch: '1' } })
    expect(p.entries).toHaveBeenLastCalledWith('run', { direction: 'backward', limit: '200', leaseEpoch: '1' })
    expect(p.byId('fleet-log-notice-legacy')).toHaveLength(1)
    p.app.unmount()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bunx jest tests/pages/fleet-job-logs-page.spec.ts`
Expected: FAIL with ENOENT for `pages/[project]/fleet/jobs/[id]/logs.vue`.

- [ ] **Step 4: Implement**

Create `apps/web/pages/[project]/fleet/jobs/[id]/logs.vue`:

```vue
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { entriesQuery, hasActiveFilter, logViewQuery, parseLogViewQuery, type LogFilters, type LogViewParams } from '~/lib/fleet-log-query'
import { LOG_STREAMS, type FleetJobLogListDto, type LogStream } from '~/lib/fleet-log-types'
import { createLogViewer, type LogViewer, type LogViewerState } from '~/lib/fleet-log-viewer'
import { formatBytes, isNearBottom, logNotices } from '~/lib/fleet-log-view'
import { isActiveJobState, isTerminalJobState } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'
import FleetLogFilters from '~/components/fleet/FleetLogFilters.vue'
import FleetLogNotices from '~/components/fleet/FleetLogNotices.vue'
import FleetLogRows from '~/components/fleet/FleetLogRows.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const slug = route.params.project as string
const jobId = route.params.id as string
const { t } = useI18n()
const jobsApi = useFleetJobs(slug)
const logsApi = useFleetJobLogs(slug, jobId)

const job = ref<FleetJobDto | null>(null)
const list = ref<FleetJobLogListDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const state = ref<LogViewerState | null>(null)
/** D355: the attempt the open viewer reads; fixed until the user picks another (a requeue never switches it). */
const activeEpoch = ref<number | null>(null)
const scroller = ref<HTMLElement | null>(null)
let viewer: LogViewer | null = null

const params = computed<LogViewParams>(() => parseLogViewQuery(route.query as Record<string, string | string[] | null>))
const attempt = computed(() => list.value?.attempts.find((a) => a.leaseEpoch === activeEpoch.value) ?? null)
const summary = computed(() => attempt.value?.streams.find((s) => s.stream === params.value.stream) ?? null)
const view = computed(() => state.value?.view ?? null)
const filtered = computed(() => hasActiveFilter(params.value.stream, params.value.filters))
const stories = computed(() => (job.value?.stories ?? []).map((s) => s.id))
const attemptOptions = computed(() => {
  const epochs = list.value?.attempts.map((a) => a.leaseEpoch) ?? []
  const all = activeEpoch.value === null || epochs.includes(activeEpoch.value) ? epochs : [activeEpoch.value, ...epochs]
  return all.map((epoch) => ({ value: String(epoch), label: t('fleet.logs.attemptOption', { epoch }) }))
})
const notices = computed(() => logNotices({
  summary: summary.value,
  legacySampled: attempt.value?.legacySampled ?? false,
  view: view.value,
  jobTerminal: job.value !== null && isTerminalJobState(job.value.state),
  expired: state.value?.expired ?? false,
}))
const downloadHref = computed(() => (activeEpoch.value !== null && summary.value && !summary.value.expired && summary.value.sizeBytes > 0
  ? logsApi.downloadHref(params.value.stream, activeEpoch.value)
  : null))
const timelineHref = `/${slug}/fleet/jobs/${jobId}#timeline`

function navigate(next: LogViewParams): void {
  void router.replace({ query: logViewQuery(next) })
}
const selectStream = (stream: LogStream): void => navigate({ ...params.value, stream })
const selectAttempt = (value: string): void => navigate({ ...params.value, epoch: Number(value) })
const updateFilters = (filters: LogFilters): void => navigate({ ...params.value, filters })

async function scrollToEnd(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/** One viewer per (stream, attempt, filters): a change disposes the old one, so its late answers are dropped. */
function startViewer(): void {
  viewer?.dispose()
  const current = job.value
  if (!current) return
  const p = params.value
  const epoch = p.epoch ?? list.value?.attempts[0]?.leaseEpoch ?? current.leaseEpoch
  activeEpoch.value = epoch
  state.value = null
  const next = createLogViewer({
    fetchPage: (page) => logsApi.entries(p.stream, entriesQuery(p, epoch, page)),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    filtered: hasActiveFilter(p.stream, p.filters),
    onChange: (s) => {
      state.value = s
      if (s.follow) void scrollToEnd()
    },
    describeError: extractApiError,
  }, { follow: isActiveJobState(current.state) })
  viewer = next
  void next.open()
}

function onScroll(): void {
  const el = scroller.value
  if (el && state.value?.follow && !isNearBottom(el)) viewer?.setFollow(false)
}

async function loadList(): Promise<void> {
  list.value = await logsApi.list()
}

async function load(): Promise<void> {
  pending.value = true
  try {
    const [loadedJob] = await Promise.all([jobsApi.get(jobId), loadList()])
    job.value = loadedJob
    loadFailed.value = false
    startViewer()
  }
  catch {
    loadFailed.value = true
  }
  finally {
    pending.value = false
  }
}

onMounted(load)
watch(() => route.fullPath, () => { if (job.value) startViewer() })

/** Live (spec §4.1): never flips `pending`; a failure waits for the next event. */
const jobReload = createDebouncer(() => { void jobsApi.get(jobId).then((j) => { job.value = j }).catch(() => undefined) }, 300)
const listReload = createDebouncer(() => { void loadList().catch(() => undefined) }, 300)
onBeforeUnmount(() => {
  viewer?.dispose()
  jobReload.cancel()
  listReload.cancel()
})
useProjectEvents(slug, {
  onFleetLog: (event) => {
    if (event.jobId !== jobId) return
    if (event.leaseEpoch === activeEpoch.value && event.stream === params.value.stream) void viewer?.onGrowth()
    const known = list.value?.attempts.some((a) => a.leaseEpoch === event.leaseEpoch && a.streams.some((s) => s.stream === event.stream)) ?? false
    if (event.complete || !known) listReload.trigger()
  },
  onFleetJob: (event) => {
    if (event.jobId === jobId) jobReload.trigger()
  },
  onResync: () => {
    jobReload.trigger()
    listReload.trigger()
    void viewer?.onGrowth()
  },
})
</script>

<template>
  <div class="space-y-4">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !job" @retry="load()" />
    <template v-else>
      <PageHeader :title="t('fleet.logs.title')" :subtitle="`${job.feature} | ${job.command}`">
        <template #actions>
          <a
            v-if="downloadHref"
            :href="downloadHref"
            download
            class="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-muted"
            data-testid="fleet-log-download"
          >{{ t('fleet.logs.download') }}</a>
          <NuxtLink :to="`/${slug}/fleet/jobs/${jobId}`" class="inline-flex h-9 items-center px-3 text-sm text-primary underline-offset-4 hover:underline" data-testid="fleet-log-back">
            {{ t('fleet.logs.back') }}
          </NuxtLink>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-center gap-3">
        <div class="flex gap-1" role="tablist">
          <Button
            v-for="stream in LOG_STREAMS"
            :key="stream"
            role="tab"
            size="sm"
            :variant="stream === params.stream ? 'default' : 'outline'"
            :aria-selected="stream === params.stream"
            :data-testid="`fleet-log-tab-${stream}`"
            @click="selectStream(stream)"
          >
            {{ t(`fleet.logs.streams.${stream}`) }}
          </Button>
        </div>
        <label v-if="attemptOptions.length > 1" class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ t('fleet.logs.attempt') }}</span>
          <FleetNativeSelect :model-value="String(activeEpoch)" :options="attemptOptions" testid="fleet-log-attempt" @update:model-value="selectAttempt($event)" />
        </label>
      </div>

      <FleetLogFilters :stream="params.stream" :filters="params.filters" :stories="stories" @update="updateFilters($event)" />
      <FleetLogNotices :notices="notices" :timeline-href="timelineHref" :truncated-at="view?.size ?? summary?.sizeBytes ?? 0" />

      <p v-if="state?.rateLimited" class="text-sm text-muted-foreground" data-testid="fleet-log-rate-limited">{{ t('fleet.logs.rateLimited') }}</p>
      <p v-if="state?.error" class="text-sm text-destructive" data-testid="fleet-log-error">{{ state.error }}</p>

      <section v-if="!state?.expired" class="rounded-md border border-border">
        <div class="flex items-center justify-end gap-2 border-b border-border px-2 py-1 text-xs">
          <span v-if="state?.follow" class="text-muted-foreground" data-testid="fleet-log-following">{{ t('fleet.logs.following') }}</span>
          <Button v-else variant="ghost" size="sm" :disabled="state?.loading" data-testid="fleet-log-jump" @click="viewer?.jumpToLatest()">
            {{ t('fleet.logs.jumpToLatest') }}
          </Button>
        </div>
        <div ref="scroller" class="max-h-[70vh] overflow-auto" data-testid="fleet-log-scroller" @scroll="onScroll()">
          <div v-if="view && !view.atStart" class="p-2">
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-earlier" @click="viewer?.loadEarlier()">{{ t('fleet.logs.loadEarlier') }}</Button>
          </div>
          <p v-if="view?.searching?.direction === 'backward'" class="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground" data-testid="fleet-log-searching">
            {{ t('fleet.logs.searching.backward', { scanned: formatBytes(view.searching.scannedFrom), size: formatBytes(view.size) }) }}
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-keep-searching" @click="viewer?.keepSearching()">{{ t('fleet.logs.searching.keep') }}</Button>
          </p>
          <FleetLogRows v-if="view" :stream="params.stream" :rows="view.rows" />
          <p v-if="view && view.rows.length === 0 && !view.searching" class="p-4 text-sm text-muted-foreground" data-testid="fleet-log-empty">
            {{ filtered ? t('fleet.logs.emptyFiltered') : t('fleet.logs.empty') }}
          </p>
          <p v-if="view?.searching?.direction === 'forward'" class="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground" data-testid="fleet-log-searching">
            {{ t('fleet.logs.searching.forward', { scanned: formatBytes(view.searching.scannedTo), size: formatBytes(view.size) }) }}
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-keep-searching" @click="viewer?.keepSearching()">{{ t('fleet.logs.searching.keep') }}</Button>
          </p>
          <div v-else-if="view && !view.atEnd && !state?.follow" class="p-2">
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-more" @click="viewer?.loadMore()">{{ t('fleet.logs.loadMore') }}</Button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Run the tests, lint and types**

Run: `cd apps/web && bunx jest tests/pages tests/components tests/lib && bun run lint && bun run type-check`
Expected: PASS. The page spec has 7 tests. Lint and `nuxt typecheck` are clean.

- [ ] **Step 6: Commit**

```bash
git add -A "apps/web/pages/[project]/fleet/jobs" apps/web/tests/helpers/mount-sfc.ts \
  apps/web/tests/pages/fleet-job-detail.spec.ts apps/web/tests/pages/fleet-budget-banner-placement.spec.ts \
  apps/web/tests/pages/fleet-job-logs-page.spec.ts
git commit -m "feat(web): job log viewer page with live follow and URL filters (S2a §4.1, D352, D355)"
```

---

### Task 8: Job page and timeline: Logs link, expired bundle, "Full log" rows

**Files:**
- Create: `apps/web/lib/fleet-job-logs-link.ts`
- Modify: `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`, `apps/web/components/fleet/FleetJobTimeline.vue`
- Test: `apps/web/tests/lib/fleet-job-logs-link.spec.ts`, `apps/web/tests/components/fleet-job-timeline-logs.spec.ts`
  (create both); `apps/web/tests/pages/fleet-job-detail.spec.ts` (modify)

**Interfaces:**
- Consumes: `useFleetJobLogs(slug, jobId).list` and `FleetJobLogListDto` (Task 2); `ApiError` (`~/composables/useApi`).
- Produces:
  - `logAttemptEpochs(list): number[]` and `bundleExpiredByLogs(list): boolean` (`~/lib/fleet-job-logs-link`).
  - `FleetJobTimeline` props `logAttempts?: readonly number[]` and `logsHref?: string`, the section `id="timeline"`,
    and test id `fleet-job-timeline-logs`.
  - Job page test id `fleet-job-logs-link`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/lib/fleet-job-logs-link.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { bundleExpiredByLogs, logAttemptEpochs } from '~/lib/fleet-job-logs-link'
import type { FleetJobLogAttemptDto, FleetJobLogStreamDto } from '~/lib/fleet-log-types'

const stream = (over: Partial<FleetJobLogStreamDto> = {}): FleetJobLogStreamDto => ({
  stream: 'run', sizeBytes: 10, complete: true, truncated: false, source: 'stream', expired: false, updatedAt: 'x', ...over,
})
const attempt = (leaseEpoch: number, streams: FleetJobLogStreamDto[], legacySampled = false): FleetJobLogAttemptDto => ({ leaseEpoch, legacySampled, streams })

describe('logAttemptEpochs (spec §4.2)', () => {
  test('only attempts with stored streams, latest first; nothing before the list loads', () => {
    expect(logAttemptEpochs({ attempts: [attempt(3, [stream()]), attempt(2, [], true), attempt(1, [stream()])] })).toEqual([3, 1])
    expect(logAttemptEpochs(null)).toEqual([])
  })
})

describe('bundleExpiredByLogs (D357)', () => {
  test('the latest attempt has an expired stream: the bundle is gone too', () => {
    expect(bundleExpiredByLogs({ attempts: [attempt(1, [stream({ expired: true })])] })).toBe(true)
  })

  test('a newer attempt after a requeue, or a newer v1/v2 attempt without streams, keeps the button', () => {
    expect(bundleExpiredByLogs({ attempts: [attempt(2, [stream()]), attempt(1, [stream({ expired: true })])] })).toBe(false)
    expect(bundleExpiredByLogs({ attempts: [attempt(2, [], true), attempt(1, [stream({ expired: true })])] })).toBe(false)
    expect(bundleExpiredByLogs(null)).toBe(false)
  })
})
```

Create `apps/web/tests/components/fleet-job-timeline-logs.spec.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { computed } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'

const file = webFile('components', 'fleet', 'FleetJobTimeline.vue')
const mount = (props: Record<string, unknown>) =>
  mountSfc(file, { props: { events: [], hasMore: false, loading: false, ...props }, globals: { computed, useI18n: () => enI18n() }, components: uiStubs })

describe('FleetJobTimeline log rows (spec §4.2)', () => {
  test('one "Full log" row per attempt, linking to the viewer for that attempt', () => {
    const m = mount({ logAttempts: [2, 1], logsHref: '/koda/fleet/jobs/j1/logs' })
    const links = m.find('[data-testid="fleet-job-timeline-logs"]')
    expect(links.map((l) => l.props.to)).toEqual([
      { path: '/koda/fleet/jobs/j1/logs', query: { epoch: '2' } },
      { path: '/koda/fleet/jobs/j1/logs', query: { epoch: '1' } },
    ])
    expect(m.textOf(links[0])).toContain('Full log of attempt 2')
    m.unmount()
  })

  test('no attempts, or no href (older callers), render no rows; the section is the #timeline anchor', () => {
    const none = mount({ logAttempts: [], logsHref: '/x' })
    expect(none.find('[data-testid="fleet-job-timeline-logs"]')).toHaveLength(0)
    expect(none.find('[data-testid="fleet-job-timeline"]')[0].props.id).toBe('timeline')
    none.unmount()
    const legacy = mount({})
    expect(legacy.find('[data-testid="fleet-job-timeline-logs"]')).toHaveLength(0)
    legacy.unmount()
  })
})
```

Append inside `describe('job detail', …)` of `apps/web/tests/pages/fleet-job-detail.spec.ts`:

```ts
  test('S2a §4.2: Logs link, expired bundle, timeline log rows, and a list reload for a new attempt (D357)', () => {
    expect(detail).toContain('data-testid="fleet-job-logs-link"')
    expect(detail).toContain('const logsHref = `/${slug}/fleet/jobs/${jobId}/logs`')
    expect(detail).toContain(':disabled="busy || bundleExpired"')
    expect(detail).toContain("bundleExpired ? t('fleet.jobs.actions.bundleExpired') : t('fleet.jobs.actions.bundle')")
    expect(detail).toContain('if (err instanceof ApiError && err.code === 410) bundleGone.value = true')
    expect(detail).toContain(':log-attempts="logAttempts" :logs-href="logsHref"')
    expect(detail).toMatch(/function initializeRelatedData\(\): void[\s\S]*?void loadLogList\(\)\.catch\(\(\) => undefined\)/)
    expect(detail).toMatch(/async function reloadSilently\(\)[\s\S]*?await loadLogList\(\)/)
    expect(liveHandlers(detail)).toContain('if (event.jobId === jobId && !logAttempts.value.includes(event.leaseEpoch)) liveReload.trigger()')
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx jest tests/lib/fleet-job-logs-link.spec.ts tests/components/fleet-job-timeline-logs.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: FAIL. The module is missing, the timeline renders no `fleet-job-timeline-logs` links and has no `id`, and
the detail-page source assertions fail.

- [ ] **Step 3: Implement**

Create `apps/web/lib/fleet-job-logs-link.ts`:

```ts
import type { FleetJobLogListDto } from '~/lib/fleet-log-types'

/** S2a §4.2: attempts whose log streams the server stores (a v3 runner, or the bundle fallback), latest first. */
export function logAttemptEpochs(list: FleetJobLogListDto | null): number[] {
  return (list?.attempts ?? []).filter((a) => a.streams.length > 0).map((a) => a.leaseEpoch)
}

/**
 * D357: retention expires an attempt's logs and bundle together (spec §5), so an expired stream in the latest attempt
 * means the bundle is gone too. A job whose latest attempt has no streams (a v1/v2 runner) learns it from the
 * download's 410 instead.
 */
export function bundleExpiredByLogs(list: FleetJobLogListDto | null): boolean {
  const latest = list?.attempts[0]
  return latest !== undefined && latest.streams.some((s) => s.expired)
}
```

In `apps/web/components/fleet/FleetJobTimeline.vue`, replace the `defineProps` line with:

```ts
const props = withDefaults(defineProps<{
  events: FleetJobEventDto[]
  hasMore: boolean
  loading: boolean
  /** S2a §4.2: attempts with stored log streams, latest first; each gets a "Full log" row. */
  logAttempts?: readonly number[]
  logsHref?: string
}>(), { logAttempts: () => [], logsHref: '' })
```

and replace the section's opening and heading with:

```vue
  <section id="timeline" class="space-y-3" data-testid="fleet-job-timeline">
    <h2 class="text-lg font-semibold">{{ t('fleet.jobs.timeline.title') }}</h2>
    <ul v-if="logsHref && logAttempts.length > 0" class="space-y-1 text-sm">
      <li v-for="epoch in logAttempts" :key="epoch">
        <NuxtLink :to="{ path: logsHref, query: { epoch: String(epoch) } }" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-timeline-logs">
          {{ t('fleet.jobs.timeline.logs', { epoch }) }} &rarr;
        </NuxtLink>
      </li>
    </ul>
```

In `apps/web/pages/[project]/fleet/jobs/[id]/index.vue`, make these changes:

1. Change the import `import { extractApiError } from '~/composables/useApi'` to
   `import { ApiError, extractApiError } from '~/composables/useApi'`. After the `FleetJobApprovals` import, add:

```ts
import { bundleExpiredByLogs, logAttemptEpochs } from '~/lib/fleet-job-logs-link'
import type { FleetJobLogListDto } from '~/lib/fleet-log-types'
```

2. Directly before `const approvalsApi = useFleetApprovals({ kind: 'project', slug })`, add:

```ts
const logsApi = useFleetJobLogs(slug, jobId)
/** S2a §4.2: the log list drives the timeline's "Full log" rows and the expired-bundle button. */
const logList = ref<FleetJobLogListDto | null>(null)
/** D357: a bundle download answered 410. */
const bundleGone = ref(false)
```

3. After `const showBundle = computed(...)`, add:

```ts
const bundleExpired = computed(() => bundleGone.value || bundleExpiredByLogs(logList.value))
const logAttempts = computed(() => logAttemptEpochs(logList.value))
const logsHref = `/${slug}/fleet/jobs/${jobId}/logs`
```

4. After `async function loadApprovals()`, add:

```ts
async function loadLogList(): Promise<void> {
  logList.value = await logsApi.list()
}
```

5. In `initializeRelatedData()`, after the `loadApprovals()` line, add:

```ts
  // Logs are secondary too: without the list the timeline has no "Full log" rows, the header link still works.
  void loadLogList().catch(() => undefined)
```

6. In `reloadSilently()`, after `await loadApprovals()`, add `await loadLogList()`.
7. In the `useProjectEvents(slug, { ... })` handlers, after `onFleetApproval: () => liveReload.trigger(),`, add (D363):

```ts
  // A new attempt's first bytes add its "Full log" row; growth of a known stream changes nothing here.
  onFleetLog: (event) => {
    if (event.jobId === jobId && !logAttempts.value.includes(event.leaseEpoch)) liveReload.trigger()
  },
```

8. Replace `const downloadBundle = (): Promise<void> => act(() => jobsApi.downloadBundle(jobId))` with:

```ts
/** D357: a 410 turns the button into "Bundle expired" for the rest of the visit. */
const downloadBundle = (): Promise<void> => act(async () => {
  try {
    await jobsApi.downloadBundle(jobId)
  }
  catch (err: unknown) {
    if (err instanceof ApiError && err.code === 410) bundleGone.value = true
    throw err
  }
})
```

9. In the header `#actions`, replace the bundle `<Button …>` with:

```vue
          <NuxtLink :to="logsHref" class="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm hover:bg-muted" data-testid="fleet-job-logs-link">
            {{ t('fleet.jobs.actions.logs') }}
          </NuxtLink>
          <Button v-if="showBundle" variant="outline" :disabled="busy || bundleExpired" data-testid="fleet-job-bundle" @click="downloadBundle()">
            {{ bundleExpired ? t('fleet.jobs.actions.bundleExpired') : t('fleet.jobs.actions.bundle') }}
          </Button>
```

10. Pass the log rows to the timeline:

```vue
      <FleetJobTimeline :events="events" :has-more="moreEvents" :loading="loadingEvents" :log-attempts="logAttempts" :logs-href="logsHref" @load-more="loadEventsFrom(eventPage + 1)" />
```

- [ ] **Step 4: Run the tests, the whole web suite, lint and types**

Run: `cd apps/web && bunx jest tests/lib/fleet-job-logs-link.spec.ts tests/components/fleet-job-timeline-logs.spec.ts tests/pages/fleet-job-detail.spec.ts`
Expected: PASS (17 tests).
Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Expected: PASS (whole suite, about 2,830 tests; lint and types clean).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-job-logs-link.ts apps/web/components/fleet/FleetJobTimeline.vue \
  "apps/web/pages/[project]/fleet/jobs/[id]/index.vue" apps/web/tests/lib/fleet-job-logs-link.spec.ts \
  apps/web/tests/components/fleet-job-timeline-logs.spec.ts apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): job page Logs link, expired bundle and timeline log rows (S2a §4.2, D357, D362, D363)"
```

---

### Task 9: E2E: a v3 scripted runner, real log uploads and a real tar.gz (spec §8 E2E (1)(2))

**Files:**
- Modify: `apps/web/package.json` (devDependency), `bun.lock`, `apps/web/tests/e2e/fixtures/scripted-runner.ts`
- Test: `apps/web/tests/e2e/fleet-logs.e2e.spec.ts` (create)

**Interfaces:**
- Consumes the API upload route `PUT /api/fleet/runner/jobs/:jobId/logs/:stream?leaseEpoch&offset[&final=1]`
  (octet-stream, `X-Content-SHA256` of the chunk, HTTP 200 `{ ret: 0, data: { outcome, size } }`). It also uses the
  bundle route and the fallback's member names (`nax.stdout`, `nax.stderr`, `nax-out/features/<feature>/runs/*.jsonl`),
  plus the existing fixtures `login`, `E2E_ADMIN`, `call`, `dispatchRun`, `repoIdOf`, `webLogin` and `waitForHydration`.
- Produces:
  - `ScriptedRunner.enroll(token, name, { logs: true })`, which speaks protocol 3.
  - `ScriptedRunner.putLog(lease, stream, offset, text, final?)`, which returns `Promise<LogUploadAnswer>`.
  - `ScriptedRunner.uploadTarBundle(lease, members: Record<string, string>)`.
  - `LogUploadAnswer`.

- [ ] **Step 1: Add `tar-stream` to the web devDependencies**

In `apps/web/package.json` `devDependencies`, add `"tar-stream": "^3.2.2",` after `"jest": "^29.7.0",` (the API
already depends on this version; it ships its own types). Run `bun install` at the repo root.
Expected: "Saved lockfile"; `git diff --stat bun.lock` shows one line, and `apps/web/node_modules/tar-stream` exists.

- [ ] **Step 2: Extend the scripted runner**

In `apps/web/tests/e2e/fixtures/scripted-runner.ts`:

1. Add `import { pack } from 'tar-stream';` after the `node:zlib` import.
2. After `type EventType = …;`, add:

```ts
/** S2a §2.2 (D307): the 200 body of a log upload. */
export interface LogUploadAnswer {
  outcome: 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';
  size: number;
  retryAfterMs?: number;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A tar.gz with one regular file per entry, laid out like the runner's bundle (S2a §2.5 member names). */
async function tarGz(members: Readonly<Record<string, string>>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: unknown) => { chunks.push(Buffer.from(chunk as Uint8Array)); });
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const [name, text] of Object.entries(members)) archive.entry({ name, mtime: new Date() }, text);
  archive.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}
```

3. Replace the `enroll` doc comment's last line and its first two code lines with:

```ts
   * With `logs` it speaks protocol v3 (S2a R1): it streams logs over `putLog` and sends no `log` sync events.
   */
  static async enroll(adminToken: string, name: string, opts: { relay?: boolean; logs?: boolean } = {}): Promise<ScriptedRunner> {
    const protocolVersion = opts.logs ? 3 : opts.relay ? 2 : 1;
```

4. Replace `uploadBundle` with these four methods, so `uploadBundle` keeps its signature for the existing specs:

```ts
  /** PUT the run bundle (accepted while RUNNING or UPLOADING, spec §3.3). */
  async uploadBundle(lease: Lease, content: string): Promise<void> {
    await this.putBundle(lease, gzipSync(Buffer.from(content, 'utf8')));
  }

  /** PUT a real tar.gz bundle whose members the API's log fallback reads (S2a §2.5), e.g. `nax.stdout`. */
  async uploadTarBundle(lease: Lease, members: Readonly<Record<string, string>>): Promise<void> {
    await this.putBundle(lease, await tarGz(members));
  }

  private async putBundle(lease: Lease, body: Buffer): Promise<void> {
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/bundle?leaseEpoch=${lease.leaseEpoch}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/gzip', 'X-Content-SHA256': sha256Hex(body) },
      body: new Uint8Array(body),
    });
    if (res.status !== 201) throw new Error(`Bundle upload failed: ${res.status} ${await res.text()}`);
  }

  /**
   * S2a §2.2: append `text` to one log stream at `offset` (the bytes the server holds), like the runner's LogShipper.
   * `final` marks the stream complete. Throws unless the server answers HTTP 200.
   */
  async putLog(lease: Lease, stream: 'run' | 'stdout' | 'stderr', offset: number, text: string, final = false): Promise<LogUploadAnswer> {
    const body = Buffer.from(text, 'utf8');
    const query = `leaseEpoch=${lease.leaseEpoch}&offset=${offset}${final ? '&final=1' : ''}`;
    const res = await fetch(`${API_URL}/api/fleet/runner/jobs/${lease.jobId}/logs/${stream}?${query}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha256Hex(body) },
      body,
    });
    const raw = await res.text();
    if (res.status !== 200) throw new Error(`Log upload failed: ${res.status} ${raw}`);
    return (JSON.parse(raw) as { data: LogUploadAnswer }).data;
  }
```

Run: `cd apps/web && bun run type-check && bun run lint`
Expected: PASS. If `nuxt typecheck` flags the `data` handler or the fetch body, keep the shapes exactly as above:
`(chunk: unknown)` and `body: new Uint8Array(body)`. tar-stream's streamx `on` is typed `unknown`, and a
`Buffer<ArrayBufferLike>` is not a `BodyInit`.

- [ ] **Step 3: Write the E2E spec**

Create `apps/web/tests/e2e/fleet-logs.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { login, E2E_ADMIN } from './fixtures/api-client';
import { call, dispatchRun, repoIdOf } from './fixtures/fleet-budgets-api';
import { waitForHydration, webLogin } from './fixtures/page-helpers';
import { ScriptedRunner, type Lease } from './fixtures/scripted-runner';

/**
 * Fleet S2a slice 2 (spec §8 E2E (1) and (2)): a protocol v3 scripted runner streams logs over the upload route.
 * (1) The viewer follows a RUNNING job live, filters server-side, and scrolling up stops following.
 * (2) The run stream is cut before `final`; the bundle carries the full run log and the fallback fills it.
 * API polls stay at one request per 2 s (the global throttle is 100 a minute; /fleet/runner/* is exempt).
 * Project `fleet-e2e` and repo acme/e2e-app come from prisma/seed-e2e.ts.
 */
const SLUG = 'fleet-e2e';
const POLL = { intervals: [2_000] };

interface LogStreamRow { stream: string; complete: boolean; source: string }
interface LogList { attempts: Array<{ leaseEpoch: number; streams: LogStreamRow[] }> }

/** One nax LogEntry line (the run JSONL), newline included. */
const entry = (level: string, storyId: string, message: string): string =>
  `${JSON.stringify({ timestamp: '2026-10-04T10:00:00.000Z', level, stage: 'execution', storyId, message })}\n`;

test.describe('Fleet logs viewer (scripted v3 runner)', () => {
  let token = '';
  let runner: ScriptedRunner;
  let repoId = '';
  const suffix = Date.now().toString().slice(-6);

  test.beforeAll(async () => {
    const session = await login(E2E_ADMIN.email, E2E_ADMIN.password);
    token = session.token;
    runner = await ScriptedRunner.enroll(token, `e2e-logs-runner-${suffix}`, { logs: true });
    repoId = await repoIdOf(token, SLUG, 'acme/e2e-app');
  });

  async function startJob(feature: string): Promise<{ jobId: string; lease: Lease }> {
    await runner.heartbeat();
    const jobId = await dispatchRun(token, SLUG, { repoId, feature, maxCostUsd: 3, pinnedRunnerId: runner.id });
    const lease = await runner.acceptAssign(jobId);
    await runner.report(lease, [{ type: 'state', payload: { to: 'RUNNING' } }]);
    return { jobId, lease };
  }

  async function complete(lease: Lease): Promise<void> {
    await runner.report(lease, [{ type: 'state', payload: { to: 'COMPLETED', exitCode: 0 } }]);
  }

  const listLogs = (jobId: string): Promise<LogList> => call<LogList>('GET', `/projects/${SLUG}/fleet/jobs/${jobId}/logs`, token);

  test('(1) a running job streams into the viewer live; story and level filters apply; scrolling up stops following', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `logs-live-${suffix}`;
    const { jobId, lease } = await startJob(feature);
    // Enough rows to scroll: 150 debug lines, then one line per story at info and warn.
    const filler = Array.from({ length: 150 }, (_, i) => entry('debug', 'US-001', `filler ${i}`)).join('');
    const first = `${filler}${entry('info', 'US-001', 'story one started')}${entry('warn', 'US-002', 'story two flaky')}`;
    const ack = await runner.putLog(lease, 'run', 0, first);
    expect(ack).toEqual({ outcome: 'appended', size: Buffer.byteLength(first) });

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await page.getByTestId('fleet-job-logs-link').click();
    await page.waitForURL(new RegExp(`/${SLUG}/fleet/jobs/${jobId}/logs$`));
    await waitForHydration(page);
    const rows = page.getByTestId('fleet-log-row');
    await expect(page.getByTestId('fleet-log-following')).toBeVisible();
    await expect(rows.last()).toContainText('story two flaky');

    // A line written while the viewer is open arrives through fleet_log + a forward fetch, with no reload.
    const later = entry('error', 'US-002', 'story two failed');
    await runner.putLog(lease, 'run', Buffer.byteLength(first), later);
    await expect(rows.last()).toContainText('story two failed', { timeout: 15_000 });

    // Scrolling away from the bottom stops following; Jump to latest brings it back.
    await page.getByTestId('fleet-log-scroller').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(page.getByTestId('fleet-log-jump')).toBeVisible();
    await expect(page.getByTestId('fleet-log-following')).toHaveCount(0);
    await page.getByTestId('fleet-log-jump').click();
    await expect(page.getByTestId('fleet-log-following')).toBeVisible();

    // Story filter (applied on Enter), then a minimum level: both live in the URL and filter server-side.
    await page.getByTestId('fleet-log-filter-story').fill('US-002');
    await page.getByTestId('fleet-log-filter-story').press('Enter');
    await page.waitForURL(/story=US-002/);
    await expect(rows).toHaveCount(2);
    await page.getByTestId('fleet-log-filter-level').selectOption('error');
    await page.waitForURL(/level=error/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('story two failed');
    await expect(rows.first().getByTestId('fleet-log-level')).toHaveText('ERROR');

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.putLog(lease, 'run', Buffer.byteLength(first) + Buffer.byteLength(later), '', true);
    await complete(lease);
  });

  test('(2) the run stream is cut before final; the bundle fills it and the viewer says so', async ({ page }) => {
    test.setTimeout(150_000);
    const feature = `logs-fallback-${suffix}`;
    const { jobId, lease } = await startJob(feature);
    const stdout = 'build ok\ntests ok\n';
    const runLines = [entry('info', 'US-001', 'one'), entry('info', 'US-001', 'two'), entry('info', 'US-001', 'three'), entry('info', 'US-001', 'four from the bundle')];
    await runner.putLog(lease, 'stdout', 0, stdout, true);
    await runner.putLog(lease, 'run', 0, runLines.slice(0, 2).join(''));    // no final: the upload "died" here

    await runner.report(lease, [{ type: 'state', payload: { to: 'UPLOADING' } }]);
    await runner.uploadTarBundle(lease, {
      'nax.stdout': stdout,
      'nax.stderr': '',
      [`nax-out/features/${feature}/runs/run-1.jsonl`]: runLines.join(''),
    });
    await complete(lease);
    // The fallback runs after the bundle response (spec §2.5): wait until the run stream reads complete from the bundle.
    await expect.poll(async () => (await listLogs(jobId)).attempts[0]?.streams.find((s) => s.stream === 'run'), { timeout: 20_000, ...POLL })
      .toMatchObject({ complete: true, source: 'bundle' });

    await webLogin(page);
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}/logs`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-log-notice-bundle')).toBeVisible();
    await expect(page.getByTestId('fleet-log-row')).toHaveCount(4);
    await expect(page.getByTestId('fleet-log-row').last()).toContainText('four from the bundle');
    await expect(page.getByTestId('fleet-log-following')).toHaveCount(0);

    // stdout was complete from the stream: no bundle notice, its own text, and a download link.
    await page.getByTestId('fleet-log-tab-stdout').click();
    await page.waitForURL(/stream=stdout/);
    await expect(page.getByTestId('fleet-log-notice-bundle')).toHaveCount(0);
    await expect(page.getByTestId('fleet-log-row')).toHaveCount(2);
    await expect(page.getByTestId('fleet-log-download')).toHaveAttribute('href', `/api/projects/${SLUG}/fleet/jobs/${jobId}/logs/stdout/raw?download=1&leaseEpoch=${lease.leaseEpoch}`);

    // The job page links the attempt's full log from the timeline.
    await page.goto(`/${SLUG}/fleet/jobs/${jobId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('fleet-job-timeline-logs')).toHaveCount(1);
  });
});
```

- [ ] **Step 4: Run the logs E2E, then every fleet E2E (the job page moved in Task 7)**

Ask the user to consent to the `koda_e2e` reset first (Global Constraints). Then:

```bash
cd apps/api && bun run test:db:up
cd ../web && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<consent text>" bunx playwright test tests/e2e/fleet-logs.e2e.spec.ts --reporter=line
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<consent text>" bunx playwright test tests/e2e/fleet-*.e2e.spec.ts --reporter=line
```

Expected: `2 passed`, then `9 passed`. The run takes about 25 s and then about 1.5 min; Playwright starts the API on
:3102 and the web on :3103 itself.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/tests/e2e/fixtures/scripted-runner.ts apps/web/tests/e2e/fleet-logs.e2e.spec.ts
git commit -m "test(web): e2e for the live log viewer and the bundle fallback with a v3 scripted runner (S2a §8, D361)"
```

---

### Task 10: Unbilled live check: a real daemon process, ~66 MiB of logs, two SIGKILLs (spec §8, D360)

**Files:**
- Modify: `apps/runner/test/fixtures/fake-nax.ts`, `apps/runner/test/integration/harness/world.ts`,
  `apps/runner/test/integration/harness/index.ts`
- Test: `apps/runner/test/live/log-shipping.live.spec.ts` (create)

**Interfaces:**
- Consumes these harness pieces:
  - `createWorld()` and `World.addRunner(name)`, which give `TestRunner.home.dir` and `jobDir(id)`.
  - `World.dispatch`, `waitForJob`, `events`, `prisma`, `api.url` and `base`.
  - `findRunLog(outDir, feature)` and `isProcessAlive(pid)`.
  - `waitFor` from `test/helpers/wait.ts`.
  - The CLI `src/main.ts`: `--home <dir> run`.
- Produces:
  - Fake nax env `FAKE_NAX_PACE_MS` and `FAKE_NAX_STDIO_BYTES`.
  - `World.adminToken: string`, `HARNESS_ADMIN { email, password }` and feature `lv` in `FEATURES`.

- [ ] **Step 1: Pace the fake nax and give it big stdout/stderr**

In `test/fixtures/fake-nax.ts`, add `writeSync` to the `node:fs` import. Then replace the padding loop (the
`const padTo …` line through the end of its `for` block) with:

```ts
  const padTo = Number(process.env['FAKE_NAX_LOG_BYTES'] ?? 0);
  const padLine = `${JSON.stringify({ level: 'debug', msg: 'pad', data: 'p'.repeat(980) })}\n`;
  // S2a slice 2 D360 (live check): FAKE_NAX_PACE_MS sleeps between batches, so the log grows over minutes with a fresh
  // heartbeat (READOPT needs one); FAKE_NAX_STDIO_BYTES writes that much stdout and stderr alongside, 64 KiB a batch.
  const paceMs = Number(process.env['FAKE_NAX_PACE_MS'] ?? 0);
  const stdioBytes = Number(process.env['FAKE_NAX_STDIO_BYTES'] ?? 0);
  let stdioWritten = 0;
  for (let written = existsSync(join(runsDir, logName)) ? statSync(join(runsDir, logName)).size : 0; written < padTo;) {
    const batch = padLine.repeat(64);
    appendFileSync(join(runsDir, logName), batch);
    written += batch.length;
    if (stdioWritten < stdioBytes) {
      const line = `stdio ${stdioWritten} ${'o'.repeat(1000)}\n`.repeat(64);
      writeSync(1, line);                                            // fd 1/2 are nax.stdout/nax.stderr (the runner's spawn)
      writeSync(2, line.replaceAll('o', 'e'));
      stdioWritten += line.length;
    }
    if (paceMs > 0) {
      flush();
      await sleep(paceMs);
    }
  }
```

(`writeSync(1|2)` writes through the fds the runner opened for `nax.stdout`/`nax.stderr`. Appending to those paths by
name would race the process's own fd offset.)

- [ ] **Step 2: Expose the admin token, the admin login and a feature for the check**

In `test/integration/harness/world.ts`:
- Add `'lv'` to the end of `FEATURES`.
- After `const PASSWORD = 'Admin1234!Aa';`, add:

```ts
/** The admin `createWorld` registers; S2a slice 2's live check prints it for a manual look at the web viewer. */
export const HARNESS_ADMIN = { email: 'root@koda.test', password: PASSWORD } as const;
```

- Use `HARNESS_ADMIN.email` in the `/auth/register` body instead of the literal.
- In `interface World`, after `readonly base: string;`, add:

```ts
  /** The registered admin's access token (project `web`), for user routes such as the log reads (S2a slice 2). */
  readonly adminToken: string;
```

- In the `world` object literal, add `adminToken: admin,` after `base,`.

In `test/integration/harness/index.ts`, export `HARNESS_ADMIN` next to `FEATURES`.

Run: `cd apps/runner && bun run lint && bunx tsc --noEmit -p . && bun run test`
Expected: PASS. The unit suite is unchanged; the integration specs still compile.

- [ ] **Step 3: Write the live check**

Create `apps/runner/test/live/log-shipping.live.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { isProcessAlive } from '../../src/executor/nax-process';
import { findRunLog } from '../../src/watcher/run-log';
import { waitFor } from '../helpers/wait';
import { createWorld, HARNESS_ADMIN, type TestRunner, type World } from '../integration/harness';

/**
 * S2a slice 2, spec §8 "live check" (plan D360): the real `koda-runner run` CLI as its own process against the real
 * built API, with the fake nax writing ~50 MiB of run JSONL (one 3 MiB line) plus 8 MiB each of stdout and stderr over
 * ~2 minutes. The daemon is SIGKILLed mid-run and again after nax wrote its last byte but before it exits; each
 * stored stream must then equal the file on disk (SHA-256), and the read routes the viewer uses must filter it.
 * Unbilled (no real nax). Run: `cd apps/api && bun run test:db:up`, `bunx turbo run build --filter=@nathapp/koda-api`,
 * then `cd apps/runner && KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts`.
 * `KODA_LOG_LIVE_KEEP=1` keeps the world up at the end and prints how to open the web viewer on it.
 */
setDefaultTimeout(600_000);
const enabled = process.env['KODA_DB_TESTS'] === '1' && process.env['KODA_LOG_LIVE'] === '1';
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const MiB = 1024 * 1024;
const RUN_BYTES = 50 * MiB;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!enabled)('S2a live check: a real daemon process streams complete logs across two crashes', () => {
  let world: World;
  let runner: TestRunner;
  let daemon: Subprocess | null = null;
  let generation = 0;

  beforeAll(async () => {
    world = await createWorld();
    runner = await world.addRunner('live');
  }, 300_000);
  afterAll(async () => {
    daemon?.kill('SIGKILL');
    if (process.env['KODA_LOG_LIVE_KEEP'] === '1') await keepOpen();
    await world?.close();
  });

  /** `koda-runner --home <home> run`, the CLI a service runs; its env is what the fake nax inherits. */
  async function spawnDaemon(env: Record<string, string>): Promise<void> {
    generation += 1;
    await world.prisma.runner.update({ where: { name: runner.name }, data: { enabled: true } });
    daemon = Bun.spawn([process.execPath, MAIN, '--home', runner.home.dir, 'run'], {
      env: { ...process.env, ...env },
      stdout: Bun.file(join(world.base, `daemon-${generation}.out`)),
      stderr: Bun.file(join(world.base, `daemon-${generation}.err`)),
    });
  }

  async function killDaemon(): Promise<void> {
    daemon?.kill('SIGKILL');
    await daemon?.exited;
    daemon = null;
  }

  const stored = async (jobId: string, stream: string): Promise<number> =>
    Number((await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } }))?.sizeBytes ?? 0);

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${world.api.url}/api/projects/web/fleet/jobs${path}`, { headers: { authorization: `Bearer ${world.adminToken}` } });
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: T }).data;
  };

  async function keepOpen(): Promise<void> {
    const flag = join(world.base, 'keep');
    await writeFile(flag, '');
    process.stdout.write([
      '', `API: ${world.api.url} (login ${HARNESS_ADMIN.email} / ${HARNESS_ADMIN.password}, project "web")`,
      `Web: cd apps/web && NUXT_API_INTERNAL_URL=${world.api.url} bun run dev, then open /web/fleet`,
      `Delete ${flag} to tear the world down.`, '',
    ].join('\n'));
    await waitFor(() => !existsSync(flag), { timeoutMs: 3_600_000, intervalMs: 1_000 });
  }

  test('SHA-256 identical after a crash mid-run (watch path) and a crash before nax exits (finish path); filters work', async () => {
    const gate = join(world.base, 'gate-lv');
    const env = {
      FAKE_NAX_LOG_BYTES: String(RUN_BYTES), FAKE_NAX_LONG_LINE_BYTES: String(3 * MiB), FAKE_NAX_PACE_MS: '120',
      FAKE_NAX_STDIO_BYTES: String(8 * MiB), FAKE_NAX_GATE: gate,
    };
    await spawnDaemon(env);
    const jobId = await world.dispatch({ feature: 'lv' });
    await world.waitForJob(jobId, (j) => j.state === 'RUNNING', 120_000);
    const outDir = join(runner.jobDir(jobId), 'nax-out');

    // Crash 1 (watch path): the API holds part of the run log; nax keeps writing while no daemon runs.
    await waitFor(async () => (await stored(jobId, 'run')) > 4 * MiB, { timeoutMs: 120_000, intervalMs: 500, message: 'no 4 MiB of run log reached the API' });
    await killDaemon();
    await Bun.sleep(10_000);
    await spawnDaemon(env);

    // Crash 2 (finish path): nax has written all its padding, then exits while the daemon is down.
    const runPath = async (): Promise<string | null> => findRunLog(outDir, 'lv');
    await waitFor(async () => {
      const path = await runPath();
      return path !== null && (await stat(path)).size >= RUN_BYTES;
    }, { timeoutMs: 300_000, intervalMs: 1_000, message: 'the fake nax never wrote its 50 MiB' });
    await killDaemon();
    const status = JSON.parse(await readFile(join(outDir, 'status.json'), 'utf8')) as { run: { pid: number } };
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(status.run.pid), { timeoutMs: 60_000, intervalMs: 250, message: 'the fake nax did not exit after the gate' });
    await spawnDaemon(env);
    // nax pushed while no daemon served its git socket, so the finish may escalate on the push (the integration
    // precedent for the finish path); the logs are what this check is about.
    await world.waitForJob(jobId, (j) => ['COMPLETED', 'ESCALATED'].includes(j.state), 300_000);

    // Success criterion 2: every stream byte-identical, complete, from the stream (not the bundle).
    const local: Record<string, string> = { run: (await runPath()) as string, stdout: join(runner.jobDir(jobId), 'nax.stdout'), stderr: join(runner.jobDir(jobId), 'nax.stderr') };
    for (const [stream, path] of Object.entries(local)) {
      const disk = await readFile(path);
      const kept = await readFile(join(world.base, 'artifacts', 'logs', jobId, '1', `${stream}.log`));
      expect({ stream, size: kept.length, sha: sha(kept) }).toEqual({ stream, size: disk.length, sha: sha(disk) });
      const row = await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } });
      expect(row).toMatchObject({ complete: true, truncated: false, source: 'stream' });
      const download = await fetch(`${world.api.url}/api/projects/web/fleet/jobs/${jobId}/logs/${stream}/raw?download=1`, { headers: { authorization: `Bearer ${world.adminToken}` } });
      expect(sha(new Uint8Array(await download.arrayBuffer()))).toBe(sha(disk));
    }
    expect(Number(local.run && (await stat(local.run)).size)).toBeGreaterThanOrEqual(RUN_BYTES);
    expect((await world.events(jobId)).some((e) => e.type === 'log')).toBe(false);

    // The viewer's reads on the 50 MiB log (criterion 3): one bounded scan per request, filters server-side.
    interface Page { entries: Array<{ level?: string; text?: string; truncatedLine?: boolean; unparsed?: boolean }>; nextCursor: number; atEnd: boolean; complete: boolean; size: number }
    const tail = await get<Page>(`/${jobId}/logs/run/entries?direction=backward&level=info`);
    expect(tail.complete).toBe(true);
    expect(tail.entries.length).toBeGreaterThan(0);
    expect(tail.entries.every((e) => e.level === 'info')).toBe(true);
    const head = await get<Page>(`/${jobId}/logs/run/entries?direction=forward&level=info`);
    expect(head).toMatchObject({ entries: [], atEnd: false });                 // the 3 MiB line is cut, unparsed: no match
    expect(head.nextCursor).toBeGreaterThan(0);
    const raw = await get<Page>(`/${jobId}/logs/run/entries?direction=forward`);
    expect(raw.entries[0]).toMatchObject({ unparsed: true, truncatedLine: true });
    const stdout = await get<Page>(`/${jobId}/logs/stdout/entries?direction=forward&q=${encodeURIComponent('stdio 0 ')}`);
    expect(stdout.entries.length).toBe(64);
  });
});
```

- [ ] **Step 4: Run it**

Ask the user to consent to the `koda_runner_test` reset first. Then:

```bash
cd apps/api && bun run test:db:up && cd ../.. && bunx turbo run build --filter=@nathapp/koda-api
cd apps/runner && PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<consent text>" KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts
```

Expected: `1 pass`, about 18 `expect()` calls, about 105 s. Without both env flags the file is skipped
(`bun run test:live` stays read-only). On a failure, the daemon's output is in
`<world.base>/daemon-<n>.{out,err}`; `runner.log` is in the runner home. Optional: rerun with `KODA_LOG_LIVE_KEEP=1`
and follow the printed steps to open `/web/fleet` on the kept stack in a browser and filter the 50 MiB log by hand.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/test/fixtures/fake-nax.ts apps/runner/test/integration/harness/world.ts \
  apps/runner/test/integration/harness/index.ts apps/runner/test/live/log-shipping.live.spec.ts
git commit -m "test(runner): unbilled live check of complete log streaming across daemon kills (S2a §8, D360)"
```

---

### Task 11: Docs, agent context and PR

**Files:**
- Modify: `docs/deployment/runner.md`, `.nax/mono/apps/runner/context.md`, `.nax/mono/apps/web/context.md`
- Regenerate: `apps/{runner,web}/{AGENTS,CLAUDE,GEMINI,codex}.md`

- [ ] **Step 1: Operator docs**

In `docs/deployment/runner.md`, insert directly before `## Operate`:

```markdown
## Run logs (S2a)

A runner with protocol v3 streams nax's run log, stdout and stderr to koda while the job runs; nothing is sampled.

- Upgrade the **API first**: it accepts protocol v1, v2 and v3. A v3 runner against an older API gets 426 at enroll and
  sync and stops. Deploy the API and web of the same release before any v3 runner: until the web has the log viewer,
  a v3 job shows no log lines anywhere but `koda fleet job logs`.
- Read a job's logs on its page (Logs) at `/<project>/fleet/jobs/<id>/logs`: tabs for the run log, stdout and stderr,
  an attempt picker, and filters (minimum level, story, stage, role, text) that run on the server and live in the URL.
  While the job runs the viewer follows new lines; scroll up to stop, "Jump to latest" to resume. A filtered search
  reads at most 2 MiB per request and asks before reading further ("Keep searching"). Download saves a whole stream.
- A stream the runner could not finish uploading is filled from the job's bundle after it arrives; the viewer says
  "Filled from the bundle". A stream cut at `FLEET_LOG_MAX_BYTES` (256 MiB) keeps its full text only in the bundle.
- Logs, bundles and `log` timeline events of jobs that ended more than `FLEET_LOG_RETENTION_DAYS` (default 30, `0`
  keeps them) days ago are deleted at 04:45 every night; the job page then shows "Bundle expired".
- Unbilled check of the whole path on one machine (real daemon process, fake nax, ~50 MiB of logs, two daemon
  kills): `cd apps/api && bun run test:db:up && cd ../.. && bunx turbo run build --filter=@nathapp/koda-api`, then
  `cd apps/runner && KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts`. With
  `KODA_LOG_LIVE_KEEP=1` it leaves the stack up and prints how to open the web viewer on it.
```

- [ ] **Step 2: Agent context**

`.nax/mono/apps/runner/context.md`:
- Replace the Rules bullet that starts "A log stream that shrinks" with:
  "- A log stream that shrinks, that the server holds more of than the file, or whose acked size the server answers
  below, is `diverged`: it stops and the bundle fills it. The shipper never rewinds. A `final` PUT the server acks
  without `complete` backs off; it is never re-sent at once."
- Append to the last Testing bullet (after "…never in CI."):
  " `test/live/log-shipping.live.spec.ts` (`KODA_DB_TESTS=1 KODA_LOG_LIVE=1`, S2a) runs `koda-runner run` as its own
  process against the built API with a paced fake nax (`FAKE_NAX_PACE_MS`, `FAKE_NAX_STDIO_BYTES`), SIGKILLs it twice
  and compares every stored log stream's SHA-256; unbilled, never in CI."

`.nax/mono/apps/web/context.md`:
- Add to the route list after `/:project/tickets/:ref`:
  "- `/:project/fleet/jobs/:id/logs` (fleet run-log viewer, S2a: entries pages, live `fleet_log` events, filters in
  the URL)".
- After the "Main folders" list in "UI Structure", add the paragraph: "Run logs and other runner- or agent-written text
  render through `{{ }}` interpolation only, never `v-html`: a log line is untrusted text."

Regenerate from the repo root and check that only the two contexts and their eight generated files changed:

```bash
nax generate
git status --short
```

Expected: `.nax/mono/apps/{runner,web}/context.md` and `apps/{runner,web}/{AGENTS,CLAUDE,GEMINI,codex}.md`. Restore
anything else with `git checkout -- <path>`.

- [ ] **Step 3: Final checks**

Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Run: `cd apps/runner && bun run test && bun run lint && bunx tsc --noEmit -p .`
Expected: PASS everywhere. Slice 2 changes no API code: `git diff --stat main -- apps/api openapi.json` prints nothing.

- [ ] **Step 4: Commit, push and open the PR**

```bash
git add docs/deployment/runner.md .nax/mono/apps/runner/context.md .nax/mono/apps/web/context.md apps/runner/*.md apps/web/*.md
git commit -m "docs(fleet): run logs operator guide and agent context (S2a slice 2)"
git push -u origin feat/fleet-s2a-web
gh pr create --title "feat(fleet): S2a slice 2 — log viewer, e2e and live check (D350-D364)" --body "$(cat <<'EOF'
## Summary
- Log viewer `/<project>/fleet/jobs/<id>/logs`:
  - run log / stdout / stderr tabs and an attempt picker;
  - server-side filters (level, story, stage, role, text) kept in the URL;
  - live follow on `fleet_log`;
  - Load earlier / Load more with 5,000-row eviction;
  - Keep searching (one request per click) and 429 backoff;
  - notices: bundle-filled, truncated, incomplete, expired, legacy sampled;
  - per-stream download through the proxy.
- Job page: Logs link, "Bundle expired" (D357), timeline "Full log of attempt N" rows (D362).
- E2E (spec §8 (1)(2)) with a protocol v3 scripted runner, real log uploads and a real tar.gz (D361).
- Unbilled live check (D360): a real `koda-runner run` process writes a ~50 MiB run log with a 3 MiB line plus 8 MiB
  each of stdout and stderr. The daemon is SIGKILLed mid-run and again before nax exits; every stream's SHA-256 matches.
- Runner hardening from #200: no rewind on a smaller ack (D350), no hot loop on a final PUT acked without `complete` (D351).
- No API change.

## Spec corrections
- D352: the job page moves to `[id]/index.vue` (Nuxt nested routes); URLs unchanged.
- D358: the expired notice has no day count and the truncated notice shows the stored size (both are API config).

## Release gate (D320)
1b may be released only once 1c **and this slice** are deployed: API first, then web, then the runner.

## Test plan
- [ ] `apps/web`: `bun run test`, lint, type-check
- [ ] `apps/runner`: `bun run test`, lint, `tsc --noEmit`
- [ ] Fleet E2E: `bunx playwright test tests/e2e/fleet-*.e2e.spec.ts` (9 tests)
- [ ] Live check: `KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts`
EOF
)"
```

Expected: the PR URL. Do not merge; the user reviews.
