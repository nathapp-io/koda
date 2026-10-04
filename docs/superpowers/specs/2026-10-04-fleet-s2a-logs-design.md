# Fleet S2a — Complete Run Logs, Log Viewer and Retention — Design

Builds the S2a phase of the fleet plan (design doc §5 "S2a observability", item (l)) and the C6 remainder from the
fleet S1 spec (`2026-09-29-fleet-s1-dispatch-design.md`, "the S1 spec", §9.5: "`ArtifactStore.putLogChunk` for full
JSONL streaming; `FleetJobEvent` stays the small indexed timeline"). It also takes the artifact retention that S1 plan
D15 deferred to S2a. Where this document and S1 spec §9.5 disagree, this document wins.

## Goal

A project member reads a nax run's complete log in koda, live while the job runs and afterwards, filtered by level,
story, stage and session role, without a shell on the runner machine. Old logs and bundles do not fill the server disk.

## Success criteria

1. While a RUN job is RUNNING, the viewer shows every line nax wrote to its run JSONL, stdout and stderr, in order,
   within a few seconds of the write. No line is dropped or sampled (the S1 60-events-per-minute budget no longer
   applies to v3 runners).
2. After the job ends, the stored run log is byte-identical to the file nax wrote (same SHA-256), including across a
   runner daemon restart mid-run.
3. The run log can be filtered by minimum level, story, stage, session role and text, server-side, on logs up to the
   256 MiB per-stream cap, without loading the whole log into the browser.
4. A stream the runner could not finish uploading is filled from the job's bundle and says so.
5. Logs, bundles and `log` timeline events of jobs that ended more than 30 days ago are deleted daily; the job row,
   its other events, approvals, budget incidents and costs stay, and the pages say the logs expired.
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

## Ground truth (verified on main `a759759f`)

- The runner already tails three streams per job (`apps/runner/src/watcher/watcher.ts`): `run` = nax's run JSONL
  (`<jobDir>/nax-out/features/<f>/runs/<logRunId>.jsonl`, found by `findRunLog`), `stdout` = `<jobDir>/nax.stdout`,
  `stderr` = `<jobDir>/nax.stderr`. `FileTail.readNew` returns whole lines only (unless `final`), at most 1 MiB per read.
- Today each read is cut into 8,000-byte chunks and sent as `log` sync events `{stream, text}` through a 60-per-minute
  `LogBudget`; the excess is counted in `droppedLogs` and lost (`watcher/log-budget.ts`). The events are stored as
  `FleetJobEvent` rows of type `log` and rendered as one-line rows by `FleetJobTimeline.vue`.
- A daemon that re-adopts a running job after a restart tails from the **end** of each file (`startAtEnd: resumed`,
  `supervisor/job-run.ts:259`), so bytes written while it was down are never sent.
- At job end the runner uploads a `tar.gz` bundle (all of `nax-out/` minus `prompt-audit`, `nax.stdout`, `nax.stderr`,
  `bundle-manifest.json`, and `plan-logs/*.jsonl` for PLAN) to `PUT /fleet/runner/jobs/:jobId/bundle?leaseEpoch=`,
  stored through `ArtifactStore` (`LocalDiskArtifactStore` under `FLEET_ARTIFACT_DIR`) with a `FleetJobArtifact` row
  unique per `(jobId, kind, leaseEpoch)`.
- `ArtifactStore.put` is an atomic whole-object replace; it has no append.
- Attempts are lease epochs on one `FleetJob`; a requeue bumps `leaseEpoch`. `FenceService.holds` checks
  `job.runnerId` and `job.leaseEpoch`.
- Live updates: `ProjectEventBus` (in-process, single API instance) feeds the SSE route `GET /projects/:slug/events`;
  events are content-free (`fleet_job`, `fleet_approval`) and the page refetches. SSE is browser-only.
- Throttling: global `ThrottlerModule` 100 req/min; only the sync route and the SSE route are `@SkipThrottle`.
- Fastify parses `application/gzip` as a raw stream via `common/hooks/bundle-content-parser.ts`.
- No retention exists for artifacts or job events; the only fleet `@Cron` is enrollment retention
  (`fleet/runners/enrollment-retention.processor.ts`, `30 4 * * *`).

## Out of scope

- Ledger cost reconciliation at bundle ingest (L3, stays deferred).
- Fleet dashboard, artifact analytics, OTel ingestion (S2b).
- Object storage (S3); local disk only, behind the `LogStore` interface.
- Streaming PLAN `plan-logs/*.jsonl` live (PLAN jobs stream stdout/stderr; plan logs come from the bundle).
- prompt-audit ingestion (design doc §6 Q3, still open).
- Per-project retention settings; one global window.
- Multi-instance API (the per-key append lock is in-process, as is the event bus).

## 1. Storage

### 1.1 `LogStore` (API)

A new interface next to `ArtifactStore`, because logs need appends and `ArtifactStore.put` is a whole-object replace:

```ts
export const LOG_STORE = Symbol('LOG_STORE');

export interface LogStore {
  /** Appends iff offset === current size. Returns the size after the call. */
  append(key: string, offset: number, bytes: Buffer): Promise<AppendResult>;
  size(key: string): Promise<number>;          // 0 when absent
  read(key: string, from: number, to: number): Promise<Buffer>;
  /** Writes a whole object (bundle fallback, §2.5). Atomic replace. */
  replace(key: string, source: Readable): Promise<number>;
  deletePrefix(prefix: string): Promise<void>; // absent prefix is a no-op
}

export type AppendResult =
  | { kind: 'appended'; size: number }
  | { kind: 'duplicate'; size: number }   // offset + length <= size: already have these bytes
  | { kind: 'conflict'; size: number };   // anything else: gap or partial overlap
```

- `LocalDiskLogStore` lives under `FLEET_ARTIFACT_DIR` (same root as bundles). Key:
  `logs/<jobId>/<leaseEpoch>/<stream>.log`, `stream ∈ {run, stdout, stderr}`. Keys are server-built; route parameters
  are validated against the enum and the epoch is an integer, so no path segment comes from free text.
- Appends to one key are serialized by an in-process per-key mutex (single API instance, see Out of scope). The append
  opens the file with `O_APPEND` after the size check under the lock and `fsync`s before returning.
- A `duplicate` never compares bytes; exact-offset idempotency plus the per-request SHA (§2.2) is the integrity check.

### 1.2 `FleetJobLog` (index row)

```prisma
model FleetJobLog {
  id         String    @id @default(cuid())
  jobId      String
  leaseEpoch Int
  stream     String    // run | stdout | stderr
  sizeBytes  BigInt    @default(0)
  complete   Boolean   @default(false)  // runner sent final=1, or filled from the bundle
  truncated  Boolean   @default(false)  // hit FLEET_LOG_MAX_BYTES
  source     String    @default("stream") // stream | bundle
  expiredAt  DateTime?
  updatedAt  DateTime  @updatedAt
  createdAt  DateTime  @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, stream])
  @@index([jobId])
}
```

`FleetJobArtifact` gains `expiredAt DateTime?`. The job page, retention and the live event read `FleetJobLog`; the
bytes live in `LogStore` (C6 split: small index in Postgres, bulk on disk).

## 2. Runner upload

### 2.1 Protocol v3

- `packages/fleet-protocol` `FLEET_PROTOCOL_VERSION = 3`; the API accepts `[1, 2, 3]`.
- v3 adds the capability `logs: { stream: true }`. Deploy the API first (same rule as 2a).
- A v3 runner with `logs.stream` sends **no** `log` sync events. v1/v2 runners are unchanged (sampled `log` events,
  `droppedLogs`).
- The server never rejects a v3 runner's `log` event (it stores it as today), so a mixed or downgraded daemon cannot
  break sync.

### 2.2 Route

`PUT /fleet/runner/jobs/:jobId/logs/:stream?leaseEpoch=<int>&offset=<int>[&final=1]`

- `@RunnerRoute()`, `@SkipThrottle()`. Body: raw bytes, `Content-Type: application/octet-stream` (a raw-stream parser
  registered beside the gzip one), at most `FLEET_LOG_CHUNK_MAX_BYTES` = 1 MiB; `X-Content-SHA256` required.
- Checks, in order:
  1. `stream` ∈ enum, `leaseEpoch` and `offset` non-negative integers → else 400.
  2. `FenceService.holds(runner, job, leaseEpoch)` and job state ∈ {RUNNING, UPLOADING} → else 409
     `{ reason: 'stale_lease' | 'job_state' }`.
  3. Body length ≤ chunk max → else 413. SHA mismatch → 422.
  4. Per-runner byte rate over `FLEET_LOG_RUNNER_BYTES_PER_SEC` (default 2 MiB/s, token bucket, in-process) → 429
     with `Retry-After`.
  5. `offset + length > FLEET_LOG_MAX_BYTES` (default 256 MiB) → append the bytes that fit (none if already full),
     set `truncated = true`, respond 413 `{ reason: 'stream_cap', size }`. The runner stops that stream.
  6. Disk write failure (ENOSPC etc.) → 507.
- Otherwise `LogStore.append`:
  - `appended` / `duplicate` → 200 `{ size }`; upsert `FleetJobLog.sizeBytes`.
  - `conflict` → 409 `{ reason: 'offset', size }`.
- `final=1` (empty body allowed): requires `offset === size`; sets `complete = true`; 200 `{ size }`. A final at a
  different offset is a 409 `offset` like any other.
- An empty, non-final body is a 400.

`GET /fleet/runner/jobs/:jobId/logs?leaseEpoch=<int>` (same guard, fence and state checks, `@SkipThrottle()`) →
`{ streams: { run: size, stdout: size, stderr: size } }` (0 for a stream with no bytes). This is the uploader's
resume probe (§2.4).

### 2.3 Live event

After a successful append that grew the stream (and after `final=1`), publish a content-free
`fleet_log { id, projectId, jobId, leaseEpoch, stream, size, complete, at }` on `ProjectEventBus`, coalesced to at most
one per job per second (trailing edge, so the last size always goes out).

### 2.4 Runner uploader

- One `LogUploader` per job attempt and stream, fed by the `Watcher` when the runner advertises `logs.stream`. The
  watcher still owns tailing; for v3 its `logLine` sink is replaced by `uploader.push(bytes)`; the `LogBudget` and
  `chunkText` are bypassed.
- **The file on disk is the buffer.** The uploader keeps only `ackedOffset` per stream and reads ranges from the file
  (up to 1 MiB, cut at the last newline unless at end-of-run, the same rule as `FileTail`). It holds nothing in memory
  beyond the chunk in flight.
- Loop: send `[ackedOffset, ackedOffset + n)`; on 200 set `ackedOffset = size`; on 409 `offset` set
  `ackedOffset = size` (jump to the server); on 429 wait `Retry-After`; on 5xx or network error back off exponentially
  to 30 s; on 409 `stale_lease`/`job_state` stop (sync already delivers `ABANDON`); on 413 `stream_cap` stop that
  stream.
- **Resume from the server, not the file end.** On start and on re-adopt the uploader first calls the size probe
  (`GET .../logs?leaseEpoch=`) and sets each stream's `ackedOffset` to the server's size. The v3 path therefore
  ignores `startAtEnd`; a daemon restart loses nothing that is still on disk.
- **Drain before UPLOADING.** When nax exits, the job run reads every stream to end (`final` read), uploads until
  `ackedOffset == file size`, then sends `final=1` per stream, then reports UPLOADING and uploads the bundle. The drain
  is bounded by `logDrainTimeoutMs` (default 120 s); on timeout it proceeds without `final=1` and the bundle fallback
  (§2.5) fills the rest.
- The `run` stream starts when `findRunLog` first finds the file. PLAN jobs upload `stdout` and `stderr` only.

### 2.5 Bundle fallback

On a successful bundle upload, for each stream of that attempt whose `FleetJobLog` row is missing or has
`complete = false` **and** `truncated = false`:

1. Extract the stream's file from the bundle (`nax-out/features/<f>/runs/<naxLogRunId>.jsonl` for `run`,
   `nax.stdout`, `nax.stderr`; PLAN `run` stays absent).
