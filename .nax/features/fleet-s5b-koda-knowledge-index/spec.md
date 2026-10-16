# SPEC: Fleet S5b-1c-c-1 — koda knowledge index over repository docs

## Summary

koda indexes the Markdown documentation of every GitHub fleet repository of a project (README, `.nax/context.md`,
`docs/**/*.md`, `.nax/features/*/spec.md`) into the project's existing LanceDB knowledge table as heading chunks, each
carrying an extractive abstract and a context line, and gives thread agents two tools over it: `koda_kb_search` (hybrid
lexical + vector search fused with reciprocal rank fusion) and `koda_get_doc` (a whole document or one section at the
indexed sha). Results cite `owner/name:path@sha7#anchor`. The index stays fresh through a 30-minute head poll, a pass
queued when a fleet RUN's pull request merges, and an admin re-index route; it is incremental by git blob sha and
records its state per repository. A 40-question evaluation set over koda's own repository measures recall@5 and
recall@20 through a REST search route and a `kb:eval` script. The feature is off until `KNOWLEDGE_INDEX_ENABLED` is
`true`.

This is feature 3c-1 of fleet S5b (S5b-R14). Umbrella design:
`docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R14, §10 row 3c). Features 1, 2, 3a
(`fleet-s5b-koda-knowledge-core`) and 3b (`fleet-s5b-project-thread-code`) are merged. Next: 3c-2
`fleet-s5b-koda-knowledge-outcomes` (fleet run outcomes, per-project path patterns, web), then 1d, 2a, 2b, 3.

## Motivation

The 2026-10-15 knowledge research found that koda's gap is content and reach, not retrieval sophistication: the
project's architecture, specs, design documents and ADRs live as repository Markdown that no thread can reach. 1c-a
put the brief and the anchor repository's `.nax/context.md` into every thread's instructions; 1c-b let PROJECT threads
read code. Neither lets an agent find "where was the token broker's cache designed and why" across a project's
documents: the brief is capped at a few kilobytes, and grepping code finds the implementation, not the rationale.

The existing KB cannot serve this today. It stores one row per document with no chunking
(`apps/api/src/rag/vector-store.service.ts:189-222`), no code produces its `doc` source, and on koda-wk every embedding
so far was stored as a zero vector because no embedding server was running (fixed 2026-10-16 by an `ollama` service in the
koda-wk deployment's compose file). Its search has no source filter, so repository chunks added to it would crowd ticket results.

## Design

### Rulings that bind every story

User, 2026-10-15 (S5b-R14) and 2026-10-16 (this brainstorm):

- S5b-R14: L1/L2 indexed repository docs, heading chunks with an extractive abstract and a citation; abstracts and
  context lines are extractive because the koda API holds no model credentials; reranker, code embeddings, temporal
  graph and automatic memory extraction stay deferred behind the evaluation set.
- 1c-c-R1 (engine): hybrid lexical + vector retrieval on the existing LanceDB knowledge engine, embeddings from Ollama
  `nomic-embed-text` (koda-wk runs it as the compose service `ollama`); Jina is deferred and the embedding provider stays
  configuration.
- 1c-c-R2 (corpus): a fixed default allowlist (README, `.nax/context.md`, root `AGENTS.md`, `docs/**/*.md`,
  `.nax/features/*/spec.md`); per-project patterns are feature 3c-2.
- 1c-c-R3 (freshness): a head poll every 30 minutes, a pass queued on a merged fleet RUN, and an admin re-index route;
  incremental by blob sha.
- 1c-c-R4 (evaluation): 40 questions over `nathapp-io/koda`, registered as a fleet repository of a koda-wk project;
  recall@5, recall@20 and MRR; if recall@20 is below 0.85, the reranker or Jina is tried next (a decision rule, not a
  gate).
- 1c-c-R5 (split): fleet run outcomes (`feature-report.md`, `decisions.jsonl`), per-project path patterns and all web
  work are feature 3c-2 `fleet-s5b-koda-knowledge-outcomes`.
- 1c-c-R6 (isolation): repository chunks share the project's LanceDB table but a separate search path; ticket search
  and its weighted fusion are unchanged.
- 1c-c-R7 (citations): `owner/name:path@sha7#anchor`, the 1c-b code citation form plus a GitHub heading anchor.

### Decisions grounded in the code (this spec)

- 1c-c-D1 (configuration): `IFleetConfig` (`apps/api/src/config/fleet.config.ts:8-63`) gains
  `knowledgeIndexEnabled: boolean` and `knowledgePollMs: number`. `FleetConfigSchema` gains
  `@IsOptional() @IsString() KNOWLEDGE_INDEX_ENABLED: string;` and `@IsOptional() @IsString() KNOWLEDGE_POLL_MS: string;`
  next to `FLEET_THREADS_ENABLED` (`:96`). The factory sets
  `knowledgeIndexEnabled: process.env['KNOWLEDGE_INDEX_ENABLED'] === 'true'` (the `threadsEnabled` rule, `:144`) and
  `knowledgePollMs` = `int('KNOWLEDGE_POLL_MS', 1_800_000)` (`int` at `:99`), replaced by `1_800_000` when it is not a
  finite number and raised to `60_000` when lower. Milliseconds match
  `FLEET_PR_REFRESH_MS`.
- 1c-c-D2 (module): a new `KnowledgeModule` (`apps/api/src/fleet/knowledge/knowledge.module.ts`) imports `RagModule`
  and `GitBrokerModule`, provides the state repository, `KnowledgeIndexService`, `KnowledgeChunkStore`,
  `KnowledgeSearchService`, `KnowledgeRepoIndexer`, `KnowledgeIndexQueue`, `KnowledgePoller` and
  `ProjectKnowledgeController`, and exports `KnowledgeIndexService`, `KnowledgeSearchService` and `KnowledgeIndexQueue`
  only. `KnowledgeIndexService` is the service face over the state repository (the api-data layering rule: controllers
  and other modules never inject the repository): `resolveProjectRepo(projectId, ref: { repoId: string } | { owner:
  string; name: string }): Promise<KnowledgeRepoRef | null>` answers the repository only when it is one of
  `findProjectRepos(projectId)`, `listProjectRepos(projectId)` returns those repositories, and
  `listProjectStates(projectId)` returns them joined with their `KnowledgeRepoIndex` rows. `KnowledgeRepoRef` is
  `{ id, projectId, provider, owner, name, defaultBranch, githubInstallationId }`. `FleetModule` (`apps/api/src/fleet/fleet.module.ts`),
  `AssistantModule` (`apps/api/src/fleet/assistant/assistant.module.ts`) and `FleetTicketsModule`
  (`apps/api/src/fleet/tickets/fleet-tickets.module.ts`) import it. `RagModule`'s `exports`
  (`apps/api/src/rag/rag.module.ts:114`) gains `EmbeddingService`. No cycle: `RagModule` and `GitBrokerModule` import no
  fleet module.
- 1c-c-D3 (state tables): migration `20261020090000_knowledge_index` adds

  ```prisma
  model KnowledgeRepoIndex {
    repoId          String    @id
    projectId       String
    status          String    @default("idle") // idle | running | failed | skipped
    indexedSha      String?
    fileCount       Int       @default(0)
    chunkCount      Int       @default(0)
    unembeddedCount Int       @default(0)
    skippedCount    Int       @default(0)
    lastError       String?
    leaseUntil      DateTime?
    startedAt       DateTime?
    finishedAt      DateTime?
    updatedAt       DateTime  @updatedAt
    repo            FleetRepo @relation(fields: [repoId], references: [id], onDelete: Cascade)
    @@index([projectId])
  }

  model KnowledgeRepoFile {
    repoId          String
    path            String
    blobSha         String
    chunkCount      Int
    unembeddedCount Int       @default(0)
    updatedAt       DateTime  @updatedAt
    repo            FleetRepo @relation(fields: [repoId], references: [id], onDelete: Cascade)
    @@id([repoId, path])
  }
  ```

  and `FleetRepo` gains the back-relations `knowledgeIndex KnowledgeRepoIndex?` and `knowledgeFiles KnowledgeRepoFile[]`.
  `PrismaKnowledgeIndexRepository` (behind `KNOWLEDGE_INDEX_REPOSITORY`, module-private) owns both tables and the
  read of indexable repositories: `findRepo(repoId)`, `findProjectRepos(projectId)` (ordered `createdAt`, then `id`,
  at most 60, as `PrismaFleetJobRepository.findProjectRepos`), `findAllGithubRepos()` (every GitHub repository with a
  non-null `githubInstallationId`, at most 500), `claim(repoId, projectId, now, leaseMs)`, `renew(repoId, leaseUntil): Promise<boolean>`, `finish(repoId, result)`,
  `listFiles(repoId)`, `upsertFile`, `deleteFile`, `listStates(projectId)`.
- 1c-c-D4 (chunk rows): a repository chunk is one `LanceRecord` (`apps/api/src/rag/lance-table-manager.ts:18-30`) in
  table `project_<projectId>`: `id = repo:<repoId>:<path>#<chunkIndex>`, `source = 'repo'`,
  `source_id = repo:<repoId>:<path>`, `content` = the context line, a newline, the abstract, a blank line, then the
  chunk text (so full-text search also matches the context line), `vector` = the embedding of `content`,
  `metadata` = `JSON.stringify` of `{ repoId, owner, name, path, sha, blobSha, title, headingPath, anchor, chunkIndex,
  chunkCount, abstract, text, status?, supersededBy? }`, `created_at` = the pass time, and `provider` / `model` = the
  embedding provider and model, or `provider: 'none'` and `model: ''` with a zero vector of the table's dimension when
  the embedding failed (1c-c-D6). The context line is `<owner>/<name> · <path> · <headingPath>`, with `headingPath`
  the H1-H3 titles joined by ` > `; for chunk 0, whose `headingPath` is empty, it is `<owner>/<name> · <path>`.
- 1c-c-D5 (chunk store): `KnowledgeChunkStore` wraps `LanceTableManager` (`lance-table-manager.ts:130`). Every write
  runs inside `exclusive('project_' + projectId, fn)` (`:369`) on the table from `getOrCreateTable` (`:231`):
  `replaceFile(projectId, sourceId, rows)` deletes `source_id = '<sourceId>'` then adds all rows in one `add` call;
  `deleteFile(projectId, sourceId)` deletes them. It never calls `addRecord` (`:395`), whose per-row
  delete-by-`source_id` would drop a file's other chunks. `readFile(projectId, sourceId)` returns the file's rows
  (at most 2000) parsed into `KnowledgeChunkRow` = `{ id, sourceId, provider }` plus every `metadata` field of 1c-c-D4,
  sorted by `chunkIndex`; `lexical` and `vector` return the same parsed shape. Every `sourceId` a method receives must
  pass `isSafeFilterValue` (`lance-table-manager.ts:37`), else the method throws `KnowledgeInvalidPathError`. `lexical(projectId, query, predicate, limit)` runs
  `table.query().fullTextSearch(query, { columns: 'content' }).where(predicate).limit(limit)` and
  `vector(projectId, embedding, predicate, limit)` runs
  `table.vectorSearch(embedding).distanceType('cosine').where(predicate).limit(limit)` (LanceDB 0.17 `QueryBase.where`).
  When `LanceTableManager.available` is false (in-memory mode), every method throws `KnowledgeStoreUnavailableError`.
  After a pass that wrote or deleted rows, the indexer calls `RagService.optimizeTable(projectId)`
  (`apps/api/src/rag/rag.service.ts:134`) once, so the full-text index covers the new rows.
- 1c-c-D6 (embedding): the indexer embeds each changed file's chunk contents with
  `EmbeddingService.embedBatch(contents)` (`apps/api/src/rag/embedding.service.ts:42`). When it throws, or returns a
  vector count or length that differs from the chunk count or `EmbeddingService.dimensions`, every chunk of that file
  is stored unembedded (1c-c-D4), the file's `unembeddedCount` is its chunk count, and the pass logs one warning. The
  existing `VectorStore` zero-vector fallback (`vector-store.service.ts:198-206`) is unchanged.
- 1c-c-D7 (search): `KnowledgeSearchService` depends on `KnowledgeChunkStore`, `EmbeddingService` and
  `KnowledgeIndexService`. `readDoc(projectId, repoId, path): Promise<KnowledgeChunkRow[]>` returns
  `KnowledgeChunkStore.readFile(projectId, 'repo:' + repoId + ':' + path)`; it is the only read path `koda_get_doc` uses.
  `search({ projectId, query, repoId?, pathPrefix?, limit })` returns
  `{ lexicalOnly: boolean; empty: boolean; hits: KnowledgeHit[] }`, where `KnowledgeHit` is
  `{ repoId, owner, name, path, sha, anchor, headingPath, title, abstract, snippet, status?, supersededBy?, score }`
  and `snippet` is the first 400 characters of the chunk text. The base predicate is `source = 'repo'`, plus
  `AND source_id LIKE 'repo:<repoId>:%'` when `repoId` is given. The lexical leg asks 50 rows (200 when `pathPrefix` is given,
  because the prefix is applied after the legs); the vector leg embeds the query with `EmbeddingService.embed` and asks
  the same number of rows with the base predicate plus `AND provider != 'none'`. When the
  query embedding throws, the vector leg is skipped and `lexicalOnly` is true. The legs fuse by reciprocal rank fusion,
  `score(row) = Σ 1 / (60 + rank)` over the legs the row appears in (rank 1-based), ties broken by row `id`
  ascending. Hits whose `repoId` is not among `KnowledgeIndexService.listProjectRepos(projectId)` are dropped (a deleted fleet repository's
  chunks), then hits whose `path` does not start with `pathPrefix` are dropped, then the list is cut to `limit`.
  `empty` is true when the project's table holds no `repo` row at all.
- 1c-c-D8 (chunker): `chunkMarkdown(input: { path: string; text: string }): MarkdownChunk[]` in
  `apps/api/src/fleet/knowledge/markdown-chunker.ts` is pure. `MarkdownChunk` is
  `{ chunkIndex, title, headingPath, anchor, abstract, text, status?, supersededBy? }`. Rules, in order (the indexer decodes `ForgeFile.content` as UTF-8, invalid bytes becoming U+FFFD, and the
  chunker first normalises `\r\n` to `\n`; an empty text yields chunk 0 only, holding the title; a front matter block
  with no closing `---` line is ordinary text):
  1. A leading YAML front matter block (`---` line, lines, `---` line) is removed from the text; its `title`,
     `status`, `description` and `superseded-by` keys are read as plain `key: value` strings.
  2. The title is the front matter `title`, else the first H1 text, else the file name without `.md`.
  3. Sections start at ATX headings of level 1 to 3 (`#`, `##`, `###` followed by a space; trailing `#` characters and
     spaces are removed from the heading text) outside fenced code blocks (a fence opens and closes on a line starting with three backticks or three tildes). Text before the first
     heading is a section whose heading path is the title.
  4. A section of fewer than 200 characters merges into the following section (its text first), and the merged
     chunk keeps the following section's `headingPath` and `anchor`; a short last section merges into the previous
     one, which keeps its own `headingPath` and `anchor`.
  5. A section of more than 2000 characters splits at blank lines outside fences into parts of at most 2000
     characters each; a single paragraph longer than 2000 characters is its own part. Parts keep the section's heading
     path and anchor.
  6. Chunk 0 is the document summary: `headingPath` and `anchor` are empty, `text` is the title, the front matter
     `description` (else the first paragraph of the first section), and a line `Sections: ` followed by the H2 titles
     joined by `; `. Section chunks follow from index 1.
  7. `abstract` is the first two sentences of the chunk text (a sentence ends at `. `, `? `, `! ` or a line break),
     after skipping heading lines, fenced blocks and list markers, cut to 300 characters; empty when nothing remains.
  8. `anchor` follows GitHub's heading ids restricted to ASCII: lower-case, drop every character that is not `a-z`,
     `0-9`, space, hyphen or underscore, replace each space with `-`; a repeated anchor in one file gets `-1`, `-2`, ... in order.
  9. `status` and `supersededBy` come from the front matter and are copied onto every chunk of the file.
- 1c-c-D9 (indexer pass): `KnowledgeRepoIndexer.indexRepo(repoId, now = new Date()): Promise<IndexPassResult>`, with
  `IndexPassResult = { status: 'indexed' | 'unchanged' | 'skipped' | 'failed' | 'busy'; reason?: string }`:
  1. `findRepo(repoId)`; unknown resolves `{ status: 'failed', reason: 'unknown repo' }` with no state written.
  2. A non-GitHub repository, or one with a null `githubInstallationId`, records state `skipped` with `lastError`
     `not a GitHub repository` / `no installation` and resolves `skipped`.
  3. `claim(repoId, projectId, now, 900_000)` atomically sets `status: running`, `startedAt`, and
     `leaseUntil = now + 15 min` only when the row is absent, not `running`, or `leaseUntil < now`; otherwise it
     resolves `busy` and nothing else runs.
  4. `mintReadOnlyToken(githubInstallationId, name)`, then `getBranchHead(token, owner, name, defaultBranch)`
     (`apps/api/src/fleet/git-broker/github-app-client.ts:69,148`).
  5. When the head equals `indexedSha` and no `KnowledgeRepoFile` row of the repository has `unembeddedCount > 0`,
     the pass finishes `idle` with counts unchanged and resolves `unchanged`.
  6. `getTree(token, owner, name, head, true)` (`:159`); a `truncated` tree fails the pass with `tree truncated`.
  7. The allowlist (pure `isIndexablePath(path: string): boolean` and
     `selectIndexableEntries(entries: ForgeTreeEntry[]): { kept: ForgeTreeEntry[]; skipped: number; capMessage: string | null }`
     in `apps/api/src/fleet/knowledge/knowledge-allowlist.ts`) keeps blob entries whose path is `README.md`, `.nax/context.md`, `AGENTS.md` (only when
     `.nax/context.md` is not in the tree), matches `docs/**/*.md`, or matches `.nax/features/<one segment>/spec.md`.
     It skips (and counts in `skippedCount`) an entry over 262144 bytes, an entry whose path fails
     `isSafeFilterValue` (`lance-table-manager.ts:37`), and every entry after the first 2000 kept (`capMessage`
     `2000-file cap reached`).
  8. A kept file whose `KnowledgeRepoFile.blobSha` equals the tree entry's `sha` and whose `unembeddedCount` is 0 is
     left alone. Every other kept file is read with `getFile(token, owner, name, path, head)` (`:174`), at most four
     at a time, chunked, embedded (1c-c-D6) and written with `replaceFile`; its `KnowledgeRepoFile` row is upserted and the
     lease is renewed with `renew(repoId, new Date(clock() + 900_000))` (`clock` is an injectable dependency defaulting
     to `Date.now`). `renew` answers false when the row is no longer this pass's lease (another claim took it); the
     pass then stops at once, writes no further rows or state, and resolves `{ status: 'failed', reason: 'lease lost' }`.
     An `embedBatch` call that has not settled within 120 seconds counts as a failed embedding (1c-c-D6).
     A `getFile` answer of null treats the file as removed.
  9. Every `KnowledgeRepoFile` row whose path is no longer kept has its chunks removed with `deleteFile` and its row
     deleted.
  10. The pass finishes `idle` with `indexedSha = head`, the file, chunk, unembedded and skipped counts, `lastError`
      null (or the `capMessage`), `leaseUntil` null and `finishedAt`; when it wrote or
      deleted rows it then optimizes once (1c-c-D5); it resolves `indexed`.
  11. Any thrown error after the claim (a mint, `getBranchHead`, `getTree` or `getFile` failure, or
      `KnowledgeStoreUnavailableError`) finishes the pass `failed` with `lastError` = `RepoCheckException.reason` or the
      error message cut to 500 characters, `leaseUntil` null, and resolves `failed`; `indexedSha` is not advanced.
- 1c-c-D10 (queue): `KnowledgeIndexQueue.enqueue(repoId, reason: 'poll' | 'merge' | 'admin')` adds the id to an
  in-process FIFO unless it is already waiting, and drains one `indexRepo` at a time; it never throws and logs a
  failed pass with `Logger.warn`. When `knowledgeIndexEnabled` is false, `enqueue` does nothing. The waiting set is
  capped at 1000 ids (a full queue drops the new id with a warning).
- 1c-c-D11 (triggers): `KnowledgePoller` (`OnModuleInit`/`OnModuleDestroy`, the `FleetPrStateRefresher` timer
  pattern, `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts:49-53`) starts
  `setInterval(() => void this.poll(), knowledgePollMs)` only when `knowledgeIndexEnabled`; `poll()` enqueues every
  `findAllGithubRepos()` id with reason `poll`. `FleetPrStateRefresher` gains a constructor dependency
  `knowledge: KnowledgeIndexQueue`; in `apply` (`:120-128`), when `next === 'merged'` and `applyMergedPr` answers
  `'updated'`, it calls `knowledge.enqueue(link.repo.id, 'merge')`. A link already `merged` is no longer refreshable
  (`findRefreshableFleetLinks`, `prisma-fleet-tickets.repository.ts:183-187`), and `apply` returns early when the state is
  unchanged, so a merge enqueues once.
- 1c-c-D12 (routes): `ProjectKnowledgeController` at `projects/:slug/knowledge`, `@UseGuards(ProjectMembershipGuard)`
  with `@ApiParam({ name: 'slug' })` (the `ProjectFleetReposController` pattern) and `@CurrentProject()`:
  - `GET repos` (member): `{ enabled, repos: KnowledgeRepoStateDto[] }`, one entry per `findProjectRepos` repository:
    `{ repoId, owner, name, provider, status, indexedSha, fileCount, chunkCount, unembeddedCount, skippedCount,
    lastError, startedAt, finishedAt }`, `status` `never` when no state row exists. Answers even when disabled.
  - `POST repos/:repoId/reindex` (`@RequiredPermission('ADMIN')`, HTTP 202): enqueues `admin` and answers
    `{ queued: true }`; 404 `knowledge.repoNotFound` when the repository is not one of the project's.
  - `POST search` (member, HTTP 200): body `{ query: string (1-500), repo?: "owner/name", pathPrefix?: string (1-300, no `..`, no
    leading `/`), limit?: integer 1-50 (default 20) }`; any other body answers 400, answers `{ lexicalOnly, empty, hits }` from `KnowledgeSearchService`; an
    unknown `repo` answers 404 `knowledge.repoNotFound`.
  - `POST reindex` and `POST search` answer 409 `knowledge.disabled` when `knowledgeIndexEnabled` is false
    (`ConflictAppException`, the `threads.disabled` pattern, `apps/api/src/fleet/threads/threads.service.ts:30`).
  The i18n keys go to `apps/api/src/i18n/{en,zh}/knowledge.json`.
- 1c-c-D13 (tools): the tool factories `kbSearchTool(deps)` and `getDocTool(deps)` live in
  `apps/api/src/fleet/assistant/tools/kb-tools.ts`, with `deps = { search: KnowledgeSearchService; index:
  KnowledgeIndexService }`. Both tools resolve a `repo` (or a citation's `owner/name`) with
  `KnowledgeIndexService.resolveProjectRepo(ctx.projectId, { owner, name })`; null throws `NotFoundAppException`, so a
  deleted or foreign repository is `not_found`. A `path` that fails `isSafeFilterValue` is `ToolInputError('path')`.
  `koda-tool-descriptors.ts` gains `KODA_KB_SEARCH` and `KODA_GET_DOC`, appended to
  `KNOWLEDGE_TOOL_DESCRIPTORS` (`:219`), which makes 12 of `KODA_TOOL_LIMITS.maxTools` 32. Both are
  `permission: { kind: 'member' }` and registered by `KnowledgeTools.onModuleInit`
  (`apps/api/src/fleet/assistant/tools/knowledge-tools.ts:241`), which gains `KnowledgeSearchService` and `KnowledgeIndexService`.
  - `koda_kb_search` input `{ query: string 1-500, repo?: "owner/name", pathPrefix?: string 1-300 with no `..` and no
    leading `/`, limit?: integer 1-20 (default 8) }`. Output: when `empty`, exactly
    `knowledge index is empty for this project`; when no hit, `no results`; otherwise a first line
    `<n> results for "<query>"` (plus ` (lexical results only: embeddings unavailable)` when `lexicalOnly`), then per
    hit a line `[<i>] <owner>/<name>:<path>@<sha7>#<anchor> — <headingPath>` (`#<anchor>` omitted when empty), a line
    `(status: <status>[ → <supersededBy>])` when the chunk has a status, and `ctx.data(abstract + '\n' + snippet)`.
    An unknown `repo` throws `NotFoundAppException` (the executor answers `not_found`).
  - `koda_get_doc` input `{ citation: string }` or `{ repo: "owner/name", path: string, anchor?: string, part?: integer
    >= 1 }`. A citation matches `^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+):([^@#]+)(?:@[0-9a-f]{7,40})?(?:#([a-z0-9_-]+))?$`;
    anything else is `ToolInputError('citation')`. A citation's sha is ignored: the answer is always the indexed
    text, labelled with the indexed sha. It reads the file's rows with `KnowledgeSearchService.readDoc(ctx.projectId, repo.id, path)`, drops chunk 0 (unless the
    file has no other chunk), keeps only rows whose `anchor` equals the requested anchor when one is given, and joins
    their `text` with a blank line. The text is split into parts of at most 12000 characters at line boundaries (a
    single line longer than 12000 characters is cut at 12000 characters, the rest starting the next part); the
    answer is a line `<owner>/<name>:<path>@<sha7> (indexed) part <p> of <m>` followed by `ctx.data(part text)`. A
    repository or file with no rows, an anchor with no rows, or a `part` beyond `m` throws `NotFoundAppException`.
