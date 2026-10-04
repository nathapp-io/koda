# Fleet S2a Slice 1c — Log Read Side, CLI and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project member reads a job's stored log streams through three user routes (list, entries, raw), filtered
server-side within a bounded scan; the CLI gains `koda fleet job logs` (with `--follow`); a nightly cron deletes the
logs, bundles and `log` events of jobs that ended more than `FLEET_LOG_RETENTION_DAYS` ago, and an expired bundle
answers 410. API + CLI only; the web viewer is slice 2.

**Architecture:** The read side lives in the existing `src/fleet/logs/` module: a pure line scanner (`log-lines.ts`)
cuts a byte window into line spans, a pure entry module (`log-entry.ts`) parses nax `LogEntry` lines and applies the
filters, and `LogReadService` composes them over `LogStore.read` with a `logScanBytes` bound. `FleetJobLogsController`
(user principals, project members, 600 req/min) exposes the routes. Retention is `FleetLogRetentionProcessor` over a
small `PrismaLogRetentionRepository`; files go first, then rows under the job row lock. The CLI command polls the
entries route through the generated client.

**Tech Stack:** NestJS 11 + Fastify + Prisma 6 (PostgreSQL) + Jest + supertest (API); Commander.js 12 + Jest (CLI);
`@nestjs/schedule` cron.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md` §3, §4.2 (the API half: expired bundle),
§5, §7 (the two read/retention keys), §8 (1c tests), §9 slice 1c. Rulings L4, L6, R9, R10, R11, R12, R13, R14.

## Global Constraints

- Streams: exactly `run | stdout | stderr` (`LOG_STREAMS`). Storage key `logs/<jobId>/<leaseEpoch>/<stream>.log`
  (`logKey`).
- Read routes live under `GET /projects/:slug/fleet/jobs/:id/logs...`, user principals only (`isUserPrincipal`, else
  403 `projects`), project members (`ProjectMembershipGuard`), job resolved by `(project, id)` (404 `fleet.jobs`).
- Read throttle: `@Throttle({ default: { limit: 600, ttl: 60000 } })` on the read controller (R10, D331).
- `FLEET_LOG_SCAN_BYTES` default `2097152` (2 MiB): max bytes scanned per entries request. Raw range max `1048576`
  (1 MiB) per request (`download=1` streams the whole stream).
- Entries `limit` default `200`, max `500`. Levels `debug < info < warn < error`.
- `FLEET_LOG_RETENTION_DAYS` default `30`; `0` disables; off (`null`) under `NODE_ENV=test` unless set. Cron
  `45 4 * * *`. Batches of `200` jobs.
- Retention never touches: the job row, non-`log` events, approvals, budget incidents, cost fields.
- **`apps/api` compiles with `strictNullChecks: false`**: a boolean discriminant does not narrow a union. Discriminate
  with a string literal field compared with `===`, as the snippets do.
- API tests: `cd apps/api && bun run test:scoped <paths>` (integration specs need `bun run test:db:up` first; the
  wrapper sets `KODA_DB_TESTS=1` for them). Never bare `bun test` at the repo root.
- Integration files log in over HTTP in `beforeAll` (login throttle 5/min). A whole file failing in under a millisecond
  with only a `loginToken` frame is the local throttle cascade: wait a minute and rerun that file alone.
- CLI tests: `cd apps/cli && bunx jest <paths>`. The CLI's `src/generated/` is gitignored and produced by
  `bun run generate` at the repo root (needs `apps/api/.env`); run it after any API contract change and before CLI
  work. Commit `openapi.json` only.
- No emojis in source; no `console.log` in `apps/api/src` (the CLI prints with `console.log` by design).
- Immutability: build new objects and arrays; local accumulators inside one function are the only mutation, as the
  snippets show.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D331 (slice 1b ended at D330).

| # | Decision | Why |
|:--|:--|:--|
| D331 | **Spec correction (R10):** the read throttle is 600 req/min **per client IP per route** (`@Throttle` on the controller). koda's `DefaultThrottlerGuard` tracks by client IP; there is no per-user tracker. | A per-user tracker needs a custom guard for one controller; the IP tracker already backs the global 100/min. |
| D332 | `leaseEpoch` is **optional** on `entries` and `raw`; it defaults to `job.leaseEpoch`. `leaseEpoch > job.leaseEpoch` answers 404 `fleet.logs`. A stream with no row answers an empty page (`size` = file size, normally 0, `complete: false`, `atEnd: true`), not 404, so a reader opened before the first upload simply polls. `download=1` of a stream with no row and no bytes answers 404 `fleet.logs`. | The CLI and the viewer can follow a job before its first byte; only a download of nothing is an error. |
| D333 | Reads take **no lock**: `LogStore.size` then `LogStore.read`. `complete` and `truncated` come from the row. A trailing line without `\n` is shown only when the row says `complete` (the row is written after `fsync`, inside the key lock, so a complete row means the file is final). | Appends only grow the file; the fallback's `replace` is an atomic rename. A read that straddles a replace returns a window of the new file, which the next request heals. |
| D334 | One async `LogStore.read` per request reads the whole scan window (at most `logScanBytes`); line splitting and parsing yield with `setImmediate` after every 256 KiB of processed bytes. | Spec R11's goal is a non-blocking event loop; a single async 2 MiB read does not block, the CPU work is what needs slicing. |
| D335 | `log-lines.ts` is pure: `forwardSpans(buf, bufStart, o)` / `backwardSpans(buf, bufStart, o)` return line spans `{ start, end, cut }` plus `linesStart`, `linesEnd`, `reachedEnd`. Filtering and the `limit` stop happen in `LogReadService`, which derives `nextCursor`, `scannedFrom`, `scannedTo` and `atEnd`. | The cursor contract is the risky part; a pure function over a Buffer is testable byte by byte. |
| D336 | **Spec correction (§3.3 cursor snap):** the server does not snap a forward cursor. A cursor that is not a line start yields its first span marked `cut: true` (entry `truncatedLine: true`, `unparsed` on the run stream). | After an overlong line (R12) the server's own `nextCursor` is mid-line; snapping to the next `\n` would drop the rest of that line. Marking the fragment keeps every byte visible and still tells the reader the line is partial. |
| D337 | A span is `cut` when it does not end with `\n` and is not the final line of a `complete` stream, or when it starts mid-line (D336). An overlong window (no line boundary inside a full window) becomes one `cut` span covering the window, and the cursor advances past it (forward) or to its start (backward). | R12: never a stall. |
| D338 | Backward with no cursor starts at the **visible end**: the file size when `complete`, else the end of the last `\n` found in the last `logScanBytes` of the file (when there is none: `0` if the window starts at 0, else the window start). An explicit cursor is clamped to the file size. | Spec §3.3 default; the tail search is bounded by the same scan budget. |
| D339 | Run-stream entry shape: parsed → `{ offset, length, timestamp?, level, stage?, storyId?, sessionRole?, message?, data? }` (string fields only when the line has them as strings; `data` as-is). Unparsed → `{ offset, length, unparsed: true, text, truncatedLine? }`. stdout/stderr → `{ offset, length, text, truncatedLine? }`. `text` drops the trailing `\n`; invalid UTF-8 becomes U+FFFD (`Buffer.toString('utf8')`). | Spec §3.3; one `FleetJobLogEntryDto` with optional fields for the OpenAPI contract. |
| D340 | `q` is matched against the lowercased decoded raw line before any JSON parse; a run line that fails `q` is never parsed. | R11; most filtered scans reject most lines. |
| D341 | `findLatestArtifact(jobId, kind)` returns the newest **unexpired** artifact. `BundleService.download`: none unexpired → if an expired one exists, 410 `fleet.bundle` (new `410` message); else 404 as today. `FleetArtifactRecord` gains `expiredAt: Date | null`. | Spec §4.2 asks for both "skip expired" and "410 for expired"; a requeued job keeps serving its newer bundle. |
| D342 | Retention selection: terminal jobs with `finishedAt < now − days` that have an unexpired `FleetJobLog` row, an unexpired `FleetJobArtifact` row, or any `log` event; ordered `(finishedAt, id)`, keyset-paged 200 at a time until a short page. `E` = the job's `leaseEpoch` as selected. | Keyset paging terminates even when a job keeps failing (it is retried the next night, not in a loop). |
| D343 | Retention files: `LogStore.deletePrefix('logs/<jobId>/<epoch>/')` for **every** epoch `0..E` (absent is a no-op), and `ArtifactStore.delete` for each unexpired bundle key with `leaseEpoch ≤ E`. | A file can exist without a row (crash between `fsync` and the first upsert); walking every epoch leaves no orphan. Attempts `> E` are never touched. |
| D344 | Retention rows: one transaction, `lockById(jobId)`; when the row is gone, nothing; otherwise delete `log` events with `leaseEpoch ≤ E` and set `expiredAt = now` on that job's unexpired `FleetJobLog` and `FleetJobArtifact` rows with `leaseEpoch ≤ E`. No state check beyond existence. | The lock orders retention after an in-flight requeue (which only adds epoch `E + 1`); the old attempts' files are already gone, so their rows must say so (spec §5). |
| D345 | Error keys (en + zh): `fleet.logQuery` (`-2`, 400, `{reason}`), `fleet.logs` (`404`), `fleet.logExpired` (`410`), `fleet.bundle.410`. | Same pattern as `fleet.logInput` / `fleet.bundle`. |
| D346 | CLI: without `--follow`, `logs` pages forward from offset 0 to `atEnd` and exits 0. With `--follow` it keeps polling forward from `nextCursor` every 2 s **only while `atEnd`** (a page that is not `atEnd` is followed at once), checks the job state every 10th sleeping poll, and stops per spec §3.4. Ctrl-C in follow exits 0 through a `process.prependListener('SIGINT', ...)` that runs before the global 130 handler. | Spec §3.4 leaves the non-follow mode open; `cat`-like output matches `--follow`'s start. The global `installSignalHandlers` exits 130 on SIGINT. |
| D347 | CLI default epoch: the first attempt of the list route; when the list is empty, `leaseEpoch` is omitted and the server uses the job's current epoch (D332). Run lines print `HH:MM:SS LEVEL [stage] [story] message` with the time cut from the ISO `timestamp` (UTC, as nax writes it), `LEVEL` upper-cased and padded to 5, `[stage]` / `[story]` only when present. Unparsed and stdout/stderr lines print `text`. | Deterministic output, no timezone dependency. |
| D348 | CLI error mapping gains `[410, 410]` in `API_RET_STATUS`, so an expired log or bundle reports status 410 (exit 1, API_ERROR, with the server's translated message). | Today a 410 envelope maps to "status unknown". |
| D349 | Slice 1a review cleanups ride Task 1: the upload service reads `LogStore.size` inside the 507 `try`, the 507 path gets unit tests, and the upload controller documents 404. | First 1c cleanup per #199. |

## Review Focus

1. **A forward page that ends exactly inside an overlong line, then the next page from its `nextCursor`**: the reader
   must get the rest of the line as a `truncatedLine` fragment and then the following lines, never skip bytes and never
   return the same bytes twice. Pinned in Task 2 (scanner) and Task 4 (service round trip).
2. **A stream that is still growing while a reader pages backward and then forward**: the trailing partial line must
   stay invisible until `complete`, and `atEnd` must be true at the last complete line, not at the file size. Pinned in
   Task 2 and Task 4.
3. **A filtered search on a large log where nothing matches in a window**: one request scans at most
   `logScanBytes`, answers `entries: []` with `atEnd: false` and a `nextCursor` past the window, so a caller can keep
   searching; it never returns the same cursor. Pinned in Task 4.
4. **Retention racing a requeue**: the job was selected at epoch `E`, then requeued to `E + 1` and started uploading;
   retention must delete only `≤ E` files and rows and leave the new attempt's file, row and `log` events intact.
   Pinned in Task 7 (integration).
5. **`koda fleet job logs --follow` on a job that is cancelled mid-run with `complete` never set**: the CLI must stop
   with exit 0 once the job is terminal and the reader is `atEnd`, not poll forever. Pinned in Task 8.

## File Map

**apps/api**
- Modify `src/config/fleet.config.ts`, `src/config/fleet.config.spec.ts`, `src/config/env.validation.ts`,
  `src/common/test-helpers/fleet-config.ts`, `.env.example`.
- Modify `src/i18n/en/fleet.json`, `src/i18n/zh/fleet.json`.
- Modify `src/fleet/logs/log-upload.service.ts`, `src/fleet/logs/log-upload.service.spec.ts`,
  `src/fleet/logs/log-upload.controller.ts` (Task 1).
- Create in `src/fleet/logs/`: `log-lines.ts`, `log-entry.ts`, `log-read.exceptions.ts`, `log-read.service.ts`,
  `fleet-job-logs.controller.ts`, `dto/fleet-job-log.dto.ts`, `dto/log-entries.query.ts`, `dto/log-raw.query.ts`,
  `domain/log-retention.domain.ts`, `prisma-log-retention.repository.ts`, `fleet-log-retention.processor.ts`, and a
  `*.spec.ts` beside each unit (`log-lines.spec.ts`, `log-entry.spec.ts`, `log-read.service.spec.ts`,
  `fleet-log-retention.processor.spec.ts`).
- Modify `src/fleet/logs/domain/fleet-job-log.domain.ts`, `src/fleet/logs/prisma-fleet-job-log.repository.ts`,
  `src/fleet/logs/test-helpers/memory-log-repo.ts`, `src/fleet/logs/logs.module.ts`.
- Modify `src/fleet/jobs/domain/fleet-job.domain.ts`, `src/fleet/jobs/prisma-fleet-job.repository.ts`,
  `src/fleet/artifacts/bundle.exceptions.ts`, `src/fleet/artifacts/bundle.service.ts`,
  `src/fleet/artifacts/job-bundle.controller.ts`; create `src/fleet/artifacts/bundle.service.spec.ts`.
- Modify `src/fleet/fleet-openapi.contract.spec.ts`.
- Create `test/integration/fleet/fleet-log-read.integration.spec.ts`,
  `test/integration/fleet/fleet-log-retention.integration.spec.ts`.

**apps/cli**
- Create `src/commands/fleet-job-logs.ts`, `src/commands/fleet-job-logs.spec.ts`.
- Modify `src/commands/fleet-job.ts` (register `logs`, description), `src/commands/fleet-job.spec.ts` (generated mock
  list), `src/utils/error.ts`, `src/utils/error.spec.ts`.

**repo root:** `openapi.json` (regenerated); `docs/deployment/runner.md`; the spec (D331, D336 text fixes ride the plan
commit).

---

### Task 1: Slice 1a cleanups — 507 covers the size read; upload controller documents 404 (D349)

**Files:**
- Modify: `apps/api/src/fleet/logs/log-upload.service.ts:95-123` (`write`)
- Modify: `apps/api/src/fleet/logs/log-upload.controller.ts:23-28` (responses)
- Test: `apps/api/src/fleet/logs/log-upload.service.spec.ts`

**Interfaces:**
- Consumes: `LogUploadService` (slice 1a), `statusOf` and `sha` helpers already at the top of the spec.
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('LogUploadService', ...)` block of `log-upload.service.spec.ts`:

```ts
  it('answers 507 when the disk refuses the size read or the append; other errors stay errors (D349)', async () => {
    const fail = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    const withStore = (over: object) => new LogUploadService(
      jobs as never, fence as never, tx as never,
      { withLock: (_key: string, fn: () => Promise<unknown>) => fn(), size: async () => 0, ...over } as never,
      logs as never, live as never, cfg as never,
    );
    const bytes = Buffer.from('x\n');
    const call = (s: LogUploadService) => s.upload({
      runnerId: 'r1', jobId: job.id, streamRaw: 'run', leaseEpochRaw: '1', offsetRaw: '0', finalRaw: undefined,
      sha256Header: sha(bytes), contentLength: '1', body: Readable.from([bytes]),
    });
    await expect(statusOf(call(withStore({ size: fail('EIO') })))).resolves.toBe(507);
    await expect(statusOf(call(withStore({ append: fail('ENOSPC') })))).resolves.toBe(507);
    await expect(call(withStore({ append: fail('EACCES') }))).rejects.toThrow('EACCES');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-upload.service.spec.ts`
Expected: FAIL — the `EIO` case rejects with the raw `Error: EIO` (no `getStatus`), because `store.size` runs before
the `try`.

- [ ] **Step 3: Move the reads inside the 507 `try`**

In `log-upload.service.ts`, replace the head of `write` so both reads are covered:

```ts
  private async write(jobId: string, key: string, p: Parsed, bytes: Buffer): Promise<LogUploadResult> {
    try {
      const row = await this.logs.findStream(jobId, p.leaseEpoch, p.stream);
      const size = await this.store.size(key);
      if (row?.complete) return { outcome: 'complete', size };
      if (row?.truncated) return { outcome: 'stream_cap', size };
      if (p.offset + bytes.length > this.cfg.logMaxBytes) {
```

The rest of the body (cap branch, append, final, upsert) and the `catch` stay exactly as they are; only the two reads
and the two early returns move from above the `try` to its top.

In `log-upload.controller.ts`, add beside the other `@ApiResponse` lines:

```ts
  @ApiResponse({ status: 404, description: 'No such job' })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-upload.service.spec.ts`