2. If found and its size ≥ the stored size, `LogStore.replace` it, set `sizeBytes`, `complete = true`,
   `source = 'bundle'`, and publish `fleet_log`.
3. If not found, or smaller than what was streamed, leave the row as is (`complete = false`).

A truncated stream is never refilled (the bundle copy would exceed the cap too); its full text stays in the bundle
download. The fallback runs after the bundle row commits and never fails the bundle upload; an extraction error is
logged and leaves the stream incomplete.

## 3. Read side

All routes are project-scoped, readable by any project member (same rule as the job page), and resolve the job by
`(project, id)` so a member of another project gets 404.

### 3.1 List

`GET /projects/:slug/fleet/jobs/:id/logs` →
`{ streams: [{ leaseEpoch, stream, sizeBytes, complete, truncated, source, expired, updatedAt }] }`, plus
`legacySampled: true` for attempts that have `log` events but no `FleetJobLog` rows (v1/v2 runners).

### 3.2 Raw

`GET /projects/:slug/fleet/jobs/:id/logs/:stream/raw?epoch=&from=&to=` → `text/plain; charset=utf-8` bytes of
`[from, to)`, `to - from ≤ 1 MiB` (else 400), clamped to the stored size. Headers `X-Log-Size`, `X-Log-Complete`.
`Content-Disposition: attachment` when `download=1` (the whole stream, streamed, no 1 MiB limit). Expired → 410.

