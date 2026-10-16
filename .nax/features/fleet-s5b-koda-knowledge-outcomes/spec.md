# SPEC: Fleet S5b-1c-c-2 — knowledge over fleet run outcomes, per-project patterns, web

## Summary

koda keeps the `feature-report.md` and `decisions.jsonl` that every fleet RUN bundle already carries as rows at
bundle ingest, indexes them into the project's LanceDB knowledge table next to the repository docs of 3c-1, and lets
thread agents find them through the existing `koda_kb_search` (a new `source` filter: `docs`, `outcomes` or `all`,
default `all`) and read them through `koda_get_doc` with a `job:<jobId>/<file>#<anchor>` citation. An outcome hit
carries its job's state and pull request state, read from Postgres at query time so a later merge never rewrites the
index. Each project can replace the fixed 3c-1 allowlist with its own path patterns. The web gains a Knowledge tab in
project settings (index state per repository, a re-index button, the patterns editor) and renders knowledge citations
in thread replies as links. Outcomes of RUNs ingested before this ships are indexed by bumping
`INGEST_PARSER_VERSION`, after which the existing re-run-outdated route re-ingests every stored bundle.

This is feature 3c-2 of fleet S5b (S5b-R14, 1c-c-R5). Umbrella design:
`docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` (§2 S5b-R14 and 1c-c-R1..R7, §10 row 3c-2).
Feature 3c-1 (`fleet-s5b-koda-knowledge-index`, PR #285) and its fix #287 are merged and deployed on koda-wk; the
koda-dogfood evaluation scored recall@20 0.975. Next after this: 1d, 2a, 2b, 3.

## Motivation

3c-1 made a project's repository docs searchable, but the record of what fleet runs actually did is still out of
reach. Every workflow-mode RUN ends with a feature report (what was built, what review found, what the branch fix
changed) and a decisions log (each advisor ruling with its rationale). The runner already copies both into the RUN
bundle (`apps/runner/src/bundle/build-bundle.ts:48-52`), but the API's ingest allowlist drops them
(`apps/api/src/fleet/ingest/bundle-reader.ts:24-32`, asserted by `bundle-reader.spec.ts:11-14`), so they live only
inside a gzipped artifact until retention deletes it. A thread asked "why did the knowledge index rebuild the FTS index
only on the missing-index error" has the code but not the run that decided it.

The fixed 3c-1 allowlist also cannot be narrowed or extended per project: koda's own repository spends most of its
indexing time on `docs/superpowers/plans/*`, and a project whose docs live under `handbook/` cannot be indexed at all.
And the index has no human surface: an admin re-indexes with `curl`, and a citation in a thread reply is plain text.

## Design

### Rulings that bind every story

User, 2026-10-16 (3c-1 brainstorm, binding here) and 2026-10-16 (this spec's questions):

- 1c-c-R2: per-project path patterns belong to this feature; the 3c-1 fixed allowlist is the default.
- 1c-c-R5: fleet run outcomes (`feature-report.md`, `decisions.jsonl`), per-project patterns and all web work are
  this feature.
- 1c-c-R6: repository and outcome chunks share the project's LanceDB table on a search path separate from ticket
  search; ticket search is unchanged.
- 1c-c-R7: document citations stay `owner/name:path@sha7#anchor`.
- 3c-2-R1 (job and PR state): an outcome chunk stores its job id only; job state and pull request state are read from
  Postgres when a search answers, so a merge or close never rewrites LanceDB rows.
- 3c-2-R2 (patterns): a project's patterns replace the default allowlist; no patterns means the default. Saving
  patterns makes every repository of the project re-select its files on the next pass.
- 3c-2-R3 (tool surface): `koda_kb_search` gains a `source` filter (`docs` | `outcomes` | `all`, default `all`);
  outcome hits cite `job:<jobId>/<file>#<anchor>` and `koda_get_doc` reads them. No new tool.
- 3c-2-R4 (backfill): `INGEST_PARSER_VERSION` goes from 2 to 3; after deploy an admin calls the existing re-run-outdated
  route and every unexpired stored bundle re-ingests and indexes its outcomes.

### Decisions grounded in the code (this spec)

- 3c-2-D1 (outcome rows): migration `20261021090000_fleet_run_outcomes` adds

  ```prisma
  model FleetRunOutcome {
    id         String   @id @default(cuid())
    jobId      String
    leaseEpoch Int
    projectId  String
    repoId     String
    kind       String   // report | decisions
    content    String   @db.Text
    createdAt  DateTime @default(now())
    job        FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
    @@unique([jobId, leaseEpoch, kind])
    @@index([projectId])
  }
  ```

  and `FleetJob` gains the back-relation `runOutcomes FleetRunOutcome[]`. `BundleFiles`
  (`apps/api/src/fleet/ingest/bundle-reader.ts:11-20`) gains two optional fields `featureReport?: BundleFile | null`
  and `decisions?: BundleFile | null` (optional so existing `BundleFiles` literals in specs still type-check);
  `readBundleFiles` always sets both, null when absent. `SLOTS` gains `[/^workflow\/feature-report\.md$/,
  'featureReport']` and `[/^workflow\/decisions\.jsonl$/, 'decisions']`; both are single-file slots like
  `workflowResult`, and the existing `INGEST_LIMITS.fileBytes` oversized rule applies. `IngestRows`
  (`apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts:108-112`) gains `outcomes?: readonly RunOutcomeRow[]` with
  `RunOutcomeRow = { kind: 'report' | 'decisions'; content: string }`. `parseBundle` puts a `report` row for a
  non-empty `featureReport` text and a `decisions` row for a non-empty `decisions` text into `rows.outcomes`, each
  `content` cut to `RUN_OUTCOME_MAX_CHARS = 262_144` characters; the per-file `files` record and the `partial` rule are
  unchanged. `BundleIngestService.write` (`bundle-ingest.service.ts:75-105`) passes `rows.outcomes` to `replaceRows`
  only when `job.command === 'RUN'`, else an empty list, and its transaction result carries `isRun` for the post-commit
  hook of D8. The `readBundleFiles` accumulator (`bundle-reader.ts:58`) starts both new fields at null, and its entry
  handler (`:80-83`) assigns them as single files, like `workflowResult`. `PrismaBundleIngestRepository.replaceRows`
  (`prisma-bundle-ingest.repository.ts:52-73`) also deletes the job's `FleetRunOutcome` rows of `ctx.leaseEpoch` and
  creates one row per outcome with `ctx.projectId` and `ctx.repoId`; an absent `rows.outcomes` counts as an empty list. `INGEST_PARSER_VERSION`
  (`domain/bundle-ingest.domain.ts:7`) becomes 3. The schema change is in `apps/api/prisma/schema.prisma`; the client is
  regenerated with `bun run db:generate` (the generated client is not committed).
- 3c-2-D2 (patterns): `apps/api/src/fleet/knowledge/knowledge-patterns.ts` (pure) exports
  `DEFAULT_KNOWLEDGE_PATTERNS: readonly string[] = ['README.md', '.nax/context.md', 'AGENTS.md', 'docs/**/*.md',
  '.nax/features/*/spec.md']`, `matchesKnowledgePattern(path: string, pattern: string): boolean` and
  `parseKnowledgePatterns(input: unknown): { ok: true; value: string[] } | { ok: false; reason: string }`.
  Matching splits the pattern and the path at `/`: a `**` segment matches zero or more whole path segments, `*` inside a
  segment matches any run of characters other than `/`, every other character matches itself. `parseKnowledgePatterns`
  accepts an array of 1 to 50 strings; each is trimmed and must be 1 to 200 characters, end with `.md`, use only
  `A-Z a-z 0-9 . _ - * /`, not start with `/`, have no empty segment, no `.` or `..` segment, and use `**` only as a
  whole segment; the first failing entry answers `{ ok: false, reason: 'patterns[<i>]' }` (a non-array or an array
  outside 1-50 answers `reason: 'patterns'`). Duplicates are removed, first kept.
  `selectIndexableEntries` (`knowledge-allowlist.ts:27`) gains an optional second parameter
  `patterns?: readonly string[]`: when given, an entry is indexable when it matches any pattern; when absent the 3c-1
  `isIndexablePath` rule decides, unchanged. The `AGENTS.md`-beside-`.nax/context.md` rule, the size, safe-path and
  2000-file rules apply either way.
  Migration `20261021091000_knowledge_project_patterns` adds
  `model KnowledgeProjectPatterns { projectId String @id; patterns Json; updatedAt DateTime @updatedAt; project Project
  @relation(fields: [projectId], references: [id], onDelete: Cascade) }` and `Project` gains
  `knowledgePatterns KnowledgeProjectPatterns?`. `IKnowledgeIndexRepository` (`knowledge-index.domain.ts`) gains
  `findProjectPatterns(projectId): Promise<string[] | null>`, `saveProjectPatterns(projectId, patterns: string[] |
  null): Promise<void>` (null deletes the row). The same migration adds `patternsKey String?` to `KnowledgeRepoIndex`,
  and `KnowledgeIndexState` and `KnowledgeFinishResult` gain `patternsKey?: string | null` (`finish` writes it when
  given, like `indexedSha`). A pattern list's key is `knowledgePatternsKey(patterns: readonly string[] | null): string`
  in `knowledge-patterns.ts`: `default` for null, else the patterns joined by a newline. `KnowledgeIndexService` gains `getPatterns(projectId): Promise<{
  patterns: string[]; custom: boolean }>` (the stored list, else `DEFAULT_KNOWLEDGE_PATTERNS` with `custom: false`) and
  `savePatterns(projectId, patterns: string[] | null): Promise<{ patterns: string[]; custom: boolean }>`.
  `KnowledgeRepoIndexer.indexRepo` reads `findProjectPatterns(repo.projectId)` after the claim, passes a non-null list
  to `selectIndexableEntries`, and computes the pass's key with `knowledgePatternsKey`. The unchanged short-circuit
  (`knowledge-repo-indexer.ts:78`) additionally requires the stored `patternsKey` to equal that key, and the idle finish
  (`:118`) writes it. A pass that started before a save therefore records the old key, and the next pass re-selects;
  a row written before this feature has a null key, so its first pass re-selects (files whose blob sha is unchanged are
  still skipped, step 8 of 1c-c-D9).
- 3c-2-D3 (pattern routes): `ProjectKnowledgeController` gains `PUT patterns` (`@RequiredPermission('ADMIN')`, the
  reindex route's permission, HTTP 200), body `KnowledgePatternsBodyDto` = `{ patterns: string[] | null }` declared
  `@Allow() @ApiProperty({ nullable: true, type: [String] }) patterns` (the `KnowledgeSearchBodyDto` pattern,
  `project-knowledge.controller.ts:18-23`, so the global whitelisting pipe keeps the field); any other body, or a list
  `parseKnowledgePatterns` rejects, answers 400 `knowledge.input` with `{ reason }`. It calls `savePatterns`, then, when
  `knowledgeIndexEnabled`, enqueues every `listProjectRepos(projectId)` repository with reason `admin`, and answers
  `{ patterns, custom, queued }` where `queued` is the number of repositories enqueued (0 when disabled). It answers
  even when indexing is disabled. `GET repos` gains `patterns: string[]`, `customPatterns: boolean` and
  `defaultPatterns: string[]` (from `getPatterns` and `DEFAULT_KNOWLEDGE_PATTERNS`).
- 3c-2-D4 (outcome reads): `IKnowledgeIndexRepository` gains `findRunOutcomes(jobId): Promise<KnowledgeRunOutcomes |
  null>` and `describeJobs(projectId, jobIds: string[]): Promise<KnowledgeJobInfo[]>`, the knowledge repository
  reading fleet tables directly as its 3c-1 `findProjectRepos` already reads `FleetRepo`. This is a recorded exception to
  the cross-module rule of `.nax/rules/api-data.md` (call the owning module's service): `KnowledgeModule` cannot import
  `FleetJobsModule`, because `FleetJobsModule` imports `FleetTicketsModule` (`fleet/jobs/fleet-jobs.module.ts:24`), which
  imports `KnowledgeModule` (`fleet/tickets/fleet-tickets.module.ts:21`). The reads are read-only and stay inside the
  module-private repository. `KnowledgeRunOutcomes = { job: { id, projectId, repoId, owner,
  name, feature, resultSha: string | null }, outcomes: RunOutcomeRow[] }` holds the rows of the job's latest ingested
  epoch: the highest `leaseEpoch` among the job's `FleetBundleIngest` rows whose `status` is `done` or `partial`, with
  `outcomes` empty when that epoch has no outcome row (so a newer bundle without a report retires the older one);
  null for an unknown job. `KnowledgeJobInfo = { jobId, repoId, feature, state, prUrl:
  string | null, prState: string | null }`, with `prUrl` = `FleetJob.resultPrUrl` and `prState` = the `prState` of the
  job's most recently updated `TicketLink` with `source = 'fleet'` and non-null `prState` (ordered `prUpdatedAt` desc,
  then `id`), else null; only jobs of `projectId` are returned. It runs two bounded queries: the jobs
  (`where id in jobIds and projectId`, `take: 200`) and their fleet links (`where jobId in jobIds, source 'fleet', prState
  not null`, ordered `prUpdatedAt` desc then `id`, `take: 1000`), keeping the first link per job. `KnowledgeIndexService`
  gains `describeJobs(projectId, jobIds)` passing through.
- 3c-2-D5 (decisions chunker): `chunkDecisions(text: string): MarkdownChunk[]` in
  `apps/api/src/fleet/knowledge/decisions-chunker.ts` is pure. Each non-empty line that parses as a JSON object with a
  string `id` is one chunk, in file order, at most `MAX_DECISION_CHUNKS = 1000` (later lines ignored, which keeps a
  decisions file under the chunk store's 2000-row read cap, `knowledge-chunk-store.ts:4`); other lines are skipped. A chunk has
  `chunkIndex` = its position from 0, `title` and `headingPath` = `Decision <id>`, `anchor` = the 1c-c-D8 anchor rule
  applied to `id` (`markdown-chunker.ts` exports its existing `slug` and `uniqueAnchor` helpers, `:215`, `:219`, for this) (lower-case, keep `a-z 0-9 space - _`, spaces to `-`; a repeated anchor gets `-1`, `-2`, ...),
  `abstract` = the first 300 characters of `rationale` (empty when absent), and `text` = these lines, each omitted when
  its values are absent: `Decision <id> (<kind>)`, `Question: <questionId>`, `Chosen: <chosenOptionId> -> <action.type>`,
  `Rationale: <rationale>`, `Decided: <decidedAt>` followed by ` by <model>` and `, confidence <confidence>` when
  those are present (the `Decided` line is omitted when `decidedAt` is absent). Values are read only when they are
  strings.
- 3c-2-D6 (outcome chunk rows): an outcome chunk is one `LanceRecord` in `project_<projectId>`:
  `source = 'outcome'`, `source_id = outcome:<repoId>:<jobId>:<kind>`, `id = <source_id>#<chunkIndex>`, `content` = the
  context line `<owner>/<name> · run <jobId> · <feature> · <path>` (plus ` · <headingPath>` when non-empty), a newline,
  the abstract, a blank line, then the chunk text; `metadata` = `JSON.stringify` of `{ repoId, owner, name, path,
  sha, blobSha: '', jobId, feature, outcomeKind, title, headingPath, anchor, chunkIndex, chunkCount, abstract, text }`
  where `path` is `feature-report.md` or `decisions.jsonl`, `outcomeKind` is `report` or `decisions`, and `sha` is the
  job's `resultSha` or `''`; vector, `provider` and `model` follow 1c-c-D4 (unembedded = `provider: 'none'` and a zero
  vector). `KnowledgeChunkMetadata` (`knowledge-chunk-store.ts:31-48`) gains optional `jobId`, `feature` and
  `outcomeKind`.
- 3c-2-D7 (outcome indexing): `KnowledgeRepoIndexer` gains `indexOutcomes(jobId: string, now = new Date()):
  Promise<OutcomePassResult>`, `OutcomePassResult = { status: 'indexed' | 'skipped' | 'failed'; reason?: string }`:
  1. `findRunOutcomes(jobId)`; null resolves `{ status: 'skipped', reason: 'unknown job' }` and writes nothing.
  2. For `report` then `decisions`: when the job has that outcome, the chunks are `chunkMarkdown({ path:
     'feature-report.md', text })` or `chunkDecisions(text)`; contents are embedded with the existing private
     `embedAll` (batches of `KNOWLEDGE_EMBED_BATCH`, `EMBED_REQUEST_TIMEOUT_MS`, `FILE_EMBED_DEADLINE_MS` per outcome
     file) and the rows written with `KnowledgeChunkStore.replaceFile(projectId, sourceId, rows)`. When the job has no
     such outcome, or its chunk list is empty, `deleteFile(projectId, sourceId)` removes any earlier rows.
  3. After both, `RagService.optimizeTable(projectId)` runs once; the pass resolves `indexed`.
  4. Any thrown error resolves `{ status: 'failed', reason }` with the message cut to 500 characters.
  No `KnowledgeRepoIndex` or `KnowledgeRepoFile` state is written for outcomes. Outcomes are indexed whatever the
  job's repository host: they are read from Postgres, not from the forge. The two outcome files are written one after
  the other on purpose: they share one embedding server, the reason `embedAll` is sequential.
- 3c-2-D8 (outcome queue and trigger): `KnowledgeIndexQueue` gains `enqueueOutcomes(jobId: string): void`. It adds
  the key `job:<jobId>` to the same waiting set as repository ids (one FIFO, one pass at a time, the 1000-entry cap,
  a key already waiting is not added twice, a no-op when `knowledgeIndexEnabled` is false, never throws); the drain
  runs `indexOutcomes(jobId)` for a `job:` key and `indexRepo(repoId)` for any other, and logs a `failed` result with
  `Logger.warn`. `IngestModule` (`apps/api/src/fleet/ingest/ingest.module.ts`) imports `KnowledgeModule` (no cycle:
  `KnowledgeModule` imports no fleet module). `BundleIngestService` gains a tenth constructor dependency `knowledge:
  KnowledgeIndexQueue` and, after the ingest transaction commits for a job whose `command` is `RUN`, calls
  `knowledge.enqueueOutcomes(job.id)` once per ingest.
- 3c-2-D9 (search over outcomes): `KnowledgeSearchQuery` (`knowledge-search.service.ts:38-45`) gains
  `source?: 'docs' | 'outcomes' | 'all'`, default `all`. With `D` = `source = 'repo'` (plus
  ` AND source_id LIKE 'repo:<repoId>:%'` when `repoId` is given) and `O` = `source = 'outcome'` (plus
  ` AND source_id LIKE 'outcome:<repoId>:%'`): the lexical predicate is `D` for `docs`, `O` for `outcomes` and
  `(D) OR (O)` for `all`; the vector predicate is the 3c-1 form for `docs` (`source = 'repo' AND provider != 'none'`
  plus the repository clause, unchanged), `source = 'outcome' AND provider != 'none'` plus the repository clause for
  `outcomes`, and `(<docs form>) OR (<outcomes form>)` for `all`. After fusion, in order: hits of a repository not
  in `listProjectRepos` are dropped (3c-1); when `pathPrefix` is given, outcome hits are dropped and doc hits filtered
  by prefix (3c-1), so `source: 'outcomes'` with a `pathPrefix` answers no hit; `describeJobs(projectId, <outcome hit job ids>)` is called once when any outcome hit remains, and
  outcome hits whose job it does not return are dropped; the list is cut to `limit`. `KnowledgeHit`
  (`:22-36`) gains `source: 'repo' | 'outcome'`, derived from the row's `sourceId` prefix (`outcome:` is `outcome`,
  anything else `repo`; `KnowledgeChunkRow` is unchanged), and, on outcome hits only, `jobId`, `feature`, `outcomeKind`,
  `jobState`, `prState` (string or null) and `prUrl` (string or null). `empty` is true when no hit answers and the table
  holds no row of the asked sources: `KnowledgeChunkStore.hasRepoRows` for `docs`, a new `hasOutcomeRows(projectId)`
  for `outcomes`, either for `all`. `KnowledgeSearchService` gains `readOutcome(projectId, jobId, path):
  Promise<KnowledgeChunkRow[]>`: `describeJobs(projectId, [jobId])`; no job answers `[]`; else
  `readFile(projectId, 'outcome:<repoId>:<jobId>:<kind>')` with `kind` `report` for `feature-report.md` and
  `decisions` for `decisions.jsonl`.
- 3c-2-D10 (search route and eval): the `POST search` body (`parseKnowledgeSearchInput`, `:72`) gains
  `source?: 'docs' | 'outcomes' | 'all'`; another value answers 400 `knowledge.input`; the route passes `source` to
  the service only when the body has it. `KnowledgeHitDto` gains the D9 fields, each with `@ApiProperty` (optional ones `required: false`). The `kb:eval` script
  (`apps/api/scripts/kb-eval.ts:179`) sends `source: 'docs'` so its scores stay comparable with the 3c-1 baseline.
- 3c-2-D11 (tools): `koda_kb_search` input gains `source?: 'docs' | 'outcomes' | 'all'` (any other value
  `ToolInputError('source')`), passed to `search` only when given. An outcome hit's line is
  `[<i>] job:<jobId>/<path>#<anchor> — <feature> · <headingPath> (run <jobState>, PR <prState>)`, with `#<anchor>`
  omitted when empty, ` · <headingPath>` omitted when empty, and `, PR <prState>` omitted when `prState` is null;
  `ctx.data(abstract + '\n' + snippet)` follows as for doc hits. When `empty`, the answer is
  `knowledge index is empty for this project` for `docs` and `all` (3c-1 text) and `no run outcomes are indexed for
  this project` for `outcomes`. `koda_get_doc` also accepts a citation matching
  `^job:([a-z0-9]{20,40})\/(feature-report\.md|decisions\.jsonl)(?:#([a-z0-9_-]+))?$`; it reads
  `KnowledgeSearchService.readOutcome(ctx.projectId, jobId, path)`, applies the 3c-1 anchor and part rules and the
  chunk-0 rule (`documentText`, `kb-tools.ts:222`) to `feature-report.md` only, because chunk 0 of `decisions.jsonl` is
  a decision, not a summary,
  and answers a line `job:<jobId>/<path> (<feature>) part <p> of <m>` followed by `ctx.data(part text)`; no rows throws
  `NotFoundAppException`. `KODA_KB_SEARCH`'s `inputSchema` gains the `source` enum property and `KODA_GET_DOC`'s
  `citation` description names the `job:` form.
- 3c-2-D12 (web settings): `apps/web/pages/[project]/settings.vue` gains a fourth tab `knowledge` (after `skills`,
  `:85-87`; the tab list's `grid-cols-3` at `:78` becomes `grid-cols-4`) rendering `SettingsKnowledgeCard` (`apps/web/components/SettingsKnowledgeCard.vue`, prop `slug`). The card
  loads `GET /projects/<slug>/knowledge/repos` through `useApi()` and `apiPath`; when `enabled` is false it shows a
  notice (`data-testid="knowledge-disabled"`). It renders one row per repository (`data-testid="knowledge-repo-<repoId>"`)
  with `owner/name`, `status`, the first 7 characters of `indexedSha`, `fileCount`, `chunkCount`, `unembeddedCount`,
  `skippedCount`, `lastError` and `finishedAt`. For a global admin (`useAuth().user.value?.role === 'ADMIN'`, the
  `CommandPalette.vue:15` rule) and only when `enabled`, each row has a re-index button that posts
  `/projects/<slug>/knowledge/repos/<repoId>/reindex`, toasts success and reloads the state. The patterns editor is a
  textarea (`data-testid="knowledge-patterns"`) holding `patterns` one per line, editable only by a global admin;
  Save sends `PUT /projects/<slug>/knowledge/patterns` with `{ patterns: <non-empty trimmed lines> }`, Reset to default
  sends `{ patterns: null }`; both toast and reload; a failure toasts `extractApiError(err)`. The form is validated with
  a zod schema (1 to 50 non-empty lines, each ending in `.md`) whose messages are i18n keys. Strings live under a
  `knowledge` group in `apps/web/i18n/locales/en.json` and `zh.json`.
- 3c-2-D13 (web citation links): `renderThreadMarkdown` (`apps/web/lib/thread-markdown.ts:203`) also links, under
  the existing standalone rule (`CONTINUES_PATH`, `:41`) and the code-span rule (`wholePath`, `:51`): a document
  citation `<owner>/<name>:<path>@<sha>[#<fragment>]` (owner and name `[A-Za-z0-9_.-]+`, path without `@`, `#` or
  whitespace, sha 7-40 lower-case hex, fragment `[A-Za-z0-9_-]+`) to
  `https://github.com/<owner>/<name>/blob/<sha>/<path>[#<fragment>]` with `target="_blank"` and
  `rel="noopener noreferrer"`; and an outcome citation `job:<jobId>/(feature-report.md|decisions.jsonl)[#<fragment>]`
  to `/<slug>/fleet/jobs/<jobId>`. Like the path links, citations are linked only when a slug is given (`:205`). The link text is the citation; the
  result still passes `sanitizeHtmlFragment`
  (whose `ALLOWED_URI_REGEXP`, `apps/web/lib/markdown.ts:19`, admits `https:` and `/`).

### Integration

Read-only symbols (verified on main `7a701489`):

- `readBundleFiles(bundle)`, `slotOf(rawName)` (`apps/api/src/fleet/ingest/bundle-reader.ts:56,35`);
  `INGEST_LIMITS.fileBytes` (`domain/bundle-ingest.domain.ts:15-16`).
- `PrismaBundleIngestRepository.rerunOutdated(parserVersion)` (`prisma-bundle-ingest.repository.ts:109`) and its route
  (`fleet-ingest.controller.ts:60`): the backfill path, unchanged.
- `chunkMarkdown({ path, text })`, `MarkdownChunk` (`apps/api/src/fleet/knowledge/markdown-chunker.ts`).
- `KnowledgeChunkStore.replaceFile`, `deleteFile`, `readFile`, `lexical`, `vector`, `hasRepoRows`
  (`knowledge-chunk-store.ts`); `isSafeFilterValue` (`apps/api/src/rag/lance-table-manager.ts:37`).
- `KnowledgeIndexService.listProjectRepos`, `resolveProjectRepo`, `listProjectStates`
  (`knowledge-index.service.ts`).
- `RagService.optimizeTable(projectId)` (`apps/api/src/rag/rag.service.ts:134`).
- `FleetJob` fields `projectId`, `repoId`, `command`, `feature`, `state`, `resultSha`, `resultPrUrl`
  (`apps/api/prisma/schema.prisma:986-1040`); `TicketLink` fields `prState`, `prUpdatedAt`, `source`, `jobId`
  (`schema.prisma:350-370`).
- Web: `useApi()`, `extractApiError` (`apps/web/composables/useApi.ts`; `put` at `:256`), `apiPath`
  (`apps/web/lib/api-path.ts`), `useAppToast()`, `useAuth()`; `SettingsProjectCard.vue` (the card pattern);
  `sanitizeHtmlFragment` (`apps/web/lib/markdown.ts`).

Symbols this feature changes. The baseline only locates the code; implement the target.

- `BundleFiles`, `SLOTS`, `readBundleFiles` (`bundle-reader.ts:11-20,24-32,56`)
  - Baseline: seven slots; no report or decisions fields.
  - Target: 3c-2-D1 (two optional fields, two slots).
- `IngestRows`, `parseBundle`, `INGEST_PARSER_VERSION` (`domain/bundle-ingest.domain.ts:108,7`; `parse-bundle.ts`)
  - Baseline: rows of cost events, stories, reviews; parser version 2.
  - Target: 3c-2-D1 (`outcomes` rows; version 3).
- `PrismaBundleIngestRepository.replaceRows` (`prisma-bundle-ingest.repository.ts:52-73`)
  - Baseline: replaces cost, story and review rows of `(jobId, leaseEpoch)`.
  - Target: also replaces `FleetRunOutcome` rows of `(jobId, leaseEpoch)` (3c-2-D1).
- `BundleIngestService` constructor and `write` (`bundle-ingest.service.ts:28-38,75-105`)
  - Baseline: nine dependencies; never touches knowledge.
  - Target: a tenth dependency `knowledge: KnowledgeIndexQueue`; RUN outcomes passed to `replaceRows` and
    `enqueueOutcomes` after commit (3c-2-D1, D8).
- `IngestModule` imports (`ingest.module.ts:16`)
  - Baseline: `[PrismaModule, ArtifactStoreModule, FleetJobsModule, FleetActivityModule, BudgetsModule, FleetTicketsModule]`.
  - Target: the same list plus `KnowledgeModule`.
- `selectIndexableEntries(entries)` (`knowledge-allowlist.ts:27`)
  - Baseline: one parameter; `isIndexablePath` decides.
  - Target: `selectIndexableEntries(entries, patterns?)` (3c-2-D2).
- `IKnowledgeIndexRepository`, `PrismaKnowledgeIndexRepository` (`knowledge-index.domain.ts`, `prisma-knowledge-index.repository.ts`)
  - Baseline: the 3c-1 methods.
  - Target: plus `findProjectPatterns`, `saveProjectPatterns` and the `patternsKey` field (D2), `findRunOutcomes`,
    `describeJobs` (D4).
- `KnowledgeIndexService` (`knowledge-index.service.ts`)
  - Baseline: `resolveProjectRepo`, `listProjectRepos`, `listProjectStates`.
  - Target: plus `getPatterns`, `savePatterns` (D2), `describeJobs` (D4).
- `KnowledgeRepoIndexer.indexRepo` and the class (`knowledge-repo-indexer.ts:46-130`)
  - Baseline: selects with `selectIndexableEntries(tree.entries)`; no outcome method.
  - Target: selects with the project's patterns (D2); gains `indexOutcomes` (D7).
- `KnowledgeIndexQueue` (`knowledge-index.queue.ts:35-75`)
  - Baseline: `enqueue(repoId, reason)`; the drain always calls `indexRepo`.
  - Target: plus `enqueueOutcomes(jobId)`; the drain dispatches by key (D8).
- `KnowledgeChunkMetadata` (`knowledge-chunk-store.ts:31-48`), `KnowledgeChunkStore`
  - Baseline: repository metadata only; `hasRepoRows`.
  - Target: optional `jobId`, `feature`, `outcomeKind` (D6); plus `hasOutcomeRows` (D9).
- `KnowledgeSearchQuery`, `KnowledgeHit`, `KnowledgeSearchService.search`, `parseKnowledgeSearchInput`
  (`knowledge-search.service.ts:22-45,72,139`)
  - Baseline: repository chunks only.
  - Target: 3c-2-D9, D10; plus `readOutcome`.
- `ProjectKnowledgeController`, `KnowledgeHitDto`, `KnowledgeSearchBodyDto`, `KnowledgeRepoStatesDto`
  (`project-knowledge.controller.ts:18-135`, `knowledge-repo-state.dto.ts:25-28`)
  - Baseline: `GET repos`, `POST repos/:repoId/reindex`, `POST search`.
  - Target: plus `PUT patterns` and the `GET repos` pattern fields (D3); the search `source` field and hit fields (D10).
- `kbSearchTool`, `getDocTool`, `CITATION_PATTERN`, `citationLine` (`apps/api/src/fleet/assistant/tools/kb-tools.ts:37,159,175,273`);
  `KODA_KB_SEARCH`, `KODA_GET_DOC` (`apps/api/src/fleet/assistant/koda-tool-descriptors.ts:222,251`)
  - Baseline: repository docs only.
  - Target: 3c-2-D11.
- `runEval` request body (`apps/api/scripts/kb-eval.ts:179`)
  - Baseline: `{ query, limit: 20 }`.
  - Target: `{ query, limit: 20, source: 'docs' }` (D10).
- `apps/web/pages/[project]/settings.vue` tabs (`:79-87`)
  - Baseline: `project`, `vcs`, `skills`.
  - Target: plus `knowledge` (D12).
- `renderThreadMarkdown` and its path linking (`apps/web/lib/thread-markdown.ts:41-60,186-191,203`)
  - Baseline: links `/<slug>/tickets/<ref>` and `/<slug>/fleet/jobs/<id>` only.
  - Target: also the two citation forms (D13).

### Failure Handling

| Case | Behaviour | Story |
|---|---|---|
| Bundle has no `feature-report.md` / `decisions.jsonl` | no outcome row of that kind | US-001 |
| Outcome text over 262144 characters | cut to 262144 characters | US-001 |
| Non-RUN job's bundle carries the files | no outcome rows | US-001 |
| Re-ingest of the same `(jobId, leaseEpoch)` | outcome rows replaced, not duplicated | US-001 |
| Invalid patterns body | 400 `knowledge.input` with the failing `reason` | US-002 |
| Patterns saved while indexing is disabled | saved, `queued: 0` | US-002 |
| Patterns route by a non-admin | 403 | US-002 |
| Patterns saved while a pass runs | that pass records the old `patternsKey`; the next pass re-selects | US-002 |
| Unknown job at `indexOutcomes` | `skipped` `unknown job`, nothing written | US-004 |
| Outcome embedding fails | chunks stored unembedded (`provider: 'none'`), excluded from the vector leg | US-004 |
| A later ingest has no outcome of a kind | that kind's earlier rows deleted | US-004 |
| Outcome pass throws | `failed` with the message, logged by the queue; the drain continues | US-004 |
| Kill switch off | `enqueueOutcomes` does nothing | US-004 |
| Decisions line that is not a JSON object with a string `id` | skipped | US-003 |
| More than 1000 decisions | the first 1000 are chunks | US-003 |
| Outcome hit whose job is not the project's or no longer exists | dropped | US-005 |
| `pathPrefix` with `source: all` | outcome hits dropped | US-005 |
| Unknown `source` value | route 400, tool `invalid_input: source` | US-005, US-006 |
| `koda_get_doc` job citation with no rows or a foreign job | `not_found` | US-006 |
| Knowledge state request fails in the web card | the page's `ErrorState` with retry | US-007 |
| Re-index or patterns save fails in the web card | toast `extractApiError(err)` | US-007 |

## Out of Scope

- No outcome index state: `GET repos` reports repository passes only; outcome passes are logged, not recorded.
- Outcomes are indexed only for RUN jobs; PLAN, CONFIG_EDIT, CONFIG_DRIFT and THREAD jobs produce none.
- A lost or failed outcome pass is not retried automatically: the in-process queue does not survive a restart, a full queue drops the key with a warning, and outcome passes record no state. The existing ingest re-run routes (per job, or all outdated) re-ingest and re-queue.
- `KnowledgeModule`'s repository reads `FleetJob`, `FleetRunOutcome`, `FleetBundleIngest` and `TicketLink` directly (D4); moving those reads behind a jobs-module service is out of scope while the module cycle exists.
- Run outcomes of a job whose bundle expired before the backfill are not recovered.
- Calling the re-run-outdated route after deploy is a deployment step, not story work; indexing must be enabled first, or the re-ingest queues no outcome pass.
- No pattern syntax beyond `*` and `**`: no `?`, character classes, braces or negation, and patterns select Markdown (`.md`) files only.
- Patterns are per project, not per repository.
- No web search page over the knowledge index; agents search through tools, admins through the REST route.
- Citation links target GitHub only; GitLab repositories' docs are not indexed (3c-1), though their RUN outcomes are.
- The `kb:eval` questions and scoring are unchanged; the script searches `docs` only.
- Ticket search, the existing `/kb` web page and its routes are unchanged (1c-c-R6).
- No LLM-written summaries of outcomes; abstracts stay extractive (S5b-R14).
- US-002 only: saving patterns does not delete the chunks of files the new patterns exclude until each repository's next pass runs.
- The generated CLI client (`apps/cli/src/generated/`) is git-ignored; regenerating it leaves no diff in a story.
- US-004 only: two API instances do not coordinate outcome passes; koda runs one API instance, and replace-by-`source_id` keeps a repeated pass idempotent.
- US-005 only: job and pull request state are read per search, not cached; a search describes at most 200 job ids, the first 200 outcome hits in rank order, and drops the outcome hits past them.
- US-007 only: the web card does not poll; it reloads after an action or a page visit.

## Stories

1. **US-001: Run outcome rows at bundle ingest** — `Workdir: apps/api` — No dependencies.
2. **US-002: Per-project path patterns** — `Workdir: apps/api` — Depends on US-001.
3. **US-003: Decisions chunker** — `Workdir: apps/api` — No dependencies.
4. **US-004: Outcome indexing pass and ingest trigger** — `Workdir: apps/api` — Depends on US-001, US-002, US-003.
5. **US-005: Search over outcomes** — `Workdir: apps/api` — Depends on US-004.
6. **US-006: Agent tools over outcomes** — `Workdir: apps/api` — Depends on US-005.
7. **US-007: Knowledge settings tab and citation links** — `Workdir: apps/web` — Depends on US-002.

Seven stories is the ceiling: outcome storage, indexing, search and tools are a producer/consumer chain whose merged
neighbours exceed 15 acceptance criteria; the edges US-001 -> US-002 -> US-004 order the stories that edit the same
`schema.prisma`, indexer, domain and repository files; the decisions chunker is pure and separate because the indexing pass with its
queue and ingest trigger already carries 12; patterns are independent of the chain; and the web is its own package.
US-002 and US-005 each regenerate `openapi.json` with `bun run api:export-spec` and the CLI client with
`bun run generate`. US-001 and US-002 change `apps/api/prisma/schema.prisma` and run `bun run db:generate`. Route
cases go into `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` (the api testing rule keeps endpoint coverage there).

### Context Files

**US-001**

- `apps/api/prisma/schema.prisma` — `FleetJob` at `:986`, where the `FleetRunOutcome` model and back-relation go.
- `apps/api/src/fleet/ingest/bundle-reader.ts` — `SLOTS`, `slotOf`, `readBundleFiles` and its accumulator.
- `apps/api/src/fleet/ingest/parse-bundle.ts` — `parseBundle`, the place outcome rows are produced.
- `apps/api/src/fleet/ingest/prisma-bundle-ingest.repository.ts` — `replaceRows` at `:52`.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — `write` at `:75`, where `job.command` is known.

**US-002**

- `apps/api/prisma/schema.prisma` — `KnowledgeRepoIndex` at `:824` and `Project` at `:156`.
- `apps/api/src/fleet/knowledge/knowledge-allowlist.ts` — `isIndexablePath`, `selectIndexableEntries`.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — `indexRepo`, the selection at `:85`, the short-circuit at `:78` and the idle finish at `:118`.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — the reindex route's permission and enqueue.
- `apps/api/src/fleet/knowledge/prisma-knowledge-index.repository.ts` — the state repository and `finish` at `:90`.

**US-003**

- `apps/api/src/fleet/knowledge/markdown-chunker.ts` — `MarkdownChunk`, `slug` at `:215` and `uniqueAnchor` at `:219` to export and reuse.
- `.nax/features/fleet-s5b-koda-knowledge-index/decisions.jsonl` — a real decisions log, the input shape.

**US-004**

- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.ts` — `rows` and `embedAll`, the embedding path `indexOutcomes` reuses.
- `apps/api/src/fleet/knowledge/knowledge-index.queue.ts` — `enqueue` and the drain.
- `apps/api/src/fleet/knowledge/decisions-chunker.ts` — created by US-003; `chunkDecisions` is called here.
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — `write`, the post-commit hook site.
- `apps/api/src/fleet/ingest/ingest.module.ts` — imports to extend with `KnowledgeModule`.

**US-005**

- `apps/api/src/fleet/knowledge/knowledge-search.service.ts` — `search`, the predicates and filters to extend.
- `apps/api/src/fleet/knowledge/knowledge-chunk-store.ts` — `hasRepoRows`, `readFile`, `parseRow`.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.ts` — `POST search`, `KnowledgeHitDto`.
- `apps/api/src/fleet/knowledge/prisma-knowledge-index.repository.ts` — the repository `describeJobs` and `findRunOutcomes` join in.
- `apps/api/scripts/kb-eval.ts` — the request body at `:179`.

**US-006**

- `apps/api/src/fleet/assistant/tools/kb-tools.ts` — `kbSearchTool`, `getDocTool`, `CITATION_PATTERN`, `citationLine`, `documentText` at `:221`.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_KB_SEARCH`, `KODA_GET_DOC`.
- `apps/api/src/fleet/knowledge/knowledge-search.service.ts` — `search` and `readOutcome` from US-005.
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts` — the `invalid_input` / `not_found` mapping.

**US-007**

- `apps/web/components/SettingsProjectCard.vue` — the settings card pattern (`useApi`, toast, emit).
- `apps/web/pages/[project]/settings.vue` — the tabs at `:77-87`.
- `apps/web/lib/thread-markdown.ts` — `pathPattern`, `wholePath`, `linkifyText`, `renderThreadMarkdown`.
- `apps/web/tests/components/settings-project-card.spec.ts` — the component test harness to mirror.
- `apps/web/tests/lib/thread-markdown.spec.ts` — the linking tests to extend.

### Creates

**US-001**

- `apps/api/prisma/migrations/20261021090000_fleet_run_outcomes/migration.sql` — the `FleetRunOutcome` table.

**US-002**

- `apps/api/src/fleet/knowledge/knowledge-patterns.spec.ts` — the unit tests of the pattern helpers.
- `apps/api/src/fleet/knowledge/knowledge-patterns.ts` — `DEFAULT_KNOWLEDGE_PATTERNS`, `matchesKnowledgePattern`, `parseKnowledgePatterns`, `knowledgePatternsKey`.
- `apps/api/prisma/migrations/20261021091000_knowledge_project_patterns/migration.sql` — the `KnowledgeProjectPatterns` table and the `patternsKey` column.

**US-003**

- `apps/api/src/fleet/knowledge/decisions-chunker.ts` — `chunkDecisions`, `MAX_DECISION_CHUNKS`.
- `apps/api/src/fleet/knowledge/decisions-chunker.spec.ts` — the chunker's unit tests.

**US-004**

None. Every change is to an existing file.

**US-005**

None. Every change is to an existing file.

**US-006**

None. Every change is to an existing file.

**US-007**

- `apps/web/components/SettingsKnowledgeCard.vue` — the knowledge settings card.
- `apps/web/tests/components/settings-knowledge-card.spec.ts` — the card's component tests.

### Modifies

Production files a story edits inside its own Workdir are named in Design and Context Files. This list holds only
files outside the story's Workdir and existing tests whose assertions the story's correct change breaks.

**US-001**

- `apps/api/src/fleet/ingest/bundle-reader.spec.ts` — the test `AC-8 keeps workflow reports and decisions unallowlisted` at `:11-14` asserts `slotOf` is null for the workflow feature report and the workflow decisions log; it becomes a test that they map to the slots `featureReport` and `decisions`. The workflow result test at `:8-10` is unchanged.
- `apps/api/src/fleet/ingest/parsers/workflow.parser.spec.ts` — the test `AC-15 is version 2` at `:64` asserts `INGEST_PARSER_VERSION` is 2; it asserts 3 after the D1 bump. Nothing else in the file changes.

**US-002**

- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — the `state` stub at `:28-32` gains `findProjectPatterns: vi.fn().mockResolvedValue(null)`, because `indexRepo` now reads the project's patterns; every existing assertion is unchanged.
- `apps/api/src/fleet/knowledge/knowledge-repo-indexer.spec.ts` — the unchanged-head test's stored state at `:128` gains `patternsKey: 'default'`, because the short-circuit now also compares the patterns key; its `unchanged` / `indexed` expectations at `:130` are unchanged.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts` — the `index` stubs at `:59-64` and `:312-315` gain `getPatterns` answering `{ patterns: DEFAULT_KNOWLEDGE_PATTERNS, custom: false }`, because `repos()` now reads the patterns; the exact `repos()` payloads at `:207-216` and `:239` gain `patterns`, `customPatterns: false` and `defaultPatterns`. Every other assertion is unchanged.
- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for the patterns route and the `GET repos` fields.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the patterns route; never hand-edited (git-ignored).
- `apps/cli/src/generated/sdk.gen.ts` — outside the api package: regenerated by `bun run generate` for the patterns route; never hand-edited (git-ignored).

**US-003**

None. The chunker is a new file with no existing caller.

**US-004**

- `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts` — the `new BundleIngestService(...)` call at `:14` gains a stub `KnowledgeIndexQueue` (`{ enqueueOutcomes: vi.fn() }`) as its tenth argument; every assertion is unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.workflow.spec.ts` — the `new BundleIngestService(...)` calls at `:46` and `:118` gain a stub `KnowledgeIndexQueue` as their tenth argument; every assertion is unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.outcomes.spec.ts` — the `new BundleIngestService(...)` call at `:26` gains a stub `KnowledgeIndexQueue` as its tenth argument; every assertion is unchanged.
- `apps/api/src/fleet/ingest/bundle-ingest.pr-links.spec.ts` — the `new BundleIngestService(...)` call at `:25` gains a stub `KnowledgeIndexQueue` as its tenth argument; every assertion is unchanged.

**US-005**

- `apps/api/src/fleet/knowledge/knowledge-search.service.spec.ts` — the tests that assert the 3c-1 predicates (`:97-108`, `:156-157`) or `empty` (`:168-206`) call `search` without `source`, which now means `all`; their `search` inputs gain `source: 'docs'`, and the asserted predicates and `empty` values are unchanged.
- `apps/api/src/fleet/knowledge/knowledge-search.service.spec.ts` — the exact doc-hit expectation at `:235-239` gains `source: 'repo'`, because every hit now carries its source; its other fields are unchanged.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the `HIT: KnowledgeHit` fixture at `:4140` gains `source: 'repo'`, because `source` is a required `KnowledgeHit` field; the search route assertions around it are unchanged.
- `apps/api/src/fleet/assistant/tools/kb-tools.spec.ts` — the typed `KnowledgeHit` literal at `:25` gains `source: 'repo'`, because `source` is a required `KnowledgeHit` field; every assertion is unchanged.
- `apps/api/src/fleet/knowledge/project-knowledge.controller.spec.ts` — the typed `HIT: KnowledgeHit` literal at `:38` gains `source: 'repo'`, because `source` is a required `KnowledgeHit` field; every assertion is unchanged.
- `apps/api/test/unit/scripts/kb-eval.spec.ts` — the request-body assertion at `:173` expects `{ query, limit: 20 }`; it becomes `{ query, limit: 20, source: 'docs' }`; every other assertion is unchanged.
- `openapi.json` — outside the api package: regenerated by `bun run api:export-spec` for the search `source` field and the hit fields.
- `apps/cli/src/generated/types.gen.ts` — outside the api package: regenerated by `bun run generate` for the search body and hit fields; never hand-edited (git-ignored).
- `apps/cli/src/generated/sdk.gen.ts` — outside the api package: regenerated by `bun run generate` for the search route; never hand-edited (git-ignored).

**US-006**

None. The tools pass `source` only when the input has it, so the existing `kb-tools.spec.ts` call assertions at `:103` and `:178` still hold, and its `inputSchema` checks use `toMatchObject`; the typed hit literal in that file is updated by US-005.

**US-007**

- `apps/web/tests/pages/settings-skills-tab.spec.ts` — the test `US-007 AC1: renders three tab triggers` at `:65-70` expects `['project', 'vcs', 'skills']`; it expects `['project', 'vcs', 'skills', 'knowledge']`, and its title says four triggers. Its other tests are unchanged.

### Seams

- SEAM-1 (US-001 -> US-004; entry point `BundleIngestService.ingestOne`): ingest writes `FleetRunOutcome` rows and,
  for a RUN job, calls `KnowledgeIndexQueue.enqueueOutcomes(jobId)` once after the transaction commits; US-004 AC 8
  asserts it on a stub queue and AC 9 asserts no call when the transaction fails.
- SEAM-2 (US-004 internal; entry point `BundleIngestService.ingestOne`): ingest through the real queue reaches
  `KnowledgeRepoIndexer.indexOutcomes(jobId)` (US-004 AC 10).
- SEAM-3 (US-003 -> US-004): `indexOutcomes` chunks a decisions outcome with `chunkDecisions`; US-004 AC 2 asserts the
  written rows carry the chunker's anchors.
- SEAM-4 (US-002 internal; entry point `PUT /api/projects/:slug/knowledge/patterns`): the route calls
  `KnowledgeIndexService.savePatterns` and `KnowledgeIndexQueue.enqueue(repoId, 'admin')` per repository (US-002 AC 12).
- SEAM-5 (US-002 internal; entry point `KnowledgeRepoIndexer.indexRepo`): the pass passes the stored patterns to
  `selectIndexableEntries` (US-002 AC 8) and records their key (US-002 AC 10).
- SEAM-6 (US-005 -> US-006; entry point `AssistantToolExecutor.execute`): `koda_kb_search` passes `source` to
  `KnowledgeSearchService.search`, and `koda_get_doc` calls `readOutcome` for a job citation (US-006 AC 1, AC 6).
- SEAM-7 (US-002 -> US-007; entry point the Knowledge tab): the card sends `PUT /projects/<slug>/knowledge/patterns`
  with the edited lines (US-007 AC 5).

## Acceptance Criteria

### US-001: Run outcome rows at bundle ingest (`Workdir: apps/api`)

1. [unit] `slotOf('workflow/feature-report.md')` answers `featureReport` and `slotOf('workflow/decisions.jsonl')` answers `decisions`, while `slotOf('workflow/x/feature-report.md')` answers null.
2. [unit] `readBundleFiles` on a gzipped tar holding `workflow/feature-report.md` (text `# R`) and `workflow/decisions.jsonl` returns `featureReport` `{ name: 'workflow/feature-report.md', text: '# R' }` and a `decisions` file with that entry's text.
3. [unit] `readBundleFiles` on a bundle with neither file returns `featureReport: null` and `decisions: null`.
4. [unit] `parseBundle` with a `featureReport` text `# R` and a `decisions` text of one line returns `rows.outcomes` equal to `[{ kind: 'report', content: '# R' }, { kind: 'decisions', content: <the line> }]`.
5. [unit] `parseBundle` with a `featureReport` of 262200 characters returns a `report` outcome whose `content` is the first 262144 characters.
6. [unit] `parseBundle` with an empty `featureReport` text and no `decisions` returns `rows.outcomes` as an empty list, and its `files` record and `partial` value equal those of the same bundle without the report.
7. [integration] `PrismaBundleIngestRepository.replaceRows` with outcome rows for `(job, leaseEpoch 1)` creates one `FleetRunOutcome` row per outcome carrying the context's `projectId` and `repoId`.
8. [integration] A second `replaceRows` for the same `(job, leaseEpoch 1)` with only a `report` outcome leaves exactly that one `FleetRunOutcome` row, and a row of `leaseEpoch 2` of the same job is untouched.
9. [integration] Deleting a `FleetJob` deletes its `FleetRunOutcome` rows.
10. [unit] `BundleIngestService.ingestOne` for a claimed RUN job whose bundle has a feature report calls `replaceRows` with `rows.outcomes` holding the `report` row.
11. [unit] `ingestOne` for a claimed PLAN job whose bundle has a feature report calls `replaceRows` with `rows.outcomes` empty.
12. [unit] `INGEST_PARSER_VERSION` equals 3.

### US-002: Per-project path patterns (`Workdir: apps/api`)

1. [unit] `matchesKnowledgePattern` answers true for (`docs/a.md`, `docs/**/*.md`), (`docs/x/y/b.md`, `docs/**/*.md`), (`.nax/features/f1/spec.md`, `.nax/features/*/spec.md`) and (`handbook/intro.md`, `handbook/*.md`), and false for (`docs/a.txt`, `docs/**/*.md`), (`.nax/features/a/b/spec.md`, `.nax/features/*/spec.md`) and (`apps/README.md`, `README.md`) (one table-driven test).
2. [unit] `parseKnowledgePatterns(['docs/**/*.md', ' handbook/*.md ', 'docs/**/*.md'])` answers `{ ok: true, value: ['docs/**/*.md', 'handbook/*.md'] }`.
3. [unit] `parseKnowledgePatterns` answers `{ ok: false, reason: 'patterns[1]' }` for `['README.md', 'src/a.ts']`, `['README.md', '/abs.md']`, `['README.md', 'docs/../x.md']`, `['README.md', 'docs/a**.md']` and `['README.md', 'docs//a.md']` (one table-driven test).
4. [unit] `parseKnowledgePatterns` answers `{ ok: false, reason: 'patterns' }` for `[]`, for a list of 51 valid patterns and for the string `'docs/*.md'` (one table-driven test).
5. [unit] `selectIndexableEntries(entries, DEFAULT_KNOWLEDGE_PATTERNS)` keeps the same paths as `selectIndexableEntries(entries)` for entries `README.md`, `AGENTS.md`, `.nax/context.md`, `docs/a.md`, `docs/x/b.md`, `.nax/features/f/spec.md`, `.nax/features/f/prd.json`, `apps/api/README.md` and `src/a.ts`.
6. [unit] `selectIndexableEntries(entries, ['handbook/*.md'])` keeps `handbook/a.md` and drops `docs/a.md` and `README.md`.
7. [unit] `selectIndexableEntries(entries, ['handbook/*.md'])` skips a `handbook/big.md` entry of 300000 bytes and reports `skipped: 1`.
8. [unit] `KnowledgeRepoIndexer.indexRepo` with `findProjectPatterns` answering `['handbook/*.md']` and a tree holding `handbook/a.md` and `docs/b.md` reads only `handbook/a.md` with `getFile`.
9. [unit] `indexRepo` whose head equals the stored `indexedSha`, with no unembedded file and a stored `patternsKey` of `default`, while `findProjectPatterns` answers `['handbook/*.md']`, does not resolve `unchanged` and calls `getTree`.
10. [unit] An `indexRepo` pass that finishes `idle` with `findProjectPatterns` answering `['handbook/*.md']` calls `finish` with `patternsKey: 'handbook/*.md'`, and with null calls it with `patternsKey: 'default'`.
11. [integration] `PrismaKnowledgeIndexRepository.saveProjectPatterns(p, ['a/*.md'])` then `findProjectPatterns(p)` answers `['a/*.md']`; after `saveProjectPatterns(p, null)` it answers null; and a `finish` with `patternsKey: 'x'` is read back by `listStates(p)`.
12. [integration] `PUT /api/projects/:slug/knowledge/patterns` as a global admin with `{ patterns: ['handbook/*.md'] }`, with indexing enabled and a stubbed `KnowledgeIndexQueue`, answers 200 `{ patterns: ['handbook/*.md'], custom: true, queued: <the project's repository count> }` and calls `enqueue(<repoId>, 'admin')` once per project repository.
13. [integration] `PUT .../knowledge/patterns` with `{ patterns: null }` answers `custom: false` and `patterns` equal to `DEFAULT_KNOWLEDGE_PATTERNS`, and a following `GET .../knowledge/repos` answers `customPatterns: false` and `defaultPatterns` equal to `DEFAULT_KNOWLEDGE_PATTERNS`.
14. [integration] `PUT .../knowledge/patterns` with `{ patterns: ['README.md', 'src/a.ts'] }` answers 400 with the body's `reason` `patterns[1]`, and by a project member who is not a global admin answers 403 (one table-driven test).
15. [integration] `PUT .../knowledge/patterns` with indexing disabled answers 200 with `queued: 0` and never calls `enqueue`.

### US-003: Decisions chunker (`Workdir: apps/api`)

1. [unit] `chunkDecisions` on two lines `{"id":"D-1","kind":"finish-approval","chosenOptionId":"A","action":{"type":"approve"},"rationale":"All green. Ship it."}` and `{"id":"D-2"}` returns two chunks with `chunkIndex` 0 and 1, `title` `Decision D-1` and `Decision D-2`, and `anchor` `d-1` and `d-2`.
2. [unit] The first chunk's `text` is the lines `Decision D-1 (finish-approval)`, `Chosen: A -> approve` and `Rationale: All green. Ship it.`, and its `abstract` is `All green. Ship it.`.
3. [unit] A line with `decidedAt` `2026-10-16T05:36:54Z`, `model` `m` and no `confidence` yields the text line `Decided: 2026-10-16T05:36:54Z by m`.
4. [unit] `chunkDecisions` skips a line that is not JSON, a JSON array line and an object line without a string `id`, and returns chunks only for the valid lines.
5. [unit] `chunkDecisions` on two lines with `id` `D 1` and `d-1` returns anchors `d-1` and `d-1-1`.
6. [unit] `chunkDecisions` on 1001 valid lines returns 1000 chunks, the last with `title` `Decision <the 1000th id>`.

### US-004: Outcome indexing pass and ingest trigger (`Workdir: apps/api`)

1. [unit] `indexOutcomes(jobId)` with `findRunOutcomes` answering a job (`repoId` `r1`, `feature` `f`) with a `report` and a `decisions` outcome calls `KnowledgeChunkStore.replaceFile` with source ids `outcome:r1:<jobId>:report` and `outcome:r1:<jobId>:decisions`, and rows whose `source` is `outcome`.
2. [unit] The rows written for a `decisions` outcome of the lines `{"id":"D-1"}` and `{"id":"D-2"}` carry the anchors `d-1` and `d-2`, `outcomeKind: 'decisions'` and `path: 'decisions.jsonl'`.
3. [unit] The rows written for the `report` outcome carry metadata `jobId`, `feature: 'f'`, `outcomeKind: 'report'`, `path: 'feature-report.md'`, and `content` starting with `<owner>/<name> · run <jobId> · f · feature-report.md`.
4. [unit] `indexOutcomes` for a job with only a `report` outcome calls `deleteFile` with `outcome:r1:<jobId>:decisions` and calls `RagService.optimizeTable` once.
5. [unit] When `EmbeddingService.embedBatch` rejects and every per-chunk `embed` rejects, the written rows carry `provider: 'none'` and a zero vector of `EmbeddingService.dimensions`.
6. [unit] `indexOutcomes` with `findRunOutcomes` answering null resolves `{ status: 'skipped', reason: 'unknown job' }` and never calls `replaceFile` or `deleteFile`.
7. [unit] When `KnowledgeChunkStore.replaceFile` throws `boom`, `indexOutcomes` resolves `{ status: 'failed', reason: 'boom' }`.
8. [unit] `BundleIngestService.ingestOne` for a claimed RUN job calls the stub `KnowledgeIndexQueue.enqueueOutcomes` once with the job id after the transaction resolved, and for a claimed PLAN job never calls it.
9. [unit] `ingestOne` for a claimed RUN job whose `replaceRows` rejects never calls `enqueueOutcomes`.
10. [unit] `BundleIngestService.ingestOne` for a claimed RUN job `j1`, wired to a real `KnowledgeIndexQueue` with indexing enabled and a stub `KnowledgeRepoIndexer`, leads to `indexOutcomes('j1')` and never to `indexRepo`.
11. [unit] `enqueueOutcomes('j1')` twice while a pass for repository `r1` is running runs `indexOutcomes('j1')` once after it.
12. [unit] `enqueueOutcomes('j1')` with `knowledgeIndexEnabled: false` runs nothing.
13. [unit] When `indexOutcomes` resolves `{ status: 'failed', reason: 'boom' }`, the queue logs a warning naming `j1` and `boom`, and the next waiting key still runs.
14. [integration] `PrismaKnowledgeIndexRepository.findRunOutcomes(j1)` for a job with `done` ingests of `leaseEpoch` 1 and 2 and outcome rows of both answers only the `leaseEpoch` 2 rows with the job's repository `owner` and `name`.
15. [integration] `findRunOutcomes(j1)` for a job whose `done` ingest of `leaseEpoch` 2 has no outcome row while `leaseEpoch` 1 has a `report` answers `outcomes` empty.

### US-005: Search over outcomes (`Workdir: apps/api`)

1. [unit] `search` with `source: 'outcomes'` passes the lexical leg `source = 'outcome'` and the vector leg `source = 'outcome' AND provider != 'none'`.
2. [unit] `search` without `source` passes the lexical leg `(source = 'repo') OR (source = 'outcome')` and the vector leg `(source = 'repo' AND provider != 'none') OR (source = 'outcome' AND provider != 'none')`.
3. [unit] `search` with `source: 'outcomes'` and `repoId: 'r1'` passes the lexical leg `source = 'outcome' AND source_id LIKE 'outcome:r1:%'`.
4. [unit] `search` with `source: 'docs'` passes the 3c-1 predicates `source = 'repo'` and `source = 'repo' AND provider != 'none'` unchanged.
5. [unit] An outcome hit for job `j1` is returned with `source: 'outcome'`, `jobId: 'j1'`, and `jobState`, `prState` and `prUrl` equal to the stubbed `describeJobs(projectId, ['j1'])` answer, and a doc hit carries `source: 'repo'`.
6. [unit] An outcome hit whose job the stubbed `describeJobs` does not return is absent from the result.
7. [unit] `search` whose hits are all doc hits never calls `describeJobs`.
8. [unit] `search` with `source: 'all'` and `pathPrefix: 'docs/'` returns no outcome hit.
9. [unit] `search` with `source: 'outcomes'` on a table with no `outcome` row returns `empty: true` and calls `hasOutcomeRows`, never `hasRepoRows`.
10. [integration] `PrismaKnowledgeIndexRepository.describeJobs(p, [j1, j2])` where `j1` has two fleet `TicketLink` rows with `prState` `open` (older `prUpdatedAt`) and `merged` (newer) answers `j1` with `prState: 'merged'` and its `resultPrUrl`, and omits `j2` of another project.
11. [unit] `readOutcome(p, 'j1', 'decisions.jsonl')` with `describeJobs` answering `j1` with `repoId` `r1` reads `outcome:r1:j1:decisions`, and with `describeJobs` answering no job returns `[]` without reading the store.
12. [integration] On a real LanceDB holding one `repo` chunk and one `outcome` chunk with the same text, `search` with `source: 'all'` and the fake embedding provider returns both, with `source: 'docs'` only the `repo` hit and with `source: 'outcomes'` only the `outcome` hit.
13. [integration] `POST /api/projects/:slug/knowledge/search` with `{ query: 'broker', source: 'outcomes' }` calls `KnowledgeSearchService.search` with `source: 'outcomes'`, and with `{ query: 'broker', source: 'code' }` answers 400 (one table-driven test).
14. [unit] `runEval` sends each question's body as `{ query, limit: 20, source: 'docs' }`.

### US-006: Agent tools over outcomes (`Workdir: apps/api`)

1. [integration] `AssistantToolExecutor.execute` of `koda_kb_search` with `{ query: 'advisor', source: 'outcomes' }` calls `KnowledgeSearchService.search` with the call's `projectId`, `query: 'advisor'`, `source: 'outcomes'` and `limit: 8`.
2. [unit] `koda_kb_search` with `source: 'code'` answers `invalid_input: source`.
3. [unit] For an outcome hit (`jobId` `j1`, `path` `feature-report.md`, `anchor` `branch-fix`, `feature` `f`, `headingPath` `Branch fix`, `jobState` `COMPLETED`, `prState` `merged`), `koda_kb_search` answers the line `[1] job:j1/feature-report.md#branch-fix — f · Branch fix (run COMPLETED, PR merged)`.
4. [unit] For an outcome hit with `prState` null and an empty `anchor`, the line is `[1] job:j1/decisions.jsonl — f · Decision D-1 (run FAILED)`.
5. [unit] `koda_kb_search` with `source: 'outcomes'` on an `empty` result answers `no run outcomes are indexed for this project`, and with `source: 'docs'` answers `knowledge index is empty for this project`.
6. [integration] `AssistantToolExecutor.execute` of `koda_get_doc` with citation `job:cmvjob00000000000000001/feature-report.md#branch-fix` calls `KnowledgeSearchService.readOutcome` with the call's `projectId`, `cmvjob00000000000000001` and `feature-report.md`, and answers a first line `job:cmvjob00000000000000001/feature-report.md (f) part 1 of 1` followed by the text of the rows whose `anchor` is `branch-fix`.
7. [unit] `koda_get_doc` with citation `job:cmvjob00000000000000001/decisions.jsonl` whose `readOutcome` answers rows with `chunkIndex` 0 and 1 and `outcomeKind` `decisions` answers both rows' text, the chunk 0 text first.
8. [unit] `koda_get_doc` with a job citation for which `readOutcome` answers no rows answers `not_found`.
9. [unit] `koda_get_doc` with citation `job:cmvjob00000000000000001/prd.json` answers `invalid_input: citation`.
10. [unit] `koda_get_doc` with a document citation `o/n:docs/a.md@abc1234` still calls `readDoc` and never `readOutcome`.
11. [unit] The `koda_kb_search` descriptor's `inputSchema` has a `source` property whose `enum` is `['docs', 'outcomes', 'all']`.

### US-007: Knowledge settings tab and citation links (`Workdir: apps/web`)

1. [unit] Mounting `SettingsKnowledgeCard` with `slug` `web`, with `$api.get` answering one repository `{ repoId: 'r1', owner: 'o', name: 'n', status: 'idle', indexedSha: 'abcdef1234', fileCount: 3, chunkCount: 9, unembeddedCount: 0, skippedCount: 1 }`, calls `$api.get` with `/projects/web/knowledge/repos` and renders a `knowledge-repo-r1` row showing `o/n`, `idle` and `abcdef1`.
2. [unit] With `enabled: false` in the answer, the card renders `knowledge-disabled` and no re-index button.
3. [unit] For a user whose `role` is `ADMIN`, clicking the `r1` row's re-index button calls `$api.post` with `/projects/web/knowledge/repos/r1/reindex`, then calls `$api.get` again.
4. [unit] For a user whose `role` is `USER`, the card renders no re-index button and the `knowledge-patterns` textarea is read-only.
5. [unit] For an admin, editing `knowledge-patterns` to `handbook/*.md`, a blank line and ` docs/*.md ` and saving calls `$api.put` with `/projects/web/knowledge/patterns` and `{ patterns: ['handbook/*.md', 'docs/*.md'] }`.
6. [unit] For an admin, Reset to default calls `$api.put` with `/projects/web/knowledge/patterns` and `{ patterns: null }`.
7. [unit] Saving a patterns line `src/a.ts` shows the zod error message and never calls `$api.put`.
8. [unit] When `$api.put` rejects, the card toasts the error text `extractApiError` returns.
9. [unit] When the re-index `$api.post` rejects, the card toasts the error text `extractApiError` returns and does not reload the state.
10. [unit] When the first `$api.get` rejects, the card renders the error state, and its retry calls `$api.get` again.
11. [unit] Mounting the project settings page renders a `knowledge` tab trigger after `skills` whose content is `SettingsKnowledgeCard` with the route's slug.
12. [unit] `renderThreadMarkdown('see o/n:docs/a.md@abc1234#intro', 'web')` contains a link whose `href` is `https://github.com/o/n/blob/abc1234/docs/a.md#intro`, whose `target` is `_blank` and whose `rel` is `noopener noreferrer`.
13. [unit] `renderThreadMarkdown` of `job:cmvjob00000000000000001/feature-report.md#branch-fix` with slug `web` contains a link whose `href` is `/web/fleet/jobs/cmvjob00000000000000001`.
14. [unit] An inline code span holding only `o/n:docs/a.md@abc1234` is wrapped in a link to `https://github.com/o/n/blob/abc1234/docs/a.md`.
15. [unit] `renderThreadMarkdown('https://x.dev/o/n:docs/a.md@abc1234', 'web')` adds no GitHub citation link inside the existing URL text.