Expected: PASS (all cases, including the earlier ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-upload.service.ts apps/api/src/fleet/logs/log-upload.service.spec.ts apps/api/src/fleet/logs/log-upload.controller.ts
git commit -m "fix(fleet): log upload maps a failed size read to 507 and documents 404 (S2a 1c D349)"
```

---

### Task 2: Line scanner (`log-lines.ts`)

**Files:**
- Create: `apps/api/src/fleet/logs/log-lines.ts`
- Test: `apps/api/src/fleet/logs/log-lines.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LineSpan { start: number; end: number; cut: boolean }` (absolute byte offsets; `end` includes the `\n`)
  - `interface SpanWindow { spans: LineSpan[]; linesStart: number; linesEnd: number; reachedEnd: boolean }`
  - `interface ScanOptions { cursor: number; size: number; complete: boolean; scanBytes: number }`
  - `forwardReadRange(o: ScanOptions): { from: number; to: number }`
  - `forwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow`
  - `backwardReadRange(o: ScanOptions): { from: number; to: number }`
  - `backwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow`
  - `visibleEnd(tail: Buffer, tailStart: number, size: number, complete: boolean): number`

The caller reads `[from, to)` from the store and passes those bytes as `buf` with `bufStart = from`. Both read ranges
include one byte before the window so the scanner can tell whether the window starts at a line start.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/fleet/logs/log-lines.spec.ts`:

```ts
import {
  backwardReadRange, backwardSpans, forwardReadRange, forwardSpans, ScanOptions, SpanWindow, visibleEnd,
} from './log-lines';

/** ASCII only, so a string index is a byte offset. */
const opts = (s: string, o: Partial<ScanOptions>): ScanOptions => ({ cursor: 0, size: s.length, complete: false, scanBytes: 1024, ...o });
const fwd = (s: string, o: Partial<ScanOptions> = {}): SpanWindow => {
  const all = opts(s, o);
  const r = forwardReadRange(all);
  return forwardSpans(Buffer.from(s).subarray(r.from, r.to), r.from, all);
};
const back = (s: string, o: Partial<ScanOptions> = {}): SpanWindow => {
  const all = opts(s, { cursor: s.length, ...o });
  const r = backwardReadRange(all);
  return backwardSpans(Buffer.from(s).subarray(r.from, r.to), r.from, all);
};
const texts = (s: string, w: SpanWindow) => w.spans.map((p) => s.slice(p.start, p.end));
const cuts = (w: SpanWindow) => w.spans.map((p) => p.cut);

describe('forwardSpans', () => {
  it('returns complete lines and hides the trailing partial line until complete', () => {
    const s = 'a\nbb\nccc';
    const open = fwd(s);
    expect(texts(s, open)).toEqual(['a\n', 'bb\n']);
    expect(open).toMatchObject({ linesStart: 0, linesEnd: 5, reachedEnd: true });
    const done = fwd(s, { complete: true });
    expect(texts(s, done)).toEqual(['a\n', 'bb\n', 'ccc']);
    expect(cuts(done)).toEqual([false, false, false]);
    expect(done.linesEnd).toBe(8);
  });

  it('stops at the scan bound and does not report reaching the end', () => {
    const s = 'a\nbb\nccc\n';
    const w = fwd(s, { scanBytes: 4 });
    expect(texts(s, w)).toEqual(['a\n']);
    expect(w).toMatchObject({ linesEnd: 2, reachedEnd: false });
  });

  it('walks an overlong line in cut windows without skipping or repeating a byte (R12, D336, Review Focus 1)', () => {
    const s = 'xxxxxxxxxx\ny\n';
    const seen: string[] = [];
    const flags: boolean[] = [];
    let cursor = 0;
    for (let i = 0; i < 10 && cursor < s.length; i += 1) {
      const w = fwd(s, { cursor, scanBytes: 4 });
      seen.push(...texts(s, w));
      flags.push(...cuts(w));
      expect(w.linesEnd).toBeGreaterThan(cursor);
      cursor = w.linesEnd;
    }
    expect(seen.join('')).toBe(s);
    expect(seen).toEqual(['xxxx', 'xxxx', 'xx\n', 'y\n']);
    expect(flags).toEqual([true, true, true, false]);
  });

  it('marks the first span cut when the cursor is not a line start (D336)', () => {
    const s = 'abc\ndef\n';
    const w = fwd(s, { cursor: 2 });
    expect(texts(s, w)).toEqual(['c\n', 'def\n']);
    expect(cuts(w)).toEqual([true, false]);
  });

  it('clamps a cursor past the end and handles an empty file', () => {
    const s = 'a\n';
    expect(fwd(s, { cursor: 99 })).toEqual({ spans: [], linesStart: 2, linesEnd: 2, reachedEnd: true });
    expect(fwd('', {})).toEqual({ spans: [], linesStart: 0, linesEnd: 0, reachedEnd: true });
  });

  it('cuts a trailing partial line that already fills a whole window while the stream is open (R12)', () => {
    const s = 'a\nzzzzzzzz';
    const first = fwd(s, { scanBytes: 4 });
    expect(texts(s, first)).toEqual(['a\n']);
    const next = fwd(s, { cursor: 2, scanBytes: 4 });
    expect(texts(s, next)).toEqual(['zzzz']);
    expect(cuts(next)).toEqual([true]);
    expect(next.linesEnd).toBe(6);
  });
});

describe('backwardSpans', () => {
  it('returns every line of a short stream in ascending order', () => {
    const s = 'a\nbb\nccc\n';
    const w = back(s);
    expect(texts(s, w)).toEqual(['a\n', 'bb\n', 'ccc\n']);
    expect(w).toMatchObject({ linesStart: 0, linesEnd: 9 });
  });

  it('drops the leading partial line of a window that does not start at 0', () => {
    const s = 'a\nbb\nccc\n';
    const w = back(s, { scanBytes: 5 });
    expect(texts(s, w)).toEqual(['ccc\n']);
    expect(w.linesStart).toBe(5);
  });

  it('keeps the first line when the window starts exactly at a line start', () => {
    const s = 'a\nbb\nccc\n';
    expect(texts(s, back(s, { scanBytes: 7 }))).toEqual(['bb\n', 'ccc\n']);
  });

  it('walks an overlong line backward in cut windows, every byte once (R12)', () => {
    const s = 'y\nxxxxxxxx\n';
    const pages: string[][] = [];
    let cursor = s.length;
    for (let i = 0; i < 10 && cursor > 0; i += 1) {
      const w = back(s, { cursor, scanBytes: 4 });
      pages.push(texts(s, w));
      expect(w.linesStart).toBeLessThan(cursor);
      cursor = w.linesStart;
    }
    expect(pages).toEqual([['xxx\n'], ['xxxx'], ['y\n', 'x']]);
    expect(pages.reverse().flat().join('')).toBe(s);
  });

  it('marks a span cut when it ends mid-line', () => {
    const s = 'y\nxxxxxxxx\n';
    const w = back(s, { cursor: 3, scanBytes: 4 });
    expect(cuts(w)).toEqual([false, true]);
  });

  it('returns nothing at cursor 0', () => {
    expect(back('a\n', { cursor: 0 })).toEqual({ spans: [], linesStart: 0, linesEnd: 0, reachedEnd: false });
  });
});

describe('visibleEnd (D338)', () => {
  it('is the size when complete, else the end of the last newline in the tail', () => {
    expect(visibleEnd(Buffer.from('a\nbb'), 0, 4, true)).toBe(4);
    expect(visibleEnd(Buffer.from('a\nbb'), 0, 4, false)).toBe(2);
    expect(visibleEnd(Buffer.from('zzzz'), 0, 4, false)).toBe(0);
    expect(visibleEnd(Buffer.from('zzzz'), 6, 10, false)).toBe(6);
  });
});
```

Check the overlong backward expectation by hand: `s = 'y\nxxxxxxxx\n'` (size 11). Cursor 11, window `[7, 11)` =
`xxx\n`, the byte before 7 is `x`, the only `\n` is at 10, so no line starts inside: one cut span `[7, 11)`. Cursor 7,
window `[3, 7)`, no `\n`: one cut span `[3, 7)`. Cursor 3, window `[0, 3)` starts at 0: `y\n` then `x` (ends mid-line,
cut).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-lines.spec.ts`
Expected: FAIL — `Cannot find module './log-lines'`.

- [ ] **Step 3: Implement**

`apps/api/src/fleet/logs/log-lines.ts`:

```ts
const NL = 0x0a;

/** One line (or a cut piece of one) as absolute byte offsets; `end` includes the `\n` when there is one. */
export interface LineSpan {
  start: number;
  end: number;
  /** D337: starts mid-line, or ends without `\n` before the end of a complete stream. */
  cut: boolean;
}

export interface SpanWindow {
  /** Ascending. */
  spans: LineSpan[];
  /** Where the spans begin; backward: the next cursor when no limit stopped the scan. */
  linesStart: number;
  /** Where the spans end; forward: the next cursor when no limit stopped the scan. */
  linesEnd: number;
  /** Forward: the window reached the file size. Backward: the window ended at the file size. */
  reachedEnd: boolean;
}

export interface ScanOptions {
  cursor: number;
  size: number;
  /** The FleetJobLog row says complete: the last line may lack `\n`. */
  complete: boolean;
  scanBytes: number;
}

/** Index of the next `\n` at or after absolute `from` and before absolute `to`, or -1. */
function nextNewline(buf: Buffer, bufStart: number, from: number, to: number): number {
  const i = buf.indexOf(NL, Math.max(0, from - bufStart));
  return i === -1 || i + bufStart >= to ? -1 : i + bufStart;
}

/** True when absolute offset `at` begins a line: 0, or the byte before it is `\n`. */
function startsLine(buf: Buffer, bufStart: number, at: number): boolean {
  return at === 0 || buf[at - 1 - bufStart] === NL;
}

/** Bytes forwardSpans needs: one before the cursor (line-start check) up to the scan bound. */
export function forwardReadRange(o: ScanOptions): { from: number; to: number } {
  const cursor = Math.min(o.cursor, o.size);
  return { from: Math.max(0, cursor - 1), to: Math.min(cursor + o.scanBytes, o.size) };
}

/** Spec §3.3 forward scan of `[cursor, cursor + scanBytes)` (D335-D337). */
export function forwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow {
  const cursor = Math.min(o.cursor, o.size);
  const windowEnd = Math.min(cursor + o.scanBytes, o.size);
  const midLine = !startsLine(buf, bufStart, cursor);
  const spans: LineSpan[] = [];
  let pos = cursor;
  for (let nl = nextNewline(buf, bufStart, pos, windowEnd); nl !== -1; nl = nextNewline(buf, bufStart, pos, windowEnd)) {
    spans.push({ start: pos, end: nl + 1, cut: pos === cursor && midLine });
    pos = nl + 1;
  }
  const reachedEnd = windowEnd === o.size;
  if (pos < windowEnd && reachedEnd && o.complete) {
    spans.push({ start: pos, end: windowEnd, cut: pos === cursor && midLine });
    pos = windowEnd;
  } else if (spans.length === 0 && windowEnd > cursor && windowEnd - cursor === o.scanBytes) {
    spans.push({ start: cursor, end: windowEnd, cut: true }); // a full window with no line boundary (R12)
    pos = windowEnd;
  }
  return { spans, linesStart: cursor, linesEnd: pos, reachedEnd };
}

/** Bytes backwardSpans needs: one before the window start (line-start check) up to the cursor. */
export function backwardReadRange(o: ScanOptions): { from: number; to: number } {
  const cursor = Math.min(o.cursor, o.size);
  const windowStart = Math.max(0, cursor - o.scanBytes);
  return { from: Math.max(0, windowStart - 1), to: cursor };
}

/** Spec §3.3 backward scan of `[cursor - scanBytes, cursor)`: the leading partial line is dropped unless at 0. */
export function backwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow {
  const cursor = Math.min(o.cursor, o.size);
  const windowStart = Math.max(0, cursor - o.scanBytes);
  const reachedEnd = cursor === o.size;
  if (cursor === windowStart) return { spans: [], linesStart: cursor, linesEnd: cursor, reachedEnd };
  const firstNl = nextNewline(buf, bufStart, windowStart, cursor);
  const first = startsLine(buf, bufStart, windowStart) ? windowStart : firstNl === -1 ? -1 : firstNl + 1;
  if (first === -1 || first >= cursor) {
    // No line starts inside the window: it is the middle or tail of an overlong line (R12).
    return { spans: [{ start: windowStart, end: cursor, cut: true }], linesStart: windowStart, linesEnd: cursor, reachedEnd };
  }
  const spans: LineSpan[] = [];
  let pos = first;
  while (pos < cursor) {
    const nl = nextNewline(buf, bufStart, pos, cursor);
    const end = nl === -1 ? cursor : nl + 1;
    const endsLine = nl !== -1 || (end === o.size && o.complete);
    spans.push({ start: pos, end, cut: !endsLine });
    pos = end;
  }
  return { spans, linesStart: first, linesEnd: cursor, reachedEnd };
}

/** D338: where a backward read without a cursor starts. `tail` holds the bytes `[tailStart, size)`. */
export function visibleEnd(tail: Buffer, tailStart: number, size: number, complete: boolean): number {
  if (complete) return size;
  const i = tail.lastIndexOf(NL);
  return i === -1 ? tailStart : tailStart + i + 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-lines.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-lines.ts apps/api/src/fleet/logs/log-lines.spec.ts
git commit -m "feat(fleet): log line scanner with forward/backward windows and cut overlong lines (S2a 1c D335-D338)"
```

---

### Task 3: Entry parsing and filters (`log-entry.ts`)

**Files:**
- Create: `apps/api/src/fleet/logs/log-entry.ts`
- Test: `apps/api/src/fleet/logs/log-entry.spec.ts`

**Interfaces:**
- Consumes: `LineSpan` (Task 2), `LogStreamName` (`domain/fleet-job-log.domain.ts`).
- Produces:
  - `LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const`, `type LogLevel`, `isLogLevel(v: unknown): v is LogLevel`
  - `interface LogFilter { level?: LogLevel; storyId?: string; stage?: string; role?: string; q?: string }`
  - `interface LogEntryView { offset: number; length: number; unparsed?: true; truncatedLine?: true; text?: string;
    timestamp?: string; level?: LogLevel; stage?: string; storyId?: string; sessionRole?: string; message?: string;
    data?: unknown }`
  - `toEntry(stream: LogStreamName, span: LineSpan, raw: Buffer, f: LogFilter): LogEntryView | null` — `raw` is the
    span's bytes; `null` means the filter rejected the line.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/fleet/logs/log-entry.spec.ts`:

```ts
import { LineSpan } from './log-lines';
import { LogFilter, toEntry } from './log-entry';

const line = (o: object) => `${JSON.stringify(o)}\n`;
const span = (raw: string, start = 100, cut = false): LineSpan => ({ start, end: start + Buffer.byteLength(raw), cut });
const run = (raw: string, f: LogFilter = {}, cut = false) => toEntry('run', span(raw, 100, cut), Buffer.from(raw), f);
const entry = { timestamp: '2026-10-04T08:15:30.123Z', level: 'warn', stage: 'review', storyId: 'US-001', sessionRole: 'implementer', message: 'slow', data: { ms: 900 } };

describe('toEntry (spec §3.3, D339-D340)', () => {
  it('parses a nax LogEntry line; length includes the newline', () => {
    const raw = line(entry);
    expect(run(raw)).toEqual({ offset: 100, length: Buffer.byteLength(raw), ...entry });
  });

  it('keeps only string fields and data as written', () => {
    expect(run(line({ level: 'info', stage: 7, message: 'm', data: [1, 2] }))).toEqual({ offset: 100, length: expect.any(Number), level: 'info', message: 'm', data: [1, 2] });
  });

  it.each([
    ['not json', 'hello world\n'],
    ['an array', '[1,2]\n'],
    ['an unknown level', line({ level: 'trace', message: 'x' })],
    ['the silent level', line({ level: 'silent', message: 'x' })],
    ['a missing level', line({ message: 'x' })],
  ])('treats %s as unparsed text', (_name, raw) => {
    expect(run(raw)).toEqual({ offset: 100, length: Buffer.byteLength(raw), unparsed: true, text: raw.slice(0, -1) });
  });

  it('applies the minimum level', () => {
    expect(run(line({ ...entry, level: 'info' }), { level: 'warn' })).toBeNull();
    expect(run(line({ ...entry, level: 'warn' }), { level: 'warn' })).not.toBeNull();
    expect(run(line({ ...entry, level: 'error' }), { level: 'warn' })).not.toBeNull();
    expect(run(line({ ...entry, level: 'debug' }), { level: 'debug' })).not.toBeNull();
  });

  it('matches story, stage and role exactly', () => {
    const raw = line(entry);
    expect(run(raw, { storyId: 'US-001', stage: 'review', role: 'implementer' })).not.toBeNull();
    expect(run(raw, { storyId: 'US-00' })).toBeNull();
    expect(run(raw, { stage: 'Review' })).toBeNull();
    expect(run(raw, { role: 'reviewer' })).toBeNull();
  });

  it('matches q case-insensitively against the raw line, keys included (R11)', () => {
    const raw = line(entry);
    expect(run(raw, { q: 'STORYID' })).not.toBeNull();
    expect(run(raw, { q: 'SLOW' })).not.toBeNull();
    expect(run(raw, { q: 'nothing-here' })).toBeNull();
  });

  it('keeps unparsed lines only for q or no filter', () => {
    expect(run('boom\n')).toMatchObject({ unparsed: true });
    expect(run('boom\n', { q: 'BOO' })).toMatchObject({ unparsed: true, text: 'boom' });
    expect(run('boom\n', { level: 'debug' })).toBeNull();
    expect(run('boom\n', { storyId: 'US-001' })).toBeNull();
  });

  it('never parses a cut span; it is unparsed and flagged', () => {
    const raw = '{"level":"info","message":"par';
    expect(run(raw, {}, true)).toEqual({ offset: 100, length: raw.length, unparsed: true, truncatedLine: true, text: raw });
  });

  it('returns stdout and stderr lines as text; only q applies', () => {
    const raw = 'Compiling 3 files\n';
    expect(toEntry('stdout', span(raw), Buffer.from(raw), { level: 'error', storyId: 'x' })).toEqual({ offset: 100, length: 18, text: 'Compiling 3 files' });
    expect(toEntry('stderr', span(raw), Buffer.from(raw), { q: 'nope' })).toBeNull();
    expect(toEntry('stderr', span(raw, 0, true), Buffer.from(raw), {})).toMatchObject({ truncatedLine: true });
  });

  it('replaces invalid UTF-8 with U+FFFD', () => {
    const raw = Buffer.concat([Buffer.from('a'), Buffer.from([0xff]), Buffer.from('b\n')]);
    expect(toEntry('stdout', { start: 0, end: raw.length, cut: false }, raw, {})).toEqual({ offset: 0, length: 4, text: 'a�b' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-entry.spec.ts`
Expected: FAIL — `Cannot find module './log-entry'`.

- [ ] **Step 3: Implement**

`apps/api/src/fleet/logs/log-entry.ts`:

```ts
import type { LogStreamName } from './domain/fleet-job-log.domain';
import type { LineSpan } from './log-lines';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: ReadonlyMap<string, number> = new Map(LOG_LEVELS.map((level, i) => [level, i]));

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && RANK.has(v);

export interface LogFilter {
  /** Minimum level (run stream). */
  level?: LogLevel;
  storyId?: string;
  stage?: string;
  /** nax `sessionRole`. */
  role?: string;
  /** Case-insensitive substring of the raw line (R11). */
  q?: string;
}

/** Spec §3.3 / D339: one entry of the entries route. */
export interface LogEntryView {
  offset: number;
  length: number;
  unparsed?: true;
  truncatedLine?: true;
  text?: string;
  timestamp?: string;
  level?: LogLevel;
  stage?: string;
  storyId?: string;
  sessionRole?: string;
  message?: string;
  data?: unknown;
}

type ParsedEntry = Pick<LogEntryView, 'timestamp' | 'stage' | 'storyId' | 'sessionRole' | 'message' | 'data'> & { level: LogLevel };

const hasStructuredFilter = (f: LogFilter): boolean => Boolean(f.level || f.storyId || f.stage || f.role);

function decodeLine(raw: Buffer): string {
  const body = raw.length > 0 && raw[raw.length - 1] === 0x0a ? raw.subarray(0, raw.length - 1) : raw;
  return body.toString('utf8');
}

const str = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  (typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {});

/** A nax LogEntry, or null when the line is not a JSON object with a known level. */
function parseLogEntry(text: string): ParsedEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!isLogLevel(o['level'])) return null;
  return {
    level: o['level'],
    ...str('timestamp', o['timestamp']),
    ...str('stage', o['stage']),
    ...str('storyId', o['storyId']),
    ...str('sessionRole', o['sessionRole']),
    ...str('message', o['message']),
    ...('data' in o ? { data: o['data'] } : {}),
  };
}

function matches(e: ParsedEntry, f: LogFilter): boolean {
  if (f.level && (RANK.get(e.level) ?? 0) < (RANK.get(f.level) ?? 0)) return false;
  if (f.storyId !== undefined && e.storyId !== f.storyId) return false;
  if (f.stage !== undefined && e.stage !== f.stage) return false;
  if (f.role !== undefined && e.sessionRole !== f.role) return false;
  return true;
}

/** Spec §3.3 (D339, D340): the entry for one span, or null when the filter rejects it. `raw` is the span's bytes. */
export function toEntry(stream: LogStreamName, span: LineSpan, raw: Buffer, f: LogFilter): LogEntryView | null {
  const text = decodeLine(raw);
  if (f.q && !text.toLowerCase().includes(f.q.toLowerCase())) return null;
  const base = { offset: span.start, length: span.end - span.start, ...(span.cut ? { truncatedLine: true as const } : {}) };
  if (stream !== 'run') return { ...base, text };
  const parsed = span.cut ? null : parseLogEntry(text);
  if (!parsed) return hasStructuredFilter(f) ? null : { ...base, unparsed: true, text };
  return matches(parsed, f) ? { ...base, ...parsed } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-entry.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-entry.ts apps/api/src/fleet/logs/log-entry.spec.ts
git commit -m "feat(fleet): parse nax log lines and apply level/story/stage/role/q filters (S2a 1c D339-D340)"
```

---

### Task 4: `LogReadService` — list, entries, raw, download

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/fleet.config.spec.ts`,
  `apps/api/src/config/env.validation.ts`, `apps/api/src/common/test-helpers/fleet-config.ts`, `apps/api/.env.example`
- Modify: `apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts`, `apps/api/src/fleet/logs/prisma-fleet-job-log.repository.ts`,
  `apps/api/src/fleet/logs/test-helpers/memory-log-repo.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Create: `apps/api/src/fleet/logs/log-read.exceptions.ts`, `apps/api/src/fleet/logs/log-read.service.ts`
- Test: `apps/api/src/fleet/logs/log-read.service.spec.ts`, `apps/api/src/config/fleet.config.spec.ts`

**Interfaces:**
- Consumes: `forwardReadRange`, `forwardSpans`, `backwardReadRange`, `backwardSpans`, `visibleEnd`, `ScanOptions`,
  `SpanWindow` (Task 2); `toEntry`, `LogEntryView`, `LogFilter` (Task 3); `LogStore`, `logKey`, `LOG_STORE`;
  `IFleetJobRepository.findById`; `MemoryLogRepo`.
- Produces:
  - `IFleetConfig.logScanBytes: number` (`FLEET_LOG_SCAN_BYTES`, default 2 MiB)
  - `IFleetJobLogRepository.listForJob(jobId): Promise<FleetJobLogRecord[]>` (latest epoch first) and
    `findLogEventEpochs(jobId): Promise<number[]>` (latest first); `MemoryLogRepo.setEventEpochs(jobId, epochs)`
  - `FleetLogExpiredException` (410 `fleet.logExpired`)
  - `RAW_MAX_BYTES = 1048576`; `interface EntriesParams extends LogFilter { leaseEpoch?; cursor?; direction:
    'forward' | 'backward'; limit }`; `interface EntriesPage { entries; nextCursor; scannedFrom; scannedTo; atEnd;
    size; complete; truncated }`; `LogStreamSummary`, `LogAttemptSummary`, `LogDownload { jobId; leaseEpoch; stream;
    sizeBytes; body: Readable }`
  - `LogReadService.list(projectId, jobId): Promise<{ attempts: LogAttemptSummary[] }>`,
    `entries(projectId, jobId, streamRaw, p: EntriesParams): Promise<EntriesPage>`,
    `raw(projectId, jobId, streamRaw, q: { leaseEpoch?; from?; to? }): Promise<Buffer>`,
    `download(projectId, jobId, streamRaw, leaseEpoch?): Promise<LogDownload>`

- [ ] **Step 1: Config key `FLEET_LOG_SCAN_BYTES`**

In `fleet.config.spec.ts`, test `'defaults the slice 2 settings outside tests'`: add `'FLEET_LOG_SCAN_BYTES'` to the
deleted keys (after `'FLEET_LOG_RUNNER_BYTES_PER_SEC'`) and `logScanBytes: 2097152,` to the expected object. In the
`refuses boot on a bad slice 2 value` table add `['FLEET_LOG_SCAN_BYTES', '1024'],`.

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: FAIL (`logScanBytes` missing; `1024` accepted).

`fleet.config.ts` — interface, after `logRunnerBytesPerSec`:

```ts
  /** S2a §3.3 / R11: max bytes one entries request scans. */
  logScanBytes: number;
```

`FleetConfigSchema`, after `FLEET_LOG_RUNNER_BYTES_PER_SEC`:

```ts
  @IsOptional() @IsString() FLEET_LOG_SCAN_BYTES: string;
```

`fleetConfig()`, after `logRunnerBytesPerSec`:

```ts
    logScanBytes: int('FLEET_LOG_SCAN_BYTES', 2 * 1024 * 1024),
```

`env.validation.ts`, before `FLEET_ENROLLMENT_RETENTION_DAYS`:

```ts
  FLEET_LOG_SCAN_BYTES: Joi.number().integer().min(65_536).max(16_777_216).optional(),
```

`common/test-helpers/fleet-config.ts`, after `logRunnerBytesPerSec: 4 * 1024 * 1024,`:

```ts
    logScanBytes: 2 * 1024 * 1024,
```

`apps/api/.env.example`, append:

```bash
# Max bytes one log entries request scans (S2a 1c).
# FLEET_LOG_SCAN_BYTES=2097152
```

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: PASS.

- [ ] **Step 2: Repository reads for the list route**

`domain/fleet-job-log.domain.ts`, in `IFleetJobLogRepository` after `listForAttempt`:

```ts
  /** Every row of the job, latest epoch first (S2a §3.1). */
  listForJob(jobId: string): Promise<FleetJobLogRecord[]>;
  /** Epochs that have `log` timeline events (v1/v2 runners), latest first (S2a §3.1 legacySampled). */
  findLogEventEpochs(jobId: string): Promise<number[]>;
```

`prisma-fleet-job-log.repository.ts`, before `upsertStream`:

```ts
  async listForJob(jobId: string): Promise<FleetJobLogRecord[]> {
    return (await this.db.fleetJobLog.findMany({ where: { jobId }, orderBy: [{ leaseEpoch: 'desc' }, { stream: 'asc' }] })).map(toRecord);
  }

  async findLogEventEpochs(jobId: string): Promise<number[]> {
    const rows = await this.db.fleetJobEvent.findMany({
      where: { jobId, type: 'log' }, distinct: ['leaseEpoch'], select: { leaseEpoch: true }, orderBy: { leaseEpoch: 'desc' },
    });
    return rows.map((r) => r.leaseEpoch);
  }
```

`test-helpers/memory-log-repo.ts`: widen the `implements Pick<...>` list with `'listForJob' | 'findLogEventEpochs'`, add
the field below `rows`, and the methods before `upsertStream`:

```ts
  /** Epochs with `log` events, per job; seed with `setEventEpochs`. */
  eventEpochs: ReadonlyMap<string, readonly number[]> = new Map();
```

```ts
  async listForJob(jobId: string): Promise<FleetJobLogRecord[]> {
    return [...this.rows.values()].filter((r) => r.jobId === jobId).sort((a, b) => b.leaseEpoch - a.leaseEpoch);
  }

  async findLogEventEpochs(jobId: string): Promise<number[]> {
    return [...(this.eventEpochs.get(jobId) ?? [])].sort((a, b) => b - a);
  }

  setEventEpochs(jobId: string, epochs: readonly number[]): void {
    this.eventEpochs = new Map([...this.eventEpochs, [jobId, epochs]]);
  }
```

(The Prisma query is exercised over HTTP in Task 5's integration spec.)

- [ ] **Step 3: Error keys and the 410 exception (D345)**

Append to `apps/api/src/i18n/en/fleet.json` (keep the file's one-key-per-line style):

```json
  "logQuery": { "-2": "Invalid log request: {reason}" },
  "logs": { "404": "No log is stored for this stream or attempt" },
  "logExpired": { "410": "This log was deleted after the retention window" }
```

and to `apps/api/src/i18n/zh/fleet.json`:

```json
  "logQuery": { "-2": "无效的日志请求：{reason}" },
  "logs": { "404": "该日志流或尝试没有存储日志" },
  "logExpired": { "410": "该日志已超过保留期限并被删除" }
```

`apps/api/src/fleet/logs/log-read.exceptions.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';

/** S2a §3 / D345: the stream's files were deleted by retention (§5). */
export class FleetLogExpiredException extends AppException {
  constructor() {
    super(410, {}, 'fleet.logExpired', 410);
  }
}
```

- [ ] **Step 4: Write the failing service tests**

`apps/api/src/fleet/logs/log-read.service.spec.ts`:

```ts
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { LogStreamName } from './domain/fleet-job-log.domain';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { EntriesPage, LogReadService } from './log-read.service';
import { MemoryLogRepo } from './test-helpers/memory-log-repo';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());
const line = (level: string, message: string, extra: object = {}) => `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level, stage: 'run', message, ...extra })}\n`;

describe('LogReadService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-log-read-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  let job: { id: string; projectId: string; leaseEpoch: number };
  let logs: MemoryLogRepo;
  let n = 0;
  const jobs = { findById: jest.fn(async (id: string) => (id === job.id ? job : null)) };
  const svc = (scanBytes = 1024) => new LogReadService(jobs as never, logs as never, store, { logScanBytes: scanBytes });
  const write = (stream: LogStreamName, text: string, epoch = 1) => {
    const path = join(root, logKey(job.id, epoch, stream));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const forward = (s: LogReadService, over: Partial<Parameters<LogReadService['entries']>[3]> = {}, stream = 'run') =>
    s.entries('p1', job.id, stream, { direction: 'forward', limit: 200, ...over });
  const backward = (s: LogReadService, over: Partial<Parameters<LogReadService['entries']>[3]> = {}, stream = 'run') =>
    s.entries('p1', job.id, stream, { direction: 'backward', limit: 200, ...over });

  beforeEach(() => {
    n += 1;
    job = { id: `job${n}`, projectId: 'p1', leaseEpoch: 2 };
    logs = new MemoryLogRepo();
  });

  it('lists attempts latest first with streams in run/stdout/stderr order and legacySampled (spec §3.1)', async () => {
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'stdout', sizeBytes: 5, complete: true });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 9, source: 'bundle', expiredAt: new Date(1) });
    logs.setEventEpochs(job.id, [1]);
    const out = await svc().list('p1', job.id);
    expect(out.attempts.map((a) => [a.leaseEpoch, a.legacySampled, a.streams.map((s) => s.stream)])).toEqual([[2, false, ['run', 'stdout']], [1, true, []]]);
    expect(out.attempts[0].streams[0]).toEqual({ stream: 'run', sizeBytes: 9, complete: false, truncated: false, source: 'bundle', expired: true, updatedAt: new Date(0).toISOString() });
    await expect(statusOf(svc().list('other-project', job.id))).resolves.toBe(404);
  });

  it('reads forward from 0 by default at the job epoch and parses run lines', async () => {
    write('run', line('info', 'a') + line('warn', 'b') + 'partial', 2);
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 999 });
    const page = await forward(svc());
    expect(page.entries.map((e) => e.message)).toEqual(['a', 'b']);
    const end = page.entries[1].offset + page.entries[1].length;
    expect(page).toMatchObject({ nextCursor: end, scannedFrom: 0, scannedTo: end, atEnd: true, complete: false, truncated: false });
    expect(page.size).toBe(end + 'partial'.length);
    expect((await forward(svc(), { level: 'warn' })).entries.map((e) => e.message)).toEqual(['b']);
  });

  it('keeps a growing stream consistent: partial line hidden until complete, atEnd at the last complete line (Review Focus 2)', async () => {
    write('run', 'l1\nl2\npar', 2);
    const back = await backward(svc(), {}, 'stdout');
    expect(back.entries).toEqual([]); // stdout has no file: an empty page (D332)
    const b = await backward(svc());
    expect(b.entries.map((e) => e.text)).toEqual(['l1', 'l2']);
    expect(b).toMatchObject({ nextCursor: 0, atEnd: true, scannedTo: 6 });
    const f1 = await forward(svc());
    expect(f1).toMatchObject({ nextCursor: 6, atEnd: true });
    appendFileSync(join(root, logKey(job.id, 2, 'run')), 'tial\nl4');
    const f2 = await forward(svc(), { cursor: 6 });
    expect(f2.entries.map((e) => e.text)).toEqual(['partial']);
    expect(f2).toMatchObject({ nextCursor: 14, atEnd: true, complete: false });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: 16, complete: true });
    const f3 = await forward(svc(), { cursor: 14 });
    expect(f3.entries.map((e) => e.text)).toEqual(['l4']);
    expect(f3).toMatchObject({ nextCursor: 16, atEnd: true, complete: true });
    expect((await backward(svc())).entries.map((e) => e.text)).toEqual(['l1', 'l2', 'partial', 'l4']);
  });

  it('pages forward through an overlong line without losing or repeating a byte (Review Focus 1)', async () => {
    const text = `${line('info', 'before')}${'x'.repeat(40)}\n${line('info', 'after')}`;
    write('run', text, 2);
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'run', sizeBytes: text.length, complete: true });
    const pieces: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 50; i += 1) {
      const page: EntriesPage = await forward(svc(16), { cursor });
      pieces.push(...page.entries.map((e) => text.slice(e.offset, e.offset + e.length)));
      if (page.atEnd) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
    }
    expect(pieces.join('')).toBe(text);
  });

  it('scans at most logScanBytes per filtered request and always moves the cursor (Review Focus 3)', async () => {
    const text = Array.from({ length: 20 }, (_, i) => line('info', `m${i}`)).join('');
    write('run', text, 2);
    let cursor = 0;
    let requests = 0;
    for (;;) {
      const page = await forward(svc(128), { cursor, q: 'never-there' });
      requests += 1;
      expect(page.entries).toEqual([]);
      expect(page.scannedTo - page.scannedFrom).toBeLessThanOrEqual(128);
      if (page.atEnd) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
    }
    expect(requests).toBeGreaterThan(text.length / 128);
    expect(requests).toBeLessThan(text.length / 20);
  });

  it('stops at the limit: forward resumes after the last entry, backward keeps the newest lines', async () => {
    write('stdout', 'a\nb\nc\nd\n', 2);
    const f = await forward(svc(), { limit: 2 }, 'stdout');
    expect(f.entries.map((e) => e.text)).toEqual(['a', 'b']);
    expect(f).toMatchObject({ nextCursor: 4, scannedTo: 4, atEnd: false });
    const b = await backward(svc(), { limit: 2 }, 'stdout');
    expect(b.entries.map((e) => e.text)).toEqual(['c', 'd']);
    expect(b).toMatchObject({ nextCursor: 4, scannedFrom: 4, atEnd: false });
    expect((await backward(svc(), { cursor: 4 }, 'stdout')).entries.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('answers an empty page for a stream not uploaded yet, 404 past the job epoch, 410 when expired, 400 for a bad stream', async () => {
    expect(await forward(svc(), {}, 'stderr')).toEqual({ entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false });
    await expect(statusOf(forward(svc(), { leaseEpoch: 3 }))).resolves.toBe(404);
    logs.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', expiredAt: new Date() });
    await expect(statusOf(forward(svc(), { leaseEpoch: 1 }))).resolves.toBe(410);
    await expect(statusOf(forward(svc(), {}, 'prompt'))).resolves.toBe(400);
    await expect(statusOf(svc().entries('p1', 'nope', 'run', { direction: 'forward', limit: 1 }))).resolves.toBe(404);
  });

  it('serves raw ranges clamped to the size and refuses more than 1 MiB', async () => {
    write('stderr', 'hello world', 2);
    expect((await svc().raw('p1', job.id, 'stderr', { from: 6 })).toString()).toBe('world');
    expect((await svc().raw('p1', job.id, 'stderr', { from: 0, to: 5 })).toString()).toBe('hello');
    await expect(statusOf(svc().raw('p1', job.id, 'stderr', { from: 0, to: 1024 * 1024 + 1 }))).resolves.toBe(400);
    await expect(statusOf(svc().raw('p1', job.id, 'stderr', { from: 9, to: 3 }))).resolves.toBe(400);
  });

  it('downloads the whole stream; empty when a row exists without bytes; 404 when neither exists', async () => {
    write('stdout', 'abc\n', 2);
    const d = await svc().download('p1', job.id, 'stdout');
    const chunks: Buffer[] = [];
    for await (const c of d.body) chunks.push(Buffer.from(c));
    expect({ ...d, body: Buffer.concat(chunks).toString() }).toEqual({ jobId: job.id, leaseEpoch: 2, stream: 'stdout', sizeBytes: 4, body: 'abc\n' });
    logs.set({ jobId: job.id, leaseEpoch: 2, stream: 'stderr', complete: true });
    expect((await svc().download('p1', job.id, 'stderr')).sizeBytes).toBe(0);
    await expect(statusOf(svc().download('p1', job.id, 'run'))).resolves.toBe(404);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-read.service.spec.ts`
Expected: FAIL — `Cannot find module './log-read.service'`.

- [ ] **Step 6: Implement**

`apps/api/src/fleet/logs/log-read.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Readable } from 'stream';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import {
  FLEET_JOB_LOG_REPOSITORY, FleetJobLogRecord, IFleetJobLogRepository, isLogStream, LOG_STREAMS, LogSource, LogStreamName,
} from './domain/fleet-job-log.domain';
import { LogEntryView, LogFilter, toEntry } from './log-entry';
import { backwardReadRange, backwardSpans, forwardReadRange, forwardSpans, ScanOptions, SpanWindow, visibleEnd } from './log-lines';
import { FleetLogExpiredException } from './log-read.exceptions';
import { LOG_STORE, LogStore, logKey } from './log-store';

/** Spec §3.2: max bytes of one raw range request. */
export const RAW_MAX_BYTES = 1024 * 1024;
/** D334: yield to the event loop after this many processed bytes. */
const YIELD_BYTES = 256 * 1024;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface EntriesParams extends LogFilter {
  leaseEpoch?: number;
  cursor?: number;
  direction: 'forward' | 'backward';
  limit: number;
}

export interface EntriesPage {
  entries: LogEntryView[];
  nextCursor: number;
  scannedFrom: number;
  scannedTo: number;
  atEnd: boolean;
  size: number;
  complete: boolean;
  truncated: boolean;
}

export interface LogStreamSummary {
  stream: LogStreamName;
  sizeBytes: number;
  complete: boolean;
  truncated: boolean;
  source: LogSource;
  expired: boolean;
  updatedAt: string;
}

export interface LogAttemptSummary {
  leaseEpoch: number;
  legacySampled: boolean;
  streams: LogStreamSummary[];
}

export interface LogDownload {
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  sizeBytes: number;
  body: Readable;
}

interface Target {
  job: FleetJobRecord;
  stream: LogStreamName;
  leaseEpoch: number;
  key: string;
  row: FleetJobLogRecord | null;
}

interface ScannedWindow extends SpanWindow {
  buf: Buffer;
  bufStart: number;
}

const summary = (r: FleetJobLogRecord): LogStreamSummary => ({
  stream: r.stream, sizeBytes: r.sizeBytes, complete: r.complete, truncated: r.truncated, source: r.source,
  expired: Boolean(r.expiredAt), updatedAt: r.updatedAt.toISOString(),
});

/** Fleet S2a §3: the user read side over LogStore + FleetJobLog. Lock-free (D333). */
@Injectable()
export class LogReadService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: Pick<IFleetJobLogRepository, 'findStream' | 'listForJob' | 'findLogEventEpochs'>,
    @Inject(LOG_STORE) private readonly store: Pick<LogStore, 'size' | 'read' | 'stream'>,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'logScanBytes'>,
  ) {}

  /** Spec §3.1: every attempt with rows or `log` events, latest first. */
  async list(projectId: string, jobId: string): Promise<{ attempts: LogAttemptSummary[] }> {
    await this.job(projectId, jobId);
    const [rows, eventEpochs] = await Promise.all([this.logs.listForJob(jobId), this.logs.findLogEventEpochs(jobId)]);
    const epochs = [...new Set([...rows.map((r) => r.leaseEpoch), ...eventEpochs])].sort((a, b) => b - a);
    const order = (s: LogStreamName): number => LOG_STREAMS.indexOf(s);
    return {
      attempts: epochs.map((leaseEpoch) => {
        const streams = rows.filter((r) => r.leaseEpoch === leaseEpoch).sort((a, b) => order(a.stream) - order(b.stream));
        return { leaseEpoch, legacySampled: streams.length === 0 && eventEpochs.includes(leaseEpoch), streams: streams.map(summary) };
      }),
    };
  }

  /** Spec §3.3 (D332-D340). */
  async entries(projectId: string, jobId: string, streamRaw: string, p: EntriesParams): Promise<EntriesPage> {
    const t = await this.target(projectId, jobId, streamRaw, p.leaseEpoch);
    const size = await this.store.size(t.key);
    const complete = t.row?.complete === true;
    const truncated = t.row?.truncated === true;
    const scan = { size, complete, scanBytes: this.cfg.logScanBytes };
    const page = p.direction === 'backward'
      ? await this.pickBackward(t.stream, await this.backwardWindow(t.key, { ...scan, cursor: p.cursor ?? (await this.visibleEndOf(t.key, size, complete)) }), p)
      : await this.pickForward(t.stream, await this.forwardWindow(t.key, { ...scan, cursor: p.cursor ?? 0 }), p);
    return { ...page, size, complete, truncated };
  }

  /** Spec §3.2: `[from, to)` clamped to the size, at most RAW_MAX_BYTES. */
  async raw(projectId: string, jobId: string, streamRaw: string, q: { leaseEpoch?: number; from?: number; to?: number }): Promise<Buffer> {
    const t = await this.target(projectId, jobId, streamRaw, q.leaseEpoch);
    const from = q.from ?? 0;
    const to = q.to ?? from + RAW_MAX_BYTES;
    if (to < from || to - from > RAW_MAX_BYTES) {
      throw new ValidationAppException({ reason: `to - from must be between 0 and ${RAW_MAX_BYTES}` }, 'fleet.logQuery');
    }
    return this.store.read(t.key, from, to);
  }

  /** Spec §3.2 `download=1`: the whole stream. 404 when there is no row and no byte (D332). */
  async download(projectId: string, jobId: string, streamRaw: string, leaseEpoch?: number): Promise<LogDownload> {
    const t = await this.target(projectId, jobId, streamRaw, leaseEpoch);
    const sizeBytes = await this.store.size(t.key);
    const head = { jobId: t.job.id, leaseEpoch: t.leaseEpoch, stream: t.stream, sizeBytes };
    if (sizeBytes === 0) {
      if (!t.row) throw new NotFoundAppException({}, 'fleet.logs');
      return { ...head, body: Readable.from([]) };
    }
    return { ...head, body: await this.store.stream(t.key) };
  }

  private async job(projectId: string, jobId: string): Promise<FleetJobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    return job;
  }

  private async target(projectId: string, jobId: string, streamRaw: string, leaseEpoch: number | undefined): Promise<Target> {
    const job = await this.job(projectId, jobId);
    if (!isLogStream(streamRaw)) throw new ValidationAppException({ reason: 'stream' }, 'fleet.logQuery');
    const epoch = leaseEpoch ?? job.leaseEpoch;
    if (epoch > job.leaseEpoch) throw new NotFoundAppException({}, 'fleet.logs');
    const row = await this.logs.findStream(job.id, epoch, streamRaw);
    if (row?.expiredAt) throw new FleetLogExpiredException();
    return { job, stream: streamRaw, leaseEpoch: epoch, key: logKey(job.id, epoch, streamRaw), row };
  }

  private async visibleEndOf(key: string, size: number, complete: boolean): Promise<number> {
    if (complete) return size;
    const tailStart = Math.max(0, size - this.cfg.logScanBytes);
    return visibleEnd(await this.store.read(key, tailStart, size), tailStart, size, complete);
  }

  private async forwardWindow(key: string, o: ScanOptions): Promise<ScannedWindow> {
    const r = forwardReadRange(o);
    const buf = await this.store.read(key, r.from, r.to);
    return { ...forwardSpans(buf, r.from, o), buf, bufStart: r.from };
  }

  private async backwardWindow(key: string, o: ScanOptions): Promise<ScannedWindow> {
    const r = backwardReadRange(o);
    const buf = await this.store.read(key, r.from, r.to);
    return { ...backwardSpans(buf, r.from, o), buf, bufStart: r.from };
  }

  private async pickForward(stream: LogStreamName, w: ScannedWindow, p: EntriesParams): Promise<Omit<EntriesPage, 'size' | 'complete' | 'truncated'>> {
    const entries: LogEntryView[] = [];
    let stoppedAt: number | null = null;
    let sinceYield = 0;
    for (const span of w.spans) {
      const entry = toEntry(stream, span, w.buf.subarray(span.start - w.bufStart, span.end - w.bufStart), p);
      if (entry) entries.push(entry);
      sinceYield += span.end - span.start;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await nextTurn();
      }
      if (entries.length === p.limit) {
        stoppedAt = span.end;
        break;
      }
    }
    const nextCursor = stoppedAt ?? w.linesEnd;
    return { entries, nextCursor, scannedFrom: w.linesStart, scannedTo: nextCursor, atEnd: w.reachedEnd && nextCursor === w.linesEnd };
  }

  private async pickBackward(stream: LogStreamName, w: ScannedWindow, p: EntriesParams): Promise<Omit<EntriesPage, 'size' | 'complete' | 'truncated'>> {
    const newestFirst: LogEntryView[] = [];
    let stoppedAt: number | null = null;
    let sinceYield = 0;
    for (const span of [...w.spans].reverse()) {
      const entry = toEntry(stream, span, w.buf.subarray(span.start - w.bufStart, span.end - w.bufStart), p);
      if (entry) newestFirst.push(entry);
      sinceYield += span.end - span.start;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await nextTurn();
      }
      if (newestFirst.length === p.limit) {
        stoppedAt = span.start;
        break;
      }
    }
    const nextCursor = stoppedAt ?? w.linesStart;
    return { entries: [...newestFirst].reverse(), nextCursor, scannedFrom: nextCursor, scannedTo: w.linesEnd, atEnd: nextCursor === 0 };
  }
}
```

Notes for the implementer:
- `entries` reads the size from the file (`store.size`), never from the row (D333); `complete`/`truncated` come from
  the row.
- Backward without a cursor starts at `visibleEndOf` (D338); `p.cursor ?? (await ...)` only reads the tail when the
  cursor is absent.
- `pickForward` / `pickBackward` are where `limit` stops the scan and where `nextCursor`, `scannedFrom`, `scannedTo`
  and `atEnd` are derived (D335). Backward walks spans newest first so a limit keeps the lines nearest the cursor, then
  returns them ascending.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-read.service.spec.ts src/fleet/logs src/config`
Expected: PASS (9 new tests; the existing logs and config suites stay green).

- [ ] **Step 8: Commit**

```bash
cd apps/api && bunx eslint src/fleet/logs src/config src/common/test-helpers --max-warnings=0 && cd ../..
git add apps/api/src/config apps/api/src/common/test-helpers/fleet-config.ts apps/api/.env.example apps/api/src/i18n apps/api/src/fleet/logs
git commit -m "feat(fleet): log read service with bounded forward/backward scans, raw ranges and downloads (S2a 1c §3)"
```

---

### Task 5: Read routes, DTOs, throttle, module wiring and HTTP integration

**Files:**
- Create: `apps/api/src/fleet/logs/dto/fleet-job-log.dto.ts`, `apps/api/src/fleet/logs/dto/log-entries.query.ts`,
  `apps/api/src/fleet/logs/dto/log-raw.query.ts`, `apps/api/src/fleet/logs/fleet-job-logs.controller.ts`
- Modify: `apps/api/src/fleet/logs/logs.module.ts`, `apps/api/src/fleet/fleet.module.spec.ts`,
  `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Test: `apps/api/src/fleet/logs/fleet-job-logs.controller.spec.ts`,
  `apps/api/test/integration/fleet/fleet-log-read.integration.spec.ts`
- Regenerate: `openapi.json`

**Interfaces:**
- Consumes: `LogReadService` (Task 4); `LOG_LEVELS`, `LogLevel` (Task 3); `LOG_STREAMS`; `parseQuery`
  (`common/dto/koda-page.query.ts`); `ProjectMembershipGuard`, `CurrentProject`, `isUserPrincipal`.
- Produces: routes `GET /projects/:slug/fleet/jobs/:id/logs`, `GET .../logs/:stream/entries`,
  `GET .../logs/:stream/raw`; OpenAPI operations `FleetJobLogsController_list|entries|raw` (generated CLI functions
  `fleetJobLogsControllerList`, `fleetJobLogsControllerEntries`, `fleetJobLogsControllerRaw`); schemas
  `FleetJobLogListDto`, `FleetJobLogAttemptDto`, `FleetJobLogStreamDto`, `FleetJobLogEntriesDto`,
  `FleetJobLogEntryDto`; `ENTRIES_DEFAULT_LIMIT = 200`, `ENTRIES_MAX_LIMIT = 500`.

- [ ] **Step 1: Write the failing controller unit test**

`apps/api/src/fleet/logs/fleet-job-logs.controller.spec.ts`:

```ts
import { FleetJobLogsController } from './fleet-job-logs.controller';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('FleetJobLogsController', () => {
  const reads = { list: jest.fn(async () => ({ attempts: [] })), entries: jest.fn(), raw: jest.fn(), download: jest.fn() };
  const controller = new FleetJobLogsController(reads as never);
  const ctx = { project: { id: 'p1' } } as never;
  const agent = { actorType: 'agent', id: 'a1' } as never;
  const user = { actorType: 'user', id: 'u1' } as never;

  it('refuses agent principals on every route (R10)', async () => {
    await expect(statusOf(controller.list('j1', ctx, agent))).resolves.toBe(403);
    await expect(statusOf(controller.entries('j1', 'run', {} as never, ctx, agent))).resolves.toBe(403);
    await expect(statusOf(controller.raw('j1', 'run', {} as never, ctx, agent))).resolves.toBe(403);
    expect(reads.list).not.toHaveBeenCalled();
    expect(reads.entries).not.toHaveBeenCalled();
  });

  it('defaults entries to forward with limit 200 and parses numbers', async () => {
    reads.entries.mockResolvedValue({ entries: [] });
    await controller.entries('j1', 'run', { cursor: '12', level: 'warn' } as never, ctx, user);
    expect(reads.entries).toHaveBeenCalledWith('p1', 'j1', 'run', { cursor: 12, level: 'warn', direction: 'forward', limit: 200 });
  });

  it('carries the 600/min read throttle (R10, D331)', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', FleetJobLogsController);
    expect(limit).toBe(600);
  });
});
```

`THROTTLER:LIMITdefault` is the metadata key `@nestjs/throttler` writes for `@Throttle({ default: ... })` on a class.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-job-logs.controller.spec.ts`
Expected: FAIL — `Cannot find module './fleet-job-logs.controller'`.

- [ ] **Step 3: DTOs and queries**

`apps/api/src/fleet/logs/dto/fleet-job-log.dto.ts` (OpenAPI shapes only; the service returns plain objects of the same
shape):

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LOG_STREAMS } from '../domain/fleet-job-log.domain';
import { LOG_LEVELS } from '../log-entry';

/** Spec §3.1: one stored stream of one attempt. */
export class FleetJobLogStreamDto {
  @ApiProperty({ enum: LOG_STREAMS }) declare stream: string;
  @ApiProperty({ description: 'Bytes stored (at most FLEET_LOG_MAX_BYTES)' }) declare sizeBytes: number;
  @ApiProperty({ description: 'final=1 accepted, or filled from the bundle' }) declare complete: boolean;
  @ApiProperty({ description: 'Cut at FLEET_LOG_MAX_BYTES; the full text is in the bundle' }) declare truncated: boolean;
  @ApiProperty({ enum: ['stream', 'bundle'] }) declare source: string;
  @ApiProperty({ description: 'Deleted by retention (spec §5); reads answer 410' }) declare expired: boolean;
  @ApiProperty() declare updatedAt: string;
}

export class FleetJobLogAttemptDto {
  @ApiProperty() declare leaseEpoch: number;
  @ApiProperty({ description: 'The attempt has only sampled `log` timeline events (a v1/v2 runner)' }) declare legacySampled: boolean;
  @ApiProperty({ type: [FleetJobLogStreamDto] }) declare streams: FleetJobLogStreamDto[];
}

export class FleetJobLogListDto {
  @ApiProperty({ type: [FleetJobLogAttemptDto], description: 'Latest attempt first' }) declare attempts: FleetJobLogAttemptDto[];
}

/** Spec §3.3 / D339: a parsed nax LogEntry, an unparsed run line, or a stdout/stderr line. */
export class FleetJobLogEntryDto {
  @ApiProperty({ description: 'Byte offset of the line start' }) declare offset: number;
  @ApiProperty({ description: 'Bytes of the line, including its newline' }) declare length: number;
  @ApiPropertyOptional({ description: 'Run stream: the line is not a nax LogEntry' }) declare unparsed?: boolean;
  @ApiPropertyOptional({ description: 'The entry is a piece of a line (overlong, or read from mid-line)' }) declare truncatedLine?: boolean;
  @ApiPropertyOptional({ description: 'The raw line without its newline (unparsed, stdout, stderr)' }) declare text?: string;
  @ApiPropertyOptional() declare timestamp?: string;
  @ApiPropertyOptional({ enum: LOG_LEVELS }) declare level?: string;
  @ApiPropertyOptional() declare stage?: string;
  @ApiPropertyOptional() declare storyId?: string;
  @ApiPropertyOptional() declare sessionRole?: string;
  @ApiPropertyOptional() declare message?: string;
  @ApiPropertyOptional({ type: Object, description: 'LogEntry.data as nax wrote it' }) declare data?: unknown;
}

export class FleetJobLogEntriesDto {
  @ApiProperty({ type: [FleetJobLogEntryDto], description: 'Ascending by offset in both directions' }) declare entries: FleetJobLogEntryDto[];
  @ApiProperty({ description: 'Cursor for the next request in the same direction' }) declare nextCursor: number;
  @ApiProperty() declare scannedFrom: number;
  @ApiProperty() declare scannedTo: number;
  @ApiProperty({ description: 'Forward: no complete line after nextCursor. Backward: nextCursor is 0' }) declare atEnd: boolean;
  @ApiProperty({ description: 'Bytes stored now' }) declare size: number;
  @ApiProperty() declare complete: boolean;
  @ApiProperty() declare truncated: boolean;
}
```

`apps/api/src/fleet/logs/dto/log-entries.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LOG_LEVELS, LogLevel } from '../log-entry';

export const ENTRIES_DEFAULT_LIMIT = 200;
export const ENTRIES_MAX_LIMIT = 500;

/** Spec §3.3 query. Pass through `parseQuery` for numbers (the global pipe does not transform). */
export class LogEntriesQuery {
  @ApiPropertyOptional({ minimum: 0, description: "Attempt; defaults to the job's current leaseEpoch (D332)" })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) leaseEpoch?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'A nextCursor from an earlier page; forward default 0, backward default the visible end' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor?: number;

  @ApiPropertyOptional({ enum: ['forward', 'backward'], default: 'forward' })
  @IsOptional() @IsIn(['forward', 'backward']) direction?: 'forward' | 'backward';

  @ApiPropertyOptional({ minimum: 1, maximum: ENTRIES_MAX_LIMIT, default: ENTRIES_DEFAULT_LIMIT })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ENTRIES_MAX_LIMIT) limit?: number;

  @ApiPropertyOptional({ enum: LOG_LEVELS, description: 'Minimum level (run stream)' })
  @IsOptional() @IsIn([...LOG_LEVELS]) level?: LogLevel;

  @ApiPropertyOptional({ description: 'Exact story id (run stream)' }) @IsOptional() @IsString() @MaxLength(128) storyId?: string;
  @ApiPropertyOptional({ description: 'Exact stage (run stream)' }) @IsOptional() @IsString() @MaxLength(128) stage?: string;
  @ApiPropertyOptional({ description: 'Exact nax sessionRole (run stream)' }) @IsOptional() @IsString() @MaxLength(128) role?: string;
  @ApiPropertyOptional({ description: 'Case-insensitive substring of the raw line' }) @IsOptional() @IsString() @MaxLength(256) q?: string;
}
```

`apps/api/src/fleet/logs/dto/log-raw.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** Spec §3.2 query. Pass through `parseQuery` for numbers. */
export class LogRawQuery {
  @ApiPropertyOptional({ minimum: 0, description: "Attempt; defaults to the job's current leaseEpoch (D332)" })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) leaseEpoch?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) from?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Exclusive; default from + 1 MiB; to - from at most 1 MiB' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) to?: number;

  @ApiPropertyOptional({ enum: ['1'], description: '1 = the whole stream as an attachment (no range limit)' })
  @IsOptional() @IsIn(['1']) download?: string;
}
```

- [ ] **Step 4: Controller**

`apps/api/src/fleet/logs/fleet-job-logs.controller.ts`:

```ts
import { Controller, Get, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { parseQuery } from '../../common/dto/koda-page.query';
import { isUserPrincipal, KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { FleetJobLogEntriesDto, FleetJobLogListDto } from './dto/fleet-job-log.dto';
import { ENTRIES_DEFAULT_LIMIT, LogEntriesQuery } from './dto/log-entries.query';
import { LogRawQuery } from './dto/log-raw.query';
import { LogReadService } from './log-read.service';

/** R10: logs are for people; agents and runners get 403 like the jobs controller. */
function assertUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
@Throttle({ default: { limit: 600, ttl: 60000 } }) // S2a R10 / D331: per client IP, per route
export class FleetJobLogsController {
  constructor(private readonly reads: LogReadService) {}

  @Get(':id/logs')
  @ApiOperation({ summary: 'Log streams of every attempt of a job, latest first (project member, S2a §3.1)' })
  @ApiResponse({ status: 200, type: FleetJobLogListDto })
  @ApiResponse({ status: 404, description: 'No such job in this project' })
  async list(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    assertUser(principal);
    return JsonResponse.Ok(await this.reads.list(ctx.project.id, id));
  }

  @Get(':id/logs/:stream/entries')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiOperation({ summary: 'One page of log lines, filtered server-side within a bounded scan (project member, S2a §3.3)' })
  @ApiResponse({ status: 200, type: FleetJobLogEntriesDto })
  @ApiResponse({ status: 400, description: 'Invalid stream or query' })
  @ApiResponse({ status: 404, description: 'No such job, or leaseEpoch is past the current attempt of the job' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async entries(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogEntriesQuery,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ) {
    assertUser(principal);
    const q = parseQuery(LogEntriesQuery, rawQuery);
    return JsonResponse.Ok(await this.reads.entries(ctx.project.id, id, stream, {
      ...q, direction: q.direction ?? 'forward', limit: q.limit ?? ENTRIES_DEFAULT_LIMIT,
    }));
  }

  @Get(':id/logs/:stream/raw')
  @ApiParam({ name: 'stream', enum: ['run', 'stdout', 'stderr'] })
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Raw bytes of a log stream: a range of at most 1 MiB, or download=1 for all of it (S2a §3.2)' })
  @ApiResponse({ status: 200, description: 'text/plain; charset=utf-8' })
  @ApiResponse({ status: 400, description: 'Invalid stream or range' })
  @ApiResponse({ status: 404, description: 'No such job or attempt, or nothing stored to download' })
  @ApiResponse({ status: 410, description: 'The stream was deleted by retention' })
  async raw(
    @Param('id') id: string,
    @Param('stream') stream: string,
    @Query() rawQuery: LogRawQuery,
    @CurrentProject() ctx: ProjectContext,
    @Principal() principal: KodaPrincipal,
  ): Promise<StreamableFile> {
    assertUser(principal);
    const q = parseQuery(LogRawQuery, rawQuery);
    if (q.download === '1') {
      const d = await this.reads.download(ctx.project.id, id, stream, q.leaseEpoch);
      return new StreamableFile(d.body, {
        type: 'text/plain; charset=utf-8',
        disposition: `attachment; filename="koda-job-${d.jobId}-${d.leaseEpoch}-${d.stream}.log"`,
        length: d.sizeBytes,
      });
    }
    return new StreamableFile(await this.reads.raw(ctx.project.id, id, stream, q), { type: 'text/plain; charset=utf-8' });
  }
}
```

Errors thrown before the `StreamableFile` is built reach the client as the usual JSON envelope (the
`job-bundle.controller.ts` pattern).

- [ ] **Step 5: Wire the module**

`apps/api/src/fleet/logs/logs.module.ts` becomes (adds `ProjectAccessModule` for the membership guard, the controller
and `LogReadService`):

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { ArtifactStoreModule } from '../artifacts/artifact-store.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { FLEET_JOB_LOG_REPOSITORY } from './domain/fleet-job-log.domain';
import { FleetJobLogsController } from './fleet-job-logs.controller';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LocalDiskLogStore } from './local-disk-log.store';
import { LOG_STORE } from './log-store';
import { LogFallbackService } from './log-fallback.service';
import { LogReadService } from './log-read.service';
import { LogUploadController } from './log-upload.controller';
import { LogUploadService } from './log-upload.service';
import { PrismaFleetJobLogRepository } from './prisma-fleet-job-log.repository';