### 3.3 Entries (run stream)

`GET /projects/:slug/fleet/jobs/:id/logs/run/entries?epoch=&cursor=&direction=forward|backward&limit=&level=&storyId=&stage=&role=&q=`

- Reads lines from `cursor` (a byte offset at a line start; default 0 forward, or the stored size backward), parses
  each as a nax `LogEntry` (`timestamp, level, stage, storyId?, sessionRole?, message, data?`), applies the filters,
  and returns `{ entries: [{ offset, length, timestamp, level, stage, storyId, sessionRole, message, data }
  | { offset, length, unparsed: true, text }], nextCursor, scannedTo, atEnd }`.
- `level` is a minimum (`debug < info < warn < error`). `q` is a case-insensitive substring over `message` and the
  JSON of `data`. `limit` default 200, max 500.
- Each request scans at most `FLEET_LOG_SCAN_BYTES` (4 MiB) and returns early with the cursor where it stopped, so a
  rare filter yields several short pages, not one long request. A trailing partial line (no newline yet) is not
  returned and not passed by the cursor.
- An unparseable line is returned as `unparsed`, never dropped; an `unparsed` line matches a filter only through `q`.
- Expired → 410.

### 3.4 CLI (L6)

`koda fleet job logs <id> --project <slug> [--stream run|stdout|stderr] [--epoch <n>] [--follow] [--level <l>]
[--story <id>] [--stage <s>] [--role <r>] [--grep <text>] [--json]`

