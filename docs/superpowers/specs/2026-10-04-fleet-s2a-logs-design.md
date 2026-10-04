# Fleet S2a — Complete Run Logs, Log Viewer and Retention — Design

Builds the S2a phase of the fleet plan (design doc §5 "S2a observability", item (l)) and the C6 remainder from the
fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec", §9.5: "`ArtifactStore.putLogChunk` for full
JSONL streaming; `FleetJobEvent` stays the small indexed timeline"). It also takes the artifact retention that S1 plan
D15 deferred to S2a. Where this document and S1 spec §9.5 disagree, this document wins.

## Goal

A project member reads a nax run's complete log in koda, live while the job runs and afterwards, filtered by level,
story, stage and session role, without a shell on the runner machine. Old logs and bundles do not fill the server disk.

## Success criteria

1. While a RUN job is RUNNING on a v3 runner, the viewer shows every line nax wrote to its run JSONL, stdout and
   stderr, in order, within a few seconds of the write. No line is sampled away.
2. After the job ends, each stored stream is byte-identical to the file on the runner (same SHA-256), including across
   a runner daemon restart mid-run and a restart after nax exited.
3. The run log can be filtered by minimum level, story, stage, session role and text, server-side, up to the 256 MiB
   per-stream cap, without loading the whole log into the browser. Cost is accepted explicitly: each request scans at
   most 2 MiB, so a rare filter on a 256 MiB log takes up to 128 requests; the viewer shows scan progress and pages on
   demand ("Keep searching"), never in an unbounded loop.
4. A stream the runner could not finish uploading is filled from the job's bundle and says so.
5. Logs, bundles and `log` timeline events of jobs that ended more than 30 days ago are deleted daily; the job row, its
   other events, approvals, budget incidents and costs stay, and the pages say the logs expired.
6. v1/v2 runners keep working unchanged.

## Rulings (user, 2026-10-04)

| # | Ruling |
|:--|:--|
| L1 | The viewer serves **both** live watching and post-run diagnosis, so logs stream **completely** during the run (not the S1 sampled excerpts). |
| L2 | **nax's OTel export is not used** for logs. Its log records are the same `LogEntry` stream as the run JSONL, but filtered by `logs.level`, `data` truncated to 2 KiB, batched every 5 s with drop-oldest overflow, and spans only flush at story/run end. The run JSONL (all levels, full `data`, redacted by nax at `logger.ts:142`) is the source of truth. OTel may feed S2b analytics later. |
| L3 | S2a includes **retention**. Ledger cost reconciliation at bundle ingest (S1b B2) stays **deferred**. |
| L4 | Retention deletes **logs + bundles + `log` events** of terminal jobs whose `finishedAt` is older than `FLEET_LOG_RETENTION_DAYS` (default 30, `0` disables). The job row and everything else stay; index rows are marked expired, not deleted. |
| L5 | Transport is **approach B**: a separate append-only, byte-offset log upload route, not `log` events in sync (approach A, rejected: logs would share sync batches with approval asks that have deadlines) and not bundle-only (approach C, rejected by L1). |
| L6 | The CLI gains `koda fleet job logs`. |
| L7 | No new run list/detail pages: the jobs list and job page are the run list and run detail. S2a adds a log viewer page linked from the job page. |

## Review rulings (spec review 2026-10-04, three read-only reviewers; decided while folding fixes)

