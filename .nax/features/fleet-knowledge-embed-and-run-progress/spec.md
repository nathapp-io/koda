# SPEC: Knowledge embedding fixes and workflow run progress

Closes: #286, #206

## Summary

Two fixes. First (#286), the knowledge index stops losing whole files to the embedder. The Markdown chunker enforces
its 2000-character cap on every chunk, Ollama embeds through its batch endpoint, and an embedding failure costs only
the chunks that failed. Second (#206), a workflow-mode RUN shows live progress after its stories finish. The runner
mirrors nax's `workflow.step` into the job, the job's phase falls back to that step when no story is current, and the
web job page gets a strip and phase labels that fit a workflow run.

## Motivation

- #286: on the koda-wk live check (koda `9ef6e27a`, Ollama `nomic-embed-text`) the chunker kept blank-line-free blocks
  whole, up to 20,055 characters against `MAX_CHUNK_CHARS = 2000`. Ollama refused the request (`input (6271 tokens) is
  too large to process`), and `KnowledgeRepoIndexer.rows` stored every chunk of the file unembedded (29 of 29 for two
  specs). An unembedded chunk ranks only through the lexical leg, so the file sank in unfiltered search. One
  `/api/embeddings` call per chunk, all in parallel, also made the first pass slow (0.6 chunks/s on CPU Ollama).
- #206: nax 0.88.0 (nathapp-io/nax#2356, in `v0.88.0`) writes `current.phase` on every phase change. In workflow
  mode, the default, those phases are `implement`, `gates`, `review`, `rereview`, `suite`, `residual`, `fix` and
  `closed`. After the last story `current` is `null` while nax runs the feature steps (`repo-gates`, `branch-review`,
  `branch-fix`, `branch-rereview`, `adjudicate`, `final-gates`, `gate-repair`, `publish`, `done`, in `workflow.step`),
  including a CI wait of up to 20 minutes. koda reads `workflow.step` only for the verdict, so the job page shows a
  blank phase for that stretch, and its strip (`Stories -> Acceptance -> Regression -> Finish`) shows a regression
  stage workflow mode skips and a finish stage it replaces.

## Design

### Rulings that bind every story

- R1: no Prisma migration. `FleetJob.postRun` is a `Json?` column, so the new `workflowStep` key rides in it.
- R2: every change to `@nathapp/fleet-protocol` is additive (an optional field).
- R3: ticket RAG is untouched. `EmbeddingService.embed` and `OllamaEmbeddingProvider.embed` keep `/api/embeddings`;
  only `embedBatch`, whose sole production caller is `KnowledgeRepoIndexer`, changes.
- R4: nax text the web does not recognise is shown raw, as today (D429).

### Decisions grounded in the code (this spec)

- D1 (chunk cap, US-001): `splitSections` (`apps/api/src/fleet/knowledge/markdown-chunker.ts:261-271`) keeps its
  blank-line packing (`splitText`, `:273-286`). A packed part longer than `MAX_CHUNK_CHARS` is re-split by walking its
  lines in order and appending each to the current part (joined with `\n`) while the part stays within the cap:
  1. Fences: a line is a fence opener or closer when `fenceMarker` (`:197-202`) matches, tracked as `textBlocks`
     (`:289-321`) tracks them, so a fence can start anywhere in the part, after prose or a heading. While a fence is
     open, a part's budget is the cap minus the length of the closing line it will end with plus one, so the close
     always fits; the closing line written at a split is the opener's marker (three backticks or three tildes, the same
     marker as the opener), and a part that reopens the fence counts its opening line inside its budget.
     When the next line does not fit inside an open fence, the current part is ended with a line holding the opening
     marker (three backticks or three tildes) and the next part starts with the fence's opening line as written.
  2. A line that does not fit, outside a fence, starts a new part when it is itself within the cap.
  3. A line longer than the cap (or than a fenced part's budget) first fills the current part's remaining space, then
     continues in new parts of the budget that applies to each part (the fenced budget, opener and closer counted,
     while a fence is open; the full cap otherwise). A cut never separates a UTF-16 surrogate pair: when the last kept code
     unit is a high surrogate, the cut moves one unit earlier. This applies inside fences too.
  Every split part keeps the section's `headingPath` and `anchor`. The heading glue (`glueHeadingBlock`, `:323-327`)
  stays, so by rule 3 a heading line leads the first part of its oversized paragraph and no part holds only the
  heading. The summary chunk (`buildSummary`, `:330-336`) is cut to `MAX_CHUNK_CHARS` with the same surrogate rule.
  Invariant: every chunk `text` is at most 2000 characters. The embedded content (repository, path and heading
  header, abstract, text) can exceed 2000 characters; D2's `truncate: true` covers it.
- D2 (Ollama batch, US-002): `OllamaEmbeddingProvider.embedBatch` sends one `POST <baseUrl>/api/embed` with JSON body
  `{ "model": <model>, "input": <texts>, "truncate": true }` and returns `embeddings` from the response
  `{ "embeddings": number[][] }`. An empty `texts` returns `[]` with no request. A non-OK response throws
  `ValidationAppException` (as `embed` does). A response whose `embeddings` is not an array of `texts.length` arrays
  throws `ValidationAppException`.
- D3 (indexer embedding, US-002): `KnowledgeRepoIndexer.rows` (`apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts:122-152`)
  embeds the file's chunk contents in order, in batches of `KNOWLEDGE_EMBED_BATCH = 16`, one request at a time (a
  deliberate exception to the `api-core.md` `Promise.all` guidance: the calls share one embedding server and the file
  deadline). The
  constants `EMBED_REQUEST_TIMEOUT_MS = 60_000` and `FILE_EMBED_DEADLINE_MS = 300_000` replace
  `EMBEDDING_TIMEOUT_MS = 120_000`. Per batch, in this order:
  1. Deadline: when `this.clock()` minus the clock reading taken at the start of `rows` is at least
     `FILE_EMBED_DEADLINE_MS`, this batch and every later one are unembedded with no request.
  2. Request: `this.embeddings.embedBatch(batch)` raced against `EMBED_REQUEST_TIMEOUT_MS`.
  3. Timeout: the whole batch is unembedded, with no per-chunk retry (a hung server must not cost 16 more timeouts).
  4. Validation: a resolved result with the wrong count, or a vector whose length is not `this.embeddings.dimensions`,
     is treated as a rejection.
  5. Rejection: each chunk of the batch is retried alone through `this.embeddings.embed(content)`, one at a time, each
     under the deadline check of step 1 and the timeout of step 2. A chunk whose retry rejects, times out or returns a
     vector of the wrong length is unembedded.
  An embedded chunk's row keeps `provider: this.embeddings.providerName`, `model: this.embeddings.modelName` and its
  vector; an unembedded chunk's row gets `provider: 'none'`, `model: ''` and a zero vector of
  `this.embeddings.dimensions`. The row order and ids are unchanged. `unembeddedCount` is the number of unembedded
  chunks. When at least one chunk is unembedded, the indexer logs exactly one warning for the file,
  `Knowledge file embedding failed for <n> of <m> chunks (repo <repoId>); storing unembedded chunks`, and never logs
  provider error text. The file deadline (300 s) is below the pass lease (`LEASE_MS = 900_000`, `:18`), so a file
  finishes embedding before the next renewal is due. The existing retry of files with `unembeddedCount > 0` on a
  later pass (`:67`, `:82`) is unchanged.
- D4 (protocol and server, US-003): `SnapshotEventPayload.postRun` (`packages/fleet-protocol/src/index.ts:163`) gains
  `workflowStep?: string`. `POST_RUN_STAGES` (`apps/api/src/fleet/sync/event-payloads.ts:32`) gains `'workflowStep'`,
  so `postRunStages` keeps it under the same `STAGE_STATUS_RE` (`:33`, 1 to 32 printable ASCII characters).
  `FleetJobPostRun` (`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts:28-32`) and `FleetJobPostRunDto`
  (`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:20-24`) gain `workflowStep?: string` (`maxLength: 32`). The existing
  rule that a present `postRun` replaces the stored one (D428) is unchanged. The sync route's established coverage is
  `test/integration/fleet/runner-sync.integration.spec.ts`; `test/e2e/api-endpoint/endpoint.e2e.spec.ts` covers `/fleet/runners`
  and the runner tool routes but no runner sync route and no job-detail route, so the changed response is pinned by
  the sync-route integration ACs (US-003) and the `fleet-openapi.contract.spec.ts` contract test, not by a new e2e
  section.
- D5 (runner, US-004): in `apps/runner/src/watcher/status-snapshot.ts`, `postRunStages` (`:30-40`) adds
  `['workflowStep', clip(status.workflow?.step, STAGE_STATUS_MAX)]`. `mapStatusToSnapshot` (`:42-62`) sets
  `currentPhase` to `status.current?.phase` when it is a string (a `current` without `phase` counts as absent); otherwise, when `status.run.status === 'running'` and
  `status.workflow` is present, to `clip(status.workflow.step, STAGE_STATUS_MAX)`; otherwise `null`. `currentStoryId`
  is unchanged (`status.current?.storyId ?? null`). `parseStatusView` already reads `workflow.step`
  (`apps/runner/src/verdict/status-view.ts`).
- D6 (web strip, US-005): `pipelineStages` (`apps/web/lib/fleet-story-graph.ts:184-204`) recognises a workflow-mode
  RUN when any of these holds: `job.postRun?.workflowStep` is a string; `job.workflow != null` (`StageJob`, `:181`,
  gains an optional `workflow?: FleetJobDto['workflow']`, so a caller that omits it is not workflow mode); `job.currentPhase`
  is one of `workflow`, `implement`, `gates`, `review`, `rereview`, `suite`, `residual`, `fix`, `closed`. A
  workflow-mode RUN gets five stages, `stories`, `acceptance`, `review`, `gates`, `publish`. `stories` and
  `acceptance` keep today's rules. The step groups are: `review` = `repo-gates`, `branch-review`, `branch-fix`,
  `branch-rereview`, `adjudicate`; `gates` = `final-gates`, `gate-repair`; `publish` = `publish`, `done`. With step
  `s` and `active = isActiveJobState(job.state)`:
  - `s` is `done`: `review` and `gates` are `passed`; `publish` follows `job.workflow?.outcome`: `ready` gives
    `passed`, `local-only` gives `failed`, `draft` gives the raw `draft`; with no workflow result (it is written only
    at bundle ingest) `publish` is `running` when active (for example UPLOADING) and `unknown` otherwise.
  - `s` is in a group: groups before it are `passed`; its own group is `running` when active, else `failed`; later
    groups are `pending` when active, else `skipped`.
  - `s` is absent or in no group: all three are `pending` when active, else `unknown`.
  Any other RUN keeps today's four stages. `StageKey` and `STAGE_KEYS` gain the new keys; the strip labels them from
  `fleet.jobs.detail.pipeline.stage.{review,gates,publish}` (en `Review`, `Gates`, `Publish`). The web `FleetJobPostRunDto`
  type (`apps/web/lib/fleet-types.ts:205-209`) gains `workflowStep?: string`.
- D7 (web phase labels, US-006): a new `apps/web/lib/fleet-phase.ts` exports `KNOWN_PHASES` (the nax pipeline stage
  names `queue-check`, `routing`, `constitution`, `context`, `prompt`, `optimizer`, `execution`, `completion`,
  `workflow`; the workflow phases of D6; the feature steps of D6) and `phaseLabelKey(phase: string): string | null`,
  returning `fleet.jobs.phases.<phase>` for a known phase and `null` otherwise. `FleetJobProgress.vue`,
  `FleetJobStories.vue`, `story-graph/StoryNode.vue` (`:52-53`) and `dashboard/ActiveRunsTable.vue` render a known phase through `t(key)` and any other
  phase raw. en labels are sentence case of the name (`branch-review` -> `Branch review`, `implement` -> `Implement`),
  with zh translations alongside.

### Integration

Read-only symbols (verified on main `9ef6e27a`):

- `fenceMarker`, `textBlocks`, `glueHeadingBlock`, `isHeadingLine` (`apps/api/src/fleet/knowledge/markdown-chunker.ts:197,289,323,210`).
- `EmbeddingService.embed`, `embedBatch`, `dimensions`, `providerName`, `modelName` (`apps/api/src/rag/embedding.service.ts:27-44`).
- `isActiveJobState`, `storyRows` (`apps/web/lib/fleet-jobs.ts`), `storiesState`, `postRunState` (`apps/web/lib/fleet-story-graph.ts:169,176`).
- `Watcher.tick` (`apps/runner/src/watcher/watcher.ts:37-67`): reads `status.json`, maps it with `mapStatusToSnapshot`
  and calls `sink.snapshot(payload)` when the payload changed.
- `parseStatusView` (`apps/runner/src/verdict/status-view.ts`), which already parses `workflow.step`.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `splitSections` / `splitText` — Baseline: a block over the cap is its own part of any length. Target: D1.
- `buildSummary` — Baseline: uncapped. Target: result cut to `MAX_CHUNK_CHARS` (D1).
- `OllamaEmbeddingProvider.embedBatch(texts)` — Baseline: `Promise.all` of `embed`. Target: one `/api/embed` request (D2).
- `KnowledgeRepoIndexer.rows` — Baseline: one `embedBatch` for the file under `EMBEDDING_TIMEOUT_MS`; any failure unembeds every chunk. Target: D3.
- `SnapshotEventPayload.postRun`, `POST_RUN_STAGES`, `FleetJobPostRun`, `FleetJobPostRunDto` — Target: gain `workflowStep` (D4).
- runner `postRunStages`, `mapStatusToSnapshot` — Target: D5.
- `pipelineStages`, `StageKey`, `STAGE_KEYS` — Baseline: four stages for every RUN. Target: D6.

### Failure Handling

| Failure | Behaviour | Owner |
|:---|:---|:---|
| Ollama `/api/embed` returns non-OK | `embedBatch` throws `ValidationAppException`; the indexer retries the batch one chunk at a time | US-002 |
| `/api/embed` returns the wrong number of embeddings | `embedBatch` throws `ValidationAppException` | US-002 |
| Batch request exceeds 60 s | whole batch unembedded, no per-chunk retry, the pass continues | US-002 |
| File embedding passes 300 s | remaining batches unembedded with no request | US-002 |
| Single-chunk retry fails | only that chunk unembedded | US-002 |
| `workflowStep` over 32 characters or not a string | server drops the key, other stages kept | US-003 |
| `workflow.step` over 32 characters | runner clips it to 32 | US-004 |
| Unknown workflow step | web shows the three workflow stages `pending` (active) or `unknown` | US-005 |
| Unknown phase | web shows it raw | US-006 |

## Out of Scope

- Splitting the per-file embedding budget across the pass lease, or renewing the lease mid-file; the 300 s file deadline stays below the 900 s lease instead.
- Changing ticket RAG embedding (`EmbeddingService.embed`, `OllamaEmbeddingProvider.embed`, `/api/embeddings`).
- Re-chunking files already indexed with every chunk embedded; only files with unembedded chunks are retried, and an operator can clear a repository's `KnowledgeRepoFile` rows to force a full re-index.
- The deferred #285 minors: DB-free LanceDB tests sharing a DB-gated file, the full-text index rebuild on every lexical failure, and `empty` describing retrieval rather than corpus existence.
- An Ollama CPU limit, or moving koda-wk to a native Ollama; that is deployment configuration outside this repository.
- Showing nax `workflow.stories` per-story `state` and `round` on the story graph.
- Showing `parallel.activeStories`; nax workflow mode never writes it.
- A Prisma migration or a new `FleetJob` column for the workflow step.
- Translating raw nax stage states other than the existing `KNOWN_STAGE_STATES`.
- Non-additive changes to `@nathapp/fleet-protocol`.
- Translating phases in the job timeline (`FleetJobTimeline.vue`, `summarizeEvent`); timeline entries keep the raw phase.
- Telling a pipeline-mode RUN whose story phase is `implement` or `review` apart from a workflow-mode RUN; D6 reads those phases as workflow mode, which nax 0.88.0 pipeline mode never writes.
- US-002 only: concurrency above one embedding request at a time.
- US-006 only: the CLI `fleet-job` view keeps printing the raw phase.

## Stories

- US-001: Chunker enforces the cap on every chunk (`Workdir: apps/api`). No dependencies. Implements D1.
- US-002: Batched embedding with per-chunk failure (`Workdir: apps/api`). No dependencies. Implements D2 and D3.
- US-003: Workflow step in the protocol and job mirror (`Workdir: apps/api`). No dependencies. Implements D4.
- US-004: Runner mirrors the workflow step (`Workdir: apps/runner`). Depends on US-003. Implements D5.
- US-005: Web workflow strip (`Workdir: apps/web`). Depends on US-003. Implements D6.
- US-006: Web phase labels (`Workdir: apps/web`). No dependencies. Implements D7.

### Context Files

**US-001**

- `apps/api/src/fleet/knowledge/markdown-chunker.ts` — the chunker; D1 changes `splitSections`, `splitText` and `buildSummary`.
- `apps/api/src/fleet/knowledge/markdown-chunker.spec.ts` — existing chunker tests and helpers (`lines`, `sections`).

**US-002**

- `apps/api/src/rag/providers/ollama-embedding.provider.ts` — `embedBatch` to rewrite (D2).
- `apps/api/src/rag/providers/ollama-embedding.provider.spec.ts` — fetch mocking pattern.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — `rows` and its timeout constant (D3).
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — the `fixture()` harness and AC-6.
- `apps/api/src/rag/embedding.service.ts` — the `embed` / `embedBatch` facade the indexer calls.

**US-003**

- `apps/api/src/fleet/sync/event-payloads.ts` — `POST_RUN_STAGES`, `postRunStages`, `interpretEvent`.
- `apps/api/src/fleet/sync/event-payloads.spec.ts` — existing `postRunStages` tests.
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetJobPostRun`.
- `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` — `FleetJobPostRunDto`, `FleetJobDto.from`.
- `apps/api/test/integration/fleet/runner-sync.integration.spec.ts` — the sync-route postRun mirror test (`:194-215`).

**US-004**

- `apps/runner/src/watcher/status-snapshot.ts` — `postRunStages`, `mapStatusToSnapshot`.
- `apps/runner/src/watcher/status-snapshot.spec.ts` — mapping tests.
- `apps/runner/src/watcher/watcher.ts` — `Watcher.tick`, the entry point.
- `apps/runner/src/watcher/watcher.spec.ts` — watcher harness with a temp `status.json`.
- `apps/runner/src/verdict/status-view.ts` — `StatusView`, `WorkflowView`.

**US-005**

- `apps/web/lib/fleet-story-graph.ts` — `pipelineStages`, `StageJob`, `StageKey`, `STAGE_KEYS`.
- `apps/web/lib/fleet-types.ts` — `FleetJobDto`, `FleetJobPostRunDto`, `FleetJobWorkflowDto`.
- `apps/web/components/fleet/story-graph/PipelineStrip.vue` — strip rendering and stage labels.
- `apps/web/tests/lib/fleet-story-graph.spec.ts` — the `pipelineStages` harness (`run()` at `:139-142`).
- `apps/web/tests/components/fleet-job-pipeline.spec.ts` — the strip component harness.

**US-006**

- `apps/web/components/fleet/FleetJobProgress.vue` — the job phase field.
- `apps/web/components/fleet/FleetJobStories.vue` — the current story's phase.
- `apps/web/components/fleet/dashboard/ActiveRunsTable.vue` — the dashboard phase column.
- `apps/web/components/fleet/story-graph/StoryNode.vue` — the graph node's current phase (`:52-53`).

### Creates

**US-006**

- `apps/web/lib/fleet-phase.ts` — `KNOWN_PHASES` and `phaseLabelKey` (D7).
- `apps/web/tests/lib/fleet-phase.spec.ts` — unit tests for `phaseLabelKey` and the locale keys.
- `apps/web/tests/components/fleet-job-progress.spec.ts` — component tests for the `FleetJobProgress` phase field.

### Modifies

Production files a story edits inside its own Workdir are named in Design and Context Files. This list holds files
outside the story's Workdir and existing tests whose assertions the story's correct change breaks.

**US-001**

- `apps/api/src/fleet/knowledge/markdown-chunker.spec.ts` — the AC-9 test at `:127-135` ("keeps a single 3000-character paragraph as one chunk of 3000 characters") now expects two section chunks of 2000 and 1000 characters whose concatenation is the paragraph; other assertions unchanged.
- `apps/api/src/fleet/knowledge/markdown-chunker.spec.ts` — the AC-9 heading-glue test at `:137-145` now expects the first section chunk to start with the `## Big` heading line and every section chunk to be at most 2000 characters, instead of one chunk holding the whole 3000-character paragraph; the no-heading-only-chunk intent is unchanged.

**US-002**

- `apps/api/src/rag/providers/ollama-embedding.provider.spec.ts` — the `embedBatch` test at `:65-71` mocks a per-text `{ embedding }` response from the legacy embeddings route; it now mocks one batch-route response `{ embeddings: [...] }` and expects one request (D2).
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — `fixture()` (`:19-41`) gains an `embed` mock delegating to the fake provider, since D3 retries rejected batches through `embed`.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — AC-6 (`:97-111`): the `throw`, `count` and `dimensions` modes also make `embed` reject so every chunk stays unembedded; the `timeout` mode advances `EMBED_REQUEST_TIMEOUT_MS` (60 s) instead of 120 s; the single-warning assertion is unchanged.

**US-003**

- `packages/fleet-protocol/src/index.ts` — outside the api package: `SnapshotEventPayload.postRun` gains `workflowStep?: string` (D4); additive only.
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — the closed-world assertion at `:19` that `FleetJobPostRunDto` has exactly the properties `acceptance`, `finish`, `regression` now expects `acceptance`, `finish`, `regression`, `workflowStep`; the `postRun` assertion at `:18` is unchanged.
- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for `FleetJobPostRunDto.workflowStep`.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the same field; never hand-edited.

**US-004**

None. The mapping change is inside the runner package; existing `status-snapshot.spec.ts` cases have no `workflow`
block, so their `postRun` and `currentPhase` expectations are unchanged.

**US-005**

- `apps/web/i18n/locales/en.json` — gains `fleet.jobs.detail.pipeline.stage.{review,gates,publish}` (`Review`, `Gates`, `Publish`).
- `apps/web/i18n/locales/zh.json` — the same three keys in Chinese.
- `apps/web/lib/fleet-types.ts` — `FleetJobPostRunDto` gains `workflowStep?: string`.
- `apps/web/tests/components/fleet-job-pipeline.spec.ts` — the base job (`:9`) uses `currentPhase: 'implement'`, which D6 reads as workflow mode; the fixture changes to `currentPhase: 'execution'` so the four-stage test at `:65-75` keeps testing a non-workflow RUN.
- `apps/web/tests/e2e/fleet-story-graph.e2e.spec.ts` — both snapshots (`:44`, `:98`) send `currentPhase: 'implement'`, which D6 reads as workflow mode, while `:76-77` assert the `regression` and `finish` stages; the snapshots change to `currentPhase: 'execution'` so the four-stage assertions keep testing a non-workflow RUN.

**US-006**

- `apps/web/i18n/locales/en.json` — gains `fleet.jobs.phases.<phase>` for every `KNOWN_PHASES` entry.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.
- `apps/web/tests/components/fleet-job-stories.spec.ts` — the phase assertion at `:35` expects the label `Implement` instead of the raw `implement` (D7).
- `apps/web/tests/components/fleet-dashboard-tables.spec.ts` — the phase assertion at `:41` expects the label `Review` instead of the raw `review` (D7).

### Seams

- SEAM-1 (US-003 -> US-004): the runner sends `postRun.workflowStep`, which US-003 adds to the protocol type and the
  server keeps; US-004's watcher AC asserts the snapshot carries it, US-003's sync-route AC asserts it is stored.
- SEAM-2 (US-003 -> US-005): the web reads `postRun.workflowStep` from the job DTO US-003 extends.
- SEAM-3 (US-006 internal): `phaseLabelKey` is consumed by four components; one AC per component.

## Acceptance Criteria

### US-001: Chunker enforces the cap on every chunk (`Workdir: apps/api`)

1. [unit] `chunkMarkdown` over a document of a `## List` heading followed directly by 300 list lines of 40 characters with no blank lines returns section chunks that are each at most 2000 characters, and joining their texts with `\n` gives back the section text.
2. [unit] `chunkMarkdown` over a document holding only one 5000-character line with no spaces returns section chunks of 2000, 2000 and 1000 characters, in order, whose concatenation is the line.
3. [unit] `chunkMarkdown` over a document holding only a fenced block opened by a ```` ```ts ```` line and closed by a ```` ``` ```` line, with 200 body lines of 30 characters, returns parts that each start with the ```` ```ts ```` line, each end with a line equal to ```` ``` ````, and are each at most 2000 characters.
4. [unit] For a document holding only a ```` ```ts ```` fenced block of 200 body lines of 30 characters, the body lines of the returned parts, taken in order with the fence lines removed, equal the original 200 body lines.
5. [unit] `chunkMarkdown` over a document holding only a line of 1999 `a` characters followed by the emoji `😀` and 100 more `a` characters returns a first section chunk of 1999 characters, so the emoji's surrogate pair starts the second chunk intact.
6. [unit] `chunkMarkdown` over a document with 400 `##` headings of 20 characters each returns a summary chunk (index 0) whose text is at most 2000 characters.
7. [unit] `chunkMarkdown` over a 5000-character section of ten 500-character paragraphs separated by blank lines still returns parts of at most 2000 characters that break only at blank lines, as before D1.
8. [unit] `chunkMarkdown` over `## Big`, a blank line, and a 3000-character paragraph returns a first section chunk whose first line is `## Big` and no chunk holding only the heading.
9. [unit] Every section chunk produced from a `## List` heading followed directly by 300 list lines of 40 characters carries that section's `headingPath` and `anchor`.
10. [unit] The `chunkIndex` values of the chunks returned for a `## List` heading followed directly by 300 list lines of 40 characters run 0, 1, 2, ... with no gap.
11. [unit] For a document of one 2001-character line, a document of a 2001-character fenced block, and a document whose summary would exceed 2000 characters, every returned chunk `text` is at most 2000 characters.
12. [unit] `chunkMarkdown` over `## Code`, a blank line, and a ```` ```ts ```` fenced block of 200 body lines of 30 characters returns a first section chunk whose first line is `## Code`, and every section chunk holding body lines has a ```` ```ts ```` opening line before its first body line and a ```` ``` ```` line after its last body line.
13. [unit] `chunkMarkdown` over a document holding only a ```` ```ts ```` fenced block whose single body line is 4000 characters returns section chunks that are each at most 2000 characters, each starting with the ```` ```ts ```` line and ending with a ```` ``` ```` line.

### US-002: Batched embedding with per-chunk failure (`Workdir: apps/api`)

1. [unit] `OllamaEmbeddingProvider.embedBatch(['a', 'b', 'c'])` with `fetch` stubbed sends exactly one request, to `http://localhost:11434/api/embed`, method `POST`, with body `{"model":"nomic-embed-text","input":["a","b","c"],"truncate":true}`, and returns the three vectors of the response `embeddings` in order.
2. [unit] `OllamaEmbeddingProvider.embedBatch` rejects with `ValidationAppException` when the response is not OK.
3. [unit] `OllamaEmbeddingProvider.embedBatch(['a', 'b'])` rejects with `ValidationAppException` when the response `embeddings` holds one vector.
4. [unit] `OllamaEmbeddingProvider.embedBatch([])` resolves to `[]` without calling `fetch`.
5. [unit] `KnowledgeRepoIndexer.indexRepo` over a file of 39 `## S<i>` sections, each a 250-character paragraph (a summary plus 39 section chunks, 40 in all), calls `embeddings.embedBatch` three times, with 16, 16 and 8 contents in chunk order, and never starts a call before the previous one settled.
6. [unit] When `embeddings.embedBatch` rejects for the second of three batches and `embeddings.embed` resolves, the rows written by `store.replaceFile` are all embedded (`provider` equals the fake provider name), and `embeddings.embed` was called once for each of the 16 chunks of that batch, one at a time.
7. [unit] When `embeddings.embedBatch` rejects for a batch and `embeddings.embed` rejects for exactly one of its chunks, only that chunk's row has `provider: 'none'`, `model: ''` and a zero vector, and `state.upsertFile` receives `unembeddedCount: 1`.
8. [unit] When `embeddings.embedBatch` never settles for its first call only, after advancing fake timers by 60,000 ms every chunk of that batch is unembedded, `embeddings.embed` is never called for them, and the later batches are still requested.
9. [unit] When `embeddings.embedBatch` resolves a batch with one vector of the wrong length, the indexer retries that batch one chunk at a time through `embeddings.embed`.
10. [unit] For the 40-chunk file of 39 `## S<i>` sections, with the injected clock returning T for its first two reads (the start of the file, before batch 1) and T + 300,000 for every later read, the second and later batches are not requested and their chunks are unembedded, while the first batch's rows keep their vectors.
11. [unit] A 40-chunk file of 39 `## S<i>` sections whose first `embedBatch` call rejects and whose `embed` rejects for exactly two chunks of that batch makes the indexer log exactly one warning, `Knowledge file embedding failed for 2 of 40 chunks (repo r1); storing unembedded chunks`, whose text holds no provider error message.
12. [unit] A file whose every batch and retry succeeds logs no embedding warning and records `unembeddedCount: 0`.

### US-003: Workflow step in the protocol and job mirror (`Workdir: apps/api`)

1. [unit] `postRunStages({ workflowStep: 'branch-review' })` returns `{ workflowStep: 'branch-review' }`.
2. [unit] `postRunStages({ acceptance: 'passed', workflowStep: 'publish' })` returns `{ acceptance: 'passed', workflowStep: 'publish' }`.
3. [unit] `postRunStages({ acceptance: 'passed', workflowStep: 'x'.repeat(33) })` returns `{ acceptance: 'passed' }`.
4. [unit] `postRunStages({ workflowStep: 7 })` returns `undefined`.
5. [unit] `interpretEvent('snapshot', { postRun: { workflowStep: 'final-gates' } })` returns a mirror whose patch is `{ postRun: { workflowStep: 'final-gates' } }`.
6. [unit] `FleetJobDto.from` over a job row whose `postRun` is `{ acceptance: 'passed', workflowStep: 'done' }` returns `postRun` equal to `{ acceptance: 'passed', workflowStep: 'done' }`.
7. [integration] A runner `POST /api/fleet/runner/sync` carrying a `snapshot` event with `postRun: { acceptance: 'running', workflowStep: 'branch-review' }` for a RUNNING job stores the job's `postRun` as exactly `{ acceptance: 'running', workflowStep: 'branch-review' }`.
8. [integration] For a RUNNING job whose stored `postRun` is `{ acceptance: 'running', workflowStep: 'branch-review' }`, a sync snapshot with `postRun: { acceptance: 'passed', workflowStep: 'publish' }` replaces the stored `postRun` with `{ acceptance: 'passed', workflowStep: 'publish' }`.

### US-004: Runner mirrors the workflow step (`Workdir: apps/runner`)

1. [unit] `mapStatusToSnapshot` over a running status with `workflow: { step: 'branch-review' }` and no `postRun` returns `postRun` equal to `{ workflowStep: 'branch-review' }`.
2. [unit] `mapStatusToSnapshot` over a status with `postRun.acceptance.status` `passed` and `workflow.step` `publish` returns `postRun` equal to `{ acceptance: 'passed', workflowStep: 'publish' }`.
3. [unit] `mapStatusToSnapshot` over a status with no `workflow` block and no `postRun` returns no `postRun` key.
4. [unit] `mapStatusToSnapshot` over a status whose `workflow.step` is 40 characters returns a `postRun.workflowStep` of its first 32 characters.
5. [unit] `mapStatusToSnapshot` over a running status with `current: null` and `workflow.step` `final-gates` returns `currentPhase: 'final-gates'` and `currentStoryId: null`.
6. [unit] `mapStatusToSnapshot` over a running status with `current: { storyId: 'US-002', phase: 'review' }` and `workflow.step` `repo-gates` returns `currentPhase: 'review'` and `currentStoryId: 'US-002'`.
7. [unit] `mapStatusToSnapshot` over a status with `run.status` `completed`, `current: null` and `workflow.step` `done` returns `currentPhase: null`.
8. [unit] `mapStatusToSnapshot` over a running status with `current: null` and no `workflow` block returns `currentPhase: null`.
9. [integration] `Watcher.tick` over a temp `status.json` with `run.status` `running`, `current: null` and `workflow: { step: 'branch-review', stories: {} }` calls `sink.snapshot` once with a payload whose `postRun.workflowStep` and `currentPhase` are both `branch-review`.
10. [integration] After a `Watcher.tick` that sent `postRun.workflowStep` `branch-review`, rewriting `status.json` with `workflow.step` `final-gates` and ticking again calls `sink.snapshot` a second time with `postRun.workflowStep` `final-gates`, and a third tick with the file unchanged calls it no more.

### US-005: Web workflow strip (`Workdir: apps/web`)

1. [unit] `pipelineStages` over a RUNNING RUN with `postRun: { workflowStep: 'branch-review' }` returns stage keys `stories`, `acceptance`, `review`, `gates`, `publish`, in that order.
2. [unit] For a RUNNING RUN with `postRun: { workflowStep: 'branch-review' }`, `pipelineStages` returns `review` `running`, `gates` `pending` and `publish` `pending`.
3. [unit] `pipelineStages` over a RUNNING RUN with step `gate-repair` returns `review` `passed`, `gates` `running` and `publish` `pending`.
4. [unit] `pipelineStages` over a COMPLETED RUN with step `done` and `workflow.outcome` `ready` returns `review`, `gates` and `publish` all `passed`.
5. [unit] `pipelineStages` over an ESCALATED RUN with step `done` and `workflow.outcome` `draft` returns a `publish` stage `{ key: 'publish', state: 'draft', known: false, variant: 'outline' }`.
6. [unit] `pipelineStages` over a FAILED RUN with step `done` and `workflow.outcome` `local-only` returns `publish` `failed`.
7. [unit] `pipelineStages` over a FAILED RUN with step `final-gates` returns `review` `passed`, `gates` `failed` and `publish` `skipped`.
8. [unit] `pipelineStages` over a RUNNING RUN with `postRun: null`, `workflow: null` and `currentPhase: 'implement'` returns the five workflow stage keys with `review`, `gates` and `publish` all `pending`.
9. [unit] `pipelineStages` over a RUNNING RUN with step `mystery` returns `review`, `gates` and `publish` all `pending`.
10. [unit] `pipelineStages` over a RUNNING RUN with `currentPhase: 'execution'`, `workflow: null` and `postRun: { acceptance: 'passed', regression: 'running' }` returns the four stage keys `stories`, `acceptance`, `regression`, `finish` with the states it returned before D6.
11. [unit] The pipeline strip rendered for a RUNNING RUN with `postRun: { workflowStep: 'branch-review' }` in the en locale shows the stage labels `Review`, `Gates` and `Publish`.
12. [unit] `pipelineStages` over a FAILED RUN with step `done` and `workflow: null` returns `publish` `unknown`.
13. [unit] `pipelineStages` over an UPLOADING RUN with step `done` and `workflow: null` returns `publish` `running`.

### US-006: Web phase labels (`Workdir: apps/web`)

1. [unit] `phaseLabelKey('branch-review')` returns `fleet.jobs.phases.branch-review`.
2. [unit] `phaseLabelKey('half-built')` returns `null`.
3. [unit] For every entry of `KNOWN_PHASES`, the en and zh locale files both define a non-empty string at `fleet.jobs.phases.<entry>`.
4. [unit] `FleetJobProgress` rendered for a job with `currentPhase: 'final-gates'` in the en locale shows `Final gates` in its phase field.
5. [unit] `FleetJobProgress` rendered for a job with `currentPhase: 'half-built'` shows `half-built` raw in its phase field.
6. [unit] `ActiveRunsTable` rendered with a run whose `currentPhase` is `review` in the en locale shows `Review` in that row.
7. [unit] `FleetJobStories` rendered for an active job whose current story's phase is `implement` in the en locale shows `Implement` in the story's phase text.
8. [unit] `StoryNode` rendered for the current story of an active job whose phase is `implement` in the en locale shows `Implement` in its phase text.