/** Fleet S2a (spec docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md). */
@Module({
  imports: [PrismaModule, LiveModule, ProjectAccessModule, ArtifactStoreModule, FleetJobsModule, SyncModule],
  controllers: [LogUploadController, FleetJobLogsController],
  providers: [
    LocalDiskLogStore, { provide: LOG_STORE, useExisting: LocalDiskLogStore },
    PrismaFleetJobLogRepository, { provide: FLEET_JOB_LOG_REPOSITORY, useExisting: PrismaFleetJobLogRepository },
    FleetLogLivePublisher, LogUploadService, LogFallbackService, LogReadService,
  ],
  exports: [LOG_STORE, FLEET_JOB_LOG_REPOSITORY, FleetLogLivePublisher, LogFallbackService],
})
export class LogsModule {}
```

`apps/api/src/fleet/fleet.module.spec.ts`: import `LogReadService` from `./logs/log-read.service` and add
`expect(module.get(LogReadService)).toBeDefined();` to `'compiles with its providers resolvable'`.

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-job-logs.controller.spec.ts src/fleet/fleet.module.spec.ts`
Expected: PASS.

- [ ] **Step 6: Write the HTTP integration test**

`apps/api/test/integration/fleet/fleet-log-read.integration.spec.ts`:

```ts
/**
 * Fleet S2a slice 1c — log read routes over HTTP (PG), spec §3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-read.integration.spec.ts
 */
import request from 'supertest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const line = (level: string, message: string, storyId = 'US-001') =>
  `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level, stage: 'run', storyId, message })}\n`;

describeIntegration('fleet log read routes (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let dir: string;
  const saved = process.env.FLEET_ARTIFACT_DIR;

  const job = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'RUNNING', leaseEpoch: 1, ...over,
    },
  });
  const store = (jobId: string, epoch: number, stream: string, text: string) => {
    const path = join(dir, 'logs', jobId, String(epoch), `${stream}.log`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const row = (jobId: string, epoch: number, stream: string, over: Partial<Prisma.FleetJobLogUncheckedCreateInput> = {}) =>
    prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: epoch, stream, sizeBytes: 0n, ...over } });
  const get = (path: string, who: keyof FleetHttpWorld['tokens'] = 'dev') =>
    request(server).get(`/api/projects/web/fleet/jobs/${path}`).set({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-log-read-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = saved;
  });

  it('lists attempts with streams and a legacy sampled attempt; members only', async () => {
    const j = await job('list', { leaseEpoch: 2 });
    await row(j.id, 2, 'stdout', { sizeBytes: 3n, complete: true });
    await row(j.id, 2, 'run', { sizeBytes: 9n });
    await prisma.fleetJobEvent.create({ data: { jobId: j.id, seq: 1, leaseEpoch: 1, runnerSeq: 1, type: 'log', payload: { stream: 'run', text: 'x' } } });
    const out = data<{ attempts: Array<{ leaseEpoch: number; legacySampled: boolean; streams: Array<{ stream: string; sizeBytes: number }> }> }>(await get(`${j.id}/logs`).expect(200));
    expect(out.attempts.map((a) => [a.leaseEpoch, a.legacySampled, a.streams.map((s) => s.stream)])).toEqual([[2, false, ['run', 'stdout']], [1, true, []]]);
    expect(out.attempts[0].streams[0].sizeBytes).toBe(9);
    await get(`${j.id}/logs`, 'viewer').expect(200);
    await get(`${j.id}/logs`, 'outsider').expect(403);
    await get('nope/logs').expect(404);
  });

  it('pages entries forward and backward with filters at the job epoch by default', async () => {
    const j = await job('entries', { leaseEpoch: 3 });
    store(j.id, 3, 'run', line('info', 'one') + line('error', 'two', 'US-002') + line('warn', 'three') + 'partial');
    await row(j.id, 3, 'run', { sizeBytes: 999n });
    const all = data<{ entries: Array<{ message: string }>; atEnd: boolean; complete: boolean }>(await get(`${j.id}/logs/run/entries`).expect(200));
    expect(all.entries.map((e) => e.message)).toEqual(['one', 'two', 'three']);
    expect(all).toMatchObject({ atEnd: true, complete: false });
    const warn = data<{ entries: Array<{ message: string }> }>(await get(`${j.id}/logs/run/entries?level=warn&storyId=US-001`).expect(200));
    expect(warn.entries.map((e) => e.message)).toEqual(['three']);
    const last = data<{ entries: Array<{ message: string }>; nextCursor: number }>(await get(`${j.id}/logs/run/entries?direction=backward&limit=1`).expect(200));
    expect(last.entries.map((e) => e.message)).toEqual(['three']);
    const before = data<{ entries: Array<{ message: string }> }>(await get(`${j.id}/logs/run/entries?direction=backward&cursor=${last.nextCursor}&q=TWO`).expect(200));
    expect(before.entries.map((e) => e.message)).toEqual(['two']);
    await get(`${j.id}/logs/run/entries?limit=501`).expect(400);
    await get(`${j.id}/logs/run/entries?direction=sideways`).expect(400);
    await get(`${j.id}/logs/prompt/entries`).expect(400);
    await get(`${j.id}/logs/run/entries?leaseEpoch=4`).expect(404);
  });

  it('answers 410 for an expired stream', async () => {
    const j = await job('expired', { state: 'COMPLETED' });
    await row(j.id, 1, 'run', { sizeBytes: 5n, complete: true, expiredAt: new Date() });
    await get(`${j.id}/logs/run/entries`).expect(410);
    await get(`${j.id}/logs/run/raw`).expect(410);
    const out = data<{ attempts: Array<{ streams: Array<{ expired: boolean }> }> }>(await get(`${j.id}/logs`).expect(200));
    expect(out.attempts[0].streams[0].expired).toBe(true);
  });

  it('serves raw ranges as text/plain and downloads the whole stream as an attachment', async () => {
    const j = await job('raw');
    store(j.id, 1, 'stderr', 'hello world\n');
    await row(j.id, 1, 'stderr', { sizeBytes: 12n });
    const range = await get(`${j.id}/logs/stderr/raw?from=6&to=11`).expect(200);
    expect(range.headers['content-type']).toMatch(/^text\/plain/);
    expect(range.text).toBe('world');
    const whole = await get(`${j.id}/logs/stderr/raw?download=1`).expect(200);
    expect(whole.headers['content-disposition']).toBe(`attachment; filename="koda-job-${j.id}-1-stderr.log"`);
    expect(whole.text).toBe('hello world\n');
    await get(`${j.id}/logs/stderr/raw?from=0&to=2000000`).expect(400);
    await get(`${j.id}/logs/stdout/raw?download=1`).expect(404);
  });

  it('allows more than the global 100 requests per minute on the read routes (R10)', async () => {
    const j = await job('throttle');
    for (let i = 0; i < 130; i += 1) await get(`${j.id}/logs/run/entries`).expect(200);
  });
});
```

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-log-read.integration.spec.ts`
Expected: PASS (5 tests). The 130-request loop proves the controller-level limit replaced the global 100/min.

- [ ] **Step 7: Regenerate the contract and pin it**

Run (repo root): `bun run generate`
Expected: `openapi.json` gains the three `GET /api/projects/{slug}/fleet/jobs/{id}/logs...` operations and the five
`FleetJobLog*Dto` schemas; `apps/cli/src/generated/sdk.gen.ts` (gitignored) gains `fleetJobLogsControllerList`,
`fleetJobLogsControllerEntries`, `fleetJobLogsControllerRaw`.

Append to `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, inside the `describe`:

```ts
  it('exposes the log read routes and their schemas (S2a §3)', () => {
    const base = '/api/projects/{slug}/fleet/jobs/{id}/logs';
    expect(spec.paths[base]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{stream}/entries`]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{stream}/raw`]?.['get']).toBeDefined();
    expect((spec.paths[`${base}/{stream}/entries`]?.['get']?.parameters ?? []).map((p) => p.name))
      .toEqual(expect.arrayContaining(['slug', 'id', 'stream', 'leaseEpoch', 'cursor', 'direction', 'limit', 'level', 'storyId', 'stage', 'role', 'q']));
    expect(Object.keys(spec.components.schemas['FleetJobLogEntriesDto']?.properties ?? {}).sort())
      .toEqual(['atEnd', 'complete', 'entries', 'nextCursor', 'scannedFrom', 'scannedTo', 'size', 'truncated']);
    expect(Object.keys(spec.components.schemas['FleetJobLogStreamDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['stream', 'sizeBytes', 'complete', 'truncated', 'source', 'expired', 'updatedAt']));
  });
```

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS (it fails if `openapi.json` was not regenerated).

- [ ] **Step 8: Commit**

```bash
cd apps/api && bun run lint && bun run type-check && cd ../..
git add apps/api/src/fleet/logs apps/api/src/fleet/fleet.module.spec.ts apps/api/src/fleet/fleet-openapi.contract.spec.ts apps/api/test/integration/fleet/fleet-log-read.integration.spec.ts openapi.json
git commit -m "feat(fleet): log list, entries and raw routes for project members, 600/min (S2a 1c §3, R10)"
```