| # | Ruling |
|:--|:--|
| R1 | **No `logs.stream` capability.** Protocol v3 itself means "this runner streams logs": a v3 runner never sends `log` sync events. API-first deploy is a **hard rule**, not a degradation path: a v3 runner against a `[1,2]` API gets 426 at enroll and sync, and the sync loop stops the daemon (`sync-loop.ts`). |
| R2 | The upload route accepts **ASSIGNED, RUNNING, UPLOADING** (the fence already proves the lease; the runner journals RUNNING before the server applies it). A terminal state answers HTTP 409 (`fleet.jobState`), and the uploader stops. |
| R3 | **No resume probe route.** The uploader resumes by sending from offset 0 (or its last acked offset); the duplicate/conflict answers carry the server's size and the uploader jumps there. One re-sent window per stream per restart is accepted. |
| R4 | The uploader is an **independent async pump**, never awaited by the 2 s watch tick. A runner-wide `LogShipper` owns all streams of all jobs: at most 2 PUTs in flight, round-robin across streams, a 30 s per-PUT timeout, `Retry-After` pauses the whole shipper. |
| R5 | **Drain** starts after the final tick and reap, runs concurrently with the existing judge/push/finish work, and is awaited (bounded by `logDrainTimeoutMs`) just before the UPLOADING transition. The re-adopt `finish` path (nax exited while the daemon was down) creates an uploader and drains too. |
| R6 | A stream whose local file **shrinks** below the acked offset, or whose server size exceeds the local file, is marked `diverged` on the runner: it stops, emits a lifecycle warning, and is left to the bundle fallback. |
| R7 | Bundle extraction uses the **`tar-stream`** npm package with `zlib` gunzip in the API (no shell `tar`, no image dependency), streams the member, and caps extracted bytes at `FLEET_LOG_MAX_BYTES`. Fallback runs **after** the bundle response, off the request path. |
| R8 | Once a stream is `complete` or `truncated`, every later upload answers outcome `complete` / `stream_cap` (HTTP 200, D307), including a repeated `final=1`. `replace` (fallback) takes the same per-key lock and is compare-and-set on `complete = false`. |
| R9 | The entries route serves **all three streams** as lines (stdout/stderr: `q` filter only), with one cursor contract (§3.3). The raw route is for download and the CLI only. |
| R10 | Log read routes are user-only (`isUserPrincipal`, like the fleet jobs controller) and carry a dedicated throttle of **600 req/min** per user instead of the global 100. |
| R11 | The entries scan bound is **2 MiB** per request, read asynchronously and parsed in 256 KiB slices with `setImmediate` yields; `q` matches the lowercased raw line (keys and escapes included). |
| R12 | A single line longer than the window (1 MiB upload, 2 MiB scan) is never a stall: the uploader sends a full window without a newline; the reader returns the window as one `unparsed` entry with `truncatedLine: true` and advances. |
| R13 | Query naming is `leaseEpoch` on every route (runner and user). |
| R14 | Slices: **1a** API transport + storage + fallback + event; **1b** runner shipper; **1c** read routes + CLI + retention; **2** web + E2E + live check. |

## Ground truth (verified on main `a759759f`)

- The runner tails three streams per job (`apps/runner/src/watcher/watcher.ts`): `run` = nax's run JSONL
  (`<jobDir>/nax-out/features/<f>/runs/<logRunId>.jsonl`, found by `findRunLog`), `stdout` = `<jobDir>/nax.stdout`,
  `stderr` = `<jobDir>/nax.stderr`. `FileTail.readNew` returns whole lines only (unless `final`, or a 1 MiB window with
  no newline), at most 1 MiB per read, as a utf8 string; it silently resets to 0 when the file shrinks.
- Each read is cut into 8,000-byte chunks and sent as `log` sync events `{stream, text}` through a 60-per-minute
  `LogBudget`; the excess is counted in `droppedLogs` and lost (`watcher/log-budget.ts`). The events are stored as
  `FleetJobEvent` rows of type `log` and rendered as one-line rows by `FleetJobTimeline.vue`.
- Re-adopt after a daemon restart (`supervisor/supervisor.ts`): a live nax goes the `watch` path and tails from the
  **end** of each file (`startAtEnd: resumed`, `supervisor/job-run.ts:259`), so bytes written while the daemon was down
  are never sent; a nax that exited meanwhile goes the `finish` path, which creates no watcher at all.
- In the `watch` path the final tick is followed by `reapQuietly` (`job-run.ts:272-273`); `finish()` then runs
  judge / progress push / PLAN finish before UPLOADING and the bundle.
- The bundle (`runner/src/bundle/build-bundle.ts`) is a `tar.gz` of `nax-out/` (without any `prompt-audit` path),
  `nax.stdout`, `nax.stderr`, `bundle-manifest.json`, and `plan-logs/*.jsonl` for PLAN, uploaded to
  `PUT /fleet/runner/jobs/:jobId/bundle?leaseEpoch=` and stored through `ArtifactStore` (`LocalDiskArtifactStore` under
  `FLEET_ARTIFACT_DIR`) with a `FleetJobArtifact` row unique per `(jobId, kind, leaseEpoch)`. The upload is allowed in
  RUNNING (partial bundle on cancel) and UPLOADING.
- `ArtifactStore.put` is an atomic whole-object replace; it has no append. The API has no tar reader dependency.
- Fastify parses `application/gzip` as an unbuffered raw stream (`common/hooks/bundle-content-parser.ts`, registered
  in `main.ts`); Fastify's `bodyLimit` does not meter such a stream.
- Job states: the runner reports ASSIGNED→RUNNING→UPLOADING→terminal (`jobs/job-state.ts`); RUNNING→CANCELLED is direct.
  A requeue (CRASHED/FAILED/CANCELLED → QUEUED) bumps `leaseEpoch` and nulls `finishedAt` and `naxLogRunId`.
- `FenceService.holds(job, runnerId, leaseEpoch)` is a pure check; `FenceService.abandon(runnerId, job, leaseEpoch)`
  queues ABANDON and must run inside a transaction under the job row lock (as `BundleService.assertHolder` does).
- `parseCapabilitiesCore` builds a clean copy of known keys only; `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2]`
  (`common/protocol.ts`), `FLEET_PROTOCOL_VERSION = 2` (`packages/fleet-protocol`).
