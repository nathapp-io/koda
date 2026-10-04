# Fleet S2a Slice 1b — Runner Log Shipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner streams every byte of a job's run JSONL, stdout and stderr to the slice 1a upload route
(`PUT /fleet/runner/jobs/:jobId/logs/:stream`) while the job runs, resumes at the server's size after a daemon
restart, drains each stream to its end with `final=1` before the UPLOADING transition, and announces protocol v3.

**Architecture:** A new runner module `src/logs/` holds a runner-wide `LogShipper`: `maxInFlight` worker loops pick
streams round-robin, read raw byte windows straight from the job's files, and PUT them through an injected
`LogTransport` (built in `daemon.ts` over the new `ServerClient.putLog`, like `BundleUploader`). `JobRun` talks to
it only through the `LogShipping` interface: register after spawn or re-adopt, `wake` after each watcher tick,
`drain` concurrently with the verdict/push work and awaited before UPLOADING, `stopJob` on halt, abandon and cleanup.
The old sync-event log path (`FileTail`, `LogBudget`, `log` events) is removed from the runner.

**Tech Stack:** Bun (ESM, `bun test`, `Bun.file`), TypeScript strict, `node:crypto` SHA-256, `@nathapp/fleet-protocol`.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md` §2.1 (runner part), §2.4, §6 (runner rows),
§7 (runner tuning), §8 (1b tests), §9 slice 1b. Rulings L1, L5, R1, R3, R4, R5, R6, R12. Slice 1a plan
`docs/superpowers/plans/2026-10-04-fleet-s2a-slice-1a-log-transport.md` D307 (the 200-outcome contract).

## Global Constraints

- Streams: exactly `run | stdout | stderr`. Paths: `run` = `findRunLog(<jobDir>/nax-out, feature)` (RUN only),
  `stdout` = `<jobDir>/nax.stdout`, `stderr` = `<jobDir>/nax.stderr`.
- Upload route (slice 1a, live on main): `PUT /api/fleet/runner/jobs/:jobId/logs/:stream?leaseEpoch=&offset=[&final=1]`,
  headers `authorization: Bearer <key>`, `content-type: application/octet-stream`, `x-content-sha256: <64 hex>`,
  `accept-language: en`. Every protocol outcome is HTTP 200 `{ ret: 0, data: { outcome, size, retryAfterMs? } }` with
  `outcome ∈ appended | duplicate | offset | complete | stream_cap | rate_limited` (D307). An empty body is accepted
  only with `final=1`.
- Runner tuning (spec §7), in `Tuning` (`src/daemon/tuning.ts`): `logChunkBytes 1_048_576`, `logMaxInFlight 2`,
  `logPutTimeoutMs 30_000`, `logBackoffMaxMs 30_000`, `logDrainTimeoutMs 120_000`. Only `startDaemon` options override them.
- `@nathapp/fleet-protocol` `FLEET_PROTOCOL_VERSION = 3` (Task 6). The API already accepts `[1, 2, 3]` (1a, D308).
- Architecture rule: only `src/sync/` talks to the server. `src/logs/` gets an injected `LogTransport` and a per-job
  `lifecycle` callback; it never imports `src/sync/http.ts`, the journal or `JobEvents`.
- Nothing in the 2 s watch tick awaits the network: `LogShipping.register`, `wake` and `stopJob` return `void`.
- Runner tests: `cd apps/runner && bun run test <paths>` for unit specs (`src/**/*.spec.ts`, `test/unit/`);
  integration: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration` after `bunx turbo run build --filter=@nathapp/koda-api`
  (the harness runs the BUILT API; a stale build has no upload route) and `bun run test:db:up` in `apps/api`.
  Never bare `bun test` at the repo root.
- Type-check and lint before each commit: `cd apps/runner && bun run type-check && bun run lint`.
- No emojis in source; no `console.log` outside `src/main.ts` and `src/logger.ts`.
- Mutable state is private to one class (`LogShipper`'s job map, stream list, cursor, pause and wake controller),
  the same way `Supervisor` and `Journal` hold theirs; everything crossing a module boundary is `readonly`.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D320 (slice 1a ended at D319).

| # | Decision | Why |
|:--|:--|:--|
| D320 | **Spec correction (§2.4, §8; release gate):** the runner's sync-event log path is **removed**, not kept as a v2 mode: `watcher/file-tail.ts`, `watcher/log-budget.ts` (with `chunkText`), `WatcherSink.logLine`, `JobEvents.logLine`, `SnapshotExtras.droppedLogs`, `WatchOptions.startAtEnd` and the watcher's `stdoutPath`/`stderrPath`/`startAtEnd`/`nowMs` options. Spec §8's "v2 vs v3 watcher behaviour" test becomes "the watcher reads no log file and emits no `log` event". The protocol types `LogEventPayload` and `SnapshotEventPayload.droppedLogs` stay: the API still accepts both from v1/v2 runners. | After this slice the binary only speaks v3, and R1 rules out falling back to v2 (a `[1,2]` API answers 426 and the sync loop stops the daemon). A v2 mode would be unreachable code that still has to be maintained. **Release gate (final review):** between 1b and slice 2, a v3 runner's job page shows no log text (the timeline rendered `log` events; the viewer and its read routes arrive in 2 and 1c). Do not release a runner build containing 1b before 1c and 2 are deployed; API first (R1). |
| D321 | Seams: `src/logs/` is client-free and journal-free. It gets a `LogTransport` (daemon-built over `ServerClient.putLog`) and, per job, a `lifecycle(level, message)` callback (JobRun passes `JobEvents.lifecycle`). The job's file layout comes from a new `JobExecutor.logSources(job): JobLogSources` (the executor owns the layout, as `createWatcher` did). `JobRun` depends on the `LogShipping` interface only. | Keeps the "only `src/sync/` talks to the server" rule and lets `JobRun` specs use a fake shipper beside `FakeExecutor`. |
| D322 | `ServerClient.putLog(args)` takes an args object `{ jobId, stream, leaseEpoch, offset, bytes, final, signal? }` (like `uploadBundle`), hashes the body itself, and returns `{ status }` for a non-2xx, `{ status, outcome, size, retryAfterMs? }` for a well-formed 2xx, `{ status }` for a malformed 2xx. A network failure throws `NetworkError`; an abort throws the abort reason (as `send()` does). `putLog` passes `LOG_PUT_TIMEOUT_MS` (60 s) to `send()` as a backstop; the shipper's own 30 s abort governs. | The spec lists positional parameters; an object reads better and matches the neighbour. The shipper decides everything from status + outcome. |
| D323 | Answer table (`classifyAnswer`), extending spec §2.4: 2xx `appended`/`duplicate`/`offset` with a size ≥ 0 → ack size (a negative size is malformed → backoff; an ack that does not move past a non-empty non-final PUT's offset is treated as a backoff, so a buggy server cannot cause a hot loop); `complete` → done; `stream_cap` → stopped + lifecycle warn; `rate_limited` → pause the whole shipper for `retryAfterMs` (1 s if absent, at most 60 s); malformed 2xx → backoff. 401, 404, 409 → stop every stream of the job (no lifecycle; 404 = job gone). 408, 422, 429, 5xx (incl. 507), network error, timeout → backoff. Any other status (400, 413, 426, ...) → that stream stopped + lifecycle error. An ack whose size is above the local file size → `diverged` (R6). | Spec table plus the statuses it leaves open; none of them may loop or crash the shipper. |
| D324 | Scheduling: `maxInFlight` worker loops, each doing one PUT at a time, so at most `maxInFlight` PUTs are in flight. Streams sit in one flat list in registration order; a worker scans it round-robin from the last pick and takes the first stream that is `active`, not `busy`, `dirty`, past its `retryAt`, while the shipper is not paused. Picking clears `dirty`; `wake`, `drain`, an ack, a backoff and a pause set it again; a read that finds nothing new leaves it clear. An idle worker sleeps until the earliest `retryAt`/pause end, or until the next `wake` (an `AbortController` swapped on every wake). | R4 with no timer per stream; a stream that cannot send costs nothing until the next tick. |
| D325 | `final=1` rides the last chunk when a draining stream reaches its file end; with nothing left it is an empty-body PUT at the acked offset. A stream whose file does not exist when it is drained becomes `done` with no PUT (no server row). | One PUT fewer per stream; an absent file has nothing to complete. |
| D326 | `backoffDelay(attempt, random, maxMs = 60_000)` gains the `maxMs` parameter (the sync loop keeps 60 s). The shipper uses full jitter from 1 s, capped at `logBackoffMaxMs`; a stream's failure count resets on any 2xx. Failures are logged on the 1st and every 10th attempt. The drain timer bounds the backoff while draining. | Reuse, not a second backoff function. |
| D327 | JobRun lifecycle: register after a successful spawn (prepare/reprepare) or at the start of `watch`/`finish`; `wake` after every watcher tick (including the final one, and when the tick threw); `drain` starts at the top of `finish()` after the terminal-state check, which in the `watch` path is after the final tick and `reapQuietly`; it is awaited just before the UPLOADING transition. A `timeout` adds lifecycle warn `log upload did not finish within <N> s; the bundle fills the rest`. `halt()` (and so `abandon()`) and `cleanup()` call `stopJob` (cleanup before `markDone`), and `start()` calls it again in a `finally` (idempotent) for the exits that skip `cleanup()` (`stale`, a halted finish, a failSafe whose recording failed). `registerLogs()` does nothing after a halt (a halt during spawn) or for a re-adopted terminal row. `failSafe()` drains before its UPLOADING → FAILED report, because no bundle follows a runner error. | R5. Every way a run ends releases the job's streams, so the shipper never writes a lifecycle event for a job that is done. |
| D328 | Daemon: one `LogShipper` per daemon, `close()`d on `stop()` (after `supervisor.shutdown()`) and on `crash()`. The wiring lands in Task 5 (so every commit type-checks); the protocol constant moves to 3 in Task 6, in the same PR. | A v3 runner must stream (R1), so the bump ships with the shipper (D308). |
| D329 | Integration tests check stored bytes on disk (`<FLEET_ARTIFACT_DIR>/logs/<jobId>/<epoch>/<stream>.log`) and `FleetJobLog` rows through the harness `prisma`. | The 1c read routes do not exist yet. |
| D330 | The fake nax gains `FAKE_NAX_LONG_LINE_BYTES` (one JSONL line of about that length, written first) and `FAKE_NAX_LOG_BYTES` (debug lines of about 1 KiB appended in 64 KiB batches until the run log holds at least that many bytes), both before the first story. | Spec §8: large JSONL and long lines through a real file. |

## Review Focus

1. **`drain` called while a non-final PUT of the same stream is in flight**: the in-flight window was cut at a newline
   and is not at the file end; the shipper must ack it, read again to the end, and send `final=1` only at the true
   end. Expected: stored bytes equal the file, exactly one `final` PUT. Pinned in Task 3 ("drain during an in-flight PUT").
2. **The server answers a size above the local file** (re-adopt after the file was replaced, or the server holds bytes
   the file no longer has): the stream must go `diverged` with a lifecycle warning and never read past the file or
   loop. Pinned in Task 3 (`offset` and `duplicate` rows with a larger size).
3. **The run log appears late**: nax creates `runs/<id>.jsonl` after the first ticks, or only shortly before exit.
   Expected: it is found on a later wake (or by the drain) and shipped from offset 0. Pinned in Task 3
   ("run log found late" and "found only by the drain").
4. **A job abandoned while its PUT hangs**: the in-flight PUT is aborted, a pending drain resolves `stopped`, and no
   lifecycle event is written for the gone job. Pinned in Task 3 (stopJob mid-drain) and Task 5 (halt mid-drain).
5. **Daemon restart re-adopt (`watch` and `finish`)**: the first PUT goes from offset 0, the server answers
   `duplicate` with its size, the shipper jumps there, and the stored stream ends byte-identical to the file.
   Pinned in Task 3 (unit, "resumes at the server size") and Task 7 (integration, SHA-256 equality).

## File Map

**apps/runner**
- Create `src/logs/types.ts`, `src/logs/answer.ts`, `src/logs/answer.spec.ts`, `src/logs/read-window.ts`,
  `src/logs/read-window.spec.ts`, `src/logs/log-shipper.ts`, `src/logs/log-shipper.spec.ts`.
- Modify `src/sync/http.ts`, `src/sync/http.spec.ts`, `src/sync/backoff.ts`, `src/sync/backoff.spec.ts`.
- Modify `src/watcher/watcher.ts`, `src/watcher/watcher.spec.ts`, `src/watcher/status-snapshot.ts`,
  `src/watcher/status-snapshot.spec.ts`; delete `src/watcher/file-tail.ts`, `src/watcher/log-budget.ts`.
- Modify `src/executor/job-executor.ts`, `src/executor/host-executor.ts`, `test/unit/host-executor.spec.ts`,
  `test/helpers/fake-executor.ts`.
- Modify `src/supervisor/job-events.ts`, `src/supervisor/job-events.spec.ts`, `src/supervisor/job-run.ts`,
  `src/supervisor/job-run.spec.ts`, `src/supervisor/supervisor.spec.ts`, `src/supervisor/command-handler.spec.ts`.
- Modify `src/daemon/tuning.ts`, `src/daemon/tuning.spec.ts`, `src/daemon/daemon.ts`, `test/unit/daemon.spec.ts`,
  `src/sync/batch.spec.ts`.
- Create `test/helpers/manual-clock.ts`, `test/helpers/fake-log-server.ts`, `test/helpers/fake-log-shipping.ts`.
- Modify `test/fixtures/fake-nax.ts`, `test/unit/fake-nax.spec.ts`, `test/integration/run-plan.integration.spec.ts`;
  create `test/integration/log-shipping.integration.spec.ts`.
- Regenerated: `apps/runner/AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md`.

**packages/fleet-protocol:** `src/index.ts` (constant 3). **repo root:** `.nax/mono/apps/runner/context.md`.

---

### Task 1: Log types, `ServerClient.putLog`, answer classification, backoff cap

**Files:**
- Create: `apps/runner/src/logs/types.ts`
- Create: `apps/runner/src/logs/answer.ts`, test `apps/runner/src/logs/answer.spec.ts`
- Modify: `apps/runner/src/sync/http.ts`, test `apps/runner/src/sync/http.spec.ts`
- Modify: `apps/runner/src/sync/backoff.ts`, test `apps/runner/src/sync/backoff.spec.ts`

**Interfaces:**
- Produces (types.ts): `LogStreamName`, `PutLogOutcome`, `PutLogArgs`, `PutLogAnswer`, `LogTransport`,
  `JobLogSources`, `LogLifecycle`, `LogJob`, `DrainResult`, `LogShipping` (exact code below).
- Produces: `ServerClient.putLog(args: PutLogArgs): Promise<PutLogAnswer>`;
  `classifyAnswer(answer: PutLogAnswer): AnswerAction`; `backoffDelay(attempt, random, maxMs?)`.

- [ ] **Step 1: Create the shared types (no behaviour, so no test of their own)**

`apps/runner/src/logs/types.ts`:

```ts
import type { LogEventPayload } from '@nathapp/fleet-protocol';

/** S2a §1.1: the three streams of a job attempt. */
export type LogStreamName = LogEventPayload['stream'];

/** Slice 1a plan D307: every protocol outcome of an upload is an HTTP 200 carrying one of these. */
export type PutLogOutcome = 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';

export interface PutLogArgs {
  readonly jobId: string;
  readonly stream: LogStreamName;
  readonly leaseEpoch: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly final: boolean;
  readonly signal?: AbortSignal;
}

/** Plan D322: a 2xx carries outcome and size; any other status carries only the status. */
export interface PutLogAnswer {
  readonly status: number;
  readonly outcome?: PutLogOutcome;
  readonly size?: number;
  readonly retryAfterMs?: number;
}

/** Built in daemon.ts over ServerClient.putLog (plan D321). Rejects on a network failure or an abort. */
export interface LogTransport {
  putLog(args: PutLogArgs): Promise<PutLogAnswer>;
}

/** Where a job's nax writes its logs (JobExecutor.logSources). `runLog` is false for PLAN jobs (spec §2.4). */
export interface JobLogSources {
  readonly outDir: string;
  readonly feature: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly runLog: boolean;
}

export type LogLifecycle = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface LogJob {
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly sources: JobLogSources;
  readonly lifecycle: LogLifecycle;
}

export type DrainResult = 'drained' | 'timeout' | 'stopped';

/** What a JobRun needs from the runner-wide shipper (plan D321). Only `drain` returns a promise, and it never rejects. */
export interface LogShipping {
  register(job: LogJob): void;
  wake(jobId: string, leaseEpoch: number): void;
  /** Ships every stream of the job to its file end, then final=1 (spec §2.4 R5). */
  drain(jobId: string, leaseEpoch: number, timeoutMs: number): Promise<DrainResult>;
  /** Stops the job's streams, aborts their in-flight PUTs, resolves a pending drain with 'stopped', forgets the job. */
  stopJob(jobId: string, leaseEpoch: number): void;
}
```

- [ ] **Step 2: Write the failing tests for `putLog`, `classifyAnswer` and the backoff cap**

Append to `apps/runner/src/sync/http.spec.ts` (it already imports `ServerClient`, `NetworkError`, `FetchFn`, `ok`, `client`):

```ts
describe('putLog (S2a §2.4, plan D322)', () => {
  test('PUTs the bytes with octet-stream type, their sha256, the bearer key, en, and the epoch/offset/final query', async () => {
    let seen = null as { method: string; url: URL; headers: Headers; body: Buffer } | null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { method: req.method, url: new URL(req.url), headers: req.headers, body: Buffer.from(await req.arrayBuffer()) };
        return new Response(JSON.stringify({ ret: 0, data: { outcome: 'appended', size: 11 } }), { status: 200 });
      },
    });
    try {
      const c = new ServerClient({ serverUrl: `http://127.0.0.1:${server.port}`, apiKey: 'kr_x' });
      const answer = await c.putLog({ jobId: 'j 1', stream: 'stdout', leaseEpoch: 2, offset: 5, bytes: Buffer.from('hello\n'), final: true });
      expect(answer).toEqual({ status: 200, outcome: 'appended', size: 11 });
      expect(seen?.method).toBe('PUT');
      expect(seen?.url.pathname).toBe('/api/fleet/runner/jobs/j%201/logs/stdout');
      expect(Object.fromEntries(seen?.url.searchParams ?? [])).toEqual({ leaseEpoch: '2', offset: '5', final: '1' });
      expect(seen?.headers.get('content-type')).toBe('application/octet-stream');
      expect(seen?.headers.get('authorization')).toBe('Bearer kr_x');
      expect(seen?.headers.get('accept-language')).toBe('en');
      expect(seen?.headers.get('x-content-sha256')).toBe(new Bun.CryptoHasher('sha256').update('hello\n').digest('hex'));
      expect(seen?.body.toString()).toBe('hello\n');
    } finally {
      server.stop(true);
    }
  });
  test('a non-final PUT has no final param; an empty final body is sent as zero bytes', async () => {
    const urls: string[] = [];
    const lengths: number[] = [];
    const c = client(async (url, init) => {
      urls.push(url);
      lengths.push((init?.body as Uint8Array).byteLength);
      return ok({ outcome: 'complete', size: 0 });
    });
    await c.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('x'), final: false });
    await c.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 1, bytes: new Uint8Array(0), final: true });
    expect(new URL(urls[0]).searchParams.has('final')).toBe(false);
    expect(new URL(urls[1]).searchParams.get('final')).toBe('1');
    expect(lengths).toEqual([1, 0]);
  });
  test('carries retryAfterMs; a non-2xx is just its status; a malformed 2xx body has no outcome', async () => {
    const answers = [
      ok({ outcome: 'rate_limited', size: -1, retryAfterMs: 250 }),
      new Response(JSON.stringify({ ret: 1, message: 'Job not found' }), { status: 409 }),
      new Response('not json', { status: 200 }),
      ok({ outcome: 'weird', size: 3 }),
      ok({ outcome: 'appended' }),
    ];
    const c = client(async () => answers.shift() as Response);
    const put = () => c.putLog({ jobId: 'j1', stream: 'stderr', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false });
    expect(await put()).toEqual({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 250 });
    expect(await put()).toEqual({ status: 409 });
    expect(await put()).toEqual({ status: 200 });
    expect(await put()).toEqual({ status: 200 });
    expect(await put()).toEqual({ status: 200 });
  });
  test('a network failure throws NetworkError; an abort rejects with the abort reason', async () => {
    const down = client(async () => { throw new TypeError('connect ECONNREFUSED'); });
    await expect(down.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false })).rejects.toBeInstanceOf(NetworkError);
    const hanging = client((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = hanging.putLog({ jobId: 'j1', stream: 'run', leaseEpoch: 1, offset: 0, bytes: Buffer.from('a'), final: false, signal: controller.signal });
    controller.abort(new Error('shipper timeout'));
    await expect(pending).rejects.toThrow('shipper timeout');
  });
});
```

Create `apps/runner/src/logs/answer.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { classifyAnswer } from './answer';