- 1c-c-D14 (instructions): `KODA_TOOLS_LINE` (`apps/api/src/fleet/threads/thread-instructions.ts:7-8`) is appended with
  ` Search the project's docs with koda_kb_search and read them with koda_get_doc; cite docs as
  owner/name:path@sha7#anchor.` Both REPO and PROJECT instructions carry it.
- 1c-c-D15 (evaluation): `apps/api/test/kb-eval/questions.json` (committed with this spec, not written by a story) is an
  array of 40 `{ id: string, question: string, expected: Array<{ repo: string; path: string; anchor?: string }> }`.
  `apps/api/scripts/kb-eval.ts` exports pure `scoreRun(questions, answers): KbEvalReport`, where `answers` maps a
  question id to its ranked hits and `KbEvalReport` is
  `{ questions: number; recallAt5: number; recallAt20: number; mrr: number; anchorRecallAt20: number; misses: string[] }`.
  A question counts toward recall@k when any of its `expected` `{repo, path}` appears among its first k hits; `mrr`
  averages `1 / rank` of the first matching hit (0 when none); `anchorRecallAt20` also requires the anchor when the
  expected entry has one; `misses` lists the ids with no match in the first 20. A hit matches an expected entry when `<owner>/<name>` equals `repo` and `path`
  equals `path`. `runEval(argv: string[], deps: { fetch: typeof fetch; env: Record<string, string | undefined>; print:
  (line: string) => void; writeFile: (path: string, text: string) => Promise<void>; questions: KbEvalQuestion[] }):
  Promise<KbEvalReport>` is the CLI body: with `--base-url <url> --project <slug> [--out <file>]` it sends
  `Authorization: Bearer <KODA_EVAL_TOKEN>` (a koda user access token or API key, the scheme
  `CombinedAuthGuard` reads, `apps/api/src/auth/guards/combined-auth.guard.ts:103-107`), calls
  `POST /api/projects/<slug>/knowledge/search` with `limit: 20` once per question, prints the report and writes it as
  JSON when `--out` is given. `apps/api/package.json` gains `"kb:eval": "bun scripts/kb-eval.ts"`. The existing
  `evaluate:retrieval` script (`apps/api/scripts/evaluate-retrieval.ts`, synthetic ticket documents) is unchanged.