- Live updates: `ProjectEventBus` (in-process, single API instance) feeds `GET /projects/:slug/events`; events are
  content-free (`fleet_job`, `fleet_approval`), the web registers named listeners only (an unknown type is ignored) and
  dedupes by event `id`. SSE is browser-only.
- Throttling: global `ThrottlerModule` 100 req/min; only the sync route and the SSE route are `@SkipThrottle`.
- The runner's architecture rule: only `src/sync/` talks to the server; the bundle upload is an injected
  `BundleUploader` built in `daemon.ts` over `ServerClient` (`sync/http.ts`).
- No retention exists for artifacts or job events; the only fleet `@Cron` is enrollment retention
  (`fleet/runners/enrollment-retention.processor.ts`, `30 4 * * *`), which is off under `NODE_ENV=test`.
- nax `LogEntry` (`packages/nax/src/logger/types.ts`): `timestamp, level, stage, storyId?, sessionRole?, message,
  data?`; `level ∈ silent|error|warn|info|debug` (`silent` is never written).

## Out of scope

- Ledger cost reconciliation at bundle ingest (L3, stays deferred).
- Fleet dashboard, artifact analytics, OTel ingestion (S2b).
- Object storage (S3); local disk only, behind the `LogStore` interface.
- Streaming PLAN `plan-logs/*.jsonl` live (PLAN jobs stream stdout/stderr; plan logs come from the bundle download).
- prompt-audit ingestion (design doc §6 Q3, still open).
- Per-project retention settings; one global window.
- Multi-instance API (the per-key append lock, the shipper rate bucket and the event coalescer are in-process).
- Agent (non-user) principals reading logs.

## 1. Storage (slice 1a)

### 1.1 `LogStore`

A new interface next to `ArtifactStore`, because logs need appends:

```ts
export const LOG_STORE = Symbol('LOG_STORE');

export interface LogStore {
  /** Under the key's lock: appends iff offset === current size. */
  append(key: string, offset: number, bytes: Buffer): Promise<AppendResult>;
  size(key: string): Promise<number>;                     // 0 when absent
  read(key: string, from: number, to: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;                 // whole object, for download
  /** Under the key's lock: atomic whole-object replace (fallback, §2.5), at most maxBytes. */
  replace(key: string, source: Readable, maxBytes: number): Promise<number>;
  deletePrefix(prefix: string): Promise<void>;            // absent prefix is a no-op
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type AppendResult =
  | { kind: 'appended'; size: number }
  | { kind: 'duplicate'; size: number }   // offset + length <= size
  | { kind: 'conflict'; size: number };   // gap or partial overlap
```

- `LocalDiskLogStore` under `FLEET_ARTIFACT_DIR`. Key `logs/<jobId>/<leaseEpoch>/<stream>.log`,
  `stream ∈ {run, stdout, stderr}`. Keys are server-built from validated parts (enum stream, integer epoch, job id from
  the database).
- A per-key in-process mutex serializes `append`, `replace` and every DB update of that stream's row (`withLock`).
  Append: size check, `appendFile`, `fsync`, then return. `size()` reads the file, never the row.

### 1.2 `FleetJobLog`

```prisma
model FleetJobLog {
  id         String    @id @default(cuid())
  jobId      String
  leaseEpoch Int
  stream     String    // run | stdout | stderr
  sizeBytes  BigInt    @default(0)
  complete   Boolean   @default(false)   // final=1 accepted, or filled from the bundle
  truncated  Boolean   @default(false)   // hit FLEET_LOG_MAX_BYTES; terminal, never complete
  source     String    @default("stream") // stream | bundle
  expiredAt  DateTime?
  updatedAt  DateTime  @updatedAt
  createdAt  DateTime  @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, stream])
  @@index([jobId])
}
```

- `FleetJobArtifact` gains `expiredAt DateTime?`. `FleetJob` gains `@@index([state, finishedAt])` for retention.
- The row is upserted inside the key lock after every append that grew the file, so it never goes backwards. A crash
  between `fsync` and the upsert leaves the row behind the file; the next append or `final=1` heals it (both read
  `LogStore.size`).
- DTOs expose `sizeBytes` as a JSON number (max 256 MiB, safe).

## 2. Transport

### 2.1 Protocol v3 (slices 1a + 1b, R1)

- API: `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2, 3]` (update the `protocol.spec.ts` pin). Runner:
  `FLEET_PROTOCOL_VERSION = 3`. No capability key.
- A v3 runner never sends `log` sync events; the server still stores any `log` event it receives (no rejection).
- Deploy order is a hard rule: API first.

### 2.2 Upload route (slice 1a)

`PUT /fleet/runner/jobs/:jobId/logs/:stream?leaseEpoch=<int>&offset=<int>[&final=1]`