describe('classifyAnswer (spec §2.4 table, plan D323)', () => {
  test('2xx outcomes', () => {
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: 10 })).toEqual({ kind: 'ack', size: 10 });
    expect(classifyAnswer({ status: 200, outcome: 'duplicate', size: 10 })).toEqual({ kind: 'ack', size: 10 });
    expect(classifyAnswer({ status: 200, outcome: 'offset', size: 4 })).toEqual({ kind: 'ack', size: 4 });
    expect(classifyAnswer({ status: 200, outcome: 'complete', size: 12 })).toEqual({ kind: 'done', size: 12 });
    expect(classifyAnswer({ status: 200, outcome: 'stream_cap', size: 99 })).toEqual({ kind: 'cap', size: 99 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 300 })).toEqual({ kind: 'pause', ms: 300 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1 })).toEqual({ kind: 'pause', ms: 1_000 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 3_600_000 })).toEqual({ kind: 'pause', ms: 60_000 });
  });
  test('a 2xx without a usable outcome and size backs off', () => {
    expect(classifyAnswer({ status: 200 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended' })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: 1.5 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: -1 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
  });
  test('401, 404 and 409 stop the whole job', () => {
    for (const status of [401, 404, 409]) expect(classifyAnswer({ status })).toEqual({ kind: 'stop-job', status });
  });
  test('408, 422, 429 and every 5xx back off', () => {
    for (const status of [408, 422, 429, 500, 502, 507]) expect(classifyAnswer({ status })).toEqual({ kind: 'backoff', detail: `HTTP ${status}` });
  });
  test('any other status fails only that stream', () => {
    for (const status of [400, 403, 413, 426, 302]) expect(classifyAnswer({ status })).toEqual({ kind: 'fail-stream', status });
  });
});
```

Append to `apps/runner/src/sync/backoff.spec.ts` inside the `describe`:

```ts
  test('an optional cap replaces 60 s (S2a plan D326)', () => {
    const top = () => 0.999999;
    expect(backoffDelay(10, top, 30_000)).toBeLessThan(30_000);
    expect(backoffDelay(10, top, 30_000)).toBeGreaterThan(29_000);
    expect(backoffDelay(1, top, 30_000)).toBe(1999);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun run test src/sync/http.spec.ts src/logs/answer.spec.ts src/sync/backoff.spec.ts`
Expected: FAIL — `c.putLog is not a function`, `Cannot find module './answer'`, and the cap test returns about 59,999 for attempt 10.

- [ ] **Step 4: Implement**

`apps/runner/src/sync/backoff.ts` — replace the function with:

```ts
/** Full jitter: uniform in [0, min(maxMs, 1 s * 2^attempt)). The sync loop uses the 60 s default; logs pass their own (S2a D326). */
export function backoffDelay(attempt: number, random: () => number, maxMs: number = MAX_MS): number {
  const ceiling = Math.min(maxMs, BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.floor(random() * ceiling);
}
```

`apps/runner/src/sync/http.ts` — add the imports and constants at the top:

```ts
import { createHash } from 'node:crypto';
import type { PutLogAnswer, PutLogArgs, PutLogOutcome } from '../logs/types';
```

```ts
/** Plan D322: a backstop only; the LogShipper aborts a PUT after its own logPutTimeoutMs. */
const LOG_PUT_TIMEOUT_MS = 60_000;
const LOG_OUTCOMES: ReadonlySet<string> = new Set(['appended', 'duplicate', 'offset', 'complete', 'stream_cap', 'rate_limited']);

/** The 2xx body of a log upload (slice 1a D307): `{ ret: 0, data: { outcome, size, retryAfterMs? } }`. Anything else yields no fields. */
function logAnswerFields(text: string): Omit<PutLogAnswer, 'status'> {
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  const envelope = body as { ret?: unknown; data?: unknown } | null;
  if (envelope === null || typeof envelope !== 'object' || envelope.ret !== 0) return {};
  const data = envelope.data as { outcome?: unknown; size?: unknown; retryAfterMs?: unknown } | null;
  if (data === null || typeof data !== 'object') return {};
  if (typeof data.outcome !== 'string' || !LOG_OUTCOMES.has(data.outcome) || typeof data.size !== 'number') return {};
  return {
    outcome: data.outcome as PutLogOutcome,
    size: data.size,
    ...(typeof data.retryAfterMs === 'number' ? { retryAfterMs: data.retryAfterMs } : {}),
  };
}
```

and the method on `ServerClient`, after `uploadBundle`:

```ts
  /** S2a §2.4, plan D322: one exact-offset append. Protocol outcomes come back as data; only the network throws. */
  async putLog(args: PutLogArgs): Promise<PutLogAnswer> {
    const query = `leaseEpoch=${args.leaseEpoch}&offset=${args.offset}${args.final ? '&final=1' : ''}`;
    const url = `${this.url(`/fleet/runner/jobs/${encodeURIComponent(args.jobId)}/logs/${args.stream}`)}?${query}`;
    const headers = {
      ...this.bearer(),
      'content-type': 'application/octet-stream',
      'accept-language': 'en',
      'x-content-sha256': createHash('sha256').update(args.bytes).digest('hex'),
    };
    const response = await this.send(url, { method: 'PUT', headers, body: args.bytes }, LOG_PUT_TIMEOUT_MS, args.signal);
    const text = await response.text().catch(() => '');
    if (!response.ok) return { status: response.status };
    return { status: response.status, ...logAnswerFields(text) };
  }
```

Create `apps/runner/src/logs/answer.ts`:

```ts
import type { PutLogAnswer } from './types';

export type AnswerAction =
  | { readonly kind: 'ack'; readonly size: number }
  | { readonly kind: 'done'; readonly size: number }
  | { readonly kind: 'cap'; readonly size: number }
  | { readonly kind: 'pause'; readonly ms: number }
  | { readonly kind: 'stop-job'; readonly status: number }
  | { readonly kind: 'fail-stream'; readonly status: number }
  | { readonly kind: 'backoff'; readonly detail: string };

const DEFAULT_PAUSE_MS = 1_000;
/** Final review: a buggy or hostile retryAfterMs must not freeze every job's logs. */
const MAX_PAUSE_MS = 60_000;

/** Spec §2.4 response table, extended by plan D323. Pure: the shipper applies the action. */
export function classifyAnswer(answer: PutLogAnswer): AnswerAction {
  const { status } = answer;
  if (status >= 200 && status < 300) {
    const { outcome, size } = answer;
    if (outcome === undefined || size === undefined || !Number.isSafeInteger(size)) return { kind: 'backoff', detail: 'malformed 2xx answer' };
    if (outcome !== 'rate_limited' && size < 0) return { kind: 'backoff', detail: 'malformed 2xx answer' };
    switch (outcome) {
      case 'appended':
      case 'duplicate':
      case 'offset':
        return { kind: 'ack', size };
      case 'complete':
        return { kind: 'done', size };
      case 'stream_cap':
        return { kind: 'cap', size };
      case 'rate_limited':
        return { kind: 'pause', ms: answer.retryAfterMs !== undefined && answer.retryAfterMs > 0 ? Math.min(answer.retryAfterMs, MAX_PAUSE_MS) : DEFAULT_PAUSE_MS };
      default:
        return { kind: 'backoff', detail: 'malformed 2xx answer' };
    }
  }
  if (status === 401 || status === 404 || status === 409) return { kind: 'stop-job', status };
  if (status === 408 || status === 422 || status === 429 || status >= 500) return { kind: 'backoff', detail: `HTTP ${status}` };
  return { kind: 'fail-stream', status };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun run test src/sync/http.spec.ts src/logs/answer.spec.ts src/sync/backoff.spec.ts src/sync/sync-loop.spec.ts`
Expected: PASS (sync-loop still uses the 60 s default).

- [ ] **Step 6: Type-check, lint, commit**

```bash
cd apps/runner && bun run type-check && bun run lint
git add apps/runner/src/logs/types.ts apps/runner/src/logs/answer.ts apps/runner/src/logs/answer.spec.ts apps/runner/src/sync/http.ts apps/runner/src/sync/http.spec.ts apps/runner/src/sync/backoff.ts apps/runner/src/sync/backoff.spec.ts
git commit -m "feat(runner): putLog client, log upload answer table and a backoff cap (S2a 1b D321-D323, D326)"
```

---

### Task 2: Raw byte windows (`readWindow`)

**Files:**
- Create: `apps/runner/src/logs/read-window.ts`, test `apps/runner/src/logs/read-window.spec.ts`

**Interfaces:**
- Produces: `readWindow(path: string, from: number, maxBytes: number, toEnd: boolean): Promise<LogWindow | null>`,
  `interface LogWindow { readonly fileSize: number; readonly bytes: Buffer }`. `null` = the file does not exist.

- [ ] **Step 1: Write the failing test**

`apps/runner/src/logs/read-window.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { readWindow } from './read-window';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const file = async (content: string | Buffer) => {
  const path = join(await tmp.make('window'), 'f.log');
  await writeFile(path, content);
  return path;
};
const text = (w: { bytes: Buffer } | null) => w?.bytes.toString('utf8');

describe('readWindow (spec §2.4, R12)', () => {
  test('an absent file is null', async () => {
    expect(await readWindow(join(await tmp.make('none'), 'missing.log'), 0, 64, false)).toBeNull();
  });
  test('cuts after the last newline, from the given offset, and reports the file size', async () => {
    const path = await file('a\nbb\ncc');
    expect(await readWindow(path, 0, 64, false)).toEqual({ fileSize: 7, bytes: Buffer.from('a\nbb\n') });
    expect(text(await readWindow(path, 2, 64, false))).toBe('bb\n');
  });
  test('holds a partial last line back, but sends it whole when reading to the end (drain)', async () => {
    const path = await file('a\nbb\ncc');
    expect(text(await readWindow(path, 5, 64, false))).toBe('');
    expect(text(await readWindow(path, 5, 64, true))).toBe('cc');
  });
  test('never reads more than maxBytes; a window with no newline is sent whole only when it is full (R12)', async () => {
    const path = await file(`${'x'.repeat(100)}\n`);
    expect((await readWindow(path, 0, 64, false))?.bytes.length).toBe(64);
    expect(text(await readWindow(path, 64, 64, false))).toBe(`${'x'.repeat(36)}\n`);
    const short = await file('no newline yet');
    expect(text(await readWindow(short, 0, 64, false))).toBe('');
  });
  test('at or past the end it returns no bytes and the real size (the caller detects a shrink)', async () => {
    const path = await file('abc\n');
    expect(await readWindow(path, 4, 64, false)).toEqual({ fileSize: 4, bytes: Buffer.alloc(0) });
    expect(await readWindow(path, 10, 64, true)).toEqual({ fileSize: 4, bytes: Buffer.alloc(0) });
  });
  test('works on raw bytes: a multi-byte character split by the window stays split', async () => {
    const path = await file(Buffer.from('éé\n', 'utf8'));
    const head = await readWindow(path, 0, 3, true);
    expect(head?.bytes).toEqual(Buffer.from([0xc3, 0xa9, 0xc3]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/runner && bun run test src/logs/read-window.spec.ts`
Expected: FAIL — `Cannot find module './read-window'`.

- [ ] **Step 3: Implement**

`apps/runner/src/logs/read-window.ts`:

```ts
import { stat } from 'node:fs/promises';

export interface LogWindow {
  readonly fileSize: number;
  readonly bytes: Buffer;
}

/**
 * Spec §2.4: the next bytes of a log file as raw bytes (never decoded). At most `maxBytes`, cut after the last `\n`;
 * a full window with no newline is sent whole (R12); `toEnd` (draining) sends everything in the window.
 * Returns null when the file does not exist.
 */
export async function readWindow(path: string, from: number, maxBytes: number, toEnd: boolean): Promise<LogWindow | null> {
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (fileSize <= from) return { fileSize, bytes: Buffer.alloc(0) };
  const raw = Buffer.from(await Bun.file(path).slice(from, Math.min(fileSize, from + maxBytes)).arrayBuffer());
  if (toEnd) return { fileSize, bytes: raw };
  const cut = raw.lastIndexOf(0x0a) + 1;
  if (cut > 0) return { fileSize, bytes: raw.subarray(0, cut) };
  return { fileSize, bytes: raw.length >= maxBytes ? raw : Buffer.alloc(0) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/runner && bun run test src/logs/read-window.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd apps/runner && bun run type-check && bun run lint
git add apps/runner/src/logs/read-window.ts apps/runner/src/logs/read-window.spec.ts
git commit -m "feat(runner): raw log windows cut at the last newline (S2a 1b, R12)"
```

---

### Task 3: `LogShipper`

**Files:**
- Create: `apps/runner/test/helpers/manual-clock.ts`, `apps/runner/test/helpers/fake-log-server.ts`
- Create: `apps/runner/src/logs/log-shipper.ts`, test `apps/runner/src/logs/log-shipper.spec.ts`

**Interfaces:**
- Consumes: Task 1 types, `classifyAnswer`, `backoffDelay(attempt, random, maxMs)`; Task 2 `readWindow`;
  `findRunLog(outDir, feature)` from `src/watcher/run-log.ts`; `Sleep` from `src/time.ts`; `Logger`, `errorMessage`.
- Produces: `class LogShipper implements LogShipping` with `constructor(deps: LogShipperDeps)` and
  `close(): Promise<void>`; `interface LogShipperTuning { chunkBytes; maxInFlight; putTimeoutMs; backoffMaxMs }`;
  `interface LogShipperDeps { transport; log; nowMs; sleep; random; tuning }`.
- Produces (test helpers): `manualClock()`, `fakeLogServer()` (used again in Task 5).

- [ ] **Step 1: Write the test helpers**

`apps/runner/test/helpers/manual-clock.ts`:

```ts
import type { Sleep } from '../../src/time';

/** A clock that moves only when the test says so. A sleeper wakes when `advance` reaches its deadline, or at once on abort. */
export function manualClock(startMs = 0) {
  let t = startMs;
  let sleepers: Array<{ at: number; wake: () => void }> = [];
  const sleep: Sleep = (ms, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const entry = { at: t + ms, wake: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = (): void => {
      sleepers = sleepers.filter((s) => s !== entry);
      resolve();
    };
    sleepers = [...sleepers, entry];
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return {
    nowMs: (): number => t,
    sleep,
    /** Moves time forward and wakes every sleeper that is due. Callers then `waitFor` what the woken code does. */
    advance(ms: number): void {
      t += ms;
      const due = sleepers.filter((s) => s.at <= t);
      sleepers = sleepers.filter((s) => s.at > t);
      for (const s of due) s.wake();
    },
  };
}
```

`apps/runner/test/helpers/fake-log-server.ts`:

```ts
import type { LogStreamName, LogTransport, PutLogAnswer, PutLogArgs } from '../../src/logs/types';

export interface LogCall {
  readonly key: string;
  readonly stream: LogStreamName;
  readonly offset: number;
  readonly text: string;
  readonly final: boolean;
}

/** One scripted answer for the next PUT: an answer, 'hold' (wait for release() or the abort), or 'network' (reject). */
export type LogOverride = PutLogAnswer | 'hold' | 'network';

/**
 * The slice 1a upload rules in memory (exact-offset append, duplicate, offset, final only at the end, complete is
 * sticky), keyed `<jobId>:<leaseEpoch>:<stream>`. Overrides are taken in order, one per PUT.
 */
export function fakeLogServer() {
  const files = new Map<string, Buffer>();
  const complete = new Set<string>();
  const calls: LogCall[] = [];
  const overrides: LogOverride[] = [];
  let held: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const answer = (key: string, bytes: Buffer, offset: number, final: boolean): PutLogAnswer => {
    const current = files.get(key) ?? Buffer.alloc(0);
    if (complete.has(key)) return { status: 200, outcome: 'complete', size: current.length };
    let size = current.length;
    let outcome: 'appended' | 'duplicate' = 'duplicate';
    if (bytes.length > 0) {
      if (offset === current.length) {
        files.set(key, Buffer.concat([current, bytes]));
        size += bytes.length;
        outcome = 'appended';
      } else if (offset + bytes.length > current.length) {
        return { status: 200, outcome: 'offset', size };
      }
    } else if (offset !== current.length) {
      return { status: 200, outcome: 'offset', size };
    }
    if (final) {
      if (size !== offset + bytes.length) return { status: 200, outcome: 'offset', size };
      complete.add(key);
      return { status: 200, outcome: 'complete', size };
    }
    return { status: 200, outcome, size };
  };

  const transport: LogTransport = {
    async putLog(args: PutLogArgs): Promise<PutLogAnswer> {
      const key = `${args.jobId}:${args.leaseEpoch}:${args.stream}`;
      const bytes = Buffer.from(args.bytes);
      calls.push({ key, stream: args.stream, offset: args.offset, text: bytes.toString('utf8'), final: args.final });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const next = overrides.shift();
        if (next === 'network') throw new Error('connect ECONNREFUSED');
        if (next === 'hold') {
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => reject(new Error('aborted'));
            if (args.signal?.aborted) abort();
            args.signal?.addEventListener('abort', abort, { once: true });
            held = [...held, resolve];
          });
        } else if (next !== undefined) {
          return next;
        }
        return answer(key, bytes, args.offset, args.final);
      } finally {
        inFlight -= 1;
      }
    },
  };

  return {
    transport,
    calls,
    overrides,
    /** Lets every held PUT go on to the normal answer. */
    release(): void {
      const waiting = held;
      held = [];
      for (const resolve of waiting) resolve();
    },
    get maxInFlight(): number { return maxInFlight; },
    get inFlight(): number { return inFlight; },
    stored: (key: string): string => (files.get(key) ?? Buffer.alloc(0)).toString('utf8'),
    isComplete: (key: string): boolean => complete.has(key),
    /** Pretends a previous daemon already uploaded these bytes (re-adopt). */
    seed: (key: string, text: string): void => { files.set(key, Buffer.from(text)); },
  };
}
```

- [ ] **Step 2: Write the failing shipper tests**

`apps/runner/src/logs/log-shipper.spec.ts`:

```ts
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryLogger } from '../logger';
import { fakeLogServer } from '../../test/helpers/fake-log-server';
import { manualClock } from '../../test/helpers/manual-clock';
import { makeTempDirs } from '../../test/helpers/tmp';
import { waitFor } from '../../test/helpers/wait';
import { LogShipper, type LogShipperTuning } from './log-shipper';
import type { JobLogSources } from './types';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const shippers: LogShipper[] = [];
afterEach(async () => { await Promise.all(shippers.splice(0).map((s) => s.close())); });

function setup(over: { tuning?: Partial<LogShipperTuning>; random?: () => number } = {}) {
  const clock = manualClock();
  const server = fakeLogServer();
  const log = createMemoryLogger();
  const notes: Array<{ job: string; level: string; message: string }> = [];
  const shipper = new LogShipper({
    transport: server.transport, log, nowMs: clock.nowMs, sleep: clock.sleep, random: over.random ?? (() => 0),
    tuning: { chunkBytes: 64, maxInFlight: 2, putTimeoutMs: 30_000, backoffMaxMs: 30_000, ...over.tuning },
  });
  shippers.push(shipper);
  const register = (jobId: string, sources: JobLogSources) => shipper.register({
    jobId, leaseEpoch: 1, sources, lifecycle: (level, message) => { notes.push({ job: jobId, level, message }); },
  });
  return { clock, server, log, notes, shipper, register };
}

async function job(name: string, runLog = true): Promise<{ dir: string; sources: JobLogSources; runPath: string }> {
  const dir = await tmp.make(name);
  const outDir = join(dir, 'nax-out');
  return {
    dir,
    sources: { outDir, feature: 'f', stdoutPath: join(dir, 'nax.stdout'), stderrPath: join(dir, 'nax.stderr'), runLog },
    runPath: join(outDir, 'features', 'f', 'runs', 'log-1.jsonl'),
  };
}
const writeRun = async (path: string, text: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

describe('shipping while the job runs', () => {
  test('sends whole lines from offset 0 and holds a partial last line until it is finished', async () => {
    const t = setup();
    const j = await job('lines');
    await writeFile(j.sources.stdoutPath, 'one\ntw');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'one\n');
    await appendFile(j.sources.stdoutPath, 'o\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'one\ntwo\n');
    expect(t.server.calls.every((c) => !c.final)).toBe(true);
  });
  test('a file larger than a chunk goes in chunk-sized pieces; an overlong line goes as a full window (R12)', async () => {
    const t = setup();
    const j = await job('long');
    const content = `${'x'.repeat(150)}\nshort\n`;
    await writeFile(j.sources.stderrPath, content);
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stderr') === content);
    expect(t.server.calls.filter((c) => c.stream === 'stderr').map((c) => c.text.length)).toEqual([64, 64, 29]);
  });
  test('resumes at the server size: a re-adopted stream starts at 0, the answer jumps it, nothing is stored twice (R3)', async () => {
    const t = setup();
    const j = await job('resume');
    await writeFile(j.sources.stdoutPath, 'a\nb\nc\n');
    t.server.seed('j1:1:stdout', 'a\nb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\nc\n');
    expect(t.server.calls.map((c) => c.offset)).toEqual([0, 4]);
  });
  test('the run log is found on a later wake and shipped from 0; a PLAN job never ships one (spec §2.4)', async () => {
    const t = setup();
    const run = await job('run');
    const plan = await job('plan', false);
    t.register('run', run.sources);
    t.register('plan', plan.sources);
    await Bun.sleep(30);                                            // the first search has come back empty
    expect(t.server.calls).toEqual([]);
    await writeRun(run.runPath, '{"msg":"a"}\n');
    await writeRun(plan.runPath, '{"msg":"p"}\n');
    t.shipper.wake('run', 1);
    t.shipper.wake('plan', 1);
    await waitFor(() => t.server.stored('run:1:run') === '{"msg":"a"}\n');
    await Bun.sleep(30);
    expect(t.server.calls.some((c) => c.key === 'plan:1:run')).toBe(false);
  });
  test('at most maxInFlight PUTs at once (R4)', async () => {
    const t = setup();
    const a = await job('a');
    const b = await job('b');
    for (const path of [a.sources.stdoutPath, a.sources.stderrPath, b.sources.stdoutPath]) await writeFile(path, 'x\n');
    t.server.overrides.push('hold', 'hold', 'hold');
    t.register('a', a.sources);
    t.register('b', b.sources);
    await waitFor(() => t.server.inFlight === 2);
    await Bun.sleep(30);
    expect(t.server.inFlight).toBe(2);
    t.server.release();
    await waitFor(() => t.server.calls.length === 3 && t.server.inFlight === 1);   // the third hold is registered
    t.server.release();
    await waitFor(() => ['a:1:stdout', 'a:1:stderr', 'b:1:stdout'].every((k) => t.server.stored(k) === 'x\n'));
    expect(t.server.maxInFlight).toBe(2);
  });
  test('round-robin: a chatty stream does not starve another job\'s stream (R4)', async () => {
    const t = setup({ tuning: { maxInFlight: 1 } });
    const chatty = await job('chatty');
    const quiet = await job('quiet');
    await writeFile(chatty.sources.stdoutPath, `${'c'.repeat(63)}\n`.repeat(5));   // five 64-byte chunks
    t.server.overrides.push('hold');
    t.register('chatty', chatty.sources);
    await waitFor(() => t.server.inFlight === 1);
    await writeFile(quiet.sources.stdoutPath, 'q\n');
    t.register('quiet', quiet.sources);
    t.server.release();
    await waitFor(() => t.server.stored('chatty:1:stdout').length === 320 && t.server.stored('quiet:1:stdout') === 'q\n');
    const order = t.server.calls.filter((c) => c.stream === 'stdout').map((c) => c.key);
    expect(order.indexOf('quiet:1:stdout')).toBeLessThan(order.lastIndexOf('chatty:1:stdout'));
    expect(order.indexOf('quiet:1:stdout')).toBeLessThanOrEqual(2);
  });
  test('wake returns at once while a PUT hangs: the watch tick never waits on the network (R4)', async () => {
    const t = setup();
    const j = await job('hang');
    await writeFile(j.sources.stdoutPath, 'x\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) t.shipper.wake('j1', 1);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('the answer table (spec §2.4, plan D323)', () => {
  test('offset jumps to the server size and continues from there', async () => {
    const t = setup();
    const j = await job('offset');
    await writeFile(j.sources.stdoutPath, 'a\nb\n');
    t.server.seed('j1:1:stdout', 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'offset', size: 2 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\nb\n');
    expect(t.server.calls[1].offset).toBe(2);
  });
  test('404 stops every stream of the job like 409 (the job is gone)', async () => {
    const t = setup();
    const j = await job('gone');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 404 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await writeFile(j.sources.stderrPath, 'e\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    expect(await t.shipper.drain('j1', 1, 1_000)).toBe('drained');
  });
  test('an ack that does not move past a non-empty PUT backs off instead of re-sending at once', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('stuck');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'appended', size: 0 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(500);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
  });
  test('offset or duplicate with a size above the local file: diverged, lifecycle warn, no further PUT (R6)', async () => {
    for (const outcome of ['offset', 'duplicate'] as const) {
      const t = setup();
      const j = await job(`ahead-${outcome}`);
      await writeFile(j.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status: 200, outcome, size: 50 });
      t.register('j1', j.sources);
      await waitFor(() => t.notes.length === 1);
      expect(t.notes[0]).toMatchObject({ level: 'warn' });
      expect(t.notes[0].message).toContain('stdout');
      t.shipper.wake('j1', 1);
      await Bun.sleep(30);
      expect(t.server.calls.filter((c) => c.stream === 'stdout')).toHaveLength(1);
    }
  });
  test('complete: the stream is done and later wakes send nothing', async () => {
    const t = setup();
    const j = await job('complete');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'complete', size: 2 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await appendFile(j.sources.stdoutPath, 'b\n');
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
  });
  test('stream_cap: that stream stops with a lifecycle warn; the job\'s other stream goes on', async () => {
    const t = setup();
    const j = await job('cap');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'stream_cap', size: 1 });
    t.register('j1', j.sources);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0]).toMatchObject({ level: 'warn' });
    expect(t.notes[0].message).toContain('size cap');
    await writeFile(j.sources.stderrPath, 'e\n');
    t.shipper.wake('j1', 1);
    await waitFor(() => t.server.stored('j1:1:stderr') === 'e\n');
  });
  test('rate_limited pauses every stream for retryAfterMs, then shipping resumes', async () => {
    const t = setup();
    const a = await job('ra');
    const b = await job('rb');
    await writeFile(a.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 5_000 });
    t.register('a', a.sources);
    await waitFor(() => t.server.calls.length === 1);
    await writeFile(b.sources.stdoutPath, 'b\n');
    t.register('b', b.sources);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(5_000);
    await waitFor(() => t.server.stored('a:1:stdout') === 'a\n' && t.server.stored('b:1:stdout') === 'b\n');
  });
  test('409 and 401 stop every stream of that job, without a lifecycle event; another job is untouched', async () => {
    for (const status of [409, 401]) {
      const t = setup();
      const a = await job(`stop-a-${status}`);
      const b = await job(`stop-b-${status}`);
      await writeFile(a.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status });
      t.register('a', a.sources);
      await waitFor(() => t.server.calls.length === 1);
      await writeFile(a.sources.stderrPath, 'e\n');
      t.shipper.wake('a', 1);
      await writeFile(b.sources.stdoutPath, 'b\n');
      t.register('b', b.sources);
      await waitFor(() => t.server.stored('b:1:stdout') === 'b\n');
      expect(t.server.calls.some((c) => c.key === 'a:1:stderr')).toBe(false);
      expect(t.notes).toEqual([]);
    }
  });
  test('400 and 413 stop only that stream, with a lifecycle error', async () => {
    for (const status of [400, 413]) {
      const t = setup();
      const j = await job(`bad-${status}`);
      await writeFile(j.sources.stdoutPath, 'a\n');
      t.server.overrides.push({ status });
      t.register('j1', j.sources);
      await waitFor(() => t.notes.length === 1);
      expect(t.notes[0]).toMatchObject({ level: 'error' });
      expect(t.notes[0].message).toContain(`HTTP ${status}`);
      await writeFile(j.sources.stderrPath, 'e\n');
      t.shipper.wake('j1', 1);
      await waitFor(() => t.server.stored('j1:1:stderr') === 'e\n');
    }
  });
  test('422, 507 and a network failure back off with jitter, then retry the same offset', async () => {
    const t = setup({ random: () => 0.5 });
    const j = await job('backoff');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 422 }, { status: 507 }, 'network');
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
    t.clock.advance(500);                                           // attempt 0: 0.5 * 1 s
    await waitFor(() => t.server.calls.length === 2);
    t.clock.advance(1_000);                                         // attempt 1: 0.5 * 2 s
    await waitFor(() => t.server.calls.length === 3);
    t.clock.advance(2_000);                                         // attempt 2: 0.5 * 4 s
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    expect(t.server.calls.map((c) => c.offset)).toEqual([0, 0, 0, 0]);
    expect(t.log.lines.filter((l) => l.message === 'log upload failed; backing off')).toHaveLength(1);
  });
  test('a PUT that hangs is aborted after putTimeoutMs and retried', async () => {
    const t = setup();
    const j = await job('timeout');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    t.clock.advance(30_000);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'a\n');
    expect(t.server.calls).toHaveLength(2);
  });
  test('a file that shrinks below the acked offset is diverged with a lifecycle warn and never rewound (R6)', async () => {
    const t = setup();
    const j = await job('shrink');
    await writeFile(j.sources.stdoutPath, 'aaaa\nbbbb\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'aaaa\nbbbb\n');
    await truncate(j.sources.stdoutPath, 3);
    t.shipper.wake('j1', 1);
    await waitFor(() => t.notes.length === 1);
    expect(t.notes[0].message).toContain('shrank');
    expect(t.server.calls.every((c) => c.offset !== 0 || c === t.server.calls[0])).toBe(true);
  });
});

describe('drain, stop and close (spec §2.4 R5)', () => {
  test('drain ships to the file end without a newline cut, ends with final=1, and resolves drained', async () => {
    const t = setup();
    const j = await job('drain');
    await writeFile(j.sources.stdoutPath, 'a\nno newline');
    await writeFile(j.sources.stderrPath, '');
    await writeRun(j.runPath, '{"m":1}\n');
    t.register('j1', j.sources);
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.server.stored('j1:1:stdout')).toBe('a\nno newline');
    for (const stream of ['stdout', 'stderr', 'run']) expect(t.server.isComplete(`j1:1:${stream}`)).toBe(true);
    expect(t.server.calls.filter((c) => c.final)).toHaveLength(3);
    expect(t.server.calls.find((c) => c.key === 'j1:1:stderr')).toMatchObject({ offset: 0, text: '', final: true });
  });
  test('drain during an in-flight PUT: final goes only after that window is acked and the rest is read (Review focus 1)', async () => {
    const t = setup();
    const j = await job('inflight');
    await writeFile(j.sources.stdoutPath, 'a\ntail');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.server.release();
    expect(await drained).toBe('drained');
    expect(t.server.stored('j1:1:stdout')).toBe('a\ntail');
    const stdout = t.server.calls.filter((c) => c.stream === 'stdout');
    expect(stdout.map((c) => [c.offset, c.text, c.final])).toEqual([[0, 'a\n', false], [2, 'tail', true]]);
  });
  test('a stream whose file never appeared is done at drain with no PUT; a run log found only by the drain is shipped (Review focus 3)', async () => {
    const t = setup();
    const j = await job('late');
    await writeFile(j.sources.stdoutPath, 'o\n');
    t.register('j1', j.sources);
    await waitFor(() => t.server.stored('j1:1:stdout') === 'o\n');
    await writeRun(j.runPath, '{"late":true}\n');
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.server.calls.some((c) => c.stream === 'stderr')).toBe(false);
    expect(t.server.stored('j1:1:run')).toBe('{"late":true}\n');
    expect(t.server.isComplete('j1:1:run')).toBe(true);
  });
  test('drain times out: in-flight PUTs are aborted, nothing more is sent, and it resolves timeout', async () => {
    const t = setup();
    const j = await job('drain-timeout');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.clock.advance(120_000);
    expect(await drained).toBe('timeout');
    await waitFor(() => t.server.inFlight === 0);
    const sent = t.server.calls.length;
    t.shipper.wake('j1', 1);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(sent);
  });
  test('stopJob mid-drain aborts the PUT, resolves stopped, and writes no lifecycle event (Review focus 4)', async () => {
    const t = setup();
    const j = await job('stop');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    t.shipper.stopJob('j1', 1);
    expect(await drained).toBe('stopped');
    await waitFor(() => t.server.inFlight === 0);
    await Bun.sleep(30);
    expect(t.notes).toEqual([]);
    expect(t.server.calls).toHaveLength(1);
  });
  test('a stream backing off is bounded by the drain deadline', async () => {
    const t = setup({ random: () => 0.999 });
    const j = await job('drain-backoff');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    t.register('j1', j.sources);
    await waitFor(() => t.server.calls.length === 1);
    const drained = t.shipper.drain('j1', 1, 1_500);
    t.clock.advance(1_500);
    expect(await drained).toBe('timeout');
  });
  test('a lifecycle callback that throws still settles the stream, so the drain finishes', async () => {
    const t = setup();
    const j = await job('throwing');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push({ status: 200, outcome: 'offset', size: 99 });
    t.shipper.register({ jobId: 'j1', leaseEpoch: 1, sources: j.sources, lifecycle: () => { throw new Error('journal closed'); } });
    await waitFor(() => t.server.calls.length === 1);
    expect(await t.shipper.drain('j1', 1, 120_000)).toBe('drained');
    expect(t.log.lines.some((l) => l.message === 'log lifecycle callback failed')).toBe(true);
  });
  test('drain of an unknown or already finished job resolves drained at once', async () => {
    const t = setup();
    expect(await t.shipper.drain('nobody', 1, 1_000)).toBe('drained');
  });
  test('close resolves a pending drain with stopped and the workers end', async () => {
    const t = setup();
    const j = await job('close');
    await writeFile(j.sources.stdoutPath, 'a\n');
    t.server.overrides.push('hold');
    t.register('j1', j.sources);
    await waitFor(() => t.server.inFlight === 1);
    const drained = t.shipper.drain('j1', 1, 120_000);
    await t.shipper.close();
    expect(await drained).toBe('stopped');
    t.register('j2', j.sources);
    await Bun.sleep(30);
    expect(t.server.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun run test src/logs/log-shipper.spec.ts`
Expected: FAIL — `Cannot find module './log-shipper'`.

- [ ] **Step 4: Implement**

`apps/runner/src/logs/log-shipper.ts`:

```ts
import { errorMessage } from '../errors';
import type { Logger } from '../logger';
import { backoffDelay } from '../sync/backoff';
import type { Sleep } from '../time';
import { findRunLog } from '../watcher/run-log';
import { classifyAnswer, type AnswerAction } from './answer';
import { readWindow } from './read-window';
import type { DrainResult, LogJob, LogShipping, LogStreamName, LogTransport, PutLogAnswer } from './types';

export interface LogShipperTuning {
  readonly chunkBytes: number;
  readonly maxInFlight: number;
  readonly putTimeoutMs: number;
  readonly backoffMaxMs: number;
}

export interface LogShipperDeps {
  readonly transport: LogTransport;
  readonly log: Logger;
  readonly nowMs: () => number;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly tuning: LogShipperTuning;
}

type StreamStatus = 'active' | 'done' | 'stopped' | 'diverged';

interface StreamEntry {
  readonly job: JobEntry;
  readonly stream: LogStreamName;
  readonly path: string;
  acked: number;
  status: StreamStatus;
  /** Plan D324: may have bytes to send. Cleared when picked; set by wake, drain, an ack, a backoff or a pause. */
  dirty: boolean;
  busy: boolean;
  failures: number;
  retryAt: number;
  inFlight: AbortController | null;
}

interface JobEntry {
  readonly key: string;
  readonly spec: LogJob;
  readonly streams: StreamEntry[];
  draining: boolean;
  /** Look for the run log on the next worker pass. */
  runSearch: boolean;
  /** A drain may finish: the run stream exists, is not expected, or was searched for after the drain began. */
  runResolved: boolean;
  waiters: Array<(result: DrainResult) => void>;
  drainTimer: AbortController | null;
}

type PutResult = { readonly kind: 'answer'; readonly answer: PutLogAnswer } | { readonly kind: 'error'; readonly message: string };

interface SentWindow {
  readonly fileSize: number;
  readonly sentFrom: number;
  readonly sentBytes: number;
  readonly final: boolean;
}

const IDLE_MS = 60_000;
const ERROR_PAUSE_MS = 1_000;
const jobKey = (jobId: string, leaseEpoch: number): string => `${jobId}:${leaseEpoch}`;

/**
 * S2a §2.4: one shipper for the whole runner (R4). Workers PUT raw byte windows of each job's log files to the
 * upload route, at most `maxInFlight` at a time, round-robin over the streams (plan D324).
 */
export class LogShipper implements LogShipping {
  private readonly jobs = new Map<string, JobEntry>();
  private order: StreamEntry[] = [];
  private cursor = -1;
  private pausedUntil = 0;
  private wakeSignal = new AbortController();
  private workers: Array<Promise<void>> = [];
  private closed = false;

  constructor(private readonly deps: LogShipperDeps) {}

  register(spec: LogJob): void {
    const key = jobKey(spec.jobId, spec.leaseEpoch);
    if (this.closed || this.jobs.has(key)) return;
    const job: JobEntry = {
      key, spec, streams: [], draining: false, runSearch: spec.sources.runLog, runResolved: !spec.sources.runLog, waiters: [], drainTimer: null,
    };
    this.jobs.set(key, job);
    this.addStream(job, 'stdout', spec.sources.stdoutPath);
    this.addStream(job, 'stderr', spec.sources.stderrPath);
    this.startWorkers();
    this.kick();
  }

  wake(jobId: string, leaseEpoch: number): void {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (!job) return;
    for (const stream of job.streams) stream.dirty = true;
    if (this.lacksRun(job)) job.runSearch = true;
    this.kick();
  }

  drain(jobId: string, leaseEpoch: number, timeoutMs: number): Promise<DrainResult> {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (!job) return Promise.resolve('drained');
    const result = new Promise<DrainResult>((resolve) => { job.waiters = [...job.waiters, resolve]; });
    job.draining = true;
    if (this.lacksRun(job)) {
      job.runSearch = true;
      job.runResolved = false;
    }
    for (const stream of job.streams) stream.dirty = true;
    if (job.drainTimer === null) {
      const timer = new AbortController();
      job.drainTimer = timer;
      void this.deps.sleep(timeoutMs, timer.signal).then(() => {
        if (!timer.signal.aborted) this.endJob(job, 'timeout');
      });
    }
    this.checkDrained(job);
    this.kick();
    return result;
  }

  stopJob(jobId: string, leaseEpoch: number): void {
    const job = this.jobs.get(jobKey(jobId, leaseEpoch));
    if (job) this.endJob(job, 'stopped');
  }

  /** Plan D328: daemon stop and crash. Pending drains resolve 'stopped'; in-flight PUTs are aborted. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.jobs.values()]) this.endJob(job, 'stopped');
    this.kick();
    await Promise.allSettled(this.workers);
  }

  private lacksRun(job: JobEntry): boolean {
    return job.spec.sources.runLog && !job.streams.some((s) => s.stream === 'run');
  }

  private addStream(job: JobEntry, stream: LogStreamName, path: string): void {
    const entry: StreamEntry = { job, stream, path, acked: 0, status: 'active', dirty: true, busy: false, failures: 0, retryAt: 0, inFlight: null };
    job.streams.push(entry);
    this.order = [...this.order, entry];
  }

  private startWorkers(): void {
    if (this.workers.length > 0) return;
    this.workers = Array.from({ length: this.deps.tuning.maxInFlight }, () => this.work());
  }

  /** Wakes every idle worker: the current sleep's signal aborts and a fresh one takes its place. */
  private kick(): void {
    const previous = this.wakeSignal;
    this.wakeSignal = new AbortController();
    previous.abort();
  }

  private async work(): Promise<void> {
    while (!this.closed) {
      // Final review: the signal is taken BEFORE any await, so a kick() during discover() or ship() is never lost.
      const signal = this.wakeSignal.signal;
      try {
        await this.discover();
        const now = this.deps.nowMs();   // one clock read for pick and idleMs, so a due retry is never slept past
        const next = this.pick(now);
        if (next) await this.ship(next);
        else if (this.closed || [...this.jobs.values()].some((job) => job.runSearch)) continue;
        else await this.deps.sleep(this.idleMs(now), signal);
      } catch (error) {
        this.deps.log.warn('log shipper error', { error: errorMessage(error) });
        if (!this.closed) await this.deps.sleep(ERROR_PAUSE_MS, signal);
      }
    }
  }

  /** The run log appears once nax starts its run (spec §2.4); a drain searches once more before it can finish. */
  private async discover(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (!job.runSearch) continue;
      job.runSearch = false;
      const searchedWhileDraining = job.draining;
      let path: string | null;
      try {
        path = await findRunLog(job.spec.sources.outDir, job.spec.sources.feature);
      } catch (error) {
        job.runSearch = true;   // a file vanished mid-search: look again (work() paces a repeated throw at 1 s)
        throw error;
      }
      if (this.jobs.get(job.key) !== job) continue;
      if (path !== null && this.lacksRun(job)) this.addStream(job, 'run', path);
      if (path !== null || searchedWhileDraining) job.runResolved = true;
      this.checkDrained(job);
    }
  }

  private pick(now: number): StreamEntry | null {
    if (now < this.pausedUntil || this.order.length === 0) return null;
    for (let step = 1; step <= this.order.length; step += 1) {
      const index = (this.cursor + step) % this.order.length;
      const entry = this.order[index];
      if (entry.status !== 'active' || entry.busy || !entry.dirty || entry.retryAt > now) continue;
      this.cursor = index;
      entry.busy = true;
      entry.dirty = false;
      return entry;
    }
    return null;
  }

  private idleMs(now: number): number {
    const waits = [this.pausedUntil - now, ...this.order.filter((s) => s.status === 'active' && !s.busy && s.dirty).map((s) => s.retryAt - now)]
      .filter((ms) => ms > 0);
    return waits.length > 0 ? Math.min(...waits) : IDLE_MS;
  }

  private async ship(entry: StreamEntry): Promise<void> {
    try {
      const window = await readWindow(entry.path, entry.acked, this.deps.tuning.chunkBytes, entry.job.draining);
      if (entry.status !== 'active') return;
      if (window === null) {
        if (entry.job.draining) this.settle(entry, 'done');   // plan D325: no file, nothing to complete
        return;
      }
      if (window.fileSize < entry.acked) {
        this.diverge(entry, `the ${entry.stream} log shrank below what the server holds (${window.fileSize} < ${entry.acked} bytes); the bundle fills it`);
        return;
      }
      const final = entry.job.draining && entry.acked + window.bytes.length >= window.fileSize;
      if (window.bytes.length === 0 && !final) return;
      const sentFrom = entry.acked;
      const result = await this.put(entry, window.bytes, final);
      if (entry.status !== 'active') return;
      this.apply(entry, result, { fileSize: window.fileSize, sentFrom, sentBytes: window.bytes.length, final });
    } catch (error) {
      // Final review: a read error (EACCES, a file replaced mid-read) or a throwing callback must not strand the
      // stream with dirty=false; it backs off and is retried, so a drain still converges or times out cleanly.
      if (entry.status === 'active') this.backoff(entry, errorMessage(error));
    } finally {
      entry.busy = false;
      entry.inFlight = null;
    }
  }

  private async put(entry: StreamEntry, bytes: Buffer, final: boolean): Promise<PutResult> {
    const request = new AbortController();
    const timer = new AbortController();
    entry.inFlight = request;
    void this.deps.sleep(this.deps.tuning.putTimeoutMs, timer.signal).then(() => {
      if (!timer.signal.aborted) request.abort(new Error('log upload timed out'));
    });
    try {
      const { jobId, leaseEpoch } = entry.job.spec;
      const answer = await this.deps.transport.putLog({ jobId, stream: entry.stream, leaseEpoch, offset: entry.acked, bytes, final, signal: request.signal });
      return { kind: 'answer', answer };
    } catch (error) {
      return { kind: 'error', message: errorMessage(error) };
    } finally {
      timer.abort();
    }
  }

  private apply(entry: StreamEntry, result: PutResult, sent: SentWindow): void {
    const action: AnswerAction = result.kind === 'answer' ? classifyAnswer(result.answer) : { kind: 'backoff', detail: result.message };
    const { jobId, leaseEpoch } = entry.job.spec;
    switch (action.kind) {
      case 'ack':
        if (action.size > sent.fileSize) {
          this.diverge(entry, `the server holds more of the ${entry.stream} log than the file (${action.size} > ${sent.fileSize} bytes); the bundle fills it`);
          return;
        }
        if (action.size <= sent.sentFrom && sent.sentBytes > 0 && !sent.final && action.size === entry.acked) {
          this.backoff(entry, `no progress: the server answered size ${action.size} for bytes at ${sent.sentFrom}`);
          return;
        }
        entry.acked = action.size;
        entry.failures = 0;
        entry.dirty = true;
        return;
      case 'done':
        entry.acked = action.size;
        this.settle(entry, 'done');
        return;
      case 'cap':
        this.notify(entry, 'warn', `the ${entry.stream} log reached the server's size cap at ${action.size} bytes; the full text is in the bundle`);
        this.settle(entry, 'stopped');
        return;
      case 'pause':
        this.pausedUntil = Math.max(this.pausedUntil, this.deps.nowMs() + action.ms);
        entry.failures = 0;
        entry.dirty = true;
        return;
      case 'stop-job':
        this.deps.log.warn('log upload refused for the job; its streams stop', { jobId, leaseEpoch, status: action.status });
        this.endJob(entry.job, 'stopped');
        return;
      case 'fail-stream':
        this.notify(entry, 'error', `${entry.stream} log upload refused (HTTP ${action.status}); the bundle fills it`);
        this.settle(entry, 'stopped');
        return;
      case 'backoff':
        this.backoff(entry, action.detail);
        return;
    }
  }

  private backoff(entry: StreamEntry, detail: string): void {
    const { jobId, leaseEpoch } = entry.job.spec;
    entry.failures += 1;
    entry.retryAt = this.deps.nowMs() + backoffDelay(entry.failures - 1, this.deps.random, this.deps.tuning.backoffMaxMs);
    entry.dirty = true;
    if (entry.failures === 1 || entry.failures % 10 === 0) {
      this.deps.log.warn('log upload failed; backing off', { jobId, leaseEpoch, stream: entry.stream, failures: entry.failures, detail });
    }
  }

  /** A lifecycle callback that throws must not skip the state change that follows it. */
  private notify(entry: StreamEntry, level: 'info' | 'warn' | 'error', message: string): void {
    try {
      entry.job.spec.lifecycle(level, message);
    } catch (error) {
      this.deps.log.warn('log lifecycle callback failed', { jobId: entry.job.spec.jobId, error: errorMessage(error) });
    }
  }

  private diverge(entry: StreamEntry, message: string): void {
    this.notify(entry, 'warn', message);
    this.settle(entry, 'diverged');
  }

  private settle(entry: StreamEntry, status: StreamStatus): void {
    entry.status = status;
    this.checkDrained(entry.job);
  }

  private checkDrained(job: JobEntry): void {
    if (!job.draining || !job.runResolved || job.streams.some((s) => s.status === 'active')) return;
    this.endJob(job, 'drained');
  }

  private endJob(job: JobEntry, result: DrainResult): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    for (const stream of job.streams) {
      if (stream.status === 'active') stream.status = 'stopped';
      stream.inFlight?.abort(new Error('log stream stopped'));
    }
    this.order = this.order.filter((s) => s.job !== job);
    job.drainTimer?.abort();
    const waiters = job.waiters;
    job.waiters = [];
    for (const resolve of waiters) resolve(result);
  }
}
```

Notes for the implementer:
- `checkDrained` inside `drain()` covers a job whose streams are all already finished.
- `work()` never sleeps while closed or while a job still wants a run-log search (final review: a `close()` or a
  `drain()` that lands while a worker is inside `discover()` would otherwise be slept past for up to 60 s).
- A `ship` that resumes after `endJob` sees `status !== 'active'` and returns before any lifecycle call
  (Review focus 4).
- `endJob` aborts the in-flight `AbortController`; the fake transport and `ServerClient.send` both reject on abort,
  so the worker is freed at once.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun run test src/logs/`
Expected: PASS. If a test hangs, a `waitFor` gives up after 10 s with "condition not met in time": check that a
`kick()` follows every change that makes a stream eligible.

- [ ] **Step 6: Commit**

```bash
cd apps/runner && bun run type-check && bun run lint
git add apps/runner/src/logs/log-shipper.ts apps/runner/src/logs/log-shipper.spec.ts apps/runner/test/helpers/manual-clock.ts apps/runner/test/helpers/fake-log-server.ts
git commit -m "feat(runner): runner-wide LogShipper with drain, backoff and divergence (S2a 1b R3-R6, D323-D326)"
```

---

### Task 4: Remove the sync-event log path; `JobExecutor.logSources`

**Files:**
- Modify: `apps/runner/src/watcher/watcher.ts` (full rewrite below), test `apps/runner/src/watcher/watcher.spec.ts`
- Delete: `apps/runner/src/watcher/file-tail.ts`, `apps/runner/src/watcher/log-budget.ts`
- Modify: `apps/runner/src/watcher/status-snapshot.ts:10,46`, test `apps/runner/src/watcher/status-snapshot.spec.ts:29-48`
- Modify: `apps/runner/src/supervisor/job-events.ts:51-54`, test `apps/runner/src/supervisor/job-events.spec.ts:66-69,77`
- Modify: `apps/runner/src/executor/job-executor.ts:30-33,47-70`, `apps/runner/src/executor/host-executor.ts:145-152`,
  test `apps/runner/test/unit/host-executor.spec.ts:73-90,280`
- Modify: `apps/runner/test/helpers/fake-executor.ts`
- Modify (compile only): `apps/runner/src/supervisor/job-run.ts:258-261`, `apps/runner/src/supervisor/supervisor.spec.ts:131,188`,
  `apps/runner/src/supervisor/job-run.spec.ts:422-429`

**Interfaces:**
- Consumes: `JobLogSources` (Task 1).
- Produces: `JobExecutor.logSources(job: JobRow): JobLogSources`; `FakeExecutor.logFiles: JobLogSources` (settable);
  `WatchOptions = { onRunIds? }`; `WatcherSink = { snapshot, lifecycle }`; `WatcherOptions = { outDir, feature, repoDir?, onRunIds? }`.

- [ ] **Step 1: Write the failing tests**

In `apps/runner/src/watcher/watcher.spec.ts`:
1. Remove the imports of `FileTail` and `LogBudget, chunkText`, `truncate` from the `node:fs/promises` import (only
   the deleted shrink test used it; eslint runs with `--max-warnings=0`), the `LogEventPayload` type import, the `logs` variable,
   `logLine` in `sink`, `logs = [];` in `beforeEach`, and the `stdoutPath`, `stderrPath`, `startAtEnd` and `nowMs`
   keys in `options()` (keep `clock` only if still used; delete it and `clock = 0` otherwise).
2. Delete the whole `describe('log tails', ...)`, `describe('the log rate cap (D45)', ...)`, `describe('chunkText', ...)`
   and `describe('FileTail', ...)` blocks.
3. Add:

```ts
describe('logs are not the watcher\'s job (S2a plan D320)', () => {
  test('log files growing changes nothing: no new snapshot, and the run log is only used for its id', async () => {
    await mkdir(runsDir(), { recursive: true });
    await writeFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"a"}\n');
    await writeFile(join(base, 'nax.stdout'), 'out\n');
    await writeStatus();
    const w = new Watcher(sink, options());
    await w.tick();
    await appendFile(join(runsDir(), 'log-1.jsonl'), '{"msg":"b"}\n');
    await appendFile(join(base, 'nax.stdout'), 'more\n');
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ naxLogRunId: 'log-1' });
    expect(ids).toEqual([{ naxRunId: 'run-1', logPath: join(runsDir(), 'log-1.jsonl') }]);
  });
});
```

In `apps/runner/test/unit/host-executor.spec.ts`:
- In the test `'the watcher sees snapshots and log lines from the real process'` rename it to
  `'the watcher sees snapshots from the real process'`, drop the `logs` array, construct the watcher with
  `w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined }, {})`, and replace
  `expect(logs.join('')).toContain('story US-003 done');` with
  `expect(await readFile(join(w.row.jobDir, 'nax.stdout'), 'utf8')).toContain('story US-003 done');`
  (import `readFile` from `node:fs/promises` if the file does not already).
- In the PLAN watcher test use `w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined }, {})`.
- Add, inside the same top-level `describe` as the snapshot test:

```ts
  test('logSources names the job\'s three log files; only a RUN job has a run log (S2a §2.4, plan D321)', async () => {
    const run = await world();
    expect(run.ex.logSources(run.row)).toEqual({
      outDir: join(run.row.jobDir, 'nax-out'), feature: run.row.assign.feature,
      stdoutPath: join(run.row.jobDir, 'nax.stdout'), stderrPath: join(run.row.jobDir, 'nax.stderr'), runLog: true,
    });
    const plan = await world('PLAN');
    expect(plan.ex.logSources(plan.row).runLog).toBe(false);
  });
```

In `apps/runner/src/watcher/status-snapshot.spec.ts`: in `'maps the finish block and the extras'` remove
`, droppedLogs: 4` from both the extras argument and the expectation; delete the test `'zero dropped logs are not reported'`.

In `apps/runner/src/supervisor/job-events.spec.ts`: delete the test `'an oversize log line is cut down'`, and in
`'every call is a quiet no-op'` remove ` events.logLine({ stream: 'run', text: 'x' });`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun run test src/watcher/ test/unit/host-executor.spec.ts`
Expected: FAIL — `w.ex.logSources is not a function` in host-executor.spec. The watcher spec's new test may already
pass (the old watcher sends no extra snapshot for log growth either); the removed sink and options keys surface as
type errors in Step 4's `type-check`, which is this task's real gate.

- [ ] **Step 3: Implement**

Replace `apps/runner/src/watcher/watcher.ts` with:

```ts
import { join } from 'node:path';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { mapStatusToSnapshot, readStatusFile } from './status-snapshot';
import { findCostRunId, findRunLog, runLogId } from './run-log';
import { featureDirFor } from '../paths/safe-segment';
import { readPrdStories, type StoryList } from './prd-stories';

export interface WatcherSink {
  snapshot(payload: SnapshotEventPayload): void;
  lifecycle(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface WatcherOptions {
  readonly outDir: string;
  readonly feature: string;
  /** D146: RUN jobs only. Stories come from `<repoDir>/.nax/features/<feature>/prd.json` (S1b §1.2). */
  readonly repoDir?: string;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

const UNREADABLE_STREAK = 5;

/**
 * Polls nax's status and PRD files and turns them into journal events (design §2 step 7). One tick per poll; the
 * caller sleeps. Logs are not read here: the LogShipper uploads them (S2a §2.4, plan D320).
 */
export class Watcher {
  private unreadable = 0;
  private lastKey = '';
  private lastIds = '';
  private runLogPath: string | null = null;
  /** D148: the serialized list last sent for this job and epoch (one Watcher per JobRun). */
  private lastStories = '';

  constructor(private readonly sink: WatcherSink, private readonly options: WatcherOptions) {}

  async tick(): Promise<void> {
    const { status, problem } = await readStatusFile(join(this.options.outDir, 'status.json'));
    if (problem === 'invalid') {
      this.unreadable += 1;
      if (this.unreadable === UNREADABLE_STREAK) this.sink.lifecycle('warn', 'status.json unreadable 5 times in a row');
      return;
    }
    if (!status) return;
    this.unreadable = 0;
    this.runLogPath ??= await findRunLog(this.options.outDir, this.options.feature);
    const payload = mapStatusToSnapshot(status, {
      logRunId: this.runLogPath ? runLogId(this.runLogPath) : null,
      costRunId: await findCostRunId(this.options.outDir),
    });
    const list = await this.readStories();
    // D148: a failed read keeps the last list's key, so nax caught mid-write emits nothing extra.
    const storiesKey = list ? JSON.stringify(list) : this.lastStories;
    const key = `${JSON.stringify(payload)}\n${storiesKey}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (list !== null && storiesKey !== this.lastStories) {
      this.lastStories = storiesKey;
      this.sink.snapshot({ ...payload, stories: list.stories, storiesTruncated: list.truncated });
    } else {
      this.sink.snapshot(payload);
    }
    const ids = `${status.run.id}|${this.runLogPath ?? ''}`;
    if (ids !== this.lastIds) {
      this.lastIds = ids;
      this.options.onRunIds?.({ naxRunId: status.run.id, logPath: this.runLogPath });
    }
  }

  private async readStories(): Promise<StoryList | null> {
    if (this.options.repoDir === undefined) return null;
    try {
      return await readPrdStories(join(featureDirFor(this.options.repoDir, this.options.feature), 'prd.json'));
    } catch {
      return null;   // featureDirFor refuses only a feature name the assign validator already refused
    }
  }
}
```

Delete the two files:

```bash
git rm apps/runner/src/watcher/file-tail.ts apps/runner/src/watcher/log-budget.ts
```

`apps/runner/src/watcher/status-snapshot.ts`: delete line 10 `  readonly droppedLogs?: number;` and line 46
`    ['droppedLogs', extras.droppedLogs && extras.droppedLogs > 0 ? extras.droppedLogs : undefined],`.

`apps/runner/src/supervisor/job-events.ts`: delete the `logLine` method (lines 51-54), the `MAX_LOG_TEXT` constant,
and `LogEventPayload` from the protocol import.

`apps/runner/src/executor/job-executor.ts`:
- add `import type { JobLogSources } from '../logs/types';`
- replace `WatchOptions` with:

```ts
export interface WatchOptions {
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}
```

- add to `JobExecutor`, after `createWatcher`:

```ts
  /** S2a §2.4, plan D321: where this job's nax writes its run log, stdout and stderr (no I/O). */
  logSources(job: JobRow): JobLogSources;
```

`apps/runner/src/executor/host-executor.ts` — replace `createWatcher` and add `logSources` (import `JobLogSources`
type from `../logs/types`):

```ts
  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    const { outDir, repoDir } = this.dirs(job);
    return new Watcher(sink, {
      outDir, feature: job.assign.feature, onRunIds: options.onRunIds,
      ...(job.command === 'RUN' ? { repoDir } : {}),   // D146: a PLAN checkout's prd.json is an older plan's
    });
  }

  logSources(job: JobRow): JobLogSources {
    const { jobDir, outDir } = this.dirs(job);
    return {
      outDir, feature: job.assign.feature, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      runLog: job.command === 'RUN',   // spec §2.4: PLAN jobs never stream a run log
    };
  }
```

Leave `nowMs` in `HostExecutorDeps`: it now has no reader in `host-executor.ts`, but existing specs
(`test/unit/host-executor-auth.spec.ts`, `test/unit/job-check.spec.ts`) and `daemon.ts` pass it. `JobWatcher.tick(final?)`
also stays: `FakeExecutor.onTick` receives `final`, and JobRun keeps passing it.

`apps/runner/test/helpers/fake-executor.ts` — add the field and method (no `note()`: existing specs assert exact
`calls` arrays):

```ts
import type { JobLogSources } from '../../src/logs/types';
```

```ts
  /** S2a: paths the job's logs live at; the default points nowhere, so the shipper finds no file. */
  logFiles: JobLogSources = {
    outDir: '/nonexistent/koda-fake/nax-out', feature: 'f',
    stdoutPath: '/nonexistent/koda-fake/nax.stdout', stderrPath: '/nonexistent/koda-fake/nax.stderr', runLog: false,
  };
```

```ts
  logSources(): JobLogSources {
    return this.logFiles;
  }
```

`apps/runner/src/supervisor/job-run.ts:258-261` — the watcher no longer takes `startAtEnd`:

```ts
    const watcher = this.deps.executor.createWatcher(start, this.events, {
      onRunIds: (ids) => { this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { naxRunId: ids.naxRunId, logPath: ids.logPath }); },
    });
```

`watchUntilExit(resumed: boolean)` loses its only use of `resumed`: change the signature to `watchUntilExit()` and
the call in `lifecycle()` to `await this.watchUntilExit();`.

`apps/runner/src/supervisor/supervisor.spec.ts:131` and `:188`: replace
`expect(b.ex.watchOptions[0].startAtEnd).toBe(true);` with `expect(b.ex.watchOptions).toHaveLength(1);`.

`apps/runner/src/supervisor/job-run.spec.ts:422-429`: rename the test to
`'watch attaches a watcher and never re-runs prepare or spawn; a cancel recorded while down is re-sent'` and replace
`expect(b.ex.watchOptions[0].startAtEnd).toBe(true);` with `expect(b.ex.watchOptions).toHaveLength(1);`
(Task 5 adds the log registration assertion).

- [ ] **Step 4: Run the tests and the type-check**

Run: `cd apps/runner && bun run type-check && bun run test src/watcher/ src/supervisor/ test/unit/host-executor.spec.ts`
Expected: PASS. `grep -rn "FileTail\|LogBudget\|chunkText\|logLine\|startAtEnd\|droppedLogs" apps/runner/src apps/runner/test`
prints nothing.

- [ ] **Step 5: Commit**

```bash
cd apps/runner && bun run lint
git add -A apps/runner/src/watcher apps/runner/src/supervisor apps/runner/src/executor apps/runner/test/unit/host-executor.spec.ts apps/runner/test/helpers/fake-executor.ts
git commit -m "refactor(runner): drop the sync-event log tail; executors name their log files (S2a 1b D320, D321)"
```

---

### Task 5: `JobRun` registers, wakes, drains and stops the job's logs

**Files:**
- Create: `apps/runner/test/helpers/fake-log-shipping.ts`
- Modify: `apps/runner/src/supervisor/job-run.ts`
- Test: `apps/runner/src/supervisor/job-run.spec.ts`
- Modify (deps only): `apps/runner/src/supervisor/supervisor.spec.ts:18-22`, `apps/runner/src/supervisor/command-handler.spec.ts:18-22`
- Modify: `apps/runner/src/daemon/tuning.ts`, test `apps/runner/src/daemon/tuning.spec.ts`
- Modify: `apps/runner/src/daemon/daemon.ts` (shipper construction, Supervisor deps, `close()` in `stop()`/`crash()`)

**Interfaces:**
- Consumes: `LogShipping`, `DrainResult` (Task 1), `LogShipper` + `fakeLogServer` + `manualClock` (Task 3),
  `JobExecutor.logSources`, `FakeExecutor.logFiles` (Task 4).
- Produces: `JobRunDeps.logs: LogShipping`; `JobRunTuning.logDrainTimeoutMs: number`; `FakeLogShipping`, `NO_LOG_SHIPPING`;
  `Tuning.logChunkBytes`, `logMaxInFlight`, `logPutTimeoutMs`, `logBackoffMaxMs`, `logDrainTimeoutMs`.

- [ ] **Step 1: Write the doubles**

`apps/runner/test/helpers/fake-log-shipping.ts`:

```ts
import type { DrainResult, LogJob, LogShipping } from '../../src/logs/types';

/**
 * Records what a JobRun asks of its log shipper. `register`, `drain` and `stopJob` are also written to `shared`
 * (pass `FakeExecutor.calls` to check their order against executor calls). `holdDrain()` keeps drains pending until
 * `releaseDrain()` or `stopJob`.
 */
export class FakeLogShipping implements LogShipping {
  readonly calls: string[] = [];
  readonly jobs: LogJob[] = [];
  wakes = 0;
  drainResult: DrainResult = 'drained';
  private held: Array<(result: DrainResult) => void> | null = null;

  constructor(private readonly shared?: string[]) {}

  private note(entry: string): void {
    this.calls.push(entry);
    this.shared?.push(entry);
  }

  register(job: LogJob): void {
    this.jobs.push(job);
    this.note(`logs.register:${job.jobId}`);
  }

  wake(): void {
    this.wakes += 1;
  }

  drain(jobId: string): Promise<DrainResult> {
    this.note(`logs.drain:${jobId}`);
    if (this.held === null) return Promise.resolve(this.drainResult);
    return new Promise<DrainResult>((resolve) => { this.held = [...(this.held ?? []), resolve]; });
  }

  stopJob(jobId: string): void {
    this.note(`logs.stop:${jobId}`);
    const waiting = this.held;
    if (waiting === null) return;
    this.held = [];
    for (const resolve of waiting) resolve('stopped');
  }

  holdDrain(): void {
    this.held = [];
  }

  releaseDrain(result: DrainResult = 'drained'): void {
    const waiting = this.held ?? [];
    this.held = null;
    for (const resolve of waiting) resolve(result);
  }
}

/** For Supervisor and CommandHandler specs, which never look at logs. */
export const NO_LOG_SHIPPING: LogShipping = {
  register: () => undefined,
  wake: () => undefined,
  drain: async () => 'drained',
  stopJob: () => undefined,
};
```

- [ ] **Step 2: Write the failing JobRun tests**

In `apps/runner/src/supervisor/job-run.spec.ts`:
- import `FakeLogShipping` from `'../../test/helpers/fake-log-shipping'`, `LogShipper` from `'../logs/log-shipper'`,
  `fakeLogServer` from `'../../test/helpers/fake-log-server'`, `makeTempDirs` from `'../../test/helpers/tmp'`,
  `writeFile` from `'node:fs/promises'`, `join` from `'node:path'`, `afterAll` from `'bun:test'`, and
  `systemSleep` from `'../time'`;
- in `build()`: create `const logs = new FakeLogShipping();`, add `logs` to `deps`, add `logDrainTimeoutMs: 120_000`
  to the tuning literal before `...tuning`, and return `logs` in the result object.

Then add:

```ts
const inOrder = (all: string[], wanted: string[]) => wanted.every((s, i) => all.indexOf(s) >= 0 && (i === 0 || all.indexOf(s) > all.indexOf(wanted[i - 1])));
const lifecycles = (b: Built) => everything(b).filter((e) => e.type === 'lifecycle').map((e) => e.payload as { level: string; message: string });
const tmpLogs = makeTempDirs();
afterAll(() => tmpLogs.cleanup());

describe('log shipping (S2a §2.4, plan D327)', () => {
  test('registers after spawn with the executor\'s log sources; its lifecycle callback writes journal lifecycle events', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.ex.dieAfterTicks(1);
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    expect(inOrder(b.ex.calls, ['spawn:j1', 'logs.register:j1'])).toBe(true);
    expect(logs.jobs[0]).toMatchObject({ jobId: 'j1', leaseEpoch: 1, sources: b.ex.logFiles });
    expect(logs.calls.filter((c) => c === 'logs.register:j1')).toHaveLength(1);
  });
  test('a lifecycle message from the shipper lands on the job\'s timeline', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    b.ex.onTick = (n) => {
      if (n === 1) b.logs.jobs[0].lifecycle('warn', 'the stdout log shrank');
      b.ex.alive = false;
    };
    await b.run.start('prepare');
    expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'the stdout log shrank' });
  });
  test('wakes the shipper after every tick, the final one included', async () => {
    const b = build();
    b.ex.dieAfterTicks(2);
    await b.run.start('prepare');
    expect(b.ex.ticks).toBe(3);
    expect(b.logs.wakes).toBe(3);
  });
  test('drains after the final tick and reap, concurrently with the progress push, and awaits it before UPLOADING (R5)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.status = { run: { id: 'run-1', status: 'failed' } };
    b.ex.dieAfterTicks(1);
    const done = new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    await waitFor(() => b.ex.calls.includes('pushProgress:j1'));
    expect(inOrder(b.ex.calls, ['reap:j1', 'logs.drain:j1', 'pushProgress:j1'])).toBe(true);
    await settle();
    expect(stateNames(b)).toEqual(['RUNNING']);
    logs.releaseDrain();
    await done;
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(inOrder(b.ex.calls, ['logs.drain:j1', 'collectBundle:j1', 'logs.stop:j1', 'cleanup:j1'])).toBe(true);
  });
  test('a drain timeout is a lifecycle warning and the run goes on to its verdict and bundle', async () => {
    const b = build();
    b.logs.drainResult = 'timeout';
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'log upload did not finish within 120 s; the bundle fills the rest' });
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a halt during the drain stops the job\'s logs and reports nothing more (Review focus 4)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.dieAfterTicks(1);
    const run = new JobRun({ ...b.deps, logs }, 'j1', 1);
    const done = run.start('prepare');
    await waitFor(() => logs.calls.includes('logs.drain:j1'));
    run.halt();
    await done;
    expect(logs.calls).toContain('logs.stop:j1');
    expect(stateNames(b)).toEqual(['RUNNING']);
    expect(b.uploads).toEqual([]);
  });
  test('the finish path (nax exited while the daemon was down) registers and drains before UPLOADING (R5)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1' });
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('finish');
    expect(inOrder(b.ex.calls, ['logs.register:j1', 'logs.drain:j1', 'collectBundle:j1'])).toBe(true);
    expect(stateNames(b)).toEqual(['UPLOADING', 'COMPLETED']);
  });
  test('the watch path registers the job\'s logs too', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242, naxRunId: 'run-1' });
    b.ex.alive = true;
    b.ex.dieAfterTicks(1);
    await b.run.start('watch');
    expect(b.logs.calls).toEqual(expect.arrayContaining(['logs.register:j1', 'logs.drain:j1', 'logs.stop:j1']));
  });
  test('a job that never spawns never registers, and its cleanup still releases the key', async () => {
    const b = build();
    b.ex.prepareResult = { ok: false, reason: 'checkout failed' };
    await b.run.start('prepare');
    expect(b.logs.calls).toEqual(['logs.stop:j1', 'logs.stop:j1']);   // cleanup(), then start()'s finally (idempotent)
  });
  test('PLAN: the drain overlaps finishPlan and completes before UPLOADING', async () => {
    const b = build('PLAN');
    const logs = new FakeLogShipping(b.ex.calls);
    logs.holdDrain();
    b.ex.dieAfterTicks(1);
    const done = new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    await waitFor(() => b.ex.calls.includes('finishPlan:j1'));
    expect(inOrder(b.ex.calls, ['logs.drain:j1', 'finishPlan:j1'])).toBe(true);
    await settle();
    expect(stateNames(b)).toEqual(['RUNNING']);
    logs.releaseDrain();
    await done;
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('a runner error drains the logs before its UPLOADING -> FAILED report (no bundle follows)', async () => {
    const b = build();
    const logs = new FakeLogShipping(b.ex.calls);
    b.ex.statusError = new Error('disk gone');
    b.ex.dieAfterTicks(1);
    await new JobRun({ ...b.deps, logs }, 'j1', 1).start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'FAILED']);
    expect(inOrder(b.ex.calls, ['logs.register:j1', 'logs.drain:j1', 'logs.stop:j1', 'cleanup:j1'])).toBe(true);
    expect(b.uploads).toEqual([]);
  });
  test('a re-adopted row that is already terminal never registers its logs', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'COMPLETED', pid: 4242, pgid: 4242 });
    await b.run.start('finish');
    expect(b.logs.calls).toEqual(['logs.stop:j1', 'logs.stop:j1']);
  });
  test('abandon of a run that never started (after a restart) stops the key and registers nothing', async () => {
    const b = build();
    b.journal.updateJob('j1', 1, { state: 'RUNNING', pid: 4242, pgid: 4242 });
    await new JobRun(b.deps, 'j1', 1).abandon();
    expect(b.logs.calls).toEqual(['logs.stop:j1']);
  });
  test('with the real shipper, a PUT that never answers does not slow the watch loop; the drain times out (R4, R5)', async () => {
    const dir = await tmpLogs.make('jr');
    await writeFile(join(dir, 'nax.stdout'), 'line\n');
    const server = fakeLogServer();
    for (let i = 0; i < 10; i += 1) server.overrides.push('hold');
    const shipper = new LogShipper({
      transport: server.transport, log: createMemoryLogger(), nowMs: () => Date.now(), sleep: systemSleep, random: () => 0,
      tuning: { chunkBytes: 1_024, maxInFlight: 2, putTimeoutMs: 60_000, backoffMaxMs: 1_000 },
    });
    try {
      const b = build('RUN', 'j1', { logDrainTimeoutMs: 1_000 });
      b.ex.logFiles = { outDir: join(dir, 'nax-out'), feature: 'f', stdoutPath: join(dir, 'nax.stdout'), stderrPath: join(dir, 'nax.stderr'), runLog: false };
      b.ex.dieAfterTicks(5);
      await new JobRun({ ...b.deps, logs: shipper }, 'j1', 1).start('prepare');
      expect(b.ex.ticks).toBe(6);
      await waitFor(() => server.inFlight === 0);
      expect(lifecycles(b)).toContainEqual({ level: 'warn', message: 'log upload did not finish within 1 s; the bundle fills the rest' });
      expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
    } finally {
      await shipper.close();
    }
  });
});
```

Also, in the existing `'watch attaches a watcher ...'` test (Task 4), add `expect(b.logs.calls).toContain('logs.register:j1');`.

Update the deps literals in `apps/runner/src/supervisor/supervisor.spec.ts` and
`apps/runner/src/supervisor/command-handler.spec.ts`: import `NO_LOG_SHIPPING` from
`'../../test/helpers/fake-log-shipping'`, add `logs: NO_LOG_SHIPPING` to the `new Supervisor({...})` object and
`logDrainTimeoutMs: 120_000` to its `tuning` literal.

`apps/runner/src/daemon/tuning.spec.ts` — the expected object gains, after `jobCheckTimeoutMs: 10_000,`:

```ts
      logChunkBytes: 1_048_576, logMaxInFlight: 2, logPutTimeoutMs: 30_000, logBackoffMaxMs: 30_000, logDrainTimeoutMs: 120_000,
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun run test src/supervisor/job-run.spec.ts src/daemon/tuning.spec.ts`
Expected: FAIL — no `logs.register:j1` in `calls`, `b.logs.wakes` is 0, and the type-check reports the unknown `logs`
dep (run `bun run type-check` to see it).

- [ ] **Step 4: Implement in `apps/runner/src/supervisor/job-run.ts`**

Imports:

```ts
import type { DrainResult, LogShipping } from '../logs/types';
```

`JobRunTuning` gains:

```ts
  /** S2a §2.4 (R5): how long the run waits for its logs to reach the server before UPLOADING. */
  readonly logDrainTimeoutMs: number;
```

`JobRunDeps` gains:

```ts
  /** S2a §2.4 (plan D321): the runner-wide log shipper; nothing in a tick awaits it. */
  readonly logs: LogShipping;
```

`lifecycle()` — register right after spawn, and for `watch`/`finish`:

```ts
  private async lifecycle(from: RunStart): Promise<void> {
    if ((from === 'prepare' || from === 'reprepare') && !(await this.prepareAndSpawn(from === 'reprepare'))) return;
    this.registerLogs();
    if (from === 'watch') {
      await this.resumeCredentials();
      await this.resumeApprovals();
    }
    if (from !== 'finish') await this.watchUntilExit();
    if (this.halted) return;
    await this.finish();
  }

  /**
   * Plan D327: R3 resume — the shipper starts at offset 0 and jumps to the server's size on its first answer.
   * Not after a halt that landed during spawn (halt() already stopped the key), and not for a re-adopted row that is
   * already terminal (its uploads would only collect 409s).
   */
  private registerLogs(): void {
    const row = this.mustRow();
    if (this.halted || isTerminalState(row.state)) return;
    this.deps.logs.register({
      jobId: this.jobId, leaseEpoch: this.leaseEpoch, sources: this.deps.executor.logSources(row),
      lifecycle: (level, message) => this.events.lifecycle(level, message),
    });
  }
```

`halt()` stops the job's streams; `abandon()` goes through it:

```ts
  halt(): void {
    this.halted = true;
    this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
  }
```

and in `abandon()` replace the first line `this.halted = true;` with `this.halt();`.

`tick()` wakes the shipper after every tick, also when the watcher threw:

```ts
  private async tick(watcher: JobWatcher, final: boolean): Promise<void> {
    try {
      await watcher.tick(final);
    } catch (error) {
      this.tickErrors += 1;
      if (this.tickErrors % TICK_WARN_EVERY === 1) this.events.lifecycle('warn', `watcher error: ${errorMessage(error)}`);
    }
    this.deps.logs.wake(this.jobId, this.leaseEpoch);
  }
```

`finish()` — start the drain after the terminal-state check, await it before UPLOADING:

```ts
  private async finish(): Promise<void> {
    const row = this.mustRow();
    if (isTerminalState(row.state)) {
      await this.cleanup();
      return;
    }
    // S2a §2.4 (R5): the logs drain while the verdict, progress push and PLAN finish run; awaited before UPLOADING.
    const drained = this.deps.logs.drain(this.jobId, this.leaseEpoch, this.deps.tuning.logDrainTimeoutMs);
    const judged = await this.judge(row);
```

(keep the body unchanged down to the `if (this.halted) return;` that precedes the UPLOADING transition), then:

```ts
    if (this.halted) return;
    await this.awaitLogs(drained);
    if (this.halted) return;
    if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');
```

New method:

```ts
  /** Plan D327: a timed-out drain is reported; the bundle fallback (slice 1a) fills the incomplete streams. */
  private async awaitLogs(drained: Promise<DrainResult>): Promise<void> {
    if ((await drained) !== 'timeout') return;
    const seconds = Math.max(1, Math.round(this.deps.tuning.logDrainTimeoutMs / 1000));
    this.events.lifecycle('warn', `log upload did not finish within ${seconds} s; the bundle fills the rest`);
  }
```

`start()` becomes a wrapper: rename the existing `start(from)` body to `private async run(from: RunStart)` and add
the `start()` shown here (the only change to the old body is its name). Place this edit before the `lifecycle()`
edit above.

```ts
  async start(from: RunStart): Promise<void> {
    try {
      await this.run(from);
    } finally {
      // Plan D327: every exit releases the job's log streams, including `stale`, a halt and a failSafe whose own
      // recording failed. Idempotent: cleanup() has normally stopped the key already, before markDone.
      this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
    }
  }
```

`failSafe()` drains before its UPLOADING transition (it uploads no bundle, so the fallback cannot fill the streams):

```ts
      if (row) {
        await killIfOurs(this.deps.executor, row, this.deps.log);
        // BUG-4: when the run never spawned (pid is null), a stale `.nax-pids` from a previous attempt at this
        // jobDir would still be inside `since = createdAt`, so reap could SIGKILL someone else's pid. Skip it.
        if (row.pid !== null) await this.reapQuietly(row);
      }
      // Plan D327: no bundle follows a runner error, so whatever nax wrote must reach the server now.
      if (this.events.currentState() === 'RUNNING') {
        await this.awaitLogs(this.deps.logs.drain(this.jobId, this.leaseEpoch, this.deps.tuning.logDrainTimeoutMs));
        if (this.halted) return;
        this.events.transition('UPLOADING');
      }
      this.events.transition('FAILED', `runner error: ${errorMessage(error)}`);
```

(replacing the existing `if (this.events.currentState() === 'RUNNING') this.events.transition('UPLOADING');` line
and the `FAILED` transition after it; the reap block above is unchanged context).

`cleanup()` releases the job's streams before `markDone`:

```ts
  private async cleanup(): Promise<void> {
    this.deps.logs.stopJob(this.jobId, this.leaseEpoch);
    const row = this.row();
    if (!row) return;
```

Final review: the daemon must supply the new required deps in this same task, or `type-check` fails at
`daemon.ts` (`new Supervisor({...})`). Wire the shipper now; Task 6 adds the protocol bump and the daemon test.

`apps/runner/src/daemon/tuning.ts` — the interface gains:

```ts
  /** S2a §7: the largest log window one PUT carries. */
  readonly logChunkBytes: number;
  /** S2a R4: log PUTs in flight at once, across every job of the runner. */
  readonly logMaxInFlight: number;
  /** S2a R4: a log PUT is aborted after this long. */
  readonly logPutTimeoutMs: number;
  /** S2a §2.4: the ceiling of the log upload backoff. */
  readonly logBackoffMaxMs: number;
  /** S2a R5: how long a finished job waits for its logs before UPLOADING. */
  readonly logDrainTimeoutMs: number;
```

and `TUNING` gains, after `jobCheckTimeoutMs: 10_000,`:

```ts
  logChunkBytes: 1_048_576,
  logMaxInFlight: 2,
  logPutTimeoutMs: 30_000,
  logBackoffMaxMs: 30_000,
  logDrainTimeoutMs: 120_000,
```

`apps/runner/src/daemon/daemon.ts`:
- import `import { LogShipper } from '../logs/log-shipper';`
- after the `uploader` is built:

```ts
  // S2a §2.4 (plan D321, D328): one shipper for every job; only this transport talks to the server.
  const shipper = new LogShipper({
    transport: { putLog: (args) => client.putLog(args) },
    log, nowMs: () => now().getTime(), sleep, random: Math.random,
    tuning: { chunkBytes: tuning.logChunkBytes, maxInFlight: tuning.logMaxInFlight, putTimeoutMs: tuning.logPutTimeoutMs, backoffMaxMs: tuning.logBackoffMaxMs },
  });
```

- the `Supervisor` deps gain `logs: shipper,` and its `tuning` literal gains `logDrainTimeoutMs: tuning.logDrainTimeoutMs`.
- in `stop()`, right after `supervisor.shutdown();`, add `await shipper.close();`
- in `crash()`, right after `supervisor.shutdown();`, add
  `void shipper.close();   // a killed daemon's uploads die with it; the next daemon resumes at the server's size (R3)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun run type-check && bun run test src/supervisor/ src/daemon/ test/unit/daemon.spec.ts`
Expected: PASS, including every pre-existing JobRun, Supervisor, CommandHandler and daemon test (every daemon spec uses
`FakeExecutor`, whose default `logFiles` point nowhere, so no log PUT is made).

- [ ] **Step 6: Commit**

```bash
cd apps/runner && bun run lint
git add apps/runner/src/supervisor apps/runner/src/daemon apps/runner/test/helpers/fake-log-shipping.ts
git commit -m "feat(runner): job runs register, wake, drain and stop their log streams; the daemon owns one shipper (S2a 1b D327, R5)"
```

---

### Task 6: Protocol v3, end-to-end daemon test, runner context

**Files:**
- Test: `apps/runner/test/unit/daemon.spec.ts` (the shipper is already wired in Task 5)
- Modify: `packages/fleet-protocol/src/index.ts:1-6`, test `apps/runner/src/sync/batch.spec.ts`
- Modify: `.nax/mono/apps/runner/context.md`; regenerate `apps/runner/{AGENTS,CLAUDE,GEMINI,codex}.md`

**Interfaces:**
- Consumes: the daemon's `LogShipper` wiring (Task 5), `FakeExecutor.logFiles` (Task 4).
- Produces: `FLEET_PROTOCOL_VERSION = 3`.

- [ ] **Step 1: Write the failing tests**

`apps/runner/src/sync/batch.spec.ts` — add inside `describe('buildSyncRequest', ...)`:

```ts
  test('a runner from S2a 1b on speaks protocol v3: it streams logs and sends no log sync events (spec R1, plan D328)', () => {
    expect(FLEET_PROTOCOL_VERSION).toBe(3);
  });
```

`apps/runner/test/unit/daemon.spec.ts`:
- `FakeServer` gains `logs: Map<string, string>` and `order: string[]`; initialise both in `fakeServer()`.
- In `fetch`, before the final `return new Response('nope', { status: 404 });`, add:

```ts
      const logRoute = /^\/api\/fleet\/runner\/jobs\/([^/]+)\/logs\/(run|stdout|stderr)$/.exec(url.pathname);
      if (logRoute && req.method === 'PUT') {
        const key = `${logRoute[1]}:${logRoute[2]}`;
        const text = Buffer.from(await req.arrayBuffer()).toString('utf8');
        const offset = Number(url.searchParams.get('offset'));
        const final = url.searchParams.get('final') === '1';
        const current = server.logs.get(key) ?? '';
        const next = offset === current.length ? current + text : current;
        server.logs.set(key, next);
        if (final) server.order.push(`log-final:${logRoute[2]}`);
        const outcome = final && offset + text.length === next.length ? 'complete' : offset === current.length ? 'appended' : 'offset';
        return envelope({ outcome, size: next.length });
      }
```

- In the sync branch, after `server.syncs.push(body);`, add:

```ts
        for (const job of body.jobs) for (const e of job.events) if (e.type === 'state') server.order.push(`state:${(e.payload as { to: string }).to}`);
```

- Add a test:

```ts
  test('S2a 1b: a job\'s stdout and stderr reach PUT /logs and complete before the UPLOADING event (plan D327, D328)', async () => {
    const server = fakeServer();
    const s = await setup(server);
    const files = await tmp.make('logs');
    await writeFile(join(files, 'nax.stdout'), 'hello\nworld\n');
    await writeFile(join(files, 'nax.stderr'), 'tail without newline');
    s.ex.logFiles = { outDir: join(files, 'nax-out'), feature: 'f', stdoutPath: join(files, 'nax.stdout'), stderrPath: join(files, 'nax.stderr'), runLog: false };
    const daemon = await startDaemon({ home: s.home, config: s.config, identity: s.identity, tuning, log: createMemoryLogger(), executorFactory: () => s.ex });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0].protocolVersion).toBe(3);
      server.queue.push({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: assignFor('RUN') });
      await waitFor(() => server.order.includes('state:COMPLETED'), { timeoutMs: 8_000 });
      expect(server.logs.get('j1:stdout')).toBe('hello\nworld\n');
      expect(server.logs.get('j1:stderr')).toBe('tail without newline');
      expect(server.order).toContain('log-final:stdout');
      expect(server.order).toContain('log-final:stderr');
      const uploading = server.order.indexOf('state:UPLOADING');
      expect(server.order.indexOf('log-final:stdout')).toBeLessThan(uploading);
      expect(server.order.indexOf('log-final:stderr')).toBeLessThan(uploading);
      expect(events(server).some((e) => e.type === 'log')).toBe(false);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun run test src/sync/batch.spec.ts test/unit/daemon.spec.ts`
Expected: FAIL — the protocol is 2 (the new daemon test fails on `protocolVersion`; its log assertions already pass
because Task 5 wired the shipper).

- [ ] **Step 3: Implement**

`packages/fleet-protocol/src/index.ts` — header and constant:

```ts
/**
 * Koda fleet protocol (spec docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md).
 * Shared by apps/api (type-only) and apps/runner. Bump FLEET_PROTOCOL_VERSION on any
 * incompatible wire change. v2 (S1.5): approval relay. v3 (S2a): logs stream over
 * PUT /fleet/runner/jobs/:jobId/logs/:stream; a v3 runner sends no `log` sync events.
 */
export const FLEET_PROTOCOL_VERSION = 3 as const;
```

`.nax/mono/apps/runner/context.md`:
- In "Role In The Monorepo", change "reports progress and a verdict, uploads the run bundle" to
  "reports progress and a verdict, streams the run log, stdout and stderr, uploads the run bundle".
- In "It should not", the first bullet becomes
  "- talk to the server from anywhere but `src/sync/` (other modules write journal events; the sync loop ships them; the bundle and log uploads get transports built in `daemon.ts` over `ServerClient`)".
- In the Architecture block, replace the `src/watcher/` line with
  `src/watcher/         status.json poll and run ids; RUN only: prd.json story list (S1b 1b), capped 100 stories / 8 KiB`
  and add after it
  `src/logs/            LogShipper (S2a): raw byte windows of the run log, stdout and stderr PUT at exact offsets, 2 in flight, drained with final=1 before UPLOADING`.
- Add to Rules:
  "- Logs travel only through the `LogShipper` (protocol v3): never as `log` sync events. A job run registers its streams after spawn or re-adopt, wakes the shipper each tick, drains before UPLOADING (bounded by `logDrainTimeoutMs`), and stops its streams on halt, abandon and cleanup. Nothing in the watch tick awaits the network.
  - A log stream that shrinks, or that the server holds more of than the file, is `diverged`: it stops and the bundle fills it. The shipper never rewinds."

Regenerate the agent files from the repo root and check that only the four runner files changed:

```bash
nax generate
git status --short
```

Expected: `apps/runner/AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `codex.md` modified. If `nax generate` also rewrites
other packages' files, restore them with `git checkout -- <path>` (only the runner context changed).

- [ ] **Step 4: Run the runner suite and the API protocol pin**

Run: `cd apps/runner && bun run type-check && bun run test`
Expected: PASS (whole runner unit suite).
Run: `cd apps/api && bun run test:scoped src/fleet/common/protocol.spec.ts`
Expected: PASS (`[1, 2, 3]` contains 3).

- [ ] **Step 5: Commit**

```bash
cd apps/runner && bun run lint
git add packages/fleet-protocol/src/index.ts apps/runner/src/sync/batch.spec.ts apps/runner/test/unit/daemon.spec.ts .nax/mono/apps/runner/context.md apps/runner/AGENTS.md apps/runner/CLAUDE.md apps/runner/GEMINI.md apps/runner/codex.md
git commit -m "feat(runner): speak protocol v3; logs reach the server before UPLOADING end to end (S2a 1b D328)"
```

---

### Task 7: Fake nax big logs and integration against the real API

**Files:**
- Modify: `apps/runner/test/fixtures/fake-nax.ts` (in `run()`, before the `for` loop over steps), test `apps/runner/test/unit/fake-nax.spec.ts`
- Modify: `apps/runner/test/integration/harness/world.ts:27` (`FEATURES` gains `la`, `lb`, `lc`: only listed features get a PRD in the origin; any other feature fails at checkout with `checkout: no prd.json at ref`)
- Modify: `apps/runner/test/integration/run-plan.integration.spec.ts:56`
- Create: `apps/runner/test/integration/log-shipping.integration.spec.ts`

**Interfaces:**
- Consumes: the harness `createWorld()`, `World.prisma`, `World.base`, `World.withFake`, `TestRunner.jobDir`,
  `TestRunner.crash`, `findRunLog`.
- Produces: `FAKE_NAX_LOG_BYTES`, `FAKE_NAX_LONG_LINE_BYTES` (D330).

- [ ] **Step 1: Write the failing fake-nax test**

Append to `apps/runner/test/unit/fake-nax.spec.ts` (inside `describe('fake nax: run scenarios', ...)`):

```ts
  test('FAKE_NAX_LONG_LINE_BYTES and FAKE_NAX_LOG_BYTES grow the run log with one long line and ~1 KiB lines (S2a plan D330)', async () => {
    const ctx = await setup();
    const proc = spawnFake(ctx, RUN, { FAKE_NAX_LONG_LINE_BYTES: '200000', FAKE_NAX_LOG_BYTES: '600000' });
    expect(await proc.exited).toBe(0);
    const runs = join(ctx.outDir, 'features', 'feat', 'runs');
    const name = (await readdir(runs)).find((n) => n !== 'latest.jsonl') as string;
    const lines = (await readFile(join(runs, name), 'utf8')).split('\n').filter(Boolean);
    expect(lines[0].length).toBeGreaterThanOrEqual(199_000);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', msg: 'long line' });
    expect((await stat(join(runs, name))).size).toBeGreaterThanOrEqual(600_000);
    expect(lines.at(-1)).toContain('story US-003 done');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/runner && bun run test test/unit/fake-nax.spec.ts`
Expected: FAIL — the first line is a story line.

- [ ] **Step 3: Implement the fake nax option**

In `apps/runner/test/fixtures/fake-nax.ts`, inside `run()`, immediately before `for (let i = 1; i <= steps; i += 1) {`, add:

```ts
  // S2a plan D330: big run logs for the log shipper tests. One long JSONL line, then ~1 KiB debug lines in 64 KiB
  // batches until the log holds at least FAKE_NAX_LOG_BYTES.
  const longLine = Number(process.env['FAKE_NAX_LONG_LINE_BYTES'] ?? 0);
  if (longLine > 0) {
    appendFileSync(join(runsDir, logName), `${JSON.stringify({ level: 'info', msg: 'long line', data: 'L'.repeat(Math.max(0, longLine - 48)) })}\n`);
  }
  const padTo = Number(process.env['FAKE_NAX_LOG_BYTES'] ?? 0);
  const padLine = `${JSON.stringify({ level: 'debug', msg: 'pad', data: 'p'.repeat(980) })}\n`;
  for (let written = existsSync(join(runsDir, logName)) ? statSync(join(runsDir, logName)).size : 0; written < padTo;) {
    const batch = padLine.repeat(64);
    appendFileSync(join(runsDir, logName), batch);
    written += batch.length;
  }
```

Add `statSync` to the existing `node:fs` import at the top of `fake-nax.ts` (`existsSync` is already imported).

Run: `cd apps/runner && bun run test test/unit/fake-nax.spec.ts` — Expected: PASS.

- [ ] **Step 4: Write the integration tests**

`apps/runner/test/integration/harness/world.ts:27`:

```ts
export const FEATURES: readonly string[] = ['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg', 'fh', 'la', 'lb', 'lc'];
```

`apps/runner/test/integration/run-plan.integration.spec.ts:56` — replace
`expect(events.some((e) => e.type === 'log' && (e.payload as { stream: string }).stream === 'run')).toBe(true);` with:

```ts
    expect(events.some((e) => e.type === 'log')).toBe(false);                 // protocol v3: logs go through PUT /logs (S2a)
    const runLog = await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId: id, leaseEpoch: 1, stream: 'run' } } });
    expect(runLog).toMatchObject({ complete: true, truncated: false, source: 'stream' });
```

Create `apps/runner/test/integration/log-shipping.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../../src/executor/nax-process';
import { findRunLog } from '../../src/watcher/run-log';
import { waitFor } from '../helpers/wait';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(180_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!enabled)('S2a 1b: the runner streams complete logs to the real API', () => {
  let world: World;
  beforeAll(async () => { world = await createWorld(); }, 180_000);
  afterAll(async () => { await world?.close(); });

  /** Plan D329: stored file on the API's disk vs the file nax wrote, for each stream; rows complete from the stream. */
  async function expectIdentical(runner: TestRunner, jobId: string, feature: string): Promise<void> {
    const jobDir = runner.jobDir(jobId);
    const runPath = await findRunLog(join(jobDir, 'nax-out'), feature);
    expect(runPath).not.toBeNull();
    const local: Record<string, string> = { run: runPath as string, stdout: join(jobDir, 'nax.stdout'), stderr: join(jobDir, 'nax.stderr') };
    for (const [stream, path] of Object.entries(local)) {
      const stored = await readFile(join(world.base, 'artifacts', 'logs', jobId, '1', `${stream}.log`));
      expect({ stream, sha: sha(stored) }).toEqual({ stream, sha: sha(await readFile(path)) });
      const row = await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch: 1, stream } } });
      expect(row).toMatchObject({ complete: true, truncated: false, source: 'stream' });
      expect(Number(row?.sizeBytes)).toBe(stored.length);
    }
    expect((await world.events(jobId)).some((e) => e.type === 'log')).toBe(false);
  }

  async function startHeld(runner: TestRunner, feature: string, gate: string, env: Record<string, string> = {}) {
    const id = await world.withFake({ FAKE_NAX_GATE: gate, ...env }, async () => {
      const jobId = await world.dispatch({ feature });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING' && j.naxRunId !== null && j.currentStoryId === null && Number(j.costSpentUsd) > 0);
      return jobId;
    });
    return { id, pid: runner.daemon?.journal.getJob(id, 1)?.pid as number };
  }

  test('a RUN with a 3 MiB log and a 1.5 MiB line: every stream stored byte-identical and complete (success criteria 1, 2; R12)', async () => {
    const runner = await world.addRunner('logs-1');
    await runner.start();
    const id = await world.withFake({ FAKE_NAX_LOG_BYTES: '3000000', FAKE_NAX_LONG_LINE_BYTES: '1500000' }, async () => {
      const jobId = await world.dispatch({ feature: 'la' });
      await world.waitForJob(jobId, (j) => j.state === 'RUNNING');
      return jobId;
    });
    await world.waitForJob(id, (j) => j.state === 'COMPLETED', 90_000);
    await expectIdentical(runner, id, 'la');
    await runner.stop();
  });

  test('daemon crash while nax runs: the new daemon resumes at the server size and nothing is lost (Review focus 5, watch path)', async () => {
    const runner = await world.addRunner('logs-2');
    await runner.start();
    const gate = join(world.base, 'gate-lb');
    const { id, pid } = await startHeld(runner, 'lb', gate, { FAKE_NAX_LOG_BYTES: '20000000' });
    const storedRun = async () => Number((await world.prisma.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId: id, leaseEpoch: 1, stream: 'run' } } }))?.sizeBytes ?? 0);
    await waitFor(async () => (await storedRun()) > 0, { timeoutMs: 30_000, message: 'no run log bytes reached the API before the crash' });
    runner.net.down = true;                                         // freeze the upload mid-stream (20 MB at 4 MiB/s takes ~5 s)
    const runPath = await findRunLog(join(runner.jobDir(id), 'nax-out'), 'lb');
    expect(await storedRun()).toBeLessThan((await readFile(runPath as string)).length);   // a real resume, not a no-op
    runner.crash();
    expect(isProcessAlive(pid)).toBe(true);
    runner.net.down = false;
    await runner.start();
    await writeFile(gate, '');
    await world.waitForJob(id, (j) => j.state === 'COMPLETED', 90_000);
    await expectIdentical(runner, id, 'lb');
    await runner.stop();
  });

  test('nax finishes while the daemon is down: the finish path drains every stream before UPLOADING (R5, finish path)', async () => {
    const runner = await world.addRunner('logs-3');
    await runner.start();
    const gate = join(world.base, 'gate-lc');
    const { id, pid } = await startHeld(runner, 'lc', gate);
    runner.crash();
    await writeFile(gate, '');
    await waitFor(() => !isProcessAlive(pid), { message: 'the held nax did not finish' });
    await runner.start();
    await world.waitForJob(id, (j) => ['COMPLETED', 'ESCALATED'].includes(j.state), 90_000);
    await expectIdentical(runner, id, 'lc');
    await runner.stop();
  });
});
```

Note: the finish-path job ends ESCALATED because its push had no credentials while the daemon was down (see
`recovery.integration.spec.ts`); the logs are what this test checks.

- [ ] **Step 5: Run the integration suite**

```bash
bunx turbo run build --filter=@nathapp/koda-api
cd apps/api && bun run test:db:up && cd ../runner
KODA_DB_TESTS=1 bun run test:integration
```

Expected: PASS for `log-shipping.integration.spec.ts`, `run-plan.integration.spec.ts` and every other integration
spec. `recovery.integration.spec.ts`'s network-cut test waits for more than 3 unacked journal events; `log` events no
longer inflate that count. If it fails on "events did not stay unacknowledged", raise `FAKE_NAX_STEPS` in that test
and say so in the commit body. If `world.prisma.fleetJobLog` is undefined, the Prisma client predates slice 1a: run `bunx turbo run db:generate`
and rerun.

- [ ] **Step 6: Commit**

```bash
cd apps/runner && bun run type-check && bun run lint
git add apps/runner/test/fixtures/fake-nax.ts apps/runner/test/unit/fake-nax.spec.ts apps/runner/test/integration/run-plan.integration.spec.ts apps/runner/test/integration/log-shipping.integration.spec.ts
git commit -m "test(runner): big logs and daemon restarts end byte-identical on the real API (S2a 1b D329, D330)"
```

---

## Self-Review

- **Spec coverage (§2.4, §8 1b list):** `putLog` seam (T1); per-stream state, raw reads, newline cut, R12 (T2, T3);
  scheduling 2 in flight, round-robin, 30 s timeout, `Retry-After` pauses all, tick never awaits (T3, T5 real-shipper
  test); every response-table row (T1 table + T3 behaviour); start/resume at the server size, PLAN never `run`, v3
  ignores `startAtEnd` and the watcher has no tails (T3, T4); shrink and server-ahead → diverged (T3); drain after reap,
  concurrent with judge/push, awaited before UPLOADING, timeout, halt, `finish` re-adopt (T5, T6, T7); tuning (T6);
  protocol 3 (T6); context.md (T6); fake nax large JSONL and long lines (T7). The unbilled live check with a real
  binary is slice 2 (spec §9).
- **Deviations recorded:** D320 removes the v2 watcher mode the spec's test list names (with a release gate until 1c
  and 2 ship); D321 adds `JobExecutor.logSources`, so `FakeExecutor` gains a field and a method (spec §2.4 said it
  is unaffected); D322 uses an args object.
- **Final review 2026-10-04** (three read-only reviewers: codebase fidelity, shipper concurrency, integration and spec):
  fixes folded into this plan — integration features `la`/`lb`/`lc` added to the harness; daemon wiring moved into
  Task 5 so its type-check passes; `work()` captures the wake signal before awaiting, never sleeps while closed or
  while a run-log search is pending, and reads the clock once; `ship()` turns errors into a backoff; lifecycle calls
  are guarded; negative sizes, no-progress acks and huge `retryAfterMs` cannot spin or freeze; JobRun registers only
  when not halted and not terminal, stops the key in `start()`'s `finally`, and drains in `failSafe`; tests added for
  404, no-progress ack, round-robin fairness, backoff bounded by the drain deadline, a throwing lifecycle, PLAN drain,
  failSafe drain, terminal re-adopt and never-started abandon; the restart integration test now cuts the network
  mid-stream so the resume is real.
- **Types:** `LogShipping` methods (`register`, `wake`, `drain`, `stopJob`) and `JobLogSources` fields are used with
  the same names in T3, T4, T5 and T6; `logDrainTimeoutMs` is the same key in `Tuning`, `JobRunTuning` and the specs.
