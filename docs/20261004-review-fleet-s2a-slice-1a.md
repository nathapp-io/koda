# Whole-Branch Code Review: Fleet S2a Slice 1a — Log Transport and Storage

**Date:** 2026-10-04
**Reviewer:** Subrina (AI)
**Branch:** `feat/fleet-s2a-logs` @ `fcfd203f` (11 commits, 4851 +/- 19)
**Base:** `main` @ `a759759f` (post S1.5 slice 2b)
**Plan:** `docs/superpowers/plans/2026-10-04-fleet-s2a-slice-1a-log-transport.md`
**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md`
**Scope:** `apps/api` only (CLI/web/runner untouched; openapi.json auto-generated)

---

## Overall Grade: **A** (92/100)

The slice lands exactly what the plan promised: a `LogStore` with exact-offset appends and a per-key mutex, a `FleetJobLog` index table, a fence-checked upload service, a coalescing `fleet_log` live publisher, a tar-stream bundle extractor and an off-the-request-path fallback that fills the streams the runner never finished. Code-review focus points 1–5 are pinned by tests, the design decisions D307–D319 are all reflected in the code, and the refactor that splits `ArtifactStoreModule` out of `ArtifactsModule` keeps the existing bundle suite green (6/6). All 67 unit tests + 11 integration tests pass; `tsc --noEmit` and `eslint --max-warnings=0` are clean. No CRITICAL or HIGH findings.

The remaining marks are concentrated around the unlocked read of `FleetJob` in the upload hot path (D310-bounded, by design), two `artifacts.get` round-trips per fallback (PERF-1), and minor test/style duplications. None block ship.

---

## Build & Test Status

| Gate | Command | Result |
|:--|:--|:--|
| Unit (67 tests, 10 files) | `cd apps/api && bun run test:scoped src/fleet/logs src/fleet/common/protocol.spec.ts src/config/fleet.config.spec.ts` | **PASS** 67/67 |
| Integration — new (11 tests, 3 files) | `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-logs-schema.integration.spec.ts test/integration/fleet/fleet-log-upload.integration.spec.ts test/integration/fleet/fleet-log-fallback.integration.spec.ts` | **PASS** 11/11 |
| Integration — existing bundles (regression) | `cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts` | **PASS** 6/6 |
| Type check | `bunx turbo type-check` | **PASS** 5/5 workspaces |
| Lint | `bunx turbo lint` | **PASS** 4/4 workspaces (max-warnings=0) |
| Prisma sync | `bunx prisma db push` against `koda_test` (5433) | **PASS** (after `prisma generate` in `apps/api`) |

---

## File Map Reviewed

| Path | LOC (impl+spec) | Notes |
|:--|--:|:--|
| `apps/api/src/fleet/logs/log-store.ts` | 33 | Interface + `logKey()` validator |
| `apps/api/src/fleet/logs/keyed-mutex.ts` | 22 | FIFO per-key promise chain; tested |
| `apps/api/src/fleet/logs/local-disk-log.store.ts` | 124 | Open/sync/rename + `replace` with capped Writable |
| `apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts` | 41 | Domain types + repo interface |
| `apps/api/src/fleet/logs/prisma-fleet-job-log.repository.ts` | 53 | Upsert + CAS `completeFromBundle` |
| `apps/api/src/fleet/logs/read-capped-body.ts` | 20 | Bounded drain (4×cap) then destroy |
| `apps/api/src/fleet/logs/runner-byte-rate.ts` | 24 | Token bucket, per-runner |
| `apps/api/src/fleet/logs/log-upload.service.ts` | 153 | Fence → rate → cap → final + CAS |
| `apps/api/src/fleet/logs/log-upload.controller.ts` | 45 | `@RunnerRoute` + `@SkipThrottle` |
| `apps/api/src/fleet/logs/log-upload.exceptions.ts` | 9 | 413/422/507 typed |
| `apps/api/src/fleet/logs/fleet-log-live.publisher.ts` | 86 | 1s trailing + immediate; timers `unref` |
| `apps/api/src/fleet/logs/bundle-log-extractor.ts` | 101 | tar-stream + gunzip; dual-flag advance |
| `apps/api/src/fleet/logs/log-fallback.service.ts` | 69 | Private queue; size-CAS under lock |
| `apps/api/src/fleet/logs/logs.module.ts` | 27 | Imports `ArtifactStoreModule` (D309) |
| `apps/api/src/fleet/artifacts/artifact-store.module.ts` | 10 | New: ARTIFACT_STORE standalone |
| `apps/api/src/fleet/artifacts/artifacts.module.ts` | 18 | Refactored: now imports `LogsModule` |
| `apps/api/src/fleet/artifacts/bundle.service.ts` | 131 | Adds `fallback.schedule(...)` post-commit |
| `apps/api/src/fleet/common/protocol.ts` | 58 | `SUPPORTED` = `[1,2,3]` |
| `apps/api/src/common/hooks/bundle-content-parser.ts` | 16 | + `registerLogContentParser` |
| `apps/api/src/main.ts` | 56 | Wires log parser |
| `apps/api/src/live/live-event.ts` | 97 | + `LiveFleetLogEvent` |
| `apps/api/src/config/fleet.config.ts` | 106 | + 3 keys (env, schema, defaults) |
| `apps/api/src/common/test-helpers/fleet-config.ts` | 28 | `IFleetConfig` complete |
| `apps/api/prisma/schema.prisma` | 897 (+23) | + `FleetJobLog` model, `logs` backref, `(state,finishedAt)` index, `FleetJobArtifact.expiredAt` |
| `apps/api/prisma/migrations/20261004120000_fleet_job_logs/migration.sql` | 24 | Matches the `prisma db push` shadow diff |
| `apps/api/src/i18n/{en,zh}/fleet.json` | 36 (+4 keys each) | Parity held |
| 3 × integration specs + `test/helpers/tar-gz.ts` | 296 | Real PG + real `LocalDiskLogStore` |

11 new files in `apps/api/src/fleet/logs/`, 1 new test helper, 3 new integration specs.

---

## Spec ↔ Implementation Cross-Check

| Plan ID | Claim | Where in code | Status |
|:--|:--|:--|:--|
| D307 | Outcomes are 200 bodies | `log-upload.service.ts:88-92`, controller `@HttpCode(200)` at `log-upload.controller.ts:20` | OK |
| D308 | `[1,2,3]`; package stays at 2 | `protocol.ts:47`; `package.json` `tar-stream` only | OK |
| D309 | `ArtifactStoreModule` standalone | `artifact-store.module.ts:7-9`; `artifacts.module.ts:14` | OK |
| D310 | Unlocked read on hot path; ABANDON under lock on miss | `log-upload.service.ts:136-152`; `fence.service.ts:21-33` | OK |
| D311 | `KeyedMutex` FIFO, `append`/`replace` don't lock | `keyed-mutex.ts:9-21`; `log-store.ts:13-14` doc | OK |
| D312 | Rate charged by Content-Length; body drained on refusal | `log-upload.service.ts:72-78`; `read-capped-body.ts:7-19` | OK |
| D313 | `sizeBytes` written from `LogStore.size()` after every store | `log-upload.service.ts:105,112,115,118` | OK |
| D314 | `complete` / `truncated` rows answer the same on every retry | `log-upload.service.ts:98-99`; `prisma-fleet-job-log.repository.ts:50` | OK |
| D315 | Cap appends the cut, then `stream_cap` | `log-upload.service.ts:101-107` | OK |
| D316 | Private serial queue; two passes over the bundle | `log-fallback.service.ts:20,41-67`; `bundle-log-extractor.ts:64-71, 91-101` | OK |
| D317 | Normalise `./`; skip symlinks; `naxLogRunId` only for matching epoch | `bundle-log-extractor.ts:13, 44-48, 82-87`; `log-fallback.service.ts:49-51` | OK |
| D318 | Truncate at cap; smaller member leaves row untouched | `log-fallback.service.ts:56-62`; `local-disk-log.store.ts:90-110` | OK |
| D319 | i18n keys `fleet.logInput/Chunk/Hash/Storage` | `en/fleet.json:32-35`, `zh/fleet.json:32-35` | OK |

**Plan defect scan:** No name in a snippet is missing in the code (`logKey`, `KeyedMutex`, `LocalDiskLogStore`, `FleetJobLogRecord`, `IFleetJobLogRepository`, `PrismaFleetJobLogRepository`, `LogStreamPatch`, `FleetLogLivePublisher`, `LogTouch`, `LiveFleetLogEvent`, `FleetFenceException`, `LogUploadService`, `LogFallbackService`, `BundleMember`, `pickLogMembers`, `extractBundleMembers`, `tarGz`, `registerLogContentParser`, `readCappedBody`, `RunnerByteRate`).

**Review focus scan (per plan §Review Focus):**

| Focus | Pinned in | Verdict |
|:--|:--|:--|
| 1 — retried chunk returns `duplicate` with size | `log-upload.service.spec.ts:67` | Pinned |
| 2 — cap cut, re-sent, byte-identical | `log-upload.service.spec.ts:106-115` | Pinned |
| 3 — bundle fallback racing a late upload | `fleet-log-fallback.integration.spec.ts:73-86` | Pinned |
| 4 — no run member / symlink / other feature | `bundle-log-extractor.spec.ts:9-31` | Pinned |
| 5 — requeue: old epoch, not new `naxLogRunId` | `log-fallback.service.spec.ts:81-86`; `log-fallback.service.ts:50` | Pinned |

---

## Findings

### 🟡 MEDIUM

#### BUG-1: `LogFallbackService.fill` opens the bundle twice (`docs/superpowers/plans/2026-10-04-fleet-s2a-slice-1a-log-transport.md:2152, 2154`)

**Severity:** MEDIUM | **Category:** Performance
**Location:** `apps/api/src/fleet/logs/log-fallback.service.ts:48, 54`

```ts
const members = await listBundleMembers(await this.artifacts.get(input.storageKey));
…
await extractBundleMembers(await this.artifacts.get(input.storageKey), wanted, async (stream, entry, member) => { … });
```

`LogStore.withLock` per stream gives FIFO across keys, but each `artifacts.get(storageKey)` is a fresh `Readable`. Plan D316 (two passes, headers first, then bytes) is the right shape, but the helper should take a single `Readable` and call the inner `walk()` twice over the same source. The second pass currently re-opens the bundle from disk/S3.

**Risk:** On a local-disk store this is `O(2·bundle_size)` read IO; on the future S3 store (the `ArtifactStore` seam) this doubles GET cost and per-bundle transfer. Slice 1b / S3 day cost is 2× expected.
**Fix:** Have `listBundleMembers` and `extractBundleMembers` accept an already-extracted list and a single shared source, or expose a `walk()` cursor that consumes one stream and yields members on demand. Within the slice's local-disk scope the cost is acceptable; flag for the S3 port.

#### BUG-2: `LogUploadService.assertHolder` uses the unlocked `job.state` for the state check (`apps/api/src/fleet/logs/log-upload.service.ts:136-152`)

**Severity:** MEDIUM | **Category:** Bug (race)
**Location:** `apps/api/src/fleet/logs/log-upload.service.ts:150`

```ts
const job = await this.jobs.findById(jobId);
…
if (!this.fence.holds(job, runnerId, leaseEpoch)) {
  // re-check fence under lock
}
if (!UPLOAD_STATES.includes(job.state)) throw new ConflictAppException(…);
return job;
```

The state check is on the **unlocked** row. A `CANCEL` or terminal transition that lands between `findById` and the append is invisible to this check, and the upload is stored for a job that just ended. The plan calls this out (D310) and accepts the bounded consequence ("at worst bytes for a job that just ended, which the reader serves like any other bytes"); the `leaseEpoch` bump that comes with a requeue is the real fence.

**Risk:** Reader serves post-terminal bytes that no live event will reference. The `events[]` integration test relies on `complete: true` propagating, which the `truncated: true` row would short-circuit — but the bytes for an `ASSIGNED→RUNNING` job cancelled mid-upload may live forever if the row was never written (it is: the row is written inside the same lock, so the reader sees either a consistent `(no row, no file)` or a `(truncated/stream_cap row, partial file)`).
**Fix:** @design remark on the method, since the behaviour is intentional per the plan; consider a follow-up that re-reads `state` after acquiring the `withLock` for parity with `BundleService.upload:117-130`.

#### ENH-1: `BundleService` schedules the fallback in-band; a crash between commit and `schedule()` loses it (`apps/api/src/fleet/artifacts/bundle.service.ts:88`)

**Severity:** MEDIUM | **Category:** Enhancement
**Location:** `apps/api/src/fleet/artifacts/bundle.service.ts:88`

```ts
this.fallback.schedule({ jobId: u.jobId, leaseEpoch, storageKey: key });
```

`schedule()` is in-process: if the API restarts before the promise chain is observed, the queued fill is lost. The bundle row and the file are intact, so an operator can re-trigger by re-uploading, but nothing re-runs automatically.

**Risk:** A flaky host that bounces the API after a bundle upload leaves streams incomplete for an attempt the runner already finished. The CLI / web reader surfaces "stream not found" with no automatic recovery.
**Fix:** Either mark this as the deliberate boundary for slice 1a (a fleet-level sweeper that re-runs the fallback for recorded bundles past the runner's last activity is the right answer, and the `@@index([state, finishedAt])` added in this slice is the seed for it) or persist a `FleetJobLogEvent`-style "bundle recorded, fallback pending" row in the same tx and have a worker pick it up.

#### SEC-1: `LocalDiskLogStore.pathFor` regex normalises on `/` only (`apps/api/src/fleet/logs/local-disk-log.store.ts:12, 24-28`)

**Severity:** MEDIUM | **Category:** Portability
**Location:** `apps/api/src/fleet/logs/local-disk-log.store.ts:12, 24-28`

```ts
const KEY_RE = /^logs\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\/?$/;
…
const full = resolve(this.root, key);
if (!full.startsWith(this.root + sep)) throw new Error(`invalid log key: ${key}`);
```

`KEY_RE` matches `/` separators. `resolve(this.root, key)` on Windows would normalise to `\\`, and the regex would not match. The rest of the API (Fastify + Prisma + bcrypt) is Linux-only today, so this is latent. The defence-in-depth (`split('.', '..')` + `startsWith(root+sep)`) is correct on both platforms; only the regex pattern is platform-bound.

**Risk:** None on Linux. A future Windows port would silently allow any `key` (regex never matches) and the `startsWith` would still block traversal — so the security property holds, only the input-validation log line is wrong.
**Fix:** Add a `@design linux-only` remark on the constant, or split the test into a regex check and a separate `resolve + startsWith` check (the latter is already there).

#### TEST-1: The `MemoryLogRepo` pattern is duplicated across `log-upload.service.spec.ts` and `log-fallback.service.spec.ts`

**Severity:** MEDIUM | **Category:** Code Quality
**Location:** `apps/api/src/fleet/logs/log-upload.service.spec.ts:18-32`, `apps/api/src/fleet/logs/log-fallback.service.spec.ts:11-26`

The two in-memory fakes are not identical (the fallback one has `completeFromBundle` and CAS semantics) but the dispatch / upsert shapes are the same. The pattern will repeat in 1c (read routes) and 2 (web tests).

**Risk:** Maintenance debt; not a correctness issue.
**Fix:** Extract `apps/api/src/fleet/logs/test-helpers/memory-log-repo.ts` with the union of behaviours and import in both specs.

### 🟢 LOW

#### PERF-1: `RunnerByteRate.take` rebuilds the buckets `Map` on every call
**Severity:** LOW | **Category:** Performance
**Location:** `apps/api/src/fleet/logs/runner-byte-rate.ts:18, 21`
`new Map([...this.buckets, [runnerId, …]])` is `O(distinct_runners)`. At the current scale (1-100 runners) this is invisible. The plan's "immutability" rule (`Global Constraints` last bullet) treats this as a deliberate trade.
**Fix:** @design — only revisit if a single instance ever has > 10 4 runners uploading concurrently.

#### PERF-2: `FleetLogLivePublisher` rebuilds the slots `Map` on every `touch()`
**Severity:** LOW | **Category:** Performance
**Location:** `apps/api/src/fleet/logs/fleet-log-live.publisher.ts:72-77, 43-44`
Same trade as PERF-1. Bounded by the number of (job, epoch, stream) triples that are mid-coalesce. The `unref()`-ed timer keeps the process from holding the loop open.

#### BUG-3: `LogFallbackService.fill` reads `listForAttempt(input.jobId, input.leaseEpoch)` inside every `withLock` callback
**Severity:** LOW | **Category:** Performance
**Location:** `apps/api/src/fleet/logs/log-fallback.service.ts:57`
The `rows` snapshot is already captured at line 44; the per-key re-read re-queries PG. With a few streams per attempt this is a handful of extra round-trips.
**Fix:** Pass the snapshot into the closure (`open` already filters by `current.complete || current.truncated`).

#### BUG-4: `LogFallbackService.fill` calls `pickLogMembers` once but `extractBundleMembers` runs the walk again
**Severity:** LOW | **Category:** Architecture
**Location:** `apps/api/src/fleet/logs/log-fallback.service.ts:48, 54`
Closely related to BUG-1; the cleanest fix subsumes both.

#### BUG-5: `assertHolder` re-loads the job on fence miss, but returns the original unlocked `job` to the caller
**Severity:** LOW | **Category:** Bug
**Location:** `apps/api/src/fleet/logs/log-upload.service.ts:150-152`
The published live event uses `job.projectId` from the unlocked read. The plan's note ("if the fence passes on the re-check … the code treats a vanished job as fenced; that is intended") is correct, but the published event uses the unlocked `projectId` even when the row was re-read under lock. `projectId` is immutable on a `FleetJob`, so this is harmless, but a comment would help the next reviewer.

#### BUG-6: `LogStore.pathFor` does not normalise Windows separators
**Severity:** LOW | **Category:** Portability
**Location:** `apps/api/src/fleet/logs/local-disk-log.store.ts:24-28`
Same as SEC-1, framed as a portability nit. Linux-only today.

#### BUG-7: `pickLogMembers` returns `run` even when the chosen member is a directory entry whose name ends in `.jsonl` but is a symlink loop or hardlink
**Severity:** LOW | **Category:** Bug
**Location:** `apps/api/src/fleet/logs/bundle-log-extractor.ts:84-87`
`posix.basename(m.name) !== 'latest.jsonl'` and `m.name.endsWith('.jsonl')` are the only filters for the run candidate. A bundle that legitimately has, e.g., a symlink `a.jsonl → b.jsonl` is treated as a candidate. The walker (`bundle-log-extractor.ts:44-48`) only checks `header.type !== 'file'`, which `tar-stream` sets for symlinks; the symlink would be **skipped** in `listBundleMembers`. So in practice the candidate set is files-only. **Not a real issue**, but worth a `// symlinks are filtered in the walker's `type !== 'file'` branch` comment for the next reader.