- Controller-level `@RunnerRoute()` and `@SkipThrottle()`. `Content-Type: application/octet-stream`, registered in
  `main.ts` beside the gzip parser as a raw stream (widen the `FastifyLike` type). `X-Content-SHA256` required.
- **Response contract (slice 1a plan D307):** every protocol outcome is HTTP **200** `{ outcome, size, retryAfterMs? }`
  with `outcome ∈ appended | duplicate | offset | complete | stream_cap | rate_limited` (the API's error envelope
  carries only a translated message, so a 409 could not return the size). HTTP errors are only 400 input, 404 job,
  409 fence or job state, 413 chunk too large, 422 SHA mismatch, 507 storage. Below, "409 `offset`" etc. name the
  outcome, not a status.
- Order of checks:
  1. `stream` ∈ enum, `leaseEpoch` and `offset` non-negative integers, `final` absent or `1` → else 400. A non-final
     empty body → 400.
  2. Per-runner rate (§2.2.1) → outcome `rate_limited` with `retryAfterMs`, **before** the body is read (the body is
     drained).
  3. Load the job (`findById`, no lock). `FenceService.holds(job, runnerId, leaseEpoch)` false → open a transaction,
     lock the row, re-check, call `FenceService.abandon` if still not held, answer HTTP 409 (`fleet.fence`).
  4. State ∉ {ASSIGNED, RUNNING, UPLOADING} → HTTP 409 (`fleet.jobState`) (R2).
  5. Read the body with a hard counter; past `FLEET_LOG_CHUNK_MAX_BYTES` (1 MiB) answer HTTP 413 (the rest of the body
     is read and discarded up to 4x the cap so the answer reaches the client). `Content-Length` is advisory. SHA
     mismatch → HTTP 422.
  6. Under the key lock:
     - Row `complete` → outcome `complete` with the size (covers a repeated `final=1`).
     - Row `truncated` → outcome `stream_cap` with the size.
     - Cap: if `offset + length > FLEET_LOG_MAX_BYTES`, cut the body to `max(0, cap - offset)` bytes, append that
       through the normal rule, set `truncated = true`, answer outcome `stream_cap`. The cut may split a line or a
       UTF-8 sequence; readers tolerate it.
     - Else `LogStore.append`: outcome `appended` / `duplicate`; `conflict` → outcome `offset`, each with the size.
     - `final=1`: requires `offset === size` after any body; sets `complete = true`; outcome `complete`. Otherwise
       outcome `offset`.
     - Disk write failure → HTTP 507.
  7. Upsert the `FleetJobLog` row (inside the lock), then publish `fleet_log` (§2.3) after the lock is released.
- Error reasons get API i18n keys (en + zh) following the `fleet.bundleInput` / `fleet.jobState` pattern.

#### 2.2.1 Rate

A per-runner token bucket, `FLEET_LOG_RUNNER_BYTES_PER_SEC` (default 4 MiB/s, burst one chunk), charged by
`Content-Length` before the read and corrected by the actual length after. In-process, single instance.

### 2.3 Live event (slice 1a)

- New `LiveFleetLogEvent` in the `LiveEvent` union: `fleet_log { id, projectId, jobId, leaseEpoch, stream, size,
  complete, at }`, `id = randomUUID()` per publish (the web dedupes by id).
- Coalesced per `(jobId, leaseEpoch, stream)` to at most one per second, trailing edge (the latest size always goes
  out). `final=1`, the cap and the fallback publish **immediately** and clear that key's timer. Timers are cleared on
  module shutdown; a key with no publish for 60 s is dropped from the map.

### 2.4 Runner `LogShipper` (slice 1b)

- **Seams.** `ServerClient` (`sync/http.ts`) gains `putLog(jobId, stream, leaseEpoch, offset, bytes, final)` sending
  the bearer token, `accept-language: en`, `content-type: application/octet-stream` and the chunk's
  `x-content-sha256`, and returning `{ status, outcome?, size?, retryAfterMs? }` (the 200 body fields of D307). A runner-wide `LogShipper` is built in `daemon.ts` over the
  client and injected into `JobRunDeps` (the executor stays client-free; `FakeExecutor` is unaffected). Update
  `.nax/mono/apps/runner/context.md`.
- **Per stream state:** `{ path, ackedOffset, state: active | done | stopped | diverged }`. The file on disk is the
  buffer; the shipper reads raw bytes (`Bun.file().slice`) — never `FileTail` strings — up to 1 MiB, cut after the last
  `\n`, or the full window when it holds no newline (R12), or everything when draining.
- **Scheduling (R4).** One loop for the whole runner: at most 2 PUTs in flight, round-robin over streams with unsent
  bytes, 30 s timeout per PUT (aborted via `AbortController`), `Retry-After` pauses all streams. The 2 s watch tick only
  calls `shipper.wake(jobKey)`; nothing in the tick awaits the network.