### Integration

Read-only symbols (verified on main `a438d70f`):

- `LanceTableManager.getOrCreateTable(tableName, opts?)`, `exclusive<T>(tableName, fn)`, `available`,
  `isSafeFilterValue(value)` (`apps/api/src/rag/lance-table-manager.ts:231,369,161,37`); `LanceRecord` (`:18-30`).
- `EmbeddingService.embed(text): Promise<number[]>`, `embedBatch(texts): Promise<number[][]>`, `dimensions`,
  `providerName`, `modelName` (`apps/api/src/rag/embedding.service.ts:38,42,26,30,34`).
- `RagService.optimizeTable(projectId): Promise<void>` (`apps/api/src/rag/rag.service.ts:134`).
- `GitHubAppClient.mintReadOnlyToken(installationId: bigint, repoName: string): Promise<{ token; expiresAt }>`,
  `getBranchHead(token, owner, name, branch): Promise<string>`,
  `getTree(token, owner, name, treeish, recursive): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean }>`,
  `getFile(token, owner, name, path, ref): Promise<ForgeFile | null>`
  (`apps/api/src/fleet/git-broker/github-app-client.ts:69,148,159,174`); `ForgeTreeEntry { path; type: 'blob' | 'tree';
  sha; size: number | null }`, `ForgeFile { sha; size; content: Buffer }` (`forge-tree.ts:2-14`).