---

### Task 6: Expired bundles answer 410; `findLatestArtifact` skips them (D341)

**Files:**
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetArtifactRecord`, `IFleetJobRepository`)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:268-282`
- Modify: `apps/api/src/fleet/artifacts/bundle.exceptions.ts`, `apps/api/src/fleet/artifacts/bundle.service.ts:109-115`,
  `apps/api/src/fleet/artifacts/job-bundle.controller.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json` (`bundle`)
- Test: `apps/api/src/fleet/artifacts/bundle.service.spec.ts` (new)

**Interfaces:**
- Consumes: `FleetJobArtifact.expiredAt` (column from slice 1a).
- Produces: `FleetArtifactRecord.expiredAt: Date | null`;
  `findLatestArtifact(jobId, kind, opts?: { includeExpired?: boolean })`; `FleetBundleException(410)`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/fleet/artifacts/bundle.service.spec.ts`:

```ts
import { Readable } from 'stream';
import { BundleService } from './bundle.service';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('BundleService.download (S2a D341)', () => {
  const job = { id: 'j1', projectId: 'p1' };
  const artifact = (leaseEpoch: number, expiredAt: Date | null) => ({ id: `a${leaseEpoch}`, jobId: 'j1', leaseEpoch, kind: 'bundle', storageKey: `jobs/j1/${leaseEpoch}/x.tar.gz`, sizeBytes: 3n, sha256: 'x', createdAt: new Date(0), expiredAt });
  const repo = { findById: jest.fn(async () => job), findLatestArtifact: jest.fn() };
  const store = { get: jest.fn(async () => Readable.from([Buffer.from('tgz')])) };
  const svc = new BundleService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  afterEach(() => jest.clearAllMocks());

  it('streams the newest unexpired bundle', async () => {
    repo.findLatestArtifact.mockResolvedValueOnce(artifact(2, null));
    await expect(svc.download('p1', 'j1')).resolves.toMatchObject({ leaseEpoch: 2, sizeBytes: 3n });
    expect(repo.findLatestArtifact).toHaveBeenCalledWith('j1', 'bundle');
    expect(store.get).toHaveBeenCalledWith('jobs/j1/2/x.tar.gz');
  });

  it('answers 410 when only an expired bundle exists', async () => {
    repo.findLatestArtifact.mockResolvedValueOnce(null).mockResolvedValueOnce(artifact(1, new Date()));
    await expect(statusOf(svc.download('p1', 'j1'))).resolves.toBe(410);
    expect(repo.findLatestArtifact).toHaveBeenLastCalledWith('j1', 'bundle', { includeExpired: true });
    expect(store.get).not.toHaveBeenCalled();
  });

  it('answers 404 when no bundle was ever uploaded, and for another project', async () => {
    repo.findLatestArtifact.mockResolvedValue(null);
    await expect(statusOf(svc.download('p1', 'j1'))).resolves.toBe(404);
    await expect(statusOf(svc.download('p2', 'j1'))).resolves.toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/artifacts/bundle.service.spec.ts`
Expected: FAIL — the 410 case answers 404 (`findLatestArtifact` is called once).

- [ ] **Step 3: Implement**

`fleet-job.domain.ts`, `FleetArtifactRecord`, after `createdAt: Date;`:

```ts
  /** S2a §5: retention deleted the file; the row stays. */
  expiredAt: Date | null;
```

and in `IFleetJobRepository` replace the three artifact methods with:

```ts
  upsertArtifact(artifact: Omit<FleetArtifactRecord, 'id' | 'createdAt' | 'expiredAt'>): Promise<FleetArtifactRecord>;
  findArtifact(jobId: string, kind: string, leaseEpoch: number): Promise<FleetArtifactRecord | null>;
  /** Newest attempt's artifact; unexpired only unless `includeExpired` (S2a D341). */
  findLatestArtifact(jobId: string, kind: string, opts?: { includeExpired?: boolean }): Promise<FleetArtifactRecord | null>;
```

`prisma-fleet-job.repository.ts`: change the `upsertArtifact` parameter type to
`Omit<FleetArtifactRecord, 'id' | 'createdAt' | 'expiredAt'>` (body unchanged) and replace `findLatestArtifact`:

```ts
  findLatestArtifact(jobId: string, kind: string, opts: { includeExpired?: boolean } = {}): Promise<FleetArtifactRecord | null> {
    return this.db.fleetJobArtifact.findFirst({
      where: { jobId, kind, ...(opts.includeExpired ? {} : { expiredAt: null }) },
      orderBy: { leaseEpoch: 'desc' },
    });
  }
```

`bundle.exceptions.ts`:

```ts
/** 410 expired by retention (S2a D341), 413 too large, 415 not gzip, 422 hash mismatch (spec §3.3). */
export class FleetBundleException extends AppException {
  constructor(status: 410 | 413 | 415 | 422, args: Record<string, unknown> = {}) {
    super(status, args, 'fleet.bundle', status);
  }
}
```

`bundle.service.ts`, in `download`, replace the two lines after `findById`'s check:

```ts
    const artifact = await this.repo.findLatestArtifact(jobId, 'bundle');
    if (!artifact) {
      // S2a D341: a bundle that retention deleted answers 410, never-uploaded answers 404.
      if (await this.repo.findLatestArtifact(jobId, 'bundle', { includeExpired: true })) throw new FleetBundleException(410);
      throw new NotFoundAppException({}, 'fleet.bundle');
    }
```

`job-bundle.controller.ts`, after the 404 `@ApiResponse`:

```ts
  @ApiResponse({ status: 410, description: 'The bundle was deleted by retention (S2a §5)' })
```

i18n: add `"410"` as the last entry of the `bundle` object — en `"410": "The bundle was deleted after the retention
window"`, zh `"410": "该产物包已超过保留期限并被删除"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/artifacts test/integration/fleet/fleet-bundles.integration.spec.ts`
Expected: PASS (the bundle integration suite still serves its bundles: their rows have `expiredAt = null`).

- [ ] **Step 5: Regenerate and commit**

Run (repo root): `bun run generate` — `openapi.json` gains the 410 response on the bundle download.

```bash
cd apps/api && bun run type-check && cd ../..
git add apps/api/src/fleet/jobs apps/api/src/fleet/artifacts apps/api/src/i18n openapi.json
git commit -m "feat(fleet): an expired bundle answers 410; the latest-bundle lookup skips expired rows (S2a 1c D341)"
```

---

### Task 7: Retention — config, repository, processor, integration (spec §5)

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/fleet.config.spec.ts`,
  `apps/api/src/config/env.validation.ts`, `apps/api/src/common/test-helpers/fleet-config.ts`, `apps/api/.env.example`
- Create: `apps/api/src/fleet/logs/domain/log-retention.domain.ts`,
  `apps/api/src/fleet/logs/prisma-log-retention.repository.ts`, `apps/api/src/fleet/logs/fleet-log-retention.processor.ts`
- Modify: `apps/api/src/fleet/logs/logs.module.ts`, `apps/api/src/fleet/fleet.module.spec.ts`
- Test: `apps/api/src/fleet/logs/fleet-log-retention.processor.spec.ts`,
  `apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts`

**Interfaces:**
- Consumes: `LogStore.deletePrefix`, `ArtifactStore.delete`, `IFleetJobRepository.lockById`, `TRANSACTION_MANAGER`,
  `TERMINAL_STATES` (`jobs/job-state.ts`); the 410s of Tasks 5 and 6 (integration).
- Produces: `IFleetConfig.logRetentionDays: number | null`; `LOG_RETENTION_REPOSITORY`, `ILogRetentionRepository`,
  `RetentionCandidate { id; leaseEpoch; finishedAt }`, `RetentionCursor { finishedAt; id }`;
  `RETENTION_BATCH = 200`; `FleetLogRetentionProcessor.scheduledPurge()` (`@Cron('45 4 * * *')`),
  `purge(before: Date, now: Date): Promise<{ expired: number; failed: number }>`,
  `expireJob(c: RetentionCandidate, now: Date): Promise<void>`.

- [ ] **Step 1: Config key `FLEET_LOG_RETENTION_DAYS`**

In `fleet.config.spec.ts`: add `'FLEET_LOG_RETENTION_DAYS'` to the deleted keys of `'defaults the slice 2 settings
outside tests'` and `logRetentionDays: 30,` to its expected object; add `['FLEET_LOG_RETENTION_DAYS', '-1'],` to the
bad-value table; and add this test before `'enables the test hooks only ...'`:

```ts
  it('turns log retention off under NODE_ENV=test unless set; 0 disables (S2a §5)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.FLEET_LOG_RETENTION_DAYS;
    expect(fleetConfig().logRetentionDays).toBeNull();
    process.env.FLEET_LOG_RETENTION_DAYS = '14';
    expect(fleetConfig().logRetentionDays).toBe(14);
    process.env.FLEET_LOG_RETENTION_DAYS = '0';
    expect(fleetConfig().logRetentionDays).toBeNull();
  });
```

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts` — Expected: FAIL.

`fleet.config.ts`: interface, after `logScanBytes`:

```ts
  /** S2a §5: days after a job ends before its logs, bundles and `log` events are deleted; null disables. */
  logRetentionDays: number | null;
```

`FleetConfigSchema`: `@IsOptional() @IsString() FLEET_LOG_RETENTION_DAYS: string;`. Make `retentionDays` take the
key, and use it twice:

```ts
/** Same default rule as OUTBOX_RETENTION_DAYS: 30 outside tests, off in tests, 0 is the kill switch. */
function retentionDays(key: string): number | null {
  const raw = process.env[key];
  if (raw === undefined) return isTest() ? null : 30;
  const days = Number.parseInt(raw, 10);
  return days > 0 ? days : null;
}
```

```ts
    logRetentionDays: retentionDays('FLEET_LOG_RETENTION_DAYS'),
```

```ts
    enrollmentRetentionDays: retentionDays('FLEET_ENROLLMENT_RETENTION_DAYS'),
```

`env.validation.ts`, before `FLEET_ENROLLMENT_RETENTION_DAYS`:

```ts
  FLEET_LOG_RETENTION_DAYS: Joi.number().integer().min(0).max(3_650).optional(),
```

`common/test-helpers/fleet-config.ts`, after `logScanBytes`: `logRetentionDays: null,`.
`apps/api/.env.example`, append:

```bash
# Days after a job ends before its logs, bundles and log events are deleted (0 disables; off under NODE_ENV=test).
# FLEET_LOG_RETENTION_DAYS=30
```

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts` — Expected: PASS.

- [ ] **Step 2: Write the failing processor tests**

`apps/api/src/fleet/logs/fleet-log-retention.processor.spec.ts`:

```ts
import { Reflector } from '@nestjs/core';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { FleetLogRetentionProcessor, RETENTION_BATCH } from './fleet-log-retention.processor';

describe('FleetLogRetentionProcessor (S2a §5)', () => {
  const calls: string[] = [];
  const repo = {
    findCandidates: jest.fn(),
    findBundleKeys: jest.fn(async () => ['jobs/j1/1/a.tar.gz']),
    expireRows: jest.fn(async () => {
      calls.push('rows');
      return { events: 1, logs: 1, artifacts: 1 };
    }),
  };
  const jobs = { lockById: jest.fn(async (id: string): Promise<{ id: string } | null> => {
    calls.push(`lock:${id}`);
    return { id };
  }) };
  const tx = { run: jest.fn((fn: () => unknown) => fn()) };
  const logStore = { deletePrefix: jest.fn(async (p: string) => { calls.push(`rm:${p}`); }) };
  const artifacts = { delete: jest.fn(async (k: string) => { calls.push(`rm:${k}`); }) };
  const make = (days: number | null = 30) =>
    new FleetLogRetentionProcessor(repo as never, jobs as never, tx as never, logStore, artifacts, testFleetConfig({ logRetentionDays: days }));
  const candidate = (id: string, leaseEpoch = 1) => ({ id, leaseEpoch, finishedAt: new Date('2026-08-01T00:00:00.000Z') });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    calls.length = 0;
  });

  it('runs daily at 04:45', () => {
    expect(new Reflector().get('SCHEDULE_CRON_OPTIONS', make().scheduledPurge)).toMatchObject({ cronTime: '45 4 * * *' });
  });

  it('does nothing when retention is disabled', async () => {
    await make(null).scheduledPurge();
    expect(repo.findCandidates).not.toHaveBeenCalled();
  });

  it('selects jobs that ended before now - days', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T04:45:00.000Z'));
    repo.findCandidates.mockResolvedValue([]);
    await make(30).scheduledPurge();
    expect(repo.findCandidates).toHaveBeenCalledWith(new Date('2026-10-01T04:45:00.000Z'), null, RETENTION_BATCH);
  });

  it('deletes files of every epoch <= E and the bundles first, then the rows under the job lock (D343, D344)', async () => {
    await make().expireJob(candidate('j1', 2), new Date(5));
    expect(calls).toEqual(['rm:logs/j1/0/', 'rm:logs/j1/1/', 'rm:logs/j1/2/', 'rm:jobs/j1/1/a.tar.gz', 'lock:j1', 'rows']);
    expect(repo.findBundleKeys).toHaveBeenCalledWith('j1', 2);
    expect(repo.expireRows).toHaveBeenCalledWith('j1', 2, new Date(5));
  });

  it('leaves the rows alone when the job row is gone', async () => {
    jobs.lockById.mockResolvedValueOnce(null);
    await make().expireJob(candidate('j1'), new Date(5));
    expect(repo.expireRows).not.toHaveBeenCalled();
  });

  it('pages by (finishedAt, id) until a short page and skips a failing job (D342)', async () => {
    const full = Array.from({ length: RETENTION_BATCH }, (_, i) => candidate(`a${String(i).padStart(3, '0')}`, 0));
    repo.findCandidates.mockResolvedValueOnce(full).mockResolvedValueOnce([candidate('b1', 0)]);
    logStore.deletePrefix.mockImplementationOnce(async () => { throw new Error('EACCES'); });
    const out = await make().purge(new Date(1), new Date(2));
    expect(out).toEqual({ expired: RETENTION_BATCH, failed: 1 });
    expect(repo.findCandidates).toHaveBeenNthCalledWith(2, new Date(1), { finishedAt: full[RETENTION_BATCH - 1].finishedAt, id: 'a199' }, RETENTION_BATCH);
    expect(repo.findCandidates).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed run (the next night is the retry)', async () => {
    repo.findCandidates.mockRejectedValueOnce(new Error('db down'));
    await expect(make().scheduledPurge()).resolves.toBeUndefined();
  });
});
```

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-log-retention.processor.spec.ts`
Expected: FAIL — `Cannot find module './fleet-log-retention.processor'`.

- [ ] **Step 3: Domain, repository and processor**

`apps/api/src/fleet/logs/domain/log-retention.domain.ts`:

```ts
export const LOG_RETENTION_REPOSITORY = Symbol('LOG_RETENTION_REPOSITORY');

/** A terminal job whose logs are due; `leaseEpoch` is E, recorded at selection (spec §5). */
export interface RetentionCandidate {
  id: string;
  leaseEpoch: number;
  finishedAt: Date;
}

export interface RetentionCursor {
  finishedAt: Date;
  id: string;
}

export interface ILogRetentionRepository {
  /**
   * Plan D342: terminal jobs that finished before `before` and still have an unexpired FleetJobLog or
   * FleetJobArtifact row or any `log` event; ordered (finishedAt, id), strictly after `after`.
   */
  findCandidates(before: Date, after: RetentionCursor | null, limit: number): Promise<RetentionCandidate[]>;
  /** Storage keys of the job's unexpired artifacts with leaseEpoch <= maxEpoch. */
  findBundleKeys(jobId: string, maxEpoch: number): Promise<string[]>;
  /** Plan D344: inside the caller's transaction, under the job row lock. */
  expireRows(jobId: string, maxEpoch: number, now: Date): Promise<{ events: number; logs: number; artifacts: number }>;
}
```

`apps/api/src/fleet/logs/prisma-log-retention.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TERMINAL_STATES } from '../jobs/job-state';
import type { ILogRetentionRepository, RetentionCandidate, RetentionCursor } from './domain/log-retention.domain';

@Injectable()
export class PrismaLogRetentionRepository implements ILogRetentionRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findCandidates(before: Date, after: RetentionCursor | null, limit: number): Promise<RetentionCandidate[]> {
    const rows = await this.db.fleetJob.findMany({
      where: {
        state: { in: [...TERMINAL_STATES] },
        finishedAt: { lt: before },
        OR: [
          { logs: { some: { expiredAt: null } } },
          { artifacts: { some: { expiredAt: null } } },
          { events: { some: { type: 'log' } } },
        ],
        ...(after ? { AND: [{ OR: [{ finishedAt: { gt: after.finishedAt } }, { finishedAt: after.finishedAt, id: { gt: after.id } }] }] } : {}),
      },
      orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, leaseEpoch: true, finishedAt: true },
    });
    return rows.map((r) => ({ id: r.id, leaseEpoch: r.leaseEpoch, finishedAt: r.finishedAt as Date }));
  }

  async findBundleKeys(jobId: string, maxEpoch: number): Promise<string[]> {
    const rows = await this.db.fleetJobArtifact.findMany({
      where: { jobId, leaseEpoch: { lte: maxEpoch }, expiredAt: null }, select: { storageKey: true }, orderBy: { leaseEpoch: 'asc' },
    });
    return rows.map((r) => r.storageKey);
  }

  async expireRows(jobId: string, maxEpoch: number, now: Date): Promise<{ events: number; logs: number; artifacts: number }> {
    const older = { jobId, leaseEpoch: { lte: maxEpoch } };
    const events = await this.db.fleetJobEvent.deleteMany({ where: { ...older, type: 'log' } });
    const logs = await this.db.fleetJobLog.updateMany({ where: { ...older, expiredAt: null }, data: { expiredAt: now } });
    const artifacts = await this.db.fleetJobArtifact.updateMany({ where: { ...older, expiredAt: null }, data: { expiredAt: now } });
    return { events: events.count, logs: logs.count, artifacts: artifacts.count };
  }
}
```

`apps/api/src/fleet/logs/fleet-log-retention.processor.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ILogRetentionRepository, LOG_RETENTION_REPOSITORY, RetentionCandidate, RetentionCursor } from './domain/log-retention.domain';
import { LOG_STORE, LogStore } from './log-store';