- **Responses:**

  | Answer | Action |
  |:--|:--|
  | 200 `appended` / `duplicate` | `ackedOffset = size` |
  | 200 `offset` | `ackedOffset = size`; if `size > local file size` → `diverged` (R6) |
  | 200 `complete` | stream `done` |
  | 200 `stream_cap` | `stopped` for that stream |
  | 200 `rate_limited` | pause the shipper for `retryAfterMs` |
  | 409 (stale lease or terminal job) | stop all streams of the job (R2: only terminal states fail the state check) |
  | 413, 400 | `stopped` + lifecycle error (a bug, not retried) |
  | 401 | stop the job's streams; the sync loop owns re-auth |
  | 422 | retry the same offset (counts toward backoff) |
  | 507, other 5xx, network, timeout | exponential backoff 1 s → 30 s, jittered; bounded by the drain deadline when draining |

- **Start and resume (R3).** A stream registers when its file first exists (`run` via `findRunLog`, which the shipper
  calls itself; PLAN jobs never register `run`). `ackedOffset` starts at 0 for a new attempt and on re-adopt; the first
  answer jumps it to the server size. v3 ignores `startAtEnd`. The v3 `Watcher` creates no `FileTail`s and no
  `LogBudget` (no double read); v1/v2 behaviour is unchanged.
- **Shrink (R6).** Before each read: local size `< ackedOffset` → `diverged`, lifecycle warning, never rewind.
- **Drain (R5).** In the `watch` path, after the final tick and `reapQuietly`, the job run calls
  `shipper.drain(jobKey, deadline)`: every active stream ships to its file end (no newline cut), then sends `final=1`.
  The drain promise runs concurrently with judge / progress push / PLAN finish and is awaited just before the
  UPLOADING transition, bounded by `logDrainTimeoutMs` (120 s) from its start. On timeout the job's streams are
  stopped (in-flight PUTs aborted) and the run proceeds; the bundle fallback fills the rest. The `finish` re-adopt path
  registers the job's streams and drains the same way. `halt()` and `abandon()` stop the job's streams; every await in
  the drain checks `halted`.
- **Throughput note.** 2 in flight × 1 MiB against the 4 MiB/s server bucket shared by all of a runner's jobs; a
  120 s drain moves at most ~480 MiB per runner, enough for the 256 MiB/stream cap on one job with backlog.

### 2.5 Bundle fallback (slice 1a, R7)

After a bundle upload commits and its response is sent, an async task (errors logged, never surfaced to the runner)
handles each stream of that attempt whose row is missing or has `complete = false` and `truncated = false`:

1. Locate the member: `stdout` → `nax.stdout`, `stderr` → `nax.stderr`, `run` (RUN jobs only) →
   `nax-out/features/<job.feature>/runs/<naxLogRunId>.jsonl` when `naxLogRunId` is set, else the single
   non-`latest.jsonl` `.jsonl` member of that directory, else the newest by tar mtime. Never another feature's dir;
   skip symlink members.
2. Stream-extract with `tar-stream` + `zlib.createGunzip`, capped at `FLEET_LOG_MAX_BYTES`.
3. Under the key lock, compare-and-set on `complete = false`: if the member was found and its size ≥ the stored size,
   `LogStore.replace`, set `sizeBytes`, `complete = true`, `source = 'bundle'`, publish `fleet_log` immediately.
   Otherwise leave the row (`complete = false`).

A `truncated` stream is never refilled; its full text stays in the bundle download. A `diverged` stream (runner side)
is just an incomplete stream here; the bundle copy replaces it when it is at least as long.

## 3. Read side (slice 1c)

Routes live under `/projects/:slug/fleet/jobs/:id/logs`, user principals only, project members (same rule as the job
page), job resolved by `(project, id)` (404 otherwise), and a dedicated `@Throttle` of 600 req/min per user (R10).
An expired stream answers 410.

### 3.1 List

`GET .../logs` → `{ attempts: [{ leaseEpoch, legacySampled, streams: [{ stream, sizeBytes, complete, truncated,
source, expired, updatedAt }] }] }`, latest epoch first.

`legacySampled` is per attempt: true when the attempt has `log` events and no `FleetJobLog` rows (a v1/v2 runner while
running). It turns false once the bundle fallback creates rows, and after retention (events deleted, rows expired).

### 3.2 Raw (download and CLI)

`GET .../logs/:stream/raw?leaseEpoch=&from=&to=` → `text/plain; charset=utf-8`, `[from, to)` clamped to the size,
`to - from ≤ 1 MiB`, `@ApiProduces('text/plain')`. `download=1` streams the whole stream as an attachment (no 1 MiB
limit). Errors use the JSON envelope like `job-bundle.controller.ts`.

### 3.3 Entries (all streams, R9)