- `RepoCheckException(reason)` (`apps/api/src/fleet/git-broker/repo-check.exception.ts`).
- `ProjectMembershipGuard`, `@CurrentProject()`, `ProjectContext` (the `ProjectFleetReposController` imports,
  `apps/api/src/fleet/repos/project-fleet-repos.controller.ts`); `ConflictAppException`
  (`apps/api/src/common/exceptions/conflict-app.exception.ts:8`); `NotFoundAppException` (`@nathapp/nestjs-common`).
- `AssistantTool`, `ToolContext`, `ToolInputError` (`apps/api/src/fleet/assistant/assistant-tool.types.ts`);
  `AssistantToolExecutor.execute(call)` maps `ToolInputError` to `invalid_input: <reason>` and `NotFoundAppException`
  to `not_found` (`assistant-tool.executor.ts:88,119`).

Symbols this feature changes. The baseline only locates the code; implement the target.

- `IFleetConfig` / `FleetConfigSchema` / `fleetConfig` (`apps/api/src/config/fleet.config.ts`)
  - Baseline: no knowledge keys.
  - Target: 1c-c-D1.
- `RagModule` `exports` (`apps/api/src/rag/rag.module.ts:114`)
  - Baseline: `[RagService, HybridRetrieverService, LanceTableManager, EntityStore, GraphStoreService, FTS_OPTIMIZE_STRATEGY, IncrementalGraphDiffService, PrismaRagRepository]`.
  - Target: the same list plus `EmbeddingService`.
- `FleetPrStateRefresher` constructor and `apply` (`apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts:39-47,120-128`)
  - Baseline: seven constructor dependencies; `apply` never touches knowledge.
  - Target: an eighth dependency `knowledge: KnowledgeIndexQueue`; `apply` enqueues per 1c-c-D11.
- `KNOWLEDGE_TOOL_DESCRIPTORS` (`apps/api/src/fleet/assistant/koda-tool-descriptors.ts:219`)
  - Baseline: `[KODA_MEMORY_SEARCH, KODA_TIMELINE]`.
  - Target: `[KODA_MEMORY_SEARCH, KODA_TIMELINE, KODA_KB_SEARCH, KODA_GET_DOC]`.
- `KnowledgeTools` constructor and `onModuleInit` (`knowledge-tools.ts:232-243`)
  - Baseline: registers `memorySearchTool` and `timelineTool`.
  - Target: also registers `kbSearchTool({ search, index })` and `getDocTool({ search, index })`.