const DAY_MS = 86_400_000;
export const RETENTION_BATCH = 200;

/**
 * Fleet S2a §5 (L4): nightly deletion of the logs, bundles and `log` events of jobs that ended more than
 * FLEET_LOG_RETENTION_DAYS ago. Files first, then rows under the job row lock (D343, D344); attempts newer
 * than the epoch seen at selection are never touched. 04:45 follows enrollment retention (04:30).
 */
@Injectable()
export class FleetLogRetentionProcessor {
  private readonly logger = new Logger(FleetLogRetentionProcessor.name);

  constructor(
    @Inject(LOG_RETENTION_REPOSITORY) private readonly repo: ILogRetentionRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById'>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(LOG_STORE) private readonly logStore: Pick<LogStore, 'deletePrefix'>,
    @Inject(ARTIFACT_STORE) private readonly artifacts: Pick<ArtifactStore, 'delete'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'logRetentionDays'>,
  ) {}

  @Cron('45 4 * * *')
  async scheduledPurge(): Promise<void> {
    const days = this.config.logRetentionDays;
    if (days === null || days <= 0) return;
    const now = new Date();
    try {
      const { expired, failed } = await this.purge(new Date(now.getTime() - days * DAY_MS), now);
      this.logger.log(`Expired the logs of ${expired} job(s) that ended more than ${days} day(s) ago; ${failed} failed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Log retention failed, will retry next run: ${message}`);
    }
  }