`GET .../logs/:stream/entries?leaseEpoch=&cursor=&direction=forward|backward&limit=&level=&storyId=&stage=&role=&q=`

Response: `{ entries, nextCursor, scannedFrom, scannedTo, atEnd, size, complete, truncated }`.

- **Line model.** A line is the bytes from a line start up to and including its `\n`. Entry `offset` = line start,
  `length` includes the `\n`. A trailing partial line (no `\n` yet) is invisible while the stream is not `complete`;
  once `complete`, it is the last line.
- **Forward** from `cursor` (default 0; must be a line start the server returned, else the server snaps forward to the
  next line start): scan `[cursor, min(cursor + 2 MiB, size))`, return complete lines in ascending order.
  `nextCursor` = the end of the last complete line scanned; `atEnd` = `nextCursor` reached the end of the last complete
  line in the stream.
- **Backward** from `cursor` (default = end of the last complete line): scan `[max(0, cursor − 2 MiB), cursor)`, drop
  the leading partial line unless the window starts at 0, return lines in **ascending** order. `nextCursor` = start of
  the first complete line in the window; `atEnd` = `nextCursor === 0`.
- **Overlong line (R12).** A window with no `\n`: return one entry `{ offset, length: windowLength, unparsed: true,
  truncatedLine: true, text }` and advance past the window (forward) or to the window start (backward).
- **Run stream:** each line is parsed as a nax `LogEntry`. A line that fails to parse, or has a `level` outside
  `debug|info|warn|error`, is `{ offset, length, unparsed: true, text }`. Filters: `level` = minimum
  (`debug < info < warn < error`), `storyId`, `stage`, `role` exact, `q` = case-insensitive substring of the raw line
  (R11). Unparsed lines match only `q` (and match when no other filter is set).
- **stdout/stderr:** entries are `{ offset, length, text }`; only `q` applies.
- `limit` default 200, max 500. A full `limit` stops the scan early; `nextCursor` is then the line after the last
  returned entry.
- Reading is async (`fs.read` slices of 256 KiB, `setImmediate` between slices); text is decoded per line with the
  `utf8` decoder's replacement on invalid sequences.

### 3.4 CLI `koda fleet job logs` (L6)

`koda fleet job logs <id> --project <slug> [--stream run|stdout|stderr] [--lease-epoch <n>] [--follow] [--level
debug|info|warn|error] [--story <id>] [--stage <s>] [--role <r>] [--grep <text>] [--json]`

- Uses the entries route through the generated client. `run` prints `HH:MM:SS LEVEL [stage] [story] message`
  (unparsed lines raw); stdout/stderr print the text. `--json` prints one JSON object per entry (NDJSON), including in
  follow mode.
- `--follow`: poll forward from `nextCursor` every 2 s; stop with exit 0 when the response says `complete` (or
  `truncated`) and `atEnd`, or when the job is terminal (job GET every 10th poll) and `atEnd`.
- Default epoch: the latest attempt from the list route. `--level` is validated by commander (`InvalidArgumentError`).
- Exit codes follow the existing commands: 0 ok (Ctrl-C in follow is 0), API errors through `handleApiError`
  (404 / 410 expired / 400). `logs` is added to the `job` command description.

## 4. Web (slice 2)

### 4.1 Viewer page `/[project]/fleet/jobs/[id]/logs`

- Tabs `Run log`, `stdout`, `stderr`; attempt picker (default latest).
- Run log rows: time, level badge, stage, story, role, message; click to expand `data` as formatted JSON. Unparsed
  lines render as plain text with an "unparsed" tag (plus "line cut" for `truncatedLine`). stdout/stderr rows are
  monospaced text. Every tab uses the entries route (R9).
- Filters (run log): minimum level, story (free text with suggestions from `job.stories` when present), stage, role,
  text; stdout/stderr: text only. Filters live in the URL query; a change resets the cursor.
- Opening: backward from the end (latest lines). Follow mode default on while the job is RUNNING: on `fleet_log` for
  this job, epoch and stream, fetch forward from the last `nextCursor`. Scrolling up turns follow off; "Jump to latest"
  turns it on.
- At most 5,000 rows in the DOM; "Load earlier" (backward) and "Load more" (forward) evict from the other end.
- A filtered page that returns no entries and is not `atEnd` shows "Searched up to {scannedTo} of {size} — Keep
  searching"; the viewer never auto-loops past one request per click (criterion 3).
- 429: back off (2 s, 4 s, 8 s) and show a quiet "Rate limited, retrying".
- Notices: "Filled from the bundle (the live upload did not finish)" (`source = bundle`); "Truncated at 256 MiB —
  download the bundle for the full log" (`truncated`); "Log incomplete ({size} received)" (job terminal,
  `complete = false`); "Logs expired after {days} days" (`expired`); "Sampled live log from an older runner; the full
  log appears after the run" (`legacySampled`, with the timeline's sampled lines linked).