- `KODA_TOOLS_LINE` (`apps/api/src/fleet/threads/thread-instructions.ts:7-8`)
  - Target: 1c-c-D14.

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| `LanceTableManager.available` is false | chunk store throws `KnowledgeStoreUnavailableError`; a pass fails with it | US-001 |
| Search route on an unavailable store | 409 `knowledge.unavailable` | US-002 |
| Query embedding throws | vector leg skipped, `lexicalOnly: true`, lexical hits returned | US-002 |
| A file's `embedBatch` throws or answers the wrong count or length | that file's chunks stored unembedded (`provider: 'none'`), counted, excluded from the vector leg | US-004 |
| Chunk of a fleet repository that no longer exists | dropped from search hits | US-002 |
| Repository unknown | pass resolves `failed` `unknown repo`, no state written | US-004 |
| GitLab repository / no installation | state `skipped` with `not a GitHub repository` / `no installation` | US-004 |
| Pass already running (lease held) | `busy`, nothing read or written | US-004 |
| Lease older than 15 minutes | the next claim takes it over | US-004 |
| Mint or GitHub read fails | pass `failed`, `lastError` = the reason, `indexedSha` not advanced | US-004 |
| Tree truncated | pass `failed` `tree truncated` | US-004 |
| File over 256 KB, unsafe path, past 2000 files | skipped and counted | US-001 |
| A pass keeps writing past 15 minutes | lease renewed after every file; never taken over | US-004 |
| `getFile` answers null | the file is treated as removed | US-004 |
| Kill switch off | no timer, `enqueue` no-op, reindex and search routes 409 `knowledge.disabled` | US-002, US-005 |
| Reindex or search for a repository not in the project | 404 `knowledge.repoNotFound` | US-002, US-005 |
| Queue already holds the repository | not added twice | US-005 |
| Queue holds 1000 ids | new id dropped with a warning | US-005 |
| Tool: unknown `repo`, missing file, anchor or part | `not_found` | US-006 |
| Tool: malformed citation or input, unsafe path | `invalid_input: <reason>` | US-006 |
| Non-numeric `KNOWLEDGE_POLL_MS` | default 1800000 | US-001 |
| Eval: search call answers non-200 | the question is recorded as a miss and the HTTP status printed; the run continues | US-007 |

## Out of Scope

- Fleet run outcomes (`feature-report.md`, `decisions.jsonl`) are not indexed; they are feature 3c-2 `fleet-s5b-koda-knowledge-outcomes`.
- Per-project path patterns are not configurable; every repository uses the fixed default allowlist until feature 3c-2.
- No web page, button or status view for the index, and no rendering of `owner/name:path@sha7#anchor` citations as links; the web is feature 3c-2.
- GitLab repositories are not indexed (1c-b-R2); they are recorded `skipped` with `not a GitHub repository`.
- Ticket search, its weighted fusion, its swagger text that says RRF, and the `VectorStore` zero-vector fallback are unchanged (1c-c-R6).
- No reranker, no Jina provider, no code embeddings, no LLM-written abstracts or context lines (S5b-R14).
- Only the default branch is indexed; other branches, tags and pull request heads are not.
- Chunks of a deleted fleet repository are not removed from LanceDB; search drops them (1c-c-D7).
- No GitHub `push` webhook; freshness comes from the poll, the merge hook and the admin route.
- No search across projects; every query is scoped to one project's table.
- No per-repository chunk cap; the 2000-file and 256 KB-per-file caps bound a pass.
- Setext headings (a line underlined with `===` or `---`) are not section headings, and anchors drop non-ASCII characters where GitHub keeps them, so a non-ASCII heading's anchor can differ from GitHub's.
- The `evaluate:retrieval` script and its synthetic documents are unchanged.
- Passing `KNOWLEDGE_INDEX_ENABLED` and `KNOWLEDGE_POLL_MS` through the koda-wk compose file, and registering `nathapp-io/koda` as a fleet repository, are deployment steps, not story work.
- `apps/api/test/kb-eval/questions.json` is authored with this spec and reviewed by the user; no story writes or edits it.
- US-004 only: two API instances do not coordinate passes beyond the database lease; koda runs one API instance.
- US-005 only: the in-process queue does not survive an API restart; the next poll re-queues every repository.

## Stories

1. **US-001: Knowledge state, chunk store, allowlist and configuration** — `Workdir: apps/api` — No dependencies.
2. **US-002: Hybrid search service and search route** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Markdown heading chunker** — `Workdir: apps/api` — No dependencies.
4. **US-004: Repository indexer pass** — `Workdir: apps/api` — Depends on US-001, US-003.
5. **US-005: Index queue, poll, merge hook, reindex and state routes** — `Workdir: apps/api` — Depends on US-002, US-004.
6. **US-006: Agent tools and instructions** — `Workdir: apps/api` — Depends on US-002.
7. **US-007: Evaluation script** — `Workdir: apps/api` — Depends on US-001, US-002.

Seven stories is the ceiling: the chunker alone carries 15 acceptance criteria, and merging the indexer with the queue
and routes, or the search service with the tools, exceeds 15. US-001 creates `KnowledgeModule` with the state
repository, chunk store and allowlist; US-002, US-004 and US-005 add their providers to it, and US-002 creates
`ProjectKnowledgeController` with the search route, to which US-005 adds the reindex and state routes. Route cases go
into `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` (the api testing rule keeps endpoint coverage there), with
`KnowledgeSearchService` or `KnowledgeIndexQueue` stubbed. US-002 and US-005 each regenerate `openapi.json` with
`bun run api:export-spec` and the CLI client with `bun run generate`.

### Context Files

**US-001**

- `apps/api/src/rag/lance-table-manager.ts` — `getOrCreateTable`, `exclusive`, `available`, `isSafeFilterValue`, `LanceRecord`.
- `apps/api/src/rag/rag.module.ts` — providers and exports at `:72-114`.
- `apps/api/src/config/fleet.config.ts` — `FLEET_THREADS_ENABLED` declaration at `:96`, `int` at `:99`, factory at `:110-144`.
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findProjectRepos` at `:55`, the ordering to mirror.
- `apps/api/test/integration/rag/hybrid-retriever.integration.spec.ts` — a real-LanceDB temp-dir test pattern.

**US-002**

- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — created by US-001; `lexical`, `vector` and `KnowledgeStoreUnavailableError` are used here.
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts` — created by US-001; `listProjectRepos` drops deleted repositories' hits, `resolveProjectRepo` resolves `repo`.
- `apps/api/src/fleet/repos/project-fleet-repos.controller.ts` — member-guarded `projects/:slug` controller pattern.
- `apps/api/src/fleet/threads/threads.service.ts` — the `threads.disabled` 409 at `:30`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — endpoint coverage file; GitHub client stubs at `:3275-3281`.

**US-003**

- `apps/api/src/fleet/threads/project-brief.service.ts` — an existing text helper style in the fleet module.
- `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` — a real design document to sanity-check sections.

**US-004**

- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintReadOnlyToken`, `getBranchHead`, `getTree`, `getFile`.
- `apps/api/src/fleet/repo-config/github-fleet-repo-files.reader.ts` — an existing recursive `getTree` walk at `:21-24`.
- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — created by US-001; `replaceFile` and `deleteFile` are used here.
- `apps/api/src/fleet/knowledge/markdown-chunker.ts` — created by US-003; `chunkMarkdown` is used here.
- `apps/api/src/fleet/knowledge/prisma-knowledge-index.repository.ts` — created by US-001; `claim`, `finish`, file rows.

**US-005**

- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` — timer at `:49-53`, `apply` at `:120-128`.
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.spec.ts` — the refresher test fixture at `:32`.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — created by US-004; the queue drains through `indexRepo`.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — created by US-002; the reindex and state routes join it.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — endpoint coverage file.

**US-006**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_MEMORY_SEARCH` at `:158-184`, catalogs at `:219-224`.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `memorySearchTool` at `:130-161`, registration at `:232-243`.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — the tool test pattern.
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — `ToolInputError` / `NotFoundAppException` mapping at `:88,119`.
- `apps/api/src/fleet/threads/thread-instructions.ts` — `KODA_TOOLS_LINE` at `:7-8`.

**US-007**

- `apps/api/test/kb-eval/questions.json` — the evaluation set (committed with the spec).
- `apps/api/scripts/test-scoped.ts` — a script exporting pure functions for unit tests.
- `apps/api/test/unit/scripts/test-scoped.spec.ts` — the script unit-test pattern.
- `apps/api/src/fleet/knowledge/knowledge-allowlist.ts` — created by US-001; `isIndexablePath` checks the fixture paths.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — created by US-002; the search route the script calls.

### Creates

**US-001**