#### BUG-8: `RunnerByteRate` does not handle `bytes = 0` distinctly
**Severity:** LOW | **Category:** Edge case
**Location:** `apps/api/src/fleet/logs/runner-byte-rate.ts:14`
`charge = Math.min(Math.max(bytes, 0), burstBytes)`. A `0` byte call is a no-op: tokens are unchanged, no `retryAfterMs` is computed. This matches the spec (rate is about bytes, not requests) and `LogUploadService` is the only caller and only uses positive `charge`. **OK** — no fix.

#### BUG-9: `LiveFleetLogEvent.stream` is typed inline as `'run' | 'stdout' | 'stderr'` instead of `LogStreamName`
**Severity:** LOW | **Category:** Type Safety
**Location:** `apps/api/src/live/live-event.ts:65`
Duplicates the union. Drift risk if a stream is added.
**Fix:** `import type { LogStreamName }` and reuse.

#### ENH-2: `replace()` uses a custom Writable with `drain` / `error` listener juggling
**Severity:** LOW | **Category:** Style
**Location:** `apps/api/src/fleet/logs/local-disk-log.store.ts:90-110`
The `Writable` shape is correct and the spec lists `Writable` exactly as the safer way to enforce the cap, but a `Transform` with a fixed-size cap (`{ writableHighWaterMark: 0 }`) plus a manual `out.write` backpressure path would be easier to reason about. **Not worth changing** — the current code is exercised by both `replace writes at most maxBytes` and the fallback's `caps a member larger than FLEET_LOG_MAX_BYTES` test.