  /** Every due job, RETENTION_BATCH at a time (D342). One failing job is logged and skipped. */
  async purge(before: Date, now: Date): Promise<{ expired: number; failed: number }> {
    let after: RetentionCursor | null = null;
    let expired = 0;
    let failed = 0;
    for (;;) {
      const batch = await this.repo.findCandidates(before, after, RETENTION_BATCH);
      for (const candidate of batch) {
        try {
          await this.expireJob(candidate, now);
          expired += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Log retention skipped job ${candidate.id}: ${message}`);
        }
      }
      if (batch.length < RETENTION_BATCH) return { expired, failed };
      const last = batch[batch.length - 1];
      after = { finishedAt: last.finishedAt, id: last.id };
    }
  }

  /** Spec §5 per job: files of attempts <= E (D343), then rows under the lock (D344). */
  async expireJob(c: RetentionCandidate, now: Date): Promise<void> {
    for (let epoch = 0; epoch <= c.leaseEpoch; epoch += 1) {
      await this.logStore.deletePrefix(`logs/${c.id}/${epoch}/`);
    }
    for (const key of await this.repo.findBundleKeys(c.id, c.leaseEpoch)) {
      await this.artifacts.delete(key);
    }
    await this.txManager.run(async () => {
      if (!(await this.jobs.lockById(c.id))) return;
      await this.repo.expireRows(c.id, c.leaseEpoch, now);
    });
  }
}
```

`logs.module.ts`: import `LOG_RETENTION_REPOSITORY` from `./domain/log-retention.domain`,
`FleetLogRetentionProcessor` from `./fleet-log-retention.processor` and `PrismaLogRetentionRepository` from
`./prisma-log-retention.repository`; the providers become:

```ts
  providers: [
    LocalDiskLogStore, { provide: LOG_STORE, useExisting: LocalDiskLogStore },
    PrismaFleetJobLogRepository, { provide: FLEET_JOB_LOG_REPOSITORY, useExisting: PrismaFleetJobLogRepository },
    PrismaLogRetentionRepository, { provide: LOG_RETENTION_REPOSITORY, useExisting: PrismaLogRetentionRepository },
    FleetLogLivePublisher, LogUploadService, LogFallbackService, LogReadService, FleetLogRetentionProcessor,
  ],
```

`fleet.module.spec.ts`: import `FleetLogRetentionProcessor` and add
`expect(module.get(FleetLogRetentionProcessor)).toBeDefined();`.

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-log-retention.processor.spec.ts src/fleet/fleet.module.spec.ts`
Expected: PASS (7 + 1 tests).

- [ ] **Step 4: Write the integration test**

`apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts`:

```ts
/**
 * Fleet S2a slice 1c — log retention (PG), spec §5, plus the expired-bundle 410 (D341).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-retention.integration.spec.ts
 */
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetLogRetentionProcessor } from '../../../src/fleet/logs/fleet-log-retention.processor';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DAY = 86_400_000;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_LOG_RETENTION_DAYS'] as const;

describeIntegration('fleet log retention (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let retention: FleetLogRetentionProcessor;
  let dir: string;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};
  const now = new Date();
  const before = new Date(now.getTime() - 30 * DAY);

  const job = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput>) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      finishedAt: new Date(now.getTime() - 40 * DAY), ...over,
    },
  });
  const file = (...parts: string[]) => join(dir, ...parts);
  const put = (path: string, text = 'x\n') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  /** One attempt's run log file + row, a bundle file + row, a log event and a state event. */
  const attempt = async (jobId: string, epoch: number) => {
    put(file('logs', jobId, String(epoch), 'run.log'));
    await prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: epoch, stream: 'run', sizeBytes: 2n, complete: true } });
    const key = `jobs/${jobId}/${epoch}/b.tar.gz`;
    put(file(key));
    await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: epoch, kind: 'bundle', storageKey: key, sizeBytes: 2n, sha256: 'x' } });
    for (const type of ['log', 'state']) {
      seq += 1;
      await prisma.fleetJobEvent.create({ data: { jobId, seq, leaseEpoch: epoch, runnerSeq: seq, type, payload: {} } });
    }
  };
  const eventTypes = async (jobId: string) =>
    (await prisma.fleetJobEvent.findMany({ where: { jobId }, orderBy: { seq: 'asc' } })).map((e) => `${e.leaseEpoch}:${e.type}`);
  const get = (path: string) => request(server).get(`/api/projects/web/fleet/jobs/${path}`).set({ Authorization: `Bearer ${world.tokens.dev}` });

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'koda-log-retention-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    process.env.FLEET_LOG_RETENTION_DAYS = '30';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    retention = app.get(FleetLogRetentionProcessor);
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('expires old terminal jobs only, keeps the job row and non-log events, and is idempotent', async () => {
    const old = await job('old', { leaseEpoch: 2 });
    await attempt(old.id, 1);
    await attempt(old.id, 2);
    put(file('logs', old.id, '0', 'stdout.log')); // a file whose row was never written (D343)
    const legacy = await job('legacy', { state: 'FAILED' });
    seq += 1;
    await prisma.fleetJobEvent.create({ data: { jobId: legacy.id, seq, leaseEpoch: 1, runnerSeq: seq, type: 'log', payload: {} } });
    const recent = await job('recent', { finishedAt: new Date(now.getTime() - 5 * DAY) });
    await attempt(recent.id, 1);
    const running = await job('running', { state: 'RUNNING', finishedAt: null });
    await attempt(running.id, 1);

    expect(await retention.purge(before, now)).toEqual({ expired: 2, failed: 0 });

    for (const epoch of ['0', '1', '2']) expect(existsSync(file('logs', old.id, epoch))).toBe(false);
    expect(existsSync(file('jobs', old.id, '1', 'b.tar.gz'))).toBe(false);
    expect(existsSync(file('jobs', old.id, '2', 'b.tar.gz'))).toBe(false);
    expect((await prisma.fleetJobLog.findMany({ where: { jobId: old.id } })).every((r) => r.expiredAt?.getTime() === now.getTime())).toBe(true);
    expect((await prisma.fleetJobArtifact.findMany({ where: { jobId: old.id } })).every((r) => r.expiredAt !== null)).toBe(true);
    expect(await eventTypes(old.id)).toEqual(['1:state', '2:state']);
    expect(await eventTypes(legacy.id)).toEqual([]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'COMPLETED', leaseEpoch: 2 });

    for (const kept of [recent, running]) {
      expect(existsSync(file('logs', kept.id, '1', 'run.log'))).toBe(true);
      expect(await prisma.fleetJobLog.count({ where: { jobId: kept.id, expiredAt: { not: null } } })).toBe(0);
      expect(await eventTypes(kept.id)).toEqual(['1:log', '1:state']);
    }

    expect(await retention.purge(before, now)).toEqual({ expired: 0, failed: 0 });
  });

  it('answers 410 for the expired logs and bundle (D341)', async () => {
    const j = await job('gone', {});
    await attempt(j.id, 1);
    await retention.purge(before, now);
    await get(`${j.id}/bundle`).expect(410);
    await get(`${j.id}/logs/run/entries`).expect(410);
    await get(`${j.id}/logs/run/raw?download=1`).expect(410);
  });

  it('touches only attempts <= E when the job was requeued after selection (Review Focus 4)', async () => {
    const j = await job('race', {});
    await attempt(j.id, 1);
    const selected = { id: j.id, leaseEpoch: 1, finishedAt: j.finishedAt as Date };
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'RUNNING', leaseEpoch: 2, finishedAt: null } });
    await attempt(j.id, 2);

    await retention.expireJob(selected, now);

    expect(existsSync(file('logs', j.id, '1'))).toBe(false);
    expect(existsSync(file('logs', j.id, '2', 'run.log'))).toBe(true);
    expect(existsSync(file('jobs', j.id, '2', 'b.tar.gz'))).toBe(true);
    const rows = await prisma.fleetJobLog.findMany({ where: { jobId: j.id }, orderBy: { leaseEpoch: 'asc' } });
    expect(rows.map((r) => [r.leaseEpoch, r.expiredAt !== null])).toEqual([[1, true], [2, false]]);
    expect(await eventTypes(j.id)).toEqual(['1:state', '2:log', '2:state']);
    await get(`${j.id}/bundle`).expect(200);
  });

  it('finishes the rows after a crash that already removed the files', async () => {
    const j = await job('crash', {});
    await attempt(j.id, 1);
    rmSync(file('logs', j.id), { recursive: true, force: true });
    rmSync(file('jobs', j.id), { recursive: true, force: true });
    expect(await retention.purge(before, now)).toEqual({ expired: 1, failed: 0 });
    expect(await prisma.fleetJobLog.count({ where: { jobId: j.id, expiredAt: null } })).toBe(0);
  });
});
```

The requeue race (Review Focus 4) calls `expireJob` with the candidate as it was selected (epoch 1) after the job moved
to epoch 2: that is exactly the state the processor sees when a requeue lands between `findCandidates` and the per-job
work.

- [ ] **Step 5: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-retention.integration.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd apps/api && bun run lint && bun run type-check && cd ../..
git add apps/api/src/config apps/api/src/common/test-helpers/fleet-config.ts apps/api/.env.example apps/api/src/fleet/logs apps/api/src/fleet/fleet.module.spec.ts apps/api/test/integration/fleet/fleet-log-retention.integration.spec.ts
git commit -m "feat(fleet): nightly log retention deletes logs, bundles and log events of old jobs (S2a 1c §5)"
```

---

### Task 8: CLI `koda fleet job logs` (spec §3.4, L6)

**Files:**
- Create: `apps/cli/src/commands/fleet-job-logs.ts`
- Modify: `apps/cli/src/commands/fleet-job.ts` (register, description), `apps/cli/src/utils/error.ts`
  (`API_RET_STATUS`), `docs/deployment/runner.md` (command list)
- Test: `apps/cli/src/commands/fleet-job-logs.spec.ts`, `apps/cli/src/utils/error.spec.ts`

**Interfaces:**
- Consumes (generated by `bun run generate` after Task 5): `fleetJobLogsControllerEntries({ path: { slug, id, stream },
  query })`, `fleetJobLogsControllerList({ path: { slug, id } })`, `fleetJobsControllerGet({ path: { slug, id } })`;
  types `FleetJobLogEntriesDto`, `FleetJobLogEntryDto`, `FleetJobLogListDto`, `FleetJobDto`,
  `FleetJobLogsControllerEntriesData`. `unwrap`, `withContext`, `handleApiError`.
- Produces: `registerLogs(job: Command, deps?: LogsDeps)`, `streamLogs(t, o, deps)`, `formatEntry(stream, entry)`,
  `parseStream`, `parseLevel`, `parseEpoch`, `interface LogsDeps { sleep(ms); print(line); onInterrupt(handler) }`.

- [ ] **Step 1: Make sure the generated client has the log routes**

Run (repo root): `bun run generate`, then `grep -c fleetJobLogsController apps/cli/src/generated/sdk.gen.ts`
Expected: `3` or more. (The directory is gitignored; never edit it.)

- [ ] **Step 2: Write the failing tests**

