# Focused Code Review: koda api and runner (security, memory, memory reduction)

**Date:** 2026-11-28
**Reviewer:** Subrina (AI)
**Version:** 0.5.2 (`main` at `745e6b072`)
**Scope:** `apps/api/src` (1,148 files, ~104k LOC without specs and generated code), `apps/runner/src` (156 files, ~17.7k LOC), Dockerfile and compose files
**Method:** targeted, not exhaustive. Every long-lived map, timer, whole-buffer read and outbound fetch in both apps was located by search and read. Memory numbers come from local measurements (macOS arm64, Bun 1.4.5) and a read-only look at a running test deployment's api container. Earlier reviews (10-18 to 11-28) were read first so settled items are not raised again.

---

## Overall Grade: A- (87/100)

| Dimension | Score |
|:---|---:|
| Security | 18 |
| Reliability | 17 |
| API Design | 17 |
| Code Quality | 18 |
| Best Practices | 17 |

No critical or high finding. The security surface is in good shape: the items earlier reviews raised on deployment, auth and webhooks are fixed in the code as it stands. Memory handling is careful as well; every in-process map I read is bounded or keyed by an admin-controlled set. The one finding that matters is the commit indexer, which runs the TypeScript compiler inside the api process. The rest are small, measured reduction options.

---

## Measurements

### api