- `run` prints `HH:MM:SS LEVEL [stage] [story] message`; `--json` prints the raw JSONL entries. stdout/stderr print raw.
- `--follow` polls the entries/raw route every 2 s from the last cursor until the stream is `complete` (SSE is
  browser-only). Default epoch is the latest.

## 4. Web

### 4.1 Viewer page

`/[project]/fleet/jobs/[id]/logs`, linked from the job page header and from each attempt.

- Tabs `Run log`, `stdout`, `stderr`; attempt picker (default the latest epoch).
- Run log rows: time, level badge, stage, story, role, message; click to expand `data` as formatted JSON. Unparsed
  lines render as plain text with a muted "unparsed" tag. stdout/stderr render as monospaced lines from the raw route.
- Filters: minimum level, story (from the job's `stories`), stage, role, text. Filters live in the URL query.
- Follow mode (default on while the job is RUNNING): on `fleet_log` for this job and stream, fetch forward from the
  last cursor. Scrolling up turns follow off; a "Jump to latest" button turns it back on.
- A window of at most 5,000 rows in the DOM; "Load earlier" (backward cursor) / "Load more" at the edges evict from
  the other end.
- Notices: "Filled from the bundle (the live upload did not finish)" (`source = bundle`); "Truncated at 256 MiB —
  download the bundle for the full log" (`truncated`); "Log incomplete (n bytes received)" (ended, `complete = false`);
  "Logs expired after 30 days" (`expired`); "Sampled live log from an older runner; the full log appears after the
  run" (`legacySampled` while running, falling back to the bundle-filled streams afterwards).
- Download button per stream (`raw?download=1`).

### 4.2 Job page and timeline

- Header gains "Logs" (link to the viewer). The bundle download shows "Expired" when the artifact has `expiredAt`.
- `FleetJobTimeline` keeps rendering v1/v2 `log` events as today. For v3 attempts there are none; the timeline shows a
  single "Logs →" link row per attempt once its first `FleetJobLog` row exists.

## 5. Retention (L4)

- `FleetLogRetentionProcessor`, `@Cron('45 4 * * *')`, skipped when `FLEET_LOG_RETENTION_DAYS = 0`.
- Selects jobs with `state ∈ {COMPLETED, FAILED, ESCALATED, CRASHED, CANCELLED}` and
  `finishedAt < now - days`, that still have an unexpired `FleetJobLog` or `FleetJobArtifact` row or any `log` event;
  200 per batch, loops until none remain. It records each job's `leaseEpoch` at selection (`E`).
- Per job, only for attempts `≤ E`, in order: `LogStore.deletePrefix('logs/<jobId>/<epoch>/')` per epoch;
  `ArtifactStore.delete` for each bundle key of those epochs; delete `FleetJobEvent` rows of type `log` with
  `leaseEpoch ≤ E`; set `expiredAt` on those epochs' `FleetJobLog` and `FleetJobArtifact` rows. Files first, rows
  second: a crash between them leaves rows pointing at missing files, and the next run finishes the job (deletes of
  absent files are no-ops).
- A job requeued between selection and deletion only gains attempts `> E`, which this pass never touches, so a new
  attempt's logs are never deleted. The old attempts are expired as planned (they were past the window).
- Bundle download of an expired artifact → 410 Gone. Log routes → 410 / `expired: true`.
- Never touched: the job row, non-`log` events, approvals, budget incidents, cost fields.

## 6. Failure modes

| Failure | Behaviour |
|:--|:--|
| API unreachable mid-run | Uploader backs off (≤ 30 s); bytes wait on disk; resumes at the server size. |
| Runner daemon restarts mid-run | Re-adopt probes each stream's server size and resumes there; no loss (v3). |
| Runner machine dies mid-run | Job goes CRASHED via the existing sweeper; streams stay `complete = false`; no bundle, so the viewer shows "Log incomplete (n bytes received)". |
| Drain exceeds `logDrainTimeoutMs` | Bundle uploaded anyway; fallback fills incomplete streams. |
| Disk full on the API | 507; runner backs off; fallback may fill after the run if space returns. |
| Stream exceeds 256 MiB | Bytes up to the cap kept, `truncated`; viewer notice; full text in the bundle. |
| Stale lease (requeued / reassigned) | 409 `stale_lease`; uploader stops; sync delivers ABANDON. |
| Corrupted chunk in transit | 422 on SHA mismatch; retried from the same offset. |
| Duplicate / reordered chunk | Exact-offset rule: duplicate → 200 no-op; gap → 409 with the server size. |
| Bundle missing or unreadable at fallback | Stream stays incomplete; error logged; bundle upload unaffected. |

## 7. Configuration

| Env | Default | Meaning |
|:--|:--|:--|
| `FLEET_LOG_MAX_BYTES` | 268435456 | Per stream per attempt cap |
| `FLEET_LOG_CHUNK_MAX_BYTES` | 1048576 | Max body per upload |
| `FLEET_LOG_RUNNER_BYTES_PER_SEC` | 2097152 | Per-runner upload rate |
| `FLEET_LOG_SCAN_BYTES` | 4194304 | Max bytes scanned per entries request |
| `FLEET_LOG_RETENTION_DAYS` | 30 | `0` disables retention |

Runner tuning: `logDrainTimeoutMs` 120000.

## 8. Testing

- **API unit:** `LocalDiskLogStore` (exact-offset append, duplicate, gap, partial overlap, concurrent appends to one
  key serialized, `deletePrefix` of an absent prefix); upload controller (fence, state, 400/409/413/422/429/507,
  `final=1` offset rule, cap partial append); entries reader (each filter, `level` minimum, `q` over data, a line
  straddling the 4 MiB scan bound, trailing partial line, unparsed lines, forward/backward cursor round trip);
  bundle fallback (incomplete vs truncated vs complete, missing file, smaller file); `fleet_log` coalescing (one per
  second, trailing edge); retention selection, order, requeue race, 410s.
- **API integration (`KODA_DB_TESTS=1`):** `FleetJobLog` upsert under concurrent appends; retention batch on a real
  database; fallback from a real bundle.
- **Runner unit:** uploader loop (200 advance, 409 jump, 429 wait, backoff, stale stop, cap stop); re-adopt resumes at
  the server size; drain then `final=1` before UPLOADING; drain timeout; v2 vs v3 sink selection; `run` stream starts
  when the log appears.
- **CLI unit:** `job logs` formatting, `--json`, filters mapped to query params, `--follow` stops on `complete`.
- **Web unit:** cursor and follow state, URL-synced filters, 5,000-row window eviction, row expansion, every notice.
- **E2E (Playwright), scripted runner speaking v3:**
  1. Viewer open while RUNNING: lines arrive in follow mode; filter by story and level; scroll up turns follow off.
  2. Job ends with stdout/stderr present; one stream's upload is cut before `final`; the bundle fills it and the
     notice shows.
- **Live check (unbilled, no approval needed):** a real `koda-runner` against a local koda, with a stub `nax` binary
  that writes ~50 MB of JSONL plus stdout/stderr over ~2 minutes. Kill and restart the daemon mid-run. Pass when each
  stored stream's SHA-256 equals the file on disk and the viewer filters work on it.

## 9. Slices

| Slice | Scope | Deps |
|:--|:--|:--|
| 1a transport + storage | `LogStore` + `LocalDiskLogStore`, `FleetJobLog` + `FleetJobArtifact.expiredAt` migration, upload route + octet-stream parser, protocol v3 + capability, runner `LogUploader` + drain + re-adopt probe, bundle fallback, `fleet_log` event | — |
| 1b read side + retention | list / raw / entries routes, CLI `job logs`, retention cron, 410 handling, openapi + CLI client regen | 1a |
| 2 web + E2E | viewer page, job page + timeline links, notices, E2E (1)(2), unbilled live check | 1b |