- Download per stream: a plain anchor to the proxied `raw?download=1` URL (the Nuxt proxy streams; never `$api.download`,
  which buffers a blob).
- i18n: every label and notice in `apps/web/i18n/locales/{en,zh}.json`, kept in parity.

### 4.2 Job page, timeline and live events

- `lib/project-event-stream.ts` and the project event hub gain a `fleet_log` parser and `onFleetLog` handler.
- Job page header: "Logs" link. The bundle button shows "Expired" when the artifact has `expiredAt`;
  `findLatestArtifact` ignores expired rows; the bundle download answers 410 for an expired artifact (API part in 1c).
- `FleetJobTimeline` keeps rendering v1/v2 `log` events. For v3 attempts it shows one "Logs →" row per attempt once the
  list route reports a stream for it.

## 5. Retention (slice 1c, L4)

- `FleetLogRetentionProcessor`, `@Cron('45 4 * * *')`. `FLEET_LOG_RETENTION_DAYS` default 30; `0` disables; off
  under `NODE_ENV=test` like enrollment retention.
- Select jobs with `state ∈ {COMPLETED, FAILED, ESCALATED, CRASHED, CANCELLED}`, `finishedAt < now − days`, and an
  unexpired `FleetJobLog` / `FleetJobArtifact` row or any `log` event; 200 per batch until none remain. Record each
  job's `leaseEpoch` at selection (`E`).
- Per job, only attempts `≤ E`:
  1. Files: `LogStore.deletePrefix('logs/<jobId>/<epoch>/')` per epoch, `ArtifactStore.delete` per bundle key.
  2. Rows, in a transaction under the job row lock with a state re-check: delete `log` events with `leaseEpoch ≤ E`
     (this also drops their runner-seq dedup rows, harmless for terminal attempts), set `expiredAt` on those epochs'
     `FleetJobLog` and `FleetJobArtifact` rows.
- If the re-check finds the job requeued, the files of attempts `≤ E` are already gone and the rows are still marked
  expired (they describe deleted files); attempts `> E` are never touched.
- A crash between files and rows leaves rows pointing at missing files; the next run finishes them (absent deletes are
  no-ops).
- Never touched: the job row, non-`log` events, approvals, budget incidents, cost fields.

## 6. Failure modes

| Failure | Behaviour |
|:--|:--|
| API unreachable mid-run | Shipper backs off (≤ 30 s); bytes wait on disk; resumes at the server size. |
| Daemon restarts, nax alive (`watch`) | Streams re-register at offset 0, jump to the server size; nothing lost. |
| Daemon restarts, nax exited (`finish`) | Streams register and drain before UPLOADING. |
| Runner machine dies mid-run | Job goes CRASHED via the sweeper; streams stay incomplete; no bundle; "Log incomplete". |
| Drain exceeds `logDrainTimeoutMs` | Streams stopped; bundle uploaded; fallback fills incomplete streams. |
| Straggler writes after final | Cannot happen in the `watch` path (drain starts after reap); in `finish`, nax is already gone. |
| File shrinks / server ahead of file | `diverged`; stream stopped; fallback replaces it if the bundle copy is at least as long. |
| Disk full on the API | 507; shipper backs off; fallback may fill after the run. |
| Stream exceeds 256 MiB | Kept up to the cap, `truncated`; viewer notice; full text in the bundle. |
| Stale lease | HTTP 409 + ABANDON queued; shipper stops the job's streams. |
| Job cancelled mid-run | Uploads keep working until the job is terminal; then HTTP 409; partial bundle (if uploaded in RUNNING) feeds the fallback. |
| Corrupted chunk | 422; retried from the same offset. |
| Duplicate / reordered chunk | Outcome `duplicate` (no write); gap → outcome `offset` with the server size. |
| Bundle missing, unreadable or without the member | Stream stays incomplete; error logged; bundle upload unaffected. |

## 7. Configuration

API (`FleetConfigSchema`, `IFleetConfig`, `fleetConfig()` in `config/fleet.config.ts`; documented in the env docs):

| Env | Default | Meaning |
|:--|:--|:--|
| `FLEET_LOG_MAX_BYTES` | 268435456 | Per stream per attempt cap |
| `FLEET_LOG_CHUNK_MAX_BYTES` | 1048576 | Max body per upload |
| `FLEET_LOG_RUNNER_BYTES_PER_SEC` | 4194304 | Per-runner upload rate |
| `FLEET_LOG_SCAN_BYTES` | 2097152 | Max bytes scanned per entries request |
| `FLEET_LOG_RETENTION_DAYS` | 30 | `0` disables; off under `NODE_ENV=test` |