#### ENH-3: `KeyedMutex.run` could be replaced by a small library (e.g., `proper-lockfile`, `async-mutex`)
**Severity:** LOW | **Category:** Style
**Location:** `apps/api/src/fleet/logs/keyed-mutex.ts`
The hand-rolled 22-line implementation is **smaller** than the smallest published alternative, has zero dependencies, and is exhaustively tested. **Keep as-is**.

#### ENH-4: `BundleService.upload` deletes the previous bundle file after scheduling the fallback
**Severity:** LOW | **Category:** Race
**Location:** `apps/api/src/fleet/artifacts/bundle.service.ts:89-105`
The fallback runs on the queue (`schedule()`) but `delete(replacedKey)` happens **synchronously** on the request path before the fallback has run. If the fallback reads the bundle and the old file has already been deleted, the `artifacts.get(recorded.replacedKey)` would 404. The ordering is: `fallback.schedule` (line 88) → `delete(replacedKey)` (line 91) → fallback's microtask. The fallback uses the **new** `key` (passed via `input.storageKey`), not `replacedKey`, so the deletion does not race the fallback. **Verified** by re-reading line 88 vs. 91. The race is therefore with the next `putBundle` for the same `(job, epoch)`, which is the normal "replace the bundle" case that already handles missing keys. **OK**.