- `apps/api/prisma/migrations/20261020090000_knowledge_index/migration.sql` — the two tables of 1c-c-D3.
- `apps/api/src/fleet/knowledge/knowledge.module.ts` — `KnowledgeModule`.
- `apps/api/src/fleet/knowledge/prisma-knowledge-index.repository.ts` — `PrismaKnowledgeIndexRepository`, `KNOWLEDGE_INDEX_REPOSITORY`.
- `apps/api/src/fleet/knowledge/knowledge-index.service.ts` — `KnowledgeIndexService`, `KnowledgeRepoRef`.
- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — `KnowledgeChunkStore`, `KnowledgeChunkRow`, `KnowledgeStoreUnavailableError`, `KnowledgeInvalidPathError`.
- `apps/api/src/fleet/knowledge/knowledge-allowlist.ts` — `isIndexablePath`, `selectIndexableEntries`.
- `apps/api/src/fleet/knowledge/knowledge-allowlist.spec.ts` — its unit tests.
- `apps/api/test/integration/fleet/knowledge-store.integration.spec.ts` — chunk store on a real temp-dir LanceDB, state repository on Postgres.

**US-002**

- `apps/api/src/fleet/knowledge/knowledge-search.service.ts` — `KnowledgeSearchService`, `KnowledgeHit`.
- `apps/api/src/fleet/knowledge/knowledge-search.service.spec.ts` — fusion and filters over a stubbed store.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — `ProjectKnowledgeController` with `POST search`, `KnowledgeSearchBodyDto`, `KnowledgeSearchResultDto`.
- `apps/api/src/i18n/en/knowledge.json` — `disabled.409`, `unavailable.409`, `repoNotFound.404`, nested as `threads.json` nests `disabled.409`.
- `apps/api/src/i18n/zh/knowledge.json` — the same keys in Chinese.

**US-003**

- `apps/api/src/fleet/knowledge/markdown-chunker.ts` — `chunkMarkdown`, `MarkdownChunk`.
- `apps/api/src/fleet/knowledge/markdown-chunker.spec.ts` — its unit tests.

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — `KnowledgeRepoIndexer`, `IndexPassResult`.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — the pass over a fake GitHub client, a stubbed store and repository.

**US-005**

- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts` — `KnowledgeIndexQueue`.
- `apps/api/src/fleet/knowledge/knowledge-poller.ts` — `KnowledgePoller`.
- `apps/api/src/fleet/knowledge/knowledge-repo-state.dto.ts` — `KnowledgeRepoStateDto`, `KnowledgeReposResultDto`.
- `apps/api/src/fleet/knowledge/knowledge-index.queue.spec.ts` — queue and poller unit tests.

**US-006**

- `apps/api/src/fleet/assistant/tools/kb-tools.ts` — `kbSearchTool`, `getDocTool`.
- `apps/api/src/fleet/assistant/tools/kb-tools.spec.ts` — `koda_kb_search` and `koda_get_doc` unit tests.

**US-007**

- `apps/api/scripts/kb-eval.ts` — `scoreRun`, `runEval`, `KbEvalQuestion`, `KbEvalReport`.
- `apps/api/test/unit/scripts/kb-eval.spec.ts` — its unit tests.

### Modifies

Production files a story edits inside its own Workdir are named in Design and Context Files. This list holds only
files outside the story's Workdir and existing tests whose assertions the story's correct change breaks.

**US-001**

- `apps/api/src/common/test-helpers/fleet-config.ts` — `testFleetConfig()` returns a complete `IFleetConfig` literal; it gains `knowledgeIndexEnabled: false` and `knowledgePollMs: 1_800_000` so every spec that uses it still type-checks; existing keys and the `overrides` behaviour are unchanged.

**US-002**

- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for the knowledge search route.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the search route; never hand-edited.
- `apps/cli/src/generated/sdk.gen.ts` — outside the api package: regenerated by `bun run generate` for the search route; never hand-edited.

**US-003**

None. The chunker is a new file with no existing caller.

**US-004**

None. The indexer is a new provider; no existing test constructs it.

**US-005**

- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.spec.ts` — the `new FleetPrStateRefresher(...)` call at `:32` gains a stub `KnowledgeIndexQueue` as its eighth argument; every existing assertion is unchanged.
- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for the reindex and state routes.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the reindex and state routes; never hand-edited.
- `apps/cli/src/generated/sdk.gen.ts` — outside the api package: regenerated by `bun run generate` for the reindex and state routes; never hand-edited.

**US-006**

- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — its `Test.createTestingModule` providers at `:70-82` gain stub `KnowledgeSearchService` and `KnowledgeIndexService` values, because `KnowledgeTools` now injects them; its assertions are unchanged.
- `apps/api/src/fleet/threads/thread-instructions.spec.ts` — the spec's copy of `KODA_TOOLS_LINE` at `:15` takes the 1c-c-D14 text; the placement assertions at `:61-62`, `:98-99`, `:124-126` and `:182-183` are unchanged.

**US-007**

None. `kb-eval.ts` and its spec are new; the `package.json` script entry is inside the api package.

### Seams

- SEAM-0 (US-001 -> US-004): the indexer selects files with `selectIndexableEntries`, writes through
  `KnowledgeChunkStore.replaceFile` / `deleteFile` and the state repository's `claim` / `finish`; US-004 ACs assert
  those calls on stubs.
- SEAM-1 (US-003 -> US-004): the indexer chunks with `chunkMarkdown`; a US-004 AC asserts the rows written for a
  two-section file carry the chunker's anchors.
- SEAM-2 (US-001 -> US-002): the search service queries through `KnowledgeChunkStore.lexical` / `vector`; US-002 ACs
  assert the predicates passed to a stub store.
- SEAM-3 (US-004 -> US-005; entry points `POST /api/projects/:slug/knowledge/repos/:repoId/reindex` and
  `FleetPrStateRefresher.refresh()`): each entry point calls `KnowledgeIndexQueue.enqueue` (US-005 AC 8 and AC 11, plus the
  re-trigger AC 9), and the queue drains through `KnowledgeRepoIndexer.indexRepo` (US-005 AC 1).
- SEAM-4 (US-002 -> US-006; entry point `AssistantToolExecutor.execute`): `koda_kb_search` calls
  `KnowledgeSearchService.search` with the call's `projectId`; a US-006 AC asserts it.
- SEAM-5 (US-002 -> US-007): the script calls `POST /api/projects/<slug>/knowledge/search` with `limit: 20`; a US-007
  AC asserts the request on a stubbed `fetch`.

## Acceptance Criteria

### US-001: Knowledge state, chunk store, allowlist and configuration (`Workdir: apps/api`)

1. [unit] `fleetConfig()` with `KNOWLEDGE_INDEX_ENABLED` and `KNOWLEDGE_POLL_MS` unset resolves `knowledgeIndexEnabled: false` and `knowledgePollMs: 1800000`, and with `KNOWLEDGE_POLL_MS=abc` resolves `knowledgePollMs: 1800000` (one table-driven test).
2. [unit] `fleetConfig()` with `KNOWLEDGE_INDEX_ENABLED=true` and `KNOWLEDGE_POLL_MS=5000` resolves `knowledgeIndexEnabled: true` and `knowledgePollMs: 60000`.
3. [unit] `Test.createTestingModule({ imports: [KnowledgeModule] })` with `PrismaService`, `TRANSACTION_MANAGER` and the `RAG_CFG` / `FLEET_CFG` configs provided as stubs compiles, and `KnowledgeChunkStore` resolves from it.
4. [integration] `PrismaKnowledgeIndexRepository.claim(repoId, projectId, now, 900000)` on a repository with no state row creates it with `status: 'running'` and `leaseUntil` = `now` + 15 minutes and answers true, and a second `claim` at `now` + 1 minute answers false.
5. [integration] After a claim at `now`, a `claim` at `now` + 16 minutes answers true.
6. [integration] Deleting a `FleetRepo` row deletes its `KnowledgeRepoIndex` and `KnowledgeRepoFile` rows.
7. [integration] On a real LanceDB in a `mkdtempSync` directory, `KnowledgeChunkStore.replaceFile(p, 'repo:r1:docs/a.md', [row0, row1, row2])` followed by `readFile(p, 'repo:r1:docs/a.md')` returns the three rows in `chunkIndex` order.
8. [integration] A second `replaceFile` for `repo:r1:docs/a.md` with one row leaves exactly that one row for the file, and the rows of `repo:r1:docs/b.md` are untouched.
9. [integration] `deleteFile(p, 'repo:r1:docs/a.md')` removes that file's rows and keeps a `ticket` row of the same table.
10. [unit] `KnowledgeChunkStore.readFile` on a manager whose `available` is false throws `KnowledgeStoreUnavailableError`.
11. [unit] `isIndexablePath` is true for `README.md`, `.nax/context.md`, `AGENTS.md`, `docs/a.md`, `docs/x/y/b.md` and `.nax/features/f1/spec.md`, and false for `apps/api/README.md`, `CLAUDE.md`, `.nax/features/f1/prd.json`, `.nax/features/a/b/spec.md`, `docs/a.txt` and `src/a.ts` (one table-driven test).
12. [unit] `selectIndexableEntries` keeps `AGENTS.md` when the entries hold no `.nax/context.md`, and drops it when they do.
13. [unit] `selectIndexableEntries` skips a `docs/big.md` entry of 300000 bytes and a `docs/it's.md` entry and reports `skipped: 2`.
14. [unit] `selectIndexableEntries` with 2001 indexable entries keeps the first 2000 in input order, reports `skipped: 1` and `capMessage: '2000-file cap reached'`.
15. [unit] `KnowledgeChunkStore.replaceFile(p, "repo:r1:docs/it's.md", rows)` throws `KnowledgeInvalidPathError` and writes nothing.