| What | Result |
|:---|:---|
| Module load only (`require dist/app.module`) | 137 MiB RSS, 3,627 modules, 15.6 MB source (28 MB before #531) |
| Full idle boot against an empty Postgres | 230-236 MiB RSS, JS heap 65 MiB, 4,290 modules, 22.7 MB source |
| Largest loaded code after boot | app code 6.4 MB, `@prisma/client` 4.7 MB (the query compiler), `@nestjs/core` 1.0 MB, zod 1.0 MB, MCP server 0.8 MB |
| Live test deployment api (v0.5.1-canary.1, 21 h up) | 393 MiB RSS: 307 anonymous, 46 bun binary, 37 LanceDB native module |
| Test deployment baseline trend (sampled every minute) | 317 to 382 MiB RSS over 21 h, in two steps (15:29Z, 08:54Z) |

Only 65 MiB of the idle footprint is JS heap. The rest is the runtime plus loaded code, so heap tuning has little to work with.

The test deployment's image is still canary.1, which loads ts-morph at startup. Redeploying v0.5.2 should remove about 52 MiB (measured 11-27). The 21 h drift is not attributed: I found no growing structure in the code, and step-shaped increases fit lazy loads (LanceDB on first RAG use) better than a leak. Compare again after the redeploy.

| Option tested (idle boot, RSS) | Result |
|:---|:---|
| Default | 233-236 MiB |
| Prisma small query compiler | 213-221 MiB (about 12-20 less) |
| `bun --smol` | 228 MiB (about 5 less) |
| Small compiler + `--smol` | 216 MiB |
| `BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0` | 213 MiB (about 20 less, costs CPU under load; not load-tested) |
| `BUN_JSC_useJIT=0` | boot fails (`SharedArrayBuffer is not defined`) |
| `RAG_IN_MEMORY_ONLY=true` | no change at idle; LanceDB is already lazy |

### Commit indexer (`CodeGraphService.extractBatch`, fresh process)

| Input | Event loop blocked | Peak RSS | RSS after GC |
|:---|---:|---:|---:|
| nothing | 0 | 18 MiB | 16 MiB |
| 12 TypeScript files, 31 KB | 432 ms | 215 MiB | 123 MiB |
| the same plus `bun.lock` and `openapi.json`, 1.45 MB | 493 ms | 322 MiB | 112 MiB |
| 3 large TypeScript files, 1.14 MB | 403 ms | 284 MiB | 111 MiB |

### runner

| What | Result |
|:---|:---|
| Importing `src/daemon/daemon.ts` | 57.5 MiB RSS |
| Importing `@nathapp/nax-agent` alone | 53.2 MiB (+48.6) |
| Importing `commander` alone | 11.8 MiB |
| Importing `src/sync/sync-loop.ts` alone | 9.9 MiB |

About 48 of the runner's ~57 MiB idle footprint is the nax-agent root entry point.

---

## Findings

### MEDIUM

#### MEM-1: The commit indexer runs the TypeScript compiler inside the api process, on unfiltered input

**Severity:** MEDIUM | **Category:** Memory / Performance

`apps/api/src/code-intel/code-commit-outbox-handler.ts:78` fetches every changed file of a pushed commit and `ast-index.service.ts:64` hands them all to `extractBatch`.

- No extension filter: `.json`, `.md`, lockfiles and binaries are fetched, base64-decoded and parsed as TypeScript (`vcs/providers/github.provider.ts:380`, `gitlab.provider.ts:353`).
- No per-file size cap, no file-count cap, no batch-byte cap. All contents are held in one array before extraction starts.
- Extraction is synchronous, so the api serves nothing while it runs.
- After the first index the compiler stays loaded: about 100 MiB that is never returned (table above). #531 moved this cost from startup to first use; it did not remove it.

**Risk:** the first push to any indexed project raises the api's steady memory by about 100 MiB and its peak by about 200 MiB, more when the commit touches large non-TypeScript files. With a 512m container limit this is the path most likely to OOM the container. A commit with many files also stalls HTTP, SSE heartbeats and runner sync for the length of the batch.

**Fix:**
1. Filter `changedFiles` to the extensions the extractor understands before fetching, and skip files over a size cap (the knowledge indexer already has `MAX_KNOWLEDGE_FILE_BYTES`).
2. Cap files and total bytes per batch; index the rest in further batches.
3. Run extraction in a short-lived child process (`Bun.spawn` of a small script that takes files on stdin and returns `FileExtraction[]`). The compiler memory then goes back to the OS when the child exits and the event loop stays free.

Step 1 was listed as out of scope in the `indexer-batch-project` spec, not ruled out. Steps 1 and 2 are small; step 3 is what lets the prod limit drop to 512m.

### LOW

#### MEM-2: Prisma ships a smaller query compiler that koda does not use

**Severity:** LOW | **Category:** Memory (reduction option)

The generated client loads `query_compiler_fast_bg.postgresql` (3.4 MB of WASM, 4.6 MB as base64 JS). The same package contains `query_compiler_small_bg.postgresql` (1.7 MB). Loading and compiling each in isolation cost 35-44 MiB against 25-27 MiB; a full api boot dropped from about 233 to about 217 MiB.

**Fix:** set the generator's compiler build to small in `apps/api/prisma/schema.prisma` (I believe the option is `compilerBuild = "small"`; confirm against the Prisma 7.10 docs), and change the Dockerfile line that deletes every `query_compiler_*` file except `query_compiler_fast_bg.postgresql*` (`apps/api/Dockerfile:93`), or the image will not boot. The small build compiles queries more slowly; I did not measure request latency, so check it on a test deployment before production.

#### MEM-3: The runner loads the whole nax-agent SDK at startup

**Severity:** LOW | **Category:** Memory (reduction option)

`daemon.ts:5` (`configureCredentials`), `owned-processes.ts:2` (`getAgentRuntime`, `setAgentRuntime`) and `thread-event-writer.ts:3` (`redactSecrets`) import the `@nathapp/nax-agent` root, which is the package's only general entry point and costs about 48 MiB.

**Fix:** needs light entry points in nax-agent (credentials, runtime slot, redaction) so the daemon imports only those, with the session code imported on the first thread job or ACP probe. The saving is at most about 45 MiB per runner and disappears once a thread job has run, so this is worth doing only if the nax side is cheap. It is small next to the ~1 GiB a running job costs.

#### MEM-4: The runner reads whole job output files into memory

**Severity:** LOW | **Category:** Memory

`verdict/fix-result.ts:35`, `verdict/review-posted.ts:9` and `executor/host-executor.ts:405` read the complete nax stdout or stderr file to find one marker line. `executor/git.ts:113` buffers all of git's stdout when no `onStdout` consumer is passed. Nothing caps the size of those files.

**Risk:** a job that writes hundreds of MB to stdout makes the daemon allocate the same amount at the end of the job, on a host that is already carrying the job's own memory.

**Fix:** scan the files line by line from a stream, and read only the head of `fix.stderr`.

#### MEM-5: An SSE client that stops reading queues events without limit

**Severity:** LOW | **Category:** Memory

`live/live-stream.ts` pushes every bus event and heartbeat to the subscriber. Nest writes them through `concatMap` and waits for `drain` (`@nestjs/core/router/router-response-controller.js:133`), so a connection whose peer has stopped reading keeps every later event in memory until the TCP connection times out. Events are small and streams are capped per user, so the exposure is limited.

**Fix:** complete the stream when its pending writes pass a threshold.

#### SEC-1: The VCS provider HTTP client is weaker than the fleet one

**Severity:** LOW | **Category:** Security / Reliability

`vcs/factory.ts:43-80` calls `fetch` with no timeout, default redirect following and an unbounded `response.json()`. `fleet/git-broker/fleet-http-client.ts` sets a timeout and `redirect: 'manual'` for the same kind of call. The API base URLs come from environment variables, so there is no user-controlled SSRF here; the gap is that polling, sync and commit-file fetches depend on the runtime's default timeout and will follow a redirect while carrying the connection token.

**Fix:** route the VCS providers through `FleetHttpClient`, or give the default client the same timeout and redirect policy.

### Still open from earlier reviews (low, verified present)

- **Credential socket request handling** (10-18 MEM-1): `apps/runner/src/credentials/cred-server.ts:56-70` starts a new reply poll for every chunk received after the first newline and applies the 64-byte limit only before a newline arrives.
- **`EntityStore`** (10-18 MEM-1): `apps/api/src/rag/entity-store.ts` has no removal for a deleted ticket; only `clear(projectId)` drops entries.

### Noted, no action proposed

- `bun audit` reports one high advisory, zod GHSA-mrhx-c7xc-m3w5, reaching the api through the MCP server and the runner through nax-agent. This is the alert dismissed by ruling on 11-26.

---

## Checked and found sound

- Deployment: api image runs as uid 1001; api and Ollama ports are published on loopback only; compose refuses to start without `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_SECRET` and `POSTGRES_PASSWORD`; access token default is 15 minutes; registration and MCP default to off.
- Request limits: JSON bodies capped at 1 MiB before parsing; bundle and log uploads stream to disk; bundle reader bounds entries, per-file bytes, total bytes and files per slot.
- Auth: password reset tokens are 32 random bytes stored as SHA-256, single use, throttled like login; session cache fill and eviction are serialised per session; MCP is agent-only, permission-gated and builds a per-request tool set.
- Secrets: AES-256-GCM with a fixed 16-byte tag check; git tokens stay in memory and are never logged; the runner socket directory must be owned by the daemon user with mode 0700.
- Webhooks: persisted delivery-id replay guard with a bounded in-memory fast path.
- In-process state in the api: webhook dedup maps, live buses, log publisher slots, byte-rate buckets, token cache, project brief cache, flow maps and keyed mutexes are all bounded or self-pruning. All 28 interval and cron timers are owned by services with a destroy hook.
- Runner: log shipper reads fixed-size windows, bundle upload streams from disk, approval receiver caps bodies at 64 KiB and verifies an HMAC before parsing.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | MEM-1 (steps 1, 2) | S | Filter extensions and cap file size and batch size before fetching commit files |
| P1 | MEM-1 (step 3) | M | Move extraction to a short-lived child process |
| P2 | MEM-2 | S | Switch to the small Prisma query compiler after a latency check on a test deployment |
| P2 | MEM-4 | S | Stream the runner's stdout and stderr marker scans |
| P3 | SEC-1 | S | Give the VCS HTTP client the fleet client's timeout and redirect policy |
| P3 | MEM-5 | S | Close an SSE stream whose write queue keeps growing |
| P3 | MEM-3 | M | Light nax-agent entry points for the runner daemon (needs nax work first) |

## Not verified

- No load test: every api number is idle or a single isolated call.
- Linux container numbers will differ from the macOS figures above; the direction should hold, the sizes may not.
- The cause of the 21 h baseline drift on the test deployment.
- Query latency with the small Prisma compiler.
- The whole api tree was not read line by line; authorization rules on individual routes were not re-audited (the 11-28 whole-repo review covers them).