`apps/cli/src/commands/fleet-job-logs.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetJobLogsControllerEntries: jest.fn(),
  fleetJobLogsControllerList: jest.fn(),
  fleetJobsControllerGet: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { formatEntry, LogsDeps, registerLogs } from './fleet-job-logs';
import { fleetJobLogsControllerEntries, fleetJobLogsControllerList, fleetJobsControllerGet } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = <T>(data: T) => ({ ret: 0, data });
const page = (entries: object[], over: object = {}) => ok({
  entries, nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false, ...over,
});
const entry = (message: string, over: object = {}) => ({
  offset: 0, length: 10, timestamp: '2026-10-04T08:15:30.123Z', level: 'info', stage: 'run', storyId: 'US-001', message, ...over,
});

describe('koda fleet job logs', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let lines: string[];
  let deps: LogsDeps & { sleep: jest.Mock; onInterrupt: jest.Mock };
  const entries = fleetJobLogsControllerEntries as jest.Mock;
  const list = fleetJobLogsControllerList as jest.Mock;
  const getJob = fleetJobsControllerGet as jest.Mock;
  const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'job', 'logs', ...a]);
  const queries = () => entries.mock.calls.map((c) => c[0].query);

  beforeEach(() => {
    lines = [];
    deps = { sleep: jest.fn(async () => {}), print: (l: string) => { lines.push(l); }, onInterrupt: jest.fn() };
    program = new Command();
    program.exitOverride();
    registerLogs(program.command('job'), deps);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    list.mockResolvedValue(ok({ attempts: [{ leaseEpoch: 3, legacySampled: false, streams: [] }] }));
  });

  afterEach(() => jest.clearAllMocks());

  it('prints the run stream from the start across pages at the latest attempt, then exits 0 (D346, D347)', async () => {
    entries
      .mockResolvedValueOnce(page([entry('one')], { nextCursor: 10, atEnd: false }))
      .mockResolvedValueOnce(page([entry('two', { level: 'warn', stage: undefined })], { nextCursor: 20, atEnd: true }));
    await run('j1');
    expect(list).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(entries).toHaveBeenNthCalledWith(1, { path: { slug: 'web', id: 'j1', stream: 'run' }, query: { cursor: 0, direction: 'forward', limit: 500, leaseEpoch: 3 } });
    expect(queries()[1]).toMatchObject({ cursor: 10 });
    expect(lines).toEqual(['08:15:30 INFO  [run] [US-001] one', '08:15:30 WARN  [US-001] two']);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.onInterrupt).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('maps the filters and --lease-epoch to the query and skips the attempt lookup', async () => {
    entries.mockResolvedValueOnce(page([]));
    await run('j1', '--stream', 'stderr', '--lease-epoch', '2', '--level', 'warn', '--story', 'US-2', '--stage', 'review', '--role', 'implementer', '--grep', 'Timeout');
    expect(list).not.toHaveBeenCalled();
    expect(entries).toHaveBeenCalledWith({
      path: { slug: 'web', id: 'j1', stream: 'stderr' },
      query: { cursor: 0, direction: 'forward', limit: 500, leaseEpoch: 2, level: 'warn', storyId: 'US-2', stage: 'review', role: 'implementer', q: 'Timeout' },
    });
  });

  it('omits leaseEpoch when the job has no attempt with logs yet (D347)', async () => {
    list.mockResolvedValueOnce(ok({ attempts: [] }));
    entries.mockResolvedValueOnce(page([]));
    await run('j1');
    expect(queries()[0]).not.toHaveProperty('leaseEpoch');
  });

  // commander 12 keeps option values across parseAsync on one program: one run per `it`.
  it('prints NDJSON with --json', async () => {
    entries.mockResolvedValueOnce(page([entry('one'), { offset: 10, length: 5, unparsed: true, text: 'boom' }]));
    await run('j1', '--json');
    expect(lines.map((l) => JSON.parse(l).offset)).toEqual([0, 10]);
  });

  it('prints raw text for stdout and for unparsed run lines', async () => {
    entries.mockResolvedValueOnce(page([{ offset: 0, length: 6, text: 'hello' }, { offset: 6, length: 5, unparsed: true, text: 'boom' }]));
    await run('j1', '--stream', 'stdout');
    expect(lines).toEqual(['hello', 'boom']);
  });

  it('follows every 2 s while at the end and stops once the stream is complete', async () => {
    entries
      .mockResolvedValueOnce(page([entry('one')], { nextCursor: 10 }))
      .mockResolvedValueOnce(page([], { nextCursor: 10 }))
      .mockResolvedValueOnce(page([entry('two')], { nextCursor: 20, complete: true }));
    await run('j1', '--follow');
    expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
    expect(deps.sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(queries().map((q) => q.cursor)).toEqual([0, 10, 10]);
    expect(lines).toHaveLength(2);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('stops following a job that ended without a complete stream: state checked every 10th poll, one last page (Review Focus 5)', async () => {
    entries.mockResolvedValue(page([], { nextCursor: 0 }));
    getJob.mockResolvedValueOnce(ok({ state: 'RUNNING' })).mockResolvedValueOnce(ok({ state: 'CANCELLED' }));
    await run('j1', '--follow');
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(getJob).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    // Sleeps 1-19; the 20th poll finds the job CANCELLED and fetches once more instead of sleeping.
    expect(deps.sleep).toHaveBeenCalledTimes(19);
    expect(entries).toHaveBeenCalledTimes(21);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it.each([
    ['--level', 'loud'],
    ['--stream', 'prompt'],
    ['--lease-epoch', '-1'],
  ])('refuses %s %s before any request', async (flag, value) => {
    await expect(run('j1', flag, value)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });

  it('reports an expired log as status 410 and exits 1 (D348)', async () => {
    entries.mockRejectedValueOnce({ ret: 410, message: 'This log was deleted after the retention window' });
    await run('j1');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('deleted after the retention window');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('is registered under koda fleet job', () => {
    const root = new Command();
    fleetCommand(root);
    const job = root.commands.find((c) => c.name() === 'fleet')?.commands.find((c) => c.name() === 'job');
    expect(job?.commands.map((c) => c.name())).toContain('logs');
    expect(job?.description()).toContain('logs');
  });
});

describe('formatEntry (D347)', () => {
  it('cuts the time from the ISO timestamp and omits missing stage and story', () => {
    expect(formatEntry('run', { offset: 0, length: 1, level: 'error', message: 'x', timestamp: 'bad' })).toBe('--:--:-- ERROR x');
    expect(formatEntry('run', { offset: 0, length: 1, unparsed: true, text: 'raw' })).toBe('raw');
    expect(formatEntry('stderr', { offset: 0, length: 1, text: 'err' })).toBe('err');
  });
});
```

In `apps/cli/src/utils/error.spec.ts`, add a row to the `maps API envelope ret %s to the expected CLI error` table
and one assertion inside it:

```ts
      [410, 1, 'API_ERROR', null],
```

```ts
      if (ret === 410) expect(parsed.error.status).toBe(410); // D348
```

(the assertion goes right after the `expect(parsed.error).toMatchObject({...})` call).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/cli && bunx jest src/commands/fleet-job-logs.spec.ts src/utils/error.spec.ts --forceExit`
Expected: FAIL — `Cannot find module './fleet-job-logs'`; the 410 row reports `status: null`.

- [ ] **Step 4: Implement**

`apps/cli/src/commands/fleet-job-logs.ts`:

```ts
import { Command, InvalidArgumentError } from 'commander';
import {
  fleetJobLogsControllerEntries,
  fleetJobLogsControllerList,
  fleetJobsControllerGet,
  type FleetJobDto,
  type FleetJobLogEntriesDto,
  type FleetJobLogEntryDto,
  type FleetJobLogListDto,
  type FleetJobLogsControllerEntriesData,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';

const STREAMS = ['run', 'stdout', 'stderr'] as const;
type Stream = (typeof STREAMS)[number];
type EntriesQuery = NonNullable<FleetJobLogsControllerEntriesData['query']>;
type Level = NonNullable<EntriesQuery['level']>;
const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']);
const POLL_MS = 2000;
const STATE_CHECK_EVERY = 10;
const PAGE_LIMIT = 500;

export function parseStream(value: string): Stream {
  if (!(STREAMS as readonly string[]).includes(value)) throw new InvalidArgumentError('expected run, stdout or stderr');
  return value as Stream;
}

export function parseLevel(value: string): Level {
  if (!(LEVELS as readonly string[]).includes(value)) throw new InvalidArgumentError('expected debug, info, warn or error');
  return value as Level;
}

export function parseEpoch(value: string): number {
  if (!/^\d{1,9}$/.test(value.trim())) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return Number(value.trim());
}

/** D347: `HH:MM:SS LEVEL [stage] [story] message` for a parsed run line; the raw text otherwise. */
export function formatEntry(stream: Stream, e: FleetJobLogEntryDto): string {
  if (stream !== 'run' || e.unparsed || !e.level) return e.text ?? '';
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(e.timestamp ?? '')?.[1] ?? '--:--:--';
  const parts = [time, e.level.toUpperCase().padEnd(5), e.stage ? `[${e.stage}]` : null, e.storyId ? `[${e.storyId}]` : null, e.message ?? ''];
  return parts.filter((p): p is string => p !== null).join(' ');
}

export interface LogsOptions {
  project?: string;
  stream: Stream;
  leaseEpoch?: number;
  follow?: boolean;
  level?: Level;
  story?: string;
  stage?: string;
  role?: string;
  grep?: string;
  json?: boolean;
}

/** Seams for tests: the poll sleep, the output line, and the follow-mode Ctrl-C hook. */
export interface LogsDeps {
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  onInterrupt(handler: () => void): void;
}

const defaultDeps: LogsDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  print: (line) => console.log(line),
  // D346: runs before the global SIGINT handler (exit 130), so Ctrl-C ends a follow with 0.
  onInterrupt: (handler) => { process.prependListener('SIGINT', handler); },
};

interface Target {
  slug: string;
  jobId: string;
  stream: Stream;
  leaseEpoch?: number;
}

function entriesQuery(t: Target, o: LogsOptions, cursor: number): EntriesQuery {
  return {
    cursor, direction: 'forward', limit: PAGE_LIMIT,
    ...(t.leaseEpoch !== undefined ? { leaseEpoch: t.leaseEpoch } : {}),
    ...(o.level ? { level: o.level } : {}),
    ...(o.story ? { storyId: o.story } : {}),
    ...(o.stage ? { stage: o.stage } : {}),
    ...(o.role ? { role: o.role } : {}),
    ...(o.grep ? { q: o.grep } : {}),
  };
}

async function fetchPage(t: Target, o: LogsOptions, cursor: number): Promise<FleetJobLogEntriesDto> {
  return unwrap<FleetJobLogEntriesDto>(await fleetJobLogsControllerEntries({
    path: { slug: t.slug, id: t.jobId, stream: t.stream },
    query: entriesQuery(t, o, cursor),
  }));
}

/** D347: the newest attempt that has logs; undefined lets the server use the job's current epoch. */
async function latestEpoch(slug: string, jobId: string): Promise<number | undefined> {
  const list = unwrap<FleetJobLogListDto>(await fleetJobLogsControllerList({ path: { slug, id: jobId } }));
  return list.attempts[0]?.leaseEpoch;
}

async function jobIsTerminal(t: Target): Promise<boolean> {
  const job = unwrap<FleetJobDto>(await fleetJobsControllerGet({ path: { slug: t.slug, id: t.jobId } }));
  return TERMINAL.has(job.state);
}

/**
 * Spec §3.4, D346: print the stream from offset 0. Without follow, stop at the end. With follow, poll every
 * 2 s while at the end; stop when the stream is complete or truncated, or when the job is terminal (checked
 * every 10th sleep, then one more page).
 */
export async function streamLogs(t: Target, o: LogsOptions, deps: LogsDeps): Promise<void> {
  let cursor = 0;
  let sleeps = 0;
  let terminal = false;
  for (;;) {
    const page = await fetchPage(t, o, cursor);
    for (const e of page.entries) deps.print(o.json ? JSON.stringify(e) : formatEntry(t.stream, e));
    const moved = page.nextCursor !== cursor;
    cursor = page.nextCursor;
    if (!page.atEnd && moved) continue;
    if (!o.follow || page.complete || page.truncated || terminal) return;
    sleeps += 1;
    if (sleeps % STATE_CHECK_EVERY === 0 && (await jobIsTerminal(t))) {
      terminal = true;
      continue;
    }
    await deps.sleep(POLL_MS);
  }
}

export function registerLogs(job: Command, deps: LogsDeps = defaultDeps): void {
  job
    .command('logs <jobId>')
    .description("Print a job's log stream (nax run JSONL, stdout or stderr); --follow keeps polling")
    .option('--stream <stream>', 'run, stdout or stderr', parseStream, 'run')
    .option('--lease-epoch <n>', 'Attempt (default: the latest attempt with logs)', parseEpoch)
    .option('--follow', 'Keep polling until the stream is complete or the job has ended')
    .option('--level <level>', 'Minimum level: debug, info, warn or error (run stream)', parseLevel)
    .option('--story <id>', 'Only this story (run stream)')
    .option('--stage <stage>', 'Only this stage (run stream)')
    .option('--role <role>', 'Only this session role (run stream)')
    .option('--grep <text>', 'Case-insensitive substring of the raw line')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'One JSON object per entry (NDJSON)')
    .action(async (jobId: string, options: LogsOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const leaseEpoch = options.leaseEpoch ?? (await latestEpoch(slug, jobId));
        if (options.follow) deps.onInterrupt(() => process.exit(0));
        await streamLogs({ slug, jobId, stream: options.stream, leaseEpoch }, options, deps);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No such job or attempt: ${jobId}` });
      }
    });
}
```

`apps/cli/src/commands/fleet-job.ts`: add `import { registerLogs } from './fleet-job-logs';`, change the description to
`'Fleet jobs: list, show, cancel, requeue, bundle, logs'`, and call `registerLogs(job);` after `registerBundle(job);`.

`apps/cli/src/utils/error.ts`, in `API_RET_STATUS` after `[404, 404],`:

```ts
  [410, 410],
```

`docs/deployment/runner.md`, in the command list after `koda fleet job bundle <jobId> --out login.tar.gz`:

```bash
koda fleet job logs <jobId> --follow               # nax run log as it streams; --stream stdout|stderr, --level warn, --grep text
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/cli && bun run test && bun run lint && bun run type-check`
Expected: PASS (whole CLI suite, lint and types clean).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/fleet-job-logs.ts apps/cli/src/commands/fleet-job-logs.spec.ts apps/cli/src/commands/fleet-job.ts apps/cli/src/utils/error.ts apps/cli/src/utils/error.spec.ts docs/deployment/runner.md
git commit -m "feat(cli): koda fleet job logs with filters, NDJSON and --follow (S2a 1c §3.4, L6)"
```

---

### Task 9: API context, whole-slice verification, PR

**Files:**
- Modify: `.nax/mono/apps/api/context.md` (+ the regenerated `apps/api/{AGENTS,CLAUDE,GEMINI}.md`, `codex.md` if present)

- [ ] **Step 1: API context note**

Replace the `Fleet logs (S2a)` bullet at the end of the Fleet section of `.nax/mono/apps/api/context.md` with:

```markdown
- Fleet logs (S2a): `src/fleet/logs/`. `LogStore.append`/`replace` assume the caller holds `withLock(key)`; every
  `FleetJobLog` write for that key happens inside the same lock. Upload outcomes are HTTP 200 bodies, not errors.
  Reads are lock-free and bounded: one entries request scans at most `FLEET_LOG_SCAN_BYTES` and always moves its
  cursor (`log-lines.ts` is the cursor contract). Retention (`FleetLogRetentionProcessor`) deletes files first, then
  marks rows expired under the job row lock, and never touches attempts newer than the epoch it selected.
```

Regenerate the agent files and keep only the API ones:

```bash
nax generate
git status --short
```

Expected: only `apps/api/` agent files change besides the context. If `nax generate` rewrites other packages' files,
restore them with `git checkout -- <path>`.

- [ ] **Step 2: Whole-slice verification**

From `apps/api`:
- `bun run lint` — 0 errors. `bun run type-check` — 0 errors.
- `bun run test` — all unit suites pass.
- `bun run test:scoped test/integration/fleet` — all fleet integration suites pass (including `fleet-log-read`,
  `fleet-log-retention`, `fleet-bundles`, `fleet-log-upload`, `fleet-log-fallback`).

From `apps/cli`: `bun run test && bun run lint && bun run type-check` — pass.

From the repo root:
- `bun run generate && git status --short openapi.json` — Expected: no change (the committed contract is current).
- `git diff --stat main -- apps/runner apps/web packages` — Expected: **empty** (this slice is API + CLI only).

- [ ] **Step 3: Commit**

```bash
git add .nax/mono/apps/api/context.md apps/api/AGENTS.md apps/api/CLAUDE.md
git status --short   # add any other regenerated apps/api agent file listed here
git commit -m "docs(fleet): S2a 1c API context (log reads and retention)"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/fleet-s2a-read-retention
gh pr create --title "feat(fleet): S2a slice 1c — log read side, CLI and retention (D331-D349)" --body "$(cat <<'EOF'
## Summary
- Read routes under `/projects/:slug/fleet/jobs/:id/logs`: list (attempts, streams, legacySampled), entries (bounded forward/backward scans with level/story/stage/role/q filters, overlong lines cut, never a stall) and raw (1 MiB ranges, `download=1`). User principals, project members, 600 req/min (R10, D331).
- `koda fleet job logs <id>` with `--stream`, `--lease-epoch`, filters, `--json` (NDJSON) and `--follow`.
- Nightly retention (`45 4 * * *`, `FLEET_LOG_RETENTION_DAYS`, default 30, off in tests): deletes logs, bundles and `log` events of terminal jobs, files first, rows expired under the job lock; attempts newer than the selected epoch are never touched.
- An expired bundle answers 410; the latest-bundle lookup skips expired rows (D341).
- Slice 1a cleanups: 507 covers the size read; upload route documents 404 (D349).

## Spec corrections
- D331: the read throttle is per client IP per route (no per-user tracker exists).
- D336: no forward cursor snap; a mid-line cursor yields a `truncatedLine` fragment (keeps overlong lines whole across pages).

## Release gate (unchanged from 1b, D320)
Do not release a runner build with 1b before 1c **and** slice 2 are deployed (API first).

## Test plan
- [ ] `apps/api`: lint, type-check, `bun run test`, `bun run test:scoped test/integration/fleet`
- [ ] `apps/cli`: test, lint, type-check
- [ ] `bun run generate` leaves `openapi.json` unchanged
EOF
)"
```

Expected: the PR URL. Do not merge; the user reviews.