#### DOC-1: The `BundleService.upload` refactor introduces a new module-cycle fix without a one-line comment
**Severity:** LOW | **Category:** Documentation
**Location:** `apps/api/src/fleet/artifacts/artifact-store.module.ts:5`
The header comment is already there (`Plan D309: the artifact store on its own so the logs module can read bundles without importing ArtifactsModule.`). **No action.**

#### DOC-2: `LiveFleetLogEvent` JSDoc does not note that `id` is fresh per publish (clients dedupe)
**Severity:** LOW | **Category:** Documentation
**Location:** `apps/api/src/live/live-event.ts:55-69`
The interface-level JSDoc says `id` is fresh per publish, but the spec describes this as the difference from `LiveFleetJobEvent` (which reuses the same id). **Already documented** at the interface.

#### TEST-2: Integration test "skips a stream that became complete after the listing (CAS under the lock)" uses `artifacts.get.mockImplementationOnce`
**Severity:** LOW | **Category:** Test brittleness
**Location:** `apps/api/src/fleet/logs/log-fallback.service.spec.ts:88-98`
The mock flips the repo state inside the implementation of the artifact `get()`. This couples the timing of the test to the order `listBundleMembers` → `extractBundleMembers` (which is enforced by the `listBundleMembers` await at line 48 of the service). Robust but subtle. **Keep** with a one-line comment if the service is ever refactored.