Runner (`Tuning` in `daemon/tuning.ts`, mapped into `JobRunTuning` in `daemon.ts`; overridable only through
`startDaemon` options): `logChunkBytes` 1048576, `logMaxInFlight` 2, `logPutTimeoutMs` 30000, `logBackoffMaxMs`
30000, `logDrainTimeoutMs` 120000.

New API dependency: `tar-stream` (+ types). `openapi.json` and the CLI client are regenerated (`bun run generate`) in
1a (runner route) and 1c (read routes).

## 8. Testing

- **1a API unit:** `LocalDiskLogStore` (exact-offset append, duplicate, gap, partial overlap, serialized concurrent
  appends, `replace` under the lock, absent `deletePrefix`); upload controller (400s, `rate_limited` before body read, stale lease
  → 409 + ABANDON queued, ASSIGNED accepted, terminal → 409, 413 by counting not header, 422, cap cut +
  `truncated`, `complete` refusals, idempotent repeated `final`, 507); row upsert monotonic; fallback (incomplete vs
  truncated vs complete, member by `naxLogRunId`, by single file, by newest, missing member, member smaller than
  stored, corrupt gzip, extraction cap, CAS against a concurrent `final`); `fleet_log` coalescing (one per second,
  trailing edge, immediate on final/fallback, map cleanup); protocol `[1,2,3]`.
- **1a API integration (`KODA_DB_TESTS=1`):** concurrent appends + row upsert on Postgres; fallback from a real
  `tar.gz` built like the runner's.
- **1b runner unit:** shipper loop (every row of the response table), in-flight cap and round-robin across two jobs,
  `Retry-After` pauses all, 30 s timeout abort; tick cadence unaffected by a hanging PUT; overlong line sent as a full
  window; shrink → diverged; server ahead → diverged; drain after reap then `final=1` before UPLOADING; drain timeout;
  halt mid-drain; `watch` re-adopt resumes at the server size; `finish` re-adopt drains; PLAN never registers `run`;
  v2 vs v3 watcher behaviour; protocol constant 3. Real files via `test/fixtures/fake-nax.ts` extended for large JSONL
  and long lines; injected fetch, sleep, jitter, now.
- **1c API unit:** entries contract (forward, backward ascending, leading partial dropped, trailing partial invisible
  until complete, overlong line, cursor snap, limit stop, each filter, unknown level → unparsed, `q` on raw line,
  stdout/stderr text entries, `size/complete/truncated` in the body); raw range limits + download streaming; list +
  `legacySampled`; 410s; throttle 600/min; retention (selection, `≤ E` only, requeue race, lock + re-check, crash
  between files and rows, `0` disables, test-env off); expired bundle → 410 and `findLatestArtifact` skips it.
  **1c CLI unit:** formatting, NDJSON, filters → query params, follow stop rules, `--level` validation, exit codes.
- **2 web unit:** cursor/follow state machine, URL-synced filters, 5,000-row eviction, keep-searching, 429 backoff,
  every notice, `fleet_log` parsing and dedupe, i18n parity.
- **2 E2E (Playwright).** Fixture work: the scripted runner gains a v3 enroll option, `putLog`, and a real tar.gz
  bundle writer (`tar-stream` in the fixture). Tests:
  1. Viewer open while RUNNING: lines arrive in follow mode; filter by story and level; scroll up turns follow off.
  2. Job ends with stdout complete and the run stream cut before `final`; the bundle (containing the full run log)
     fills it; the "Filled from the bundle" notice shows.
- **2 live check (unbilled, no approval needed):** a real `koda-runner` against a local koda with a stub `nax` binary
  writing ~50 MB of JSONL (including one 3 MiB line) plus stdout/stderr over ~2 minutes. Kill and restart the daemon
  mid-run, and once more after the stub exits. Pass when each stored stream's SHA-256 equals the file on disk and the
  viewer filters work on it.

## 9. Slices (R14)

| Slice | Scope | Deps |
|:--|:--|:--|
| 1a API transport + storage | `LogStore` + `LocalDiskLogStore`, migration (`FleetJobLog`, `FleetJobArtifact.expiredAt`, `FleetJob(state, finishedAt)` index), octet-stream parser, upload route + rate bucket, protocol `[1,2,3]`, bundle fallback (`tar-stream`), `fleet_log` event + coalescer, config keys, i18n reasons, openapi regen | — |
| 1b runner shipper | `ServerClient.putLog`, `LogShipper`, watcher v3 mode, drain in `watch` and `finish`, shrink/diverged, tuning, protocol 3, runner context.md | 1a |
| 1c read side + CLI + retention | list / raw / entries routes, throttle, CLI `job logs`, retention cron, expired-bundle 410 + `findLatestArtifact`, openapi + CLI regen | 1a |
| 2 web + E2E | viewer page, live-event parser, job page + timeline links, expired bundle UI, notices, i18n, E2E fixture + tests (1)(2), unbilled live check | 1b, 1c |