### US-002: Hybrid search service and search route (`Workdir: apps/api`)

1. [unit] `KnowledgeSearchService.search` with a stub store whose lexical leg returns rows `[a, b]` and vector leg returns `[b, c]` returns hits in the order `b, a, c`, with `b`'s score equal to `1/61 + 1/62`.
2. [unit] `search` passes the lexical leg the predicate `source = 'repo'` and the vector leg `source = 'repo' AND provider != 'none'`.
3. [unit] With `repoId: 'r1'`, both predicates end with `AND source_id LIKE 'repo:r1:%'`.
4. [unit] When `EmbeddingService.embed` throws, `search` never calls the vector leg, returns the lexical hits and `lexicalOnly: true`.
5. [unit] A hit whose `repoId` is not returned by the stubbed `KnowledgeIndexService.listProjectRepos(projectId)` is absent from the result.
6. [unit] With `pathPrefix: 'docs/adr/'`, both legs are asked for 200 rows, only hits whose `path` starts with `docs/adr/` are returned, and the result is cut to `limit` after that filter.
7. [unit] `search` on a project whose table holds no `source = 'repo'` row returns `{ empty: true, hits: [] }`.
8. [integration] On a real LanceDB holding one embedded and one `provider: 'none'` chunk of the same text, `search` with the fake embedding provider returns both hits, and the `provider: 'none'` hit's score is `1/(60 + its lexical rank)`.
9. [integration] `POST /api/projects/:slug/knowledge/search` as a project member with `{ query: 'broker', repo: 'o/n', limit: 5 }` calls `KnowledgeSearchService.search` with the project's id, the `repoId` of `o/n` and `limit: 5`, and answers 200 with its `{ lexicalOnly, empty, hits }`.
10. [integration] `POST .../knowledge/search` with an empty `query`, and with `pathPrefix: '../x'`, answers 400 (one table-driven test).
11. [integration] `POST .../knowledge/search` with `repo: 'o/missing'` answers 404.
12. [integration] `POST .../knowledge/search` with `knowledgeIndexEnabled: false` answers 409.
13. [integration] When `KnowledgeSearchService.search` throws `KnowledgeStoreUnavailableError`, `POST .../knowledge/search` answers 409.
14. [integration] `POST .../knowledge/search` by a user who is not a project member answers 403.

### US-003: Markdown heading chunker (`Workdir: apps/api`)

1. [unit] `chunkMarkdown({ path: 'docs/a.md', text })` for a text with an H1 `Alpha`, an H2 `Beta` and an H2 `Gamma`, each section over 200 characters, returns chunk 0 with empty `headingPath` and `anchor` and text containing `Sections: Beta; Gamma`, then chunks with `headingPath` `Alpha`, `Alpha > Beta` and `Alpha > Gamma`.
2. [unit] A `## Not a heading` line inside a block fenced with three backticks, or with three tildes, does not start a section (one table-driven test).
3. [unit] A text starting with a front matter block holding `title: Decision 7`, `status: superseded` and `superseded-by: docs/adr/0009.md` returns chunks whose `title` is `Decision 7` and which all carry `status: 'superseded'` and `supersededBy: 'docs/adr/0009.md'`.
4. [unit] No chunk of that text includes the front matter lines in its `text`.
5. [unit] With no front matter and no H1, the title is the file name without `.md` (`docs/guide-x.md` gives `guide-x`).
6. [unit] A 150-character section between two long sections merges into the following section, whose chunk text starts with the short section's text and whose `anchor` is the following section's.
7. [unit] A trailing section of 150 characters merges into the previous section.
8. [unit] A 5000-character section made of 500-character paragraphs splits into chunks of at most 2000 characters each, all with the section's `headingPath` and `anchor`.
9. [unit] A single 3000-character paragraph is one chunk of 3000 characters.
10. [unit] The heading `## Token Broker: cache & reuse` gets the anchor `token-broker-cache--reuse`.
11. [unit] Two headings `## Notes` in one file get the anchors `notes` and `notes-1`.
12. [unit] A 400-character H2 section whose body starts `First sentence. Second one! Third.` gets the abstract `First sentence. Second one!`.
13. [unit] A 400-character H2 section whose body is a fenced block, then the line `- Item one. Done.`, then further text, gets the abstract `Item one. Done.`.
14. [unit] Text before the first heading becomes chunk 1 with the title as its `headingPath`, and chunk 0's text holds the front matter `description` when present.
15. [unit] A text with `\r\n` line ends returns the same chunks as the same text with `\n`, and the heading `## Notes ##` gives the heading text `Notes` and the anchor `notes`.

### US-004: Repository indexer pass (`Workdir: apps/api`)

Every case runs `KnowledgeRepoIndexer.indexRepo` with a fake `GitHubAppClient`, a stub `KnowledgeChunkStore`, the
fake embedding provider, and a stub state repository whose `findRepo('r1')` resolves a GitHub repository `o/n` with
installation `5n` and `claim` answers true, unless stated.

1. [unit] `indexRepo('r1')` calls `mintReadOnlyToken(5n, 'n')`, `getBranchHead(token, 'o', 'n', 'main')` and `getTree(token, 'o', 'n', head, true)`, in that order.
2. [unit] For a tree holding `README.md`, `docs/a.md`, `.nax/features/f1/prd.json` and `src/a.ts`, it calls `getFile` for exactly `README.md` and `docs/a.md`, each at the head sha.
3. [unit] A `docs/a.md` holding two H2 sections of 500 characters each (no H1) is written with one `replaceFile(projectId, 'repo:r1:docs/a.md', rows)` call whose rows carry `source: 'repo'`, ids `repo:r1:docs/a.md#0` to `#2`, the chunker's anchors in `metadata`, and chunk 0's `content` starting with the line `o/n · docs/a.md`.
4. [unit] A file whose `KnowledgeRepoFile.blobSha` equals its tree `sha` and whose `unembeddedCount` is 0 is neither read nor written.
5. [unit] A stored `KnowledgeRepoFile` for `docs/gone.md` that is not in the tree, and a tree file `docs/null.md` whose `getFile` answers null, each get `deleteFile(projectId, 'repo:r1:<path>')` and lose their file row (one table-driven test).
6. [unit] When `embedBatch` for `docs/a.md` throws, when it answers one vector fewer than the chunk count, and when it has not settled after 120 seconds of fake time, the file's rows carry `provider: 'none'`, `model: ''` and a zero vector of `EmbeddingService.dimensions`, its file row has `unembeddedCount` equal to its chunk count, and the pass resolves `indexed` (one table-driven test).
7. [unit] When the head equals the stored `indexedSha`, the pass resolves `unchanged` without calling `getTree` when no file row has `unembeddedCount > 0`, and calls `getTree` and re-reads only that file when one file row has it (one table-driven test).
8. [unit] When `renew` answers false after the first of three changed files, the pass resolves `{ status: 'failed', reason: 'lease lost' }`, calls `replaceFile` once, and never calls `finish`.
9. [unit] `indexRepo` on a GitLab repository records `lastError: 'not a GitHub repository'`, and on a GitHub repository with a null installation records `no installation`; each resolves `skipped` and calls no GitHub method (one table-driven test).
10. [unit] When `claim` answers false, the pass resolves `busy` and calls no GitHub method and no store method.
11. [unit] A tree answered with `truncated: true` finishes the state `failed` with `lastError: 'tree truncated'`, writes no rows, and leaves `indexedSha` unchanged.
12. [unit] When `mintReadOnlyToken` throws `RepoCheckException('app_not_installed')`, when `getFile` throws `Error('boom')`, and when `replaceFile` throws `KnowledgeStoreUnavailableError`, the state finishes `failed` with `lastError` `app_not_installed`, `boom` and the error's message respectively, `leaseUntil` null and `indexedSha` unchanged (one table-driven test).
13. [unit] A successful pass that wrote rows calls `RagService.optimizeTable(projectId)` exactly once and finishes the state `idle` with `indexedSha` = the head, `fileCount`, `chunkCount` and `leaseUntil` null.
14. [unit] `indexRepo('unknown')` resolves `{ status: 'failed', reason: 'unknown repo' }` and calls no state-writing method.
15. [unit] A pass writing three changed files calls the state repository's `renew` three times, each after that file's `replaceFile`.