#### TEST-3: `runner-byte-rate.spec.ts` does not exercise `bytes = 0` or `bytes < 0`
**Severity:** LOW | **Category:** Coverage
**Location:** `apps/api/src/fleet/logs/runner-byte-rate.spec.ts`
`Math.max(bytes, 0)` floors negative values; this is never tested. **Add** one case.

#### TEST-4: `keyed-mutex.spec.ts` does not exercise the case where `run` is called after the entry is deleted
**Severity:** LOW | **Category:** Coverage
**Location:** `apps/api/src/fleet/logs/keyed-mutex.spec.ts:5-20`
The "drops one microtask turn after the last section settles" assertion depends on a real microtask flush. A test that calls `m.run('k', ...)` after `await tick()` is needed if the implementation ever inlines the deletion. **No fix**; current test is sufficient.

---

## Dimension Scores

| Dimension | Score | Notes |
|:--|:--|:--|
| **Security** | 18/20 | Path traversal defended at two layers; rate-limit not constant-time (SEC-1); SHA mismatch is not constant-time but is not a secret comparison; `tar-stream` is fed server-blessed tarballs (spec), so symlink-pivot is not a concern. No secrets logged. |
| **Reliability** | 19/20 | Every async path has explicit error handling; timers and listeners are cleaned; the `KeyedMutex` advances on `close` for tar-stream's streamx; the `replace` uses tmp + atomic rename; `LogStore.append` does `fsync` per chunk. Race on unlocked `job.state` is documented (BUG-2). |
| **API Design** | 19/20 | `LogStore` interface is small and consistent with `ArtifactStore`; the controller reuses `@RunnerRoute` + `@SkipThrottle` + `JsonResponse.Ok`; outcomes are a typed union; i18n parity is held. `LiveFleetLogEvent.stream` duplicates the union (BUG-9). |
| **Code Quality** | 17/20 | Functions are small, early-returns everywhere, immutability rule followed for shared maps, spec literals named (`UPLOAD_STATES`, `WINDOW_MS`). Deducted for the two duplicate `MemoryLogRepo`s (TEST-1) and a few inline type unions. |
| **Best Practices** | 19/20 | Platform patterns from `@nathapp/nestjs-*` are used correctly; tests run as `bun run test:scoped`; the migrations match `prisma db push` against the shadow DB; the dependency addition is minimal (`tar-stream` only). `ENH-1` is the one cross-cutting gap. |

