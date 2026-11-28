# SPEC: Review 11-28 memory and hardening bundle (api, runner)

Closes: #534

## Summary

This feature implements the findings of the 2026-11-28 focused review (koda #534 and #535) that are still open after the commit-indexer input limits (koda #534 steps 1 and 2, merged in #536). It is a bundle of five independent changes in two packages:

1. Commit-index extraction runs in a short-lived child process, so the TypeScript compiler's memory is returned to the OS (koda #534 step 3).
2. A live (SSE) stream ends when its client has stopped reading.
3. The VCS providers' default HTTP client gets a timeout and stops following redirects.
4. `EntityStore` drops the entity of a deleted ticket.
5. The runner scans job output files line by line with bounded memory, and its credential socket handles one request line per connection.

It completes koda #534: steps 1 and 2 are merged, and item 1 above is step 3. It relates to koda #535 without closing it, because #535 keeps two items this feature defers (see Out of Scope).

## Motivation

Measured on 2026-11-28 with Bun 1.4.5 on macOS arm64:

| Input to `CodeGraphService.extractBatch` (fresh process) | Peak RSS | RSS after GC |
|---|---:|---:|
| nothing | 18 MiB | 16 MiB |
| 12 TypeScript files, 31 KB | 215 MiB | 123 MiB |
| 3 large TypeScript files, 1.14 MB | 284 MiB | 111 MiB |

- **The compiler stays loaded.** After the first indexed commit the api process keeps about 100 MiB that it never returns, and extraction blocks the event loop while it runs. The planned production api container limit is 512 MiB.
- **A stalled SSE client accumulates events.** `createLiveStream` pushes every event and heartbeat; Nest writes them one at a time and waits for the socket to drain, so events for a client that no longer reads queue in memory until the TCP connection times out.
- **The VCS default HTTP client has no limits.** `createDefaultHttpClient` in `vcs/factory.ts` calls `fetch` with no timeout and follows redirects. The GitLab provider authenticates with a `PRIVATE-TOKEN` header, which `fetch` keeps when it follows a redirect to another origin. `FleetHttpClient` already uses a timeout and `redirect: 'manual'`.
- **`EntityStore` never forgets a ticket.** A `TICKET_DELETED` event re-reads the ticket instead of removing its entity.
- **The runner reads whole output files.** `readFixResult`, `reviewPosted` and `HostExecutor.readFixOutcome` load a complete nax output file to find one line.
- **The credential socket re-runs a request per chunk.** `serveRequest` starts a new reply for every chunk that arrives after the first newline while the first reply is pending, and keeps appending to its buffer.

## Design

### Calls made in this spec

**Extractors and the extraction child (US-001).**

- `CodeExtractor` is an abstract class with one method, `extract(files)`, returning a promise of `FileExtraction[]`. Two implementations:
  - `InProcessCodeExtractor` calls `CodeGraphService.extractBatch` in the api process.
  - `ChildProcessCodeExtractor` spawns one child process per `extract` call with `node:child_process` `spawn`, writes the request to the child's stdin, reads the response from its stdout, and the child exits.
- Wire protocol, UTF-8 JSON in both directions:
  - request: `{ "files": [{ "path": string, "content": string }] }`
  - response: `{ "results": FileExtraction[] }`, one result per request file, in request order
- `runExtractionRequest(input, graph)` is the child's logic as a pure function: it parses the request, calls `graph.extractBatch(files)` and returns the response string. The entry script `extraction-child.ts` imports `reflect-metadata` first, reads stdin to the end, writes `runExtractionRequest(...)` to stdout and exits 0; on a throw it writes the message to stderr and exits 1.
- `ChildProcessCodeExtractor` takes `(command, timeoutMs)`. The default command is `[process.execPath, join(__dirname, 'extraction-child.js')]`, which is the built script under `dist/code-intel/`. The default `timeoutMs` is `EXTRACTION_TIMEOUT_MS` (120,000). It is constructed by a factory, not by Nest's injector.
- One `ChildProcessCodeExtractor` runs at most one child at a time: an `extract` call made while another is running starts its child only after the earlier call has settled, whether it resolved or rejected. Calls run in the order they were made.
- `apps/api/scripts/check-extraction-child.cjs` is a build check, added to the `build` script after `check-compiler-load.cjs`. It runs the built `dist/code-intel/extraction-child.js` with one TypeScript file on stdin and asserts the response holds that file's symbol. It follows the pattern of `scripts/check-compiler-load.cjs`.

**Extraction mode and indexCommit (US-002).**

- Mode is read by `readCodeIntelConfig(env)` from `CODE_INTEL_EXTRACTION_MODE`: `child` (default when unset or empty) or `inprocess`. Any other value throws. `createCodeExtractor(config, graph)` returns the matching implementation. `CodeIntelModule` provides `CodeExtractor` through a factory that calls `createCodeExtractor(readCodeIntelConfig(process.env), graph)`.
- `apps/api/.env.test` sets `CODE_INTEL_EXTRACTION_MODE=inprocess`. Tests run the api from TypeScript source, where the built child script does not exist, so suites that index through the real module use the in-process extractor. `apps/api/.env.example` documents the variable.
- `AstIndexService.indexCommit` awaits `CodeExtractor.extract(files)` instead of calling `codeGraph.extractBatch(files)`. Everything after extraction is unchanged. When `extract` rejects, `indexCommit` rejects with the same error before it opens the transaction, so no symbol is deleted or written and the outbox retries the event. On the HTTP index route (`codeintel.index.write`) the rejection is not mapped: it propagates like any other unexpected error from `indexCommit`.

**Stalled live stream (US-003).**

- `LiveStreamOptions` gains an optional `isStalled: () => boolean`. On each heartbeat tick that passes the existing `done` and `checking` guard, `createLiveStream` reads it first; a tick that guard skips is not counted. When it returns true on two consecutive ticks, the stream completes on the second tick without checking access and without sending a ping. A false reading resets the count. Without `isStalled` the stream behaves as today.
- `socketHasBacklog(req, res)` returns a function that reports whether the client has unsent bytes. It reads the raw HTTP response first — `res.writableLength > 0`, passed by the route from `@Res({ passthrough: true })` — and then the request's socket: `req.raw.socket.writableLength > 0` for a Fastify request, `req.socket.writableLength > 0` for a plain Node request, and false when neither is present. It reads both on every call. The response reading is the one that works on the runtime the api ships on (koda #538): the container runs Bun, which buffers an HTTP response's writes on the response and leaves the socket's `writableLength` at 0 however much is queued.
- A connection has unsent bytes only while the client's send buffer is full, so two readings one heartbeat apart (25 s by default) mean the client is not reading. A browser `EventSource` reconnects by itself.
- The four SSE routes pass `isStalled: socketHasBacklog(req, reply?.raw)`, with `reply` from `@Res({ passthrough: true })`.

**VCS HTTP client (US-004).**

- `createDefaultHttpClient(options?)` is exported from `vcs/factory.ts` and takes `{ timeoutMs?: number }`, default `VCS_HTTP_TIMEOUT_MS` (30,000).
- `get` and `post` pass `redirect: 'manual'` and `signal: AbortSignal.timeout(timeoutMs)` to `fetch`.
- A 3xx response is not followed. It takes the existing not-ok path, so the call rejects with the error `httpError` builds, whose `response.status` is the 3xx status.

**EntityStore (US-005).**

- `EntityStore.removeEntity(projectId, id)` deletes one ticket entity of that project and does nothing when it is absent. Entities of other projects and `code_module` entities are not touched.
- `handleOutboxEvent` for a `ticket_event` whose payload `action` is `'TICKET_DELETED'` and that carries a string `ticketId` and `projectId` calls `removeEntity(projectId, ticketId)` and returns, without reading the ticket. This check comes before the existing `payload.ticket` branch.

**Runner (US-006).**

- `scanLines(path, onLine)` in `src/verdict/scan-lines.ts` reads a file as a stream and calls `onLine` once per line, without the line terminator (`\n` or `\r\n`). It resolves `false` when the file does not exist and `true` otherwise. `onLine` may return `'stop'` to end the scan. A line longer than `MAX_SCAN_LINE_BYTES` (65,536) is delivered once, cut to its first `MAX_SCAN_LINE_BYTES` bytes; the rest of that line is skipped and the next line is delivered normally.
- `readFixResult`, `reviewPosted` and the `fix.stderr` read in `HostExecutor.readFixOutcome` use `scanLines`. Their results are unchanged: `readFixResult` still keeps the first log marker and the last matching result line, and the existing `fix-result.spec.ts`, `fix-result.fix-ready.spec.ts` and `review-posted.spec.ts` pass without edits. The `fix.stderr` scan stops at the first non-blank line.
- `serveRequest` in `credentials/cred-server.ts` reads one request line per connection. Once a newline has arrived it calls `request` once with the text before that newline, trimmed, and ignores every later chunk.

### Integration

Read only (verified 2026-11-28 at `745e6b072`):

```ts
// apps/api/src/code-intel/code-graph.service.ts
export type FileExtraction = { path: string; symbols: ExtractedSymbol[] } | { path: string; error: string };
extractBatch(files: ReadonlyArray<{ path: string; content: string }>): FileExtraction[]   // synchronous

// apps/api/src/live/live-stream.ts
export function createLiveStream<E extends LiveStreamEvent = LiveEvent>(options: LiveStreamOptions<E>): Observable<MessageEvent>

// apps/api/src/rag/entity-store.ts
indexEntity(projectId: string, entity: Entity): void
searchEntities(projectId: string, query: string): ScoredEntity[]
handleOutboxEvent(event: { eventType: string; payload: unknown }): Promise<void>

// apps/api/src/events/outbox-envelope.util.ts: a ticket_event payload carries
// { id, type: 'ticket_event', action, timestamp, ticketId, projectId, actorId, actorType, data }

// apps/runner/src/credentials/cred-server.ts
export const MAX_REQUEST_BYTES = 64;
export function serveRequest<T>(socket: RequestSocket, request: (line: string) => Promise<T> | null, replies: Replies<T>): void

// apps/runner/src/verdict/fix-result.ts, review-posted.ts
export async function readFixResult(stdoutPath: string, prNumber: number): Promise<FixResult>
export async function reviewPosted(stdoutPath: string): Promise<boolean>
```

Changed. The baseline only locates the code; implement the target.

- `AstIndexService` constructor
  - Baseline: `(codeGraph: CodeGraphService, symbolStore: SymbolStore, txManager: ITransactionManager)`
  - Target: `(codeGraph: CodeGraphService, symbolStore: SymbolStore, txManager: ITransactionManager, extractor: CodeExtractor)`. `codeGraph` stays because `resolveRelationships` is still called on it.
- `AstIndexService.indexCommit`
  - Baseline: `const extractions = this.codeGraph.extractBatch(files)`
  - Target: `const extractions = await this.extractor.extract(files)`; signature unchanged.
- `LiveStreamOptions`
  - Baseline: `{ key, heartbeatMs, expiresAtMs, now, subscribe, stillAllowed, onClose }`
  - Target: the same fields plus optional `isStalled?: () => boolean`.
- `createDefaultHttpClient` in `apps/api/src/vcs/factory.ts`
  - Baseline: module-private `function createDefaultHttpClient(): HttpClient`
  - Target: `export function createDefaultHttpClient(options?: { timeoutMs?: number }): HttpClient`

New symbols:

```ts
// apps/api/src/code-intel/code-extractor.ts
export abstract class CodeExtractor {
  abstract extract(files: ReadonlyArray<{ path: string; content: string }>): Promise<FileExtraction[]>;
}
export class InProcessCodeExtractor extends CodeExtractor { constructor(graph: Pick<CodeGraphService, 'extractBatch'>) }
export type CodeExtractionFailure = 'spawn' | 'exit' | 'timeout' | 'protocol';
export class CodeExtractionError extends Error { readonly reason: CodeExtractionFailure }

// apps/api/src/code-intel/extraction-protocol.ts
export function runExtractionRequest(input: string, graph: Pick<CodeGraphService, 'extractBatch'>): string

// apps/api/src/code-intel/child-process-code-extractor.ts
export const EXTRACTION_TIMEOUT_MS = 120_000;
export class ChildProcessCodeExtractor extends CodeExtractor { constructor(command?: readonly string[], timeoutMs?: number) }

// apps/api/src/code-intel/code-intel.config.ts
export type CodeExtractionMode = 'child' | 'inprocess';
export function readCodeIntelConfig(env: Record<string, string | undefined>): { extractionMode: CodeExtractionMode }
export function createCodeExtractor(config: { extractionMode: CodeExtractionMode }, graph: CodeGraphService): CodeExtractor

// apps/api/src/live/socket-backlog.ts
export function socketHasBacklog(req: unknown): () => boolean

// apps/api/src/rag/entity-store.ts
removeEntity(projectId: string, id: string): void

// apps/runner/src/verdict/scan-lines.ts
export const MAX_SCAN_LINE_BYTES = 65_536;
export function scanLines(path: string, onLine: (line: string) => void | 'stop'): Promise<boolean>
```

Patterns to follow:

- api tests are Vitest (`vi.*`); services with constructor-only dependencies are built with `new`, as `ast-index.batch.spec.ts` does. Runner tests are `bun:test` and prefer real temp files.
- `ChildProcessCodeExtractor` tests pass their own `command`: `[process.execPath, <a .cjs fixture script written to a temp directory>]`. They never run the real child script. These tests spawn real processes, so their `describe` block is skipped inside a nax session sandbox with `describe.skipIf(isNaxSandboxed())`, importing `isNaxSandboxed` from `apps/api/test/helpers/test-environment.ts` (the runner's real-process suites use the same shared helper); the declared `testScoped` command runs them on the host.
- `apps/runner/src/credentials/provider-key-server.spec.ts` has the `FakeSocket` stand-in for `RequestSocket`; the `serveRequest` tests reuse that shape.
- The SSE controller specs (`live.controller.spec.ts` and its three siblings) already build each controller and call `events(...)`.

### Failure Handling

| Case | Behaviour |
|---|---|
| The child cannot be spawned | `extract` rejects with `CodeExtractionError`, `reason` `'spawn'` |
| The child exits with a non-zero code | rejects, `reason` `'exit'` |
| Writing the request to the child's stdin fails because the child already exited (`EPIPE`) | rejects, `reason` `'exit'`; no `error` event is left unhandled on the child's stdin |
| The child is still running after `timeoutMs` | the child is killed with `SIGKILL`; rejects, `reason` `'timeout'` |
| The child's stdout is not JSON, has no `results` array, or `results.length` differs from `files.length` | rejects, `reason` `'protocol'` |
| `runExtractionRequest` receives input that is not JSON or whose `files` is not an array | throws an `Error` |
| `CodeExtractor.extract` rejects inside `indexCommit` | `indexCommit` rejects with the same error; no `deleteByFile`, no `upsertSymbol`, the transaction is not opened |
| `CODE_INTEL_EXTRACTION_MODE` holds another value | `readCodeIntelConfig` throws an `Error` that names the variable |
| A VCS `fetch` does not answer within `timeoutMs` | the call rejects |
| A VCS endpoint answers 3xx | the call rejects with an error whose `response.status` is that status |
| `scanLines` on a missing file | resolves `false`, `onLine` never called |
| `scanLines` on a path that cannot be opened or read for another reason (for example a directory) | rejects with that error, as the three callers' reads do today |
| `TICKET_DELETED` for a ticket the store does not hold | `handleOutboxEvent` resolves, nothing changes |

## Out of Scope

- Switching the api to Prisma's small query compiler build (review MEM-2, part of #535): it needs a query-latency check on a live deployment first and is a manual change.
- Bounding the stdout that `createGit().run` buffers when no `onStdout` consumer is passed (`apps/runner/src/executor/git.ts`, part of #535).
- Light entry points in `@nathapp/nax-agent` for the runner daemon (review MEM-3): tracked in the nax repository.
- Filtering and capping the commit indexer's input (koda #534 steps 1 and 2): shipped separately; `code-commit-outbox-handler.ts` is not changed here.
- A pool of extraction processes, a resident worker, worker threads or parallel extraction: one child per `extract` call.
- Routing the VCS providers through `FleetHttpClient`, and capping the size of a VCS response body.
- Following a same-origin redirect in the VCS client: a renamed repository that answers 301 now fails until its connection URL is updated.
- Memory or timing assertions in tests: the measurements in Motivation are evidence, not acceptance criteria.
- Removing a deleted project's entities from `EntityStore`: `clear(projectId)` already exists and its callers are unchanged.
- US-001 only: resource limits on the child process other than the timeout.
- US-001 only: a cap on the bytes read from the child's stdout; the request is already bounded by the indexer's batch limits (#536).
- US-006 only: where `scanLines` cuts a line longer than the cap when the cut falls inside a multi-byte UTF-8 character; the three callers match ASCII markers at the start of a line.
- US-001 only: a test of the `extraction-child.ts` entry script's exit code 1 on a throw; `runExtractionRequest` is tested directly and the build check covers the success path.
- US-003 only: a test of a heartbeat tick that the `checking` guard skips; the rule is stated in Design and the counted ticks are tested.
- US-003 only: confirming under Bun in a deployed container that a stalled client's connection reports unsent bytes; that is a manual live check after deploy. The same check run locally against Bun 1.4.5 and the Fastify adapter (finishing this feature, koda #538) found the socket reading dead on that runtime — 131 MB queued for a non-reading client with `socket.writableLength` still 0, while the response reported 12.5 MB — so `socketHasBacklog` now reads the response first. Only the deployed confirmation is still deferred.
- US-005 only: an entity of another source (for example a `code_module`) that shares a ticket's id; `removeEntity` removes ticket entities only.
- US-006 only: authenticating the peer of a credential socket; by ruling of 2026-11-01 job placement is the isolation control.
- US-006 only: any change to which token a credential socket answers with, or to its expiry handling.

## Stories

Six stories. US-001 and US-002 are one capability; the other four are independent of it and of each other.

**US-001: Code extractors and the extraction child.** Workdir: `apps/api`. No dependencies.
Adds `CodeExtractor`, `InProcessCodeExtractor`, `CodeExtractionError`, `runExtractionRequest`, the `extraction-child.ts` entry script, `ChildProcessCodeExtractor` and the `check-extraction-child.cjs` build check wired into the `build` script of `apps/api/package.json`. Nothing uses them yet.
Verification note: `bun run --cwd apps/api build` runs `scripts/check-extraction-child.cjs` against the built child script.

**US-002: indexCommit extracts through CodeExtractor.** Workdir: `apps/api`. Depends on US-001.
Adds `readCodeIntelConfig` and `createCodeExtractor`, provides `CodeExtractor` in `CodeIntelModule`, switches `AstIndexService.indexCommit` to it, sets `CODE_INTEL_EXTRACTION_MODE=inprocess` in `apps/api/.env.test` and documents the variable in `apps/api/.env.example`.

**US-003: A live stream ends for a stalled client.** Workdir: `apps/api`. No dependencies.
Adds `isStalled` to `createLiveStream`, adds `socketHasBacklog`, and passes it from the four SSE routes.

**US-004: VCS default HTTP client timeout and no redirects.** Workdir: `apps/api`. No dependencies.
Exports `createDefaultHttpClient` with a timeout option and `redirect: 'manual'`.

**US-005: EntityStore drops a deleted ticket.** Workdir: `apps/api`. No dependencies.
Adds `EntityStore.removeEntity` and the `TICKET_DELETED` branch in `handleOutboxEvent`.

**US-006: Runner line scanning and single-request credential socket.** Workdir: `apps/runner`. No dependencies.
Adds `scanLines`, uses it in `readFixResult`, `reviewPosted` (`apps/runner/src/verdict/review-posted.ts`) and `HostExecutor.readFixOutcome`, and makes `serveRequest` handle one request line per connection.

### Context Files

**US-001**
- `apps/api/src/code-intel/code-graph.service.ts` — `extractBatch` and `FileExtraction`, called by both extractors
- `apps/api/scripts/check-compiler-load.cjs` — the build-check pattern to follow
- `apps/api/package.json` — the `build` script the new check is added to

**US-002**
- `apps/api/src/code-intel/ast-index.service.ts` — `indexCommit` being changed
- `apps/api/src/code-intel/code-intel.module.ts` — where `CodeExtractor` is provided
- `apps/api/src/code-intel/code-extractor.ts` — created by US-001, consumed here
- `apps/api/src/code-intel/child-process-code-extractor.ts` — created by US-001, returned by `createCodeExtractor`
- `apps/api/src/code-intel/code-commit-outbox-handler.spec.ts` — the handler setup AC-8 reuses (mocked `decryptToken` and `createVcsProvider`, connection and config stubs)

**US-003**
- `apps/api/src/live/live-stream.ts` — `createLiveStream` being changed
- `apps/api/src/live/live.controller.ts` — SSE route, passes `isStalled`
- `apps/api/src/live/me-live.controller.ts` — SSE route, passes `isStalled`
- `apps/api/src/fleet/threads/thread-events.controller.ts` — SSE route, passes `isStalled`
- `apps/api/src/fleet/threads/workspace-thread-events.controller.ts` — SSE route, passes `isStalled`

**US-004**
- `apps/api/src/vcs/factory.ts` — `createDefaultHttpClient` and `createVcsProvider`
- `apps/api/src/fleet/git-broker/fleet-http-client.ts` — the timeout and redirect policy to mirror
- `apps/api/src/vcs/factory.spec.ts` — existing factory tests

**US-005**
- `apps/api/src/rag/entity-store.ts` — the store being changed
- `apps/api/src/rag/rag.module.ts` — `EntityStoreWarmup`, which registers the `ticket_event` handler
- `apps/api/src/rag/entity-store.spec.ts` — existing store tests

**US-006**
- `apps/runner/src/verdict/fix-result.ts` — `readFixResult`
- `apps/runner/src/executor/host-executor.ts` — `readFixOutcome` and its `fix.stderr` read
- `apps/runner/src/credentials/cred-server.ts` — `serveRequest`
- `apps/runner/src/verdict/review-posted.ts` — `reviewPosted`
- `apps/runner/test/unit/host-executor.spec.ts` — existing `readFixOutcome` tests and their executor fixture; AC-8 is added here

### Creates

**US-001**
- `apps/api/src/code-intel/code-extractor.ts` — `CodeExtractor`, `InProcessCodeExtractor`, `CodeExtractionError`
- `apps/api/src/code-intel/extraction-protocol.ts` — `runExtractionRequest`
- `apps/api/src/code-intel/extraction-child.ts` — the child entry script
- `apps/api/src/code-intel/child-process-code-extractor.ts` — `ChildProcessCodeExtractor`
- `apps/api/src/code-intel/code-extractor.spec.ts` — tests for the in-process extractor and the protocol
- `apps/api/src/code-intel/child-process-code-extractor.spec.ts` — tests against fixture child scripts
- `apps/api/scripts/check-extraction-child.cjs` — build check for the built child script

**US-002**
- `apps/api/src/code-intel/code-intel.config.ts` — `readCodeIntelConfig`, `createCodeExtractor`
- `apps/api/src/code-intel/code-intel.config.spec.ts` — tests for both functions
- `apps/api/src/code-intel/ast-index.extractor.spec.ts` — tests for `indexCommit` over `CodeExtractor`

**US-003**
- `apps/api/src/live/socket-backlog.ts` — `socketHasBacklog`
- `apps/api/src/live/socket-backlog.spec.ts` — its tests
- `apps/api/src/live/live-stream.stalled.spec.ts` — tests for `isStalled`

**US-004**
- `apps/api/src/vcs/default-http-client.spec.ts` — tests for `createDefaultHttpClient`

**US-005**
- `apps/api/src/rag/entity-store.ticket-deleted.spec.ts` — tests for removal

**US-006**
- `apps/runner/src/verdict/scan-lines.ts` — `scanLines`
- `apps/runner/src/verdict/scan-lines.spec.ts` — its tests
- `apps/runner/src/verdict/scan-callers.spec.ts` — the large-file tests for `readFixResult` and `reviewPosted` (AC-5 to AC-7)
- `apps/runner/src/credentials/cred-server.request-line.spec.ts` — tests for single-request handling

### Modifies

US-001, US-003, US-004 and US-005 change no existing test: each adds behaviour behind a new symbol or an optional field, and the existing assertions keep holding.

**US-002**
- `apps/api/src/code-intel/ast-index.service.spec.ts` — it builds `new AstIndexService(codeGraph, symbolStore, txManager)` with three arguments; it passes a fourth, an extractor whose `extract` resolves with `codeGraph.extractBatch(files)`, so its existing assertions on `extractBatch` and on the index result keep holding. The replacing invariant is US-002 AC-7.
- `apps/api/src/code-intel/ast-index.batch.spec.ts` — its four `new AstIndexService(graph, store, tx)` calls pass a fourth argument, an extractor whose `extract` resolves with `graph.extractBatch(files)`; its assertions that `graph.extractBatch` is called once with the files stay true through that extractor. The replacing invariant is US-002 AC-7.
- `apps/api/src/code-intel/ast-index.project-scope.spec.ts` — its `new AstIndexService(graph, store, tx)` call passes a fourth argument, an extractor whose `extract` resolves with `graph.extractBatch(files)`; the delete-before-upsert order and project-scoped id assertions stay unchanged.
- `apps/api/test/unit/ast-index.service.unit.spec.ts` — it builds `AstIndexService` through `Test.createTestingModule` with a `providers` list that has no `CodeExtractor`, so the module no longer compiles; it adds a `CodeExtractor` provider whose `extract` calls `mockCodeGraph.extractBatch(files)` at call time (the tests reassign that mock's return value per case) and resolves with the result. Its assertions on `extractBatch` stay true through that extractor.

**US-006**
- `apps/runner/test/unit/host-executor.spec.ts` — no existing assertion changes; the story appends one `readFixOutcome` case (US-006 AC-8) that reuses the file's executor fixture.

### Seams

- US-002 consumes `CodeExtractor`, `InProcessCodeExtractor` and `ChildProcessCodeExtractor` (US-001). US-002 AC-7 stubs `CodeExtractor.extract` and drives `AstIndexService.indexCommit`; US-002 AC-8 enters one level higher, at `CodeCommitOutboxHandler.process`, the handler the `code_commit` outbox event reaches, with a real `AstIndexService` behind it. US-002 AC-6 proves the module provides the extractor that `readCodeIntelConfig` selects: `.env.test` sets `inprocess`, so the test stubs `child` to show the factory reads the environment.
- US-003 wires `socketHasBacklog` into four existing routes. AC-10 to AC-13 call each controller's `@Sse()` method, the method Nest invokes for the route, and observe the returned stream. AC-10 and AC-11 reuse the request the existing controller specs build (a Bearer JWT header) and add `raw.socket`. AC-12 and AC-13 pre-set `req.threadEvents` and `req.workspaceThreadEvents`, which the route guards set in production, and cast the request to add `raw.socket`.
- US-004: `createVcsProvider` already calls `createDefaultHttpClient()` when no `httpClient` is supplied; AC-6 enters at `createVcsProvider`.
- US-005: `EntityStoreWarmup.onModuleInit` already registers the `ticket_event` handler on `FanOutPublisher` and forwards to `EntityStore.handleOutboxEvent`; AC-7 enters at the registered handler.
- US-006: `HostExecutor.readReviewPosted` and `HostExecutor.readFixOutcome` already call `reviewPosted` and `readFixResult`; AC-8 enters at `readFixOutcome`.

## Acceptance Criteria

### US-001

- AC-1 [unit] `new InProcessCodeExtractor(graph).extract(files)`, with `graph.extractBatch` stubbed to return `[{ path: 'src/a.ts', symbols: [] }]`, resolves with that array and calls `graph.extractBatch` exactly once with `files`.
- AC-2 [unit] `runExtractionRequest` given the JSON text of `{ files: [{ path: 'src/a.ts', content: 'export function a() {}' }] }` and a real `CodeGraphService` returns a JSON string that parses to an object whose `results` has one entry with `path` `'src/a.ts'` and a symbol named `a`.
- AC-3 [unit] `runExtractionRequest('not json', graph)` throws an `Error`.
- AC-4 [unit] `runExtractionRequest` given the JSON text of `{ files: 'x' }` throws an `Error`.
- AC-5 [unit] A `ChildProcessCodeExtractor` whose command runs a fixture script that reads the request from stdin and prints `{ results }` with one `{ path, symbols: [] }` per request file resolves `extract([{ path: 'a.ts', content: 'A' }, { path: 'b.ts', content: 'B' }])` with two results whose paths are `['a.ts', 'b.ts']` in that order.
- AC-6 [unit] `new ChildProcessCodeExtractor(['/nonexistent/koda-extraction-binary']).extract([{ path: 'a.ts', content: 'A' }])` rejects with a `CodeExtractionError` whose `reason` is `'spawn'`.
- AC-7 [unit] With a fixture script that exits with code 3, `extract` of one file rejects with a `CodeExtractionError` whose `reason` is `'exit'`.
- AC-8 [unit] With a fixture script that writes its process id to a file and then never exits, and `timeoutMs` 2000, `extract` of one file rejects with a `CodeExtractionError` whose `reason` is `'timeout'`.
- AC-9 [unit] With a fixture script that writes its process id to a file and then never exits, and `timeoutMs` 2000, once `extract` of one file has rejected the process id file exists, and within one second the process with that id no longer exists.
- AC-10 [unit] With a fixture script that prints `not json` and exits 0, `extract` of one file rejects with a `CodeExtractionError` whose `reason` is `'protocol'`.
- AC-11 [unit] With a fixture script that prints `{"results":[]}` and exits 0, `extract` of one file rejects with a `CodeExtractionError` whose `reason` is `'protocol'`.
- AC-12 [unit] With a fixture script that prints `{"ok":true}` and exits 0, `extract` of one file rejects with a `CodeExtractionError` whose `reason` is `'protocol'`.
- AC-13 [unit] With a fixture script that exits with code 0 at once without reading stdin, `extract` of one file whose `content` is 2,000,000 characters rejects with a `CodeExtractionError` whose `reason` is `'exit'`, and no `uncaughtException` is raised in the test process.
- AC-14 [unit] With a fixture script that appends a `start` line to a log file, waits 300 ms, appends an `end` line and prints a valid response, two `extract` calls made on one `ChildProcessCodeExtractor` without awaiting the first both resolve, and the log file reads `start`, `end`, `start`, `end`.

### US-002

- AC-1 [unit] `readCodeIntelConfig({})` and `readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: '' })` each return `{ extractionMode: 'child' }`.
- AC-2 [unit] `readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: 'inprocess' })` returns `{ extractionMode: 'inprocess' }`.
- AC-3 [unit] `readCodeIntelConfig({ CODE_INTEL_EXTRACTION_MODE: 'thread' })` throws an `Error` whose message contains `CODE_INTEL_EXTRACTION_MODE`.
- AC-4 [unit] `createCodeExtractor({ extractionMode: 'inprocess' }, new CodeGraphService())` returns an instance of `InProcessCodeExtractor`.
- AC-5 [unit] `createCodeExtractor({ extractionMode: 'child' }, new CodeGraphService())` returns an instance of `ChildProcessCodeExtractor`.
- AC-6 [unit] With `CODE_INTEL_EXTRACTION_MODE` stubbed to `child` through `vi.stubEnv` before the module is compiled and restored after the test, a testing module compiled from `GlobalStubsModule` and `CodeIntelModule` (as `code-intel.module.spec.ts` does) returns an instance of `ChildProcessCodeExtractor` for `moduleRef.get(CodeExtractor)`; constructing it spawns nothing.
- AC-7 [unit] With an extractor whose `extract` resolves with one `symbols` result per file, `indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'A' }, { path: 'src/b.ts', content: 'B' }], 'proj-1')` calls `extract` exactly once with those two files in that order, and never calls `codeGraph.extractBatch`.
- AC-8 [unit] With a `CodeCommitOutboxHandler` built over a real `AstIndexService` (a real `CodeGraphService`, stub symbol store, pass-through transaction manager, stub extractor resolving one `symbols` result per file) a repository stub returning a VCS connection, a config with `encryptionKey` set, `decryptToken` mocked and `createVcsProvider` mocked to return a provider whose `fetchCommitFiles` resolves `[{ path: 'src/a.ts', content: 'A' }]` (the setup `code-commit-outbox-handler.spec.ts` uses), `process({ repoId: 'acme/widgets', commitHash: 'c1', ref: 'refs/heads/main', projectId: 'p1', changedFiles: ['src/a.ts'] })` calls the extractor's `extract` once with `[{ path: 'src/a.ts', content: 'A' }]`.
- AC-9 [unit] When `extract` rejects with `new CodeExtractionError(...)` of reason `'timeout'`, `indexCommit` rejects with that same error instance.
- AC-10 [unit] When `extract` rejects with a `CodeExtractionError`, `indexCommit` never calls `symbolStore.deleteByFile` or `symbolStore.upsertSymbol`.
- AC-11 [unit] When `extract` rejects with a `CodeExtractionError`, `indexCommit` never calls the transaction manager's `run`.

### US-003

- AC-1 [unit] A stream from `createLiveStream` with `isStalled` always returning true completes on its second heartbeat tick, and `onClose` is called once.
- AC-2 [unit] For a stream from `createLiveStream` with `isStalled` always returning true, `stillAllowed` is called on the first heartbeat tick and not on the second.
- AC-3 [unit] For a stream from `createLiveStream` with `isStalled` always returning true, no `ping` event is emitted on the second heartbeat tick.
- AC-4 [unit] With `isStalled` returning true, false, true on three consecutive ticks and `stillAllowed` resolving true, the stream is not completed after the third tick.
- AC-5 [unit] With no `isStalled` option and `stillAllowed` resolving true, three heartbeat ticks emit three `ping` events and the stream is not completed.
- AC-6 [unit] `socketHasBacklog({ raw: { socket: { writableLength: 10 } } })()` returns true.
- AC-7 [unit] `socketHasBacklog({ socket: { writableLength: 10 } })()` returns true.
- AC-8 [unit] For a request object whose `raw.socket.writableLength` is 0, the function `socketHasBacklog` returned gives false, and gives true after that `writableLength` is set to 5 without calling `socketHasBacklog` again.
- AC-9 [unit] `socketHasBacklog({})()` returns false.
- AC-10 [unit] The stream `LiveController.events` returns for a request whose `raw.socket.writableLength` stays 5 completes after two heartbeat intervals.
- AC-11 [unit] The stream `MeLiveController.events` returns for a request whose `raw.socket.writableLength` stays 5 completes after two heartbeat intervals.
- AC-12 [unit] The stream `ThreadEventsController`'s `@Sse()` method returns for a request whose `raw.socket.writableLength` stays 5 completes after two heartbeat intervals.
- AC-13 [unit] The stream `WorkspaceThreadEventsController`'s `@Sse()` method returns for a request whose `raw.socket.writableLength` stays 5 completes after two heartbeat intervals.

### US-004

- AC-1 [unit] With the global `fetch` stubbed to resolve a 200 JSON response, `createDefaultHttpClient().get('https://api.example.test/x', { headers: {} })` calls `fetch` with `redirect` equal to `'manual'` and a `signal` that is an `AbortSignal`.
- AC-2 [unit] With the same stub, `createDefaultHttpClient().post('https://api.example.test/x', { headers: {}, body: {} })` calls `fetch` with `redirect` equal to `'manual'` and a `signal` that is an `AbortSignal`.
- AC-3 [unit] With `fetch` stubbed to resolve a response of status 302, `createDefaultHttpClient().get(...)` rejects with an error whose `response.status` is 302.
- AC-4 [unit] With `fetch` stubbed to stay pending until its `signal` aborts and then reject, `createDefaultHttpClient({ timeoutMs: 50 }).get(...)` rejects within one second.
- AC-5 [unit] With the same stub, `createDefaultHttpClient({ timeoutMs: 50 }).post(...)` rejects within one second.
- AC-6 [unit] With `fetch` stubbed to resolve `{ default_branch: 'main' }`, `createVcsProvider('github', { provider: 'github', token: 't', repoUrl: 'https://github.com/acme/widgets' }).getDefaultBranch()` calls `fetch` with `redirect` equal to `'manual'`.

### US-005

- AC-1 [unit] After `indexEntity('p1', { id: 't1', label: 'Login bug', tags: ['login', 'bug'], source: 'ticket', sourceId: 't1' })`, `removeEntity('p1', 't1')` makes `searchEntities('p1', 'login')` return an empty array.
- AC-2 [unit] `removeEntity('p1', 'missing')` on an empty store returns without throwing.
- AC-3 [unit] With ticket `t1` indexed for both `p1` and `p2`, `removeEntity('p1', 't1')` leaves `getAllEntities('p2')` holding the entity with id `t1`.
- AC-4 [unit] With entities `t1` and `t2` indexed for `p1`, `handleOutboxEvent({ eventType: 'ticket_event', payload: { action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' } })` leaves `getAllEntities('p1')` holding only the entity with id `t2`.
- AC-5 [unit] With a rag repository stub supplied to the store and `t1` indexed for `p1`, `handleOutboxEvent` for a `ticket_event` with `action` `'TICKET_DELETED'`, `ticketId` `'t1'` and `projectId` `'p1'` never calls `findTicketById`.
- AC-6 [unit] `handleOutboxEvent` for a `ticket_event` with `action` `'TICKET_UPDATED'`, `ticketId` `'t3'` and `projectId` `'p1'`, with `findTicketById` resolving `{ id: 't3', title: 'Export report' }`, makes `searchEntities('p1', 'export')` return the entity with id `t3`.
- AC-7 [unit] With an `EntityStoreWarmup` built over a real `EntityStore` holding ticket `t1` for `p1` and a `FanOutPublisher` stub that records registered handlers, after `onModuleInit()` calling the handler registered for `ticket_event` with `{ action: 'TICKET_DELETED', ticketId: 't1', projectId: 'p1' }` makes `searchEntities('p1', 'login')` return an empty array for a ticket labelled `Login bug`.
- AC-8 [unit] With only `t2` indexed for `p1`, `handleOutboxEvent` for a `ticket_event` with `action` `'TICKET_DELETED'`, `ticketId` `'unknown'` and `projectId` `'p1'` resolves and `getAllEntities('p1')` still holds exactly the entity with id `t2`.

### US-006

- AC-1 [unit] `scanLines` on a path that does not exist resolves `false` and never calls `onLine`.
- AC-2 [unit] `scanLines` on a file holding `a`, a line feed, `b`, a carriage return and line feed, then `c` calls `onLine` with `'a'`, `'b'`, `'c'` in that order and resolves `true`.
- AC-3 [unit] When `onLine` returns `'stop'` for the first line of a three-line file, `onLine` is called exactly once.
- AC-4 [unit] For a file whose first line is 200,000 `x` characters and whose second line is `tail`, `scanLines` calls `onLine` twice: first with a string of `MAX_SCAN_LINE_BYTES` `x` characters, then with `'tail'`.
- AC-5 [unit] Regression guard for existing behaviour: `readFixResult(path, 7)` on a file of 50,000 filler lines followed by the line `nax bot fix: PR #7 — pushed abc` returns `kind` `'pushed'`.
- AC-6 [unit] Regression guard for existing behaviour: `reviewPosted(path)` on a file of 50,000 filler lines followed by a line starting with `nax bot review: artifact ` resolves `true`.
- AC-7 [unit] Regression guard for existing behaviour: `reviewPosted(path)` on a path that does not exist resolves `false`.
- AC-8 [unit] Regression guard for existing behaviour: `HostExecutor.readFixOutcome` for a job whose `fix.stderr` holds two blank lines, the line `fatal: push rejected`, then 20,000 further lines returns `stderrLine` `'fatal: push rejected'`.
- AC-9 [unit] With `serveRequest` on a fake socket and a `request` function returning a promise that stays pending, sending the chunk `get` plus a line feed and then the same chunk again calls `request` exactly once.
- AC-10 [unit] With `serveRequest` on a fake socket and a `request` function returning a promise that stays pending, after the chunk `get` plus a line feed and then ten further chunks of 1,024 bytes each that each contain a line feed, `request` has still been called exactly once; after the pending promise resolves, the socket's `end` is called exactly once, with the JSON of the resolved value followed by a line feed.
- AC-11 [unit] Regression guard for existing behaviour: sending the single chunk `get`, a line feed, then `extra` calls `request` once with the line `'get'`.
- AC-12 [unit] Regression guard for existing behaviour: sending 65 bytes with no line feed answers the socket with the `badRequest` reply and never calls `request`.
- AC-13 [unit] `scanLines` on a path that is a directory rejects with an error.
- AC-14 [unit] `scanLines` on an empty file resolves `true` and never calls `onLine`.