### US-005: Index queue, poll, merge hook, reindex and state routes (`Workdir: apps/api`)

1. [unit] `KnowledgeIndexQueue.enqueue('r1', 'admin')` with `knowledgeIndexEnabled: true` calls the stubbed `KnowledgeRepoIndexer.indexRepo` with `'r1'` once.
2. [unit] While a pass for `r0` is still running, enqueuing `r1`, then `r2`, then `r1` again runs `indexRepo` for `r0`, `r1` and `r2` once each, in that order.
3. [unit] `enqueue` with `knowledgeIndexEnabled: false` never calls `indexRepo`.
4. [unit] When `indexRepo` rejects, `enqueue` does not throw, `Logger.warn` is called once, and the next queued id still runs.
5. [unit] With 1000 ids waiting, `enqueue` of a new id does not add it and calls `Logger.warn`.
6. [unit] `KnowledgePoller.onModuleInit` with `knowledgeIndexEnabled: false` starts no timer.
7. [unit] `KnowledgePoller.poll()` enqueues every `findAllGithubRepos()` id with reason `poll`.
8. [unit] `FleetPrStateRefresher.refresh()` with a stubbed fleet link of repository `r9` in state `open` whose PR the GitHub stub reports merged, and `applyMergedPr` answering `'updated'`, calls `KnowledgeIndexQueue.enqueue('r9', 'merge')` once.
9. [unit] `refresh()` with the same link already in state `merged` calls `enqueue` zero times.
10. [unit] `refresh()` with a link the GitHub stub reports closed calls `enqueue` zero times.
11. [integration] `POST /api/projects/:slug/knowledge/repos/:repoId/reindex` as a global ADMIN answers 202 `{ queued: true }` and calls `KnowledgeIndexQueue.enqueue(repoId, 'admin')`.
12. [integration] The reindex route as a project DEVELOPER answers 403, and as a global ADMIN for a repository of another project answers 404.
13. [integration] The reindex route with `knowledgeIndexEnabled: false` answers 409.
14. [integration] `GET /api/projects/:slug/knowledge/repos` as a project member answers 200 with one entry per fleet repository of the project, `status: 'never'` for a repository with no state row, and `enabled` equal to `knowledgeIndexEnabled`.

### US-006: Agent tools and instructions (`Workdir: apps/api`)

1. [unit] `KNOWLEDGE_TOOL_DESCRIPTORS` names `koda_memory_search`, `koda_timeline`, `koda_kb_search` and `koda_get_doc` in that order, and `KODA_TOOL_DESCRIPTORS` has at most `KODA_TOOL_LIMITS.maxTools` entries.
2. [unit] `AssistantToolExecutor.execute` of `koda_kb_search` `{ query: 'token cache' }` for a job of project `p1` calls `KnowledgeSearchService.search` with `{ projectId: 'p1', query: 'token cache', limit: 8 }`.
3. [unit] With one hit `{ owner: 'o', name: 'n', path: 'docs/a.md', sha: 'abcdef1234', anchor: 'cache', headingPath: 'A > Cache' }`, the result's first line is `1 results for "token cache"` and the second is `[1] o/n:docs/a.md@abcdef1#cache — A > Cache`.
4. [unit] The hit's abstract and snippet appear inside the call's koda-data fence (passed through `ctx.data`).
5. [unit] A hit with `status: 'superseded'` and `supersededBy: 'docs/adr/0009.md'` adds the line `(status: superseded → docs/adr/0009.md)`.
6. [unit] With `lexicalOnly: true`, the first line ends with `(lexical results only: embeddings unavailable)`; with `empty: true` the whole result is `knowledge index is empty for this project`; with no hits it is `no results`.
7. [unit] `koda_kb_search` with `query: ''`, with a 501-character query, with `limit: 21` and with `pathPrefix: '../x'` each answers `invalid_input` with reasons `query`, `query`, `limit` and `pathPrefix` (one table-driven test).
8. [unit] `koda_kb_search` with `repo: 'o/missing'`, and `koda_get_doc` with `{ repo: 'o/missing', path: 'docs/a.md' }`, each answer `not_found` when `KnowledgeIndexService.resolveProjectRepo` resolves null (one table-driven test).
9. [unit] `koda_get_doc` with `{ citation: 'o/n:docs/a.md@1111111#cache' }`, over rows indexed at sha `abcdef1234`, calls `KnowledgeSearchService.readDoc(projectId, <id of o/n>, 'docs/a.md')` and answers a first line `o/n:docs/a.md@abcdef1 (indexed) part 1 of 1` followed by the fenced text of the rows whose anchor is `cache`.
10. [unit] `koda_get_doc` with `{ repo: 'o/n', path: 'docs/a.md' }` answers the text of every chunk except chunk 0, joined by a blank line, in `chunkIndex` order.
11. [unit] A document held in one row whose text is 30 lines of 999 characters joined by `\n` (29999 characters) answers `part 1 of 3` for `part` absent, `part 3 of 3` for `part: 3`, and `not_found` for `part: 4`.
12. [unit] `koda_get_doc` with `{ citation: 'not a citation' }` answers `invalid_input: citation`, with `{ repo: 'o/n', path: "docs/it's.md" }` answers `invalid_input: path`, and with an anchor no row carries answers `not_found`.
13. [unit] A document that is one 13000-character line answers `part 1 of 2` whose text is its first 12000 characters.
14. [unit] `buildProjectThreadInstructions` and `buildThreadInstructions` both return text whose `koda tools:` line ends with `cite docs as owner/name:path@sha7#anchor.` and names `koda_kb_search` and `koda_get_doc`.

### US-007: Evaluation script (`Workdir: apps/api`)

1. [unit] `scoreRun` with two questions, one whose expected `{ repo: 'o/n', path: 'docs/a.md' }` matches the 3rd hit (`owner: 'o', name: 'n', path: 'docs/a.md'`) and one whose expected path is the 12th hit, returns `recallAt5: 0.5`, `recallAt20: 1` and `mrr` equal to `(1/3 + 1/12) / 2`.
2. [unit] A question whose expected path is absent from its 20 hits is listed in `misses` and adds 0 to `mrr`.
3. [unit] An expected entry with `anchor: 'cache'` counts toward `anchorRecallAt20` only when a hit in the first 20 has that path and that anchor, and still counts toward `recallAt20` on the path alone.
4. [unit] A question with two expected entries counts as found when either one matches.
5. [unit] `runEval(['--base-url', 'http://k', '--project', 'koda-dogfood'], deps)` with a stubbed `fetch` and `KODA_EVAL_TOKEN=t` calls `http://k/api/projects/koda-dogfood/knowledge/search` once per question with method `POST`, the header `Authorization: Bearer t`, and a JSON body `{ query: <question>, limit: 20 }`.
6. [unit] When the stubbed `fetch` answers 500 for one question in `runEval`, that question is in `misses`, the run continues with the next question, and the report counts all questions.
7. [unit] Every entry of `apps/api/test/kb-eval/questions.json` has a unique `id`, a non-empty `question` and at least one `expected` entry for which `isIndexablePath(path)` is true, and the file holds 40 entries.