**Total: 92/100 → A**

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P1 | BUG-1 | M | `LogFallbackService.fill` should open the bundle once; cache the source or stream both passes from one `Readable`. |
| P1 | ENH-1 | M | Document the in-process fallback queue as a deliberate slice 1a boundary; design the recovery path (sweeper on `(state, finishedAt)`) for a follow-up. |
| P2 | BUG-2 | S | `@design` comment on `assertHolder`; consider re-reading `state` inside the lock for symmetry with `BundleService.upload`. |
| P2 | TEST-1 | S | Extract a `memory-log-repo.ts` test helper. |
| P3 | SEC-1 / BUG-6 | XS | Add a `@design linux-only` remark on `KEY_RE`. |
| P3 | BUG-9 | XS | Reuse `LogStreamName` in `LiveFleetLogEvent`. |
| P3 | BUG-3 | XS | Use the already-captured `rows` snapshot inside the per-key closure. |
| P4 | TEST-3 | XS | Add `bytes = 0` and `bytes < 0` cases to `runner-byte-rate.spec.ts`. |
| P4 | PERF-1, PERF-2 | — | Document the `Map` immutability as `@design`; revisit only if scale changes. |

---

## What's Right (preserve in future reviews)

- D310 — the unlocked `findById` on the hot path with a `lockById`-gated ABANDON. Bounded consequence, easy to reason about.
- D311 — the `KeyedMutex` is 22 lines, has no deps, and is exhaustively tested. Don't replace it.
- D312 — drain `4×` then destroy; the alternative (destroy on first over-cap byte) would reset the socket and 413 wouldn't reach the runner.
- D316 — the two-pass walk over the bundle. The single-`get` cost is the real fix (BUG-1), not the walk shape.
- The `FleetLogLivePublisher` slot map being immutable + `unref` — the only mutable state per slice is a `Map<string, {timer, pending}>` and it is replaced, not mutated, on every touch.
- The single `addContentTypeParser` per content type (`application/gzip`, `application/octet-stream`) — no JSON raw-body hook, no per-handler boilerplate.
- The integration tests using a **real** `LocalDiskLogStore` on a temp dir plus a real PG database. The mocks are limited to the things the test cares about (`FenceService`, `RunnerByteRate`, the repo, the bus).

---

## Sign-off

This branch is ready to merge as-is. The MEDIUM items are real but bounded; none of them is on the hot path of the upload or the bundle-fallback correctness claim. The findings should land as separate, small PRs (or be added to a `.nax/features/.../followups.md`) so the merge isn't blocked.
