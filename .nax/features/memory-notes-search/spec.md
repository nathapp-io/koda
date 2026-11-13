# SPEC: Memory notes from agents, and search that finds them

Closes: #456

## Summary

Two changes to project memory in `apps/api`, both found by the 2026-11-13 memory live check and quality eval (design doc §9.197).

1. The agent tool `koda_add_memory` (thread and MCP) proposes **notes only**: a slug, a type, a one-line description and a Markdown body, the same four fields nax's own `nax-memory__save` takes. It no longer offers FACT, PREFERENCE, CONSTRAINT or INCIDENT_PATTERN.
2. Memory text search gets an **any-word pass**: when the all-words full-text query finds nothing, the same words are tried as an OR query, ranked by `ts_rank`, before the substring fallback. The substring fallback also matches a note's `description` (#456).

## Motivation

- **Thread memories never reach nax runs.** nax's koda memory provider mirrors and searches NOTE rows only (`packages/nax/src/memory/koda-mapping.ts`, the NOTE filter in its pull and search mapping). In the live check, a thread agent asked to save two durable facts chose CONSTRAINT and PREFERENCE, because `koda_add_memory` offers those kinds first. Both were stored in koda and are invisible to every nax run. The other non-note kinds in koda-wk are machine-derived ticket facts (`ticket_event` status and assignee), which nax should not read.
- **Natural questions find nothing.** `websearch_to_tsquery` ANDs every word. In a 30-query eval against 16 notes, 10 queries returned zero rows: paraphrases and questions where one word (`use`, `happens`, `why`) is absent from the note. No query returned a wrong note, so recall, not precision, is the gap. A live thread agent hit it too: `Postgres port API integration tests env var` returned nothing, and the agent had to retry with `postgres`.
- **#456.** When full-text search finds no row (for example Chinese text, which the `english` parser does not segment), the `contains` fallback matches `subject`, `predicate` and `object` but not `description`. So a term that appears only in a note's index line cannot be found, although full-text search covers that field.

## Design

### Integration

Symbols the feature reads, unchanged:

- `noteFieldError(input: MemoryNoteInput): MemoryNoteField | null` in `apps/api/src/memory/memory-note.ts`, where `MemoryNoteField = 'subject' | 'predicate' | 'object' | 'description'`. It is the one note validator; `POST /memory` calls it too.
- `MEMORY_NOTE_SLUG_RE` (`/^[a-z0-9][a-z0-9-]{0,63}$/`), `MEMORY_NOTE_TYPES` (`['user', 'feedback', 'project', 'reference']`), `MEMORY_NOTE_BODY_MAX_BYTES` (8192), `MEMORY_NOTE_DESCRIPTION_MAX_CHARS` (200) in `apps/api/src/memory/memory-note.ts`.
- `buildActiveKey(...)` in `apps/api/src/memory/prisma-memory-item.repository.ts`: a NOTE's active key is `NOTE:<subject>`, so re-saving a slug with a new type supersedes the old note.
- `ToolInputError(reason)` in `apps/api/src/fleet/assistant/assistant-tool.types.ts`; the agent reads `invalid_input: <reason>`.
- `MemoryGovernanceService.getProjectMemory` and the `koda_memory_search` tool (`apps/api/src/fleet/assistant/tools/knowledge-tools.ts`): both reach `PrismaMemoryItemRepository.findByProjectMemory` with the caller's `text`. The REST route `GET /projects/:slug/memory?text=` reaches the same method. `ContextBuilderService` calls it with no `text` and is unaffected.

Symbols the feature changes. The baseline only locates the code; implement the target.

- `KODA_ADD_MEMORY` in `apps/api/src/fleet/assistant/koda-tool-descriptors.ts`
  - Baseline: `inputSchema.required` is `['kind', 'subject', 'predicate']`; properties `kind` (enum `MEMORY_WRITE_KINDS` = FACT, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN, NOTE), `subject`, `predicate`, `object`, `description`.
  - Target: `inputSchema` is `{ type: 'object', additionalProperties: false, required: ['slug', 'type', 'description', 'body'], properties: { slug, type, description, body } }`. `slug` carries `pattern` = `MEMORY_NOTE_SLUG_RE.source`; `type` carries `enum` = `MEMORY_NOTE_TYPES`; `description` has `minLength: 1`, `maxLength: MEMORY_NOTE_DESCRIPTION_MAX_CHARS`; `body` has `minLength: 1`, `maxLength: MEMORY_NOTE_BODY_MAX_BYTES`. The tool description says it remembers one note in the project's memory, names the four types with one line each on when to use them (`project`: how this project works; `feedback`: a rule or agreement on how to work; `reference`: where something is or how a tool behaves; `user`: about a person), and keeps the existing approval and `koda_record_decision` sentences. The `MEMORY_WRITE_KINDS` constant in this file is removed.
- `addMemoryTool(...)` in `apps/api/src/fleet/assistant/tools/add-memory-tool.ts`
  - Baseline: `AddMemoryInput = { kind: MemoryWriteKind; subject; predicate; object?; description? }`; `parse` accepts five kinds; triples are judged by `MAX_KEY_CHARS` / `MAX_OBJECT_CHARS`.
  - Target: `AddMemoryInput = { slug: string; type: string; description: string; body: string }`. `parse` reads exactly those four keys (any other key, including a legacy `kind`, `subject`, `predicate`, `object` or `ownerId`, is dropped), builds the candidate `{ kind: MemoryKind.NOTE, subject: slug, predicate: type, object: body, description }` and judges it with `noteFieldError`. The field it names is translated to the tool's own name: `subject` -> `slug`, `predicate` -> `type`, `object` -> `body`, `description` -> `description`. Field checks run in this order: first a type check of each field in the order `slug`, `type`, `body`, `description` (a missing or non-string field refuses with that field's own name), then `noteFieldError` on the candidate. The JSON schema limits are advisory for the model: `body.maxLength` counts characters, while `parse` enforces the 8192-byte cap through `noteFieldError`. `preview` and `execute` keep their current behaviour with `kind` fixed to `NOTE`, `subject` = slug, `predicate` = type, `object` = body. The preview header stays `Remember in <projectSlug>: NOTE <slug> / <type>`, followed by the description line, the body, and the `Replaces memory:<id>` line when an active note has that slug. `MemoryWriteKind`, `MEMORY_WRITE_KINDS`, `MAX_KEY_CHARS` and `MAX_OBJECT_CHARS` are removed from this file. Both `MEMORY_WRITE_KINDS` definitions go (one in `koda-tool-descriptors.ts`, one in `add-memory-tool.ts`); the removals are verified by `bunx turbo type-check` and `bunx turbo lint` reporting no remaining reference, not by an AC.
- `MCP_DESCRIPTIONS.koda_add_memory` in `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts`
  - Baseline: "Remember one fact, preference, constraint, incident pattern or note in this project's memory. The call runs at once as the calling agent, ..." (MCP agents read this text, not the descriptor's).
  - Target: the first sentence says the call remembers one note in this project's memory and names the four note types; the remaining sentences ("The call runs at once as the calling agent, ..." and the project sentence) are kept as they are.
- `PrismaMemoryItemRepository.findByProjectMemory(query, page)` in `apps/api/src/memory/prisma-memory-item.repository.ts`
  - Baseline: a non-blank `text` with lexemes runs `findRankedByText` (all words); zero rows falls to `findByContains`. The lexeme probe `hasSearchLexemes(text)` runs `SELECT numnode(websearch_to_tsquery(...)) AS "lexemes"`.
  - Target: the probe also returns the query's text form, written without a subquery alias so the existing probe assertion (`numnode(websearch_to_tsquery(`) stays true: `SELECT numnode(websearch_to_tsquery('english', $text)) AS "lexemes", websearch_to_tsquery('english', $text)::text AS "query"` (both through the existing `tsQuery(text)` helper). The search order becomes:
    1. All words: `findRankedByText` with the existing `websearch_to_tsquery` expression. Rows found are returned.
    2. Any word: only when step 1 found nothing **and** the probe's `query` contains ` & ` **and** contains no `!`. The same ranked query runs with the expression `replace(websearch_to_tsquery('english', text)::text, ' & ', ' | ')::tsquery`. It keeps every filter (scope, `deletedAt`, status, TTL bound, kind, subject prefix), the paging, the explicit `orderBy` when given, and otherwise `ts_rank` order. Rows found are returned.
    3. Substring: `findByContains`, as today, with the text term matching `subject`, `predicate`, `object` **or `description`**, case-insensitive (#456).
  - A probe row without `query` (or a `null` one) skips step 2.

Worked skeleton for the repository change (shape only; names other than the public method are the implementer's):

```ts
async findByProjectMemory(query, page) {
  const text = searchText(query.text);
  if (text !== undefined) {
    const probe = await this.searchProbe(text);            // { lexemes, query }
    if (probe.lexemes > 0) {
      const all = await this.findRankedByText(query, tsQuery(text), page);
      if (all.total > 0) return all;
      if (anyWordAllowed(probe.query)) {
        const any = await this.findRankedByText(query, anyWordTsQuery(text), page);
        if (any.total > 0) return any;
      }
    }
  }
  return this.findByContains(query, page);
}
const anyWordTsQuery = (text: string): Prisma.Sql =>
  Prisma.sql`replace(${tsQuery(text)}::text, ' & ', ' | ')::tsquery`;
const anyWordAllowed = (q: string | null | undefined): boolean =>
  typeof q === 'string' && q.includes(' & ') && !q.includes('!');
```

The `::tsquery` cast keeps the lexemes as `websearch_to_tsquery` already stemmed them; `to_tsquery` would stem them a second time. A phrase (`<->`) inside the text stays a phrase in the any-word pass.

### Approach

The any-word pass is plain Postgres full-text search over the existing generated `searchVector` column and its index. No migration, no embeddings, no synonym dictionary. `ts_rank` over an OR query scores a row higher when it holds more of the query's lexemes, so the note that matches most words of a question comes first.

### Failure Handling

| Input | Behaviour |
|:--|:--|
| `koda_add_memory` with `slug` missing, not a string, or not matching `MEMORY_NOTE_SLUG_RE` | refused `invalid_input: slug`; no proposal |
| `type` missing or not one of `user`, `feedback`, `project`, `reference` | refused `invalid_input: type` |
| `description` missing, blank, or over 200 characters after trim | refused `invalid_input: description` |
| `body` missing, blank, or over 8192 UTF-8 bytes | refused `invalid_input: body` |
| a legacy triple input `{ kind: 'FACT', subject, predicate, object }` with no `slug` | refused `invalid_input: slug`; no proposal |
| re-saving a slug another principal's active note holds | refused `forbidden` naming `memory.update`, as today |
| search text whose all-words query finds nothing and that has 2+ words | any-word pass |
| search text with a negated word (`-word`) | no any-word pass; substring fallback as today |
| search text with one lexeme | no any-word pass (it would be the same query) |
| any-word pass finds nothing | substring fallback, now including `description` |

## Out of Scope

- Existing FACT, PREFERENCE, CONSTRAINT and INCIDENT_PATTERN rows are not migrated, converted or deleted.
- `POST /memory`, `POST /memory/decisions`, `POST /memory/extract`, the CLI `memory create` command and ticket-event memory keep accepting and writing every kind they write today; only the `koda_add_memory` tool narrows to notes.
- `koda_add_memory` keeps writing project-scope notes only; a `scope` field for user notes is not added.
- `koda_record_decision`, `koda_memory_search` and `koda_get_memory` keep their input schemas.
- nax is not changed: its koda provider keeps mirroring and searching NOTE rows only.
- Search gains no synonyms, embeddings, typo tolerance or language other than the `english` text-search configuration, and the `searchVector` column and its index are not changed (no migration).
- The search response does not report which pass (all words, any word or substring) produced the rows.
- The any-word pass is not run for a text containing a negated word.
- The web memory page and settings card are not changed.
- `ContextBuilderService`'s memory read, which passes no text, is not changed.
- Approval requests for `koda_add_memory` that are still pending at deploy time and carry a legacy triple input are not migrated; approving one after deploy answers `invalid_input: slug`.
- US-002 only: the note limits (slug pattern, 200-character description, 8192-byte body) are not re-pinned through the tool; `noteFieldError`'s existing specs pin them, and the tool only translates the field name it reports.
- US-002 only: the preview's `Replaces memory:<id>` line keeps its current behaviour; the existing cases that pin it are rewritten to note inputs under `### Modifies`, not re-specified.
- US-003 only: the `forbidden` refusal for replacing another principal's note keeps its current behaviour; the existing permissions case that pins it is rewritten to note inputs under `### Modifies`, not re-specified.
- US-005 only: the any-word pass reuses the all-words query's filter list unchanged, so the status, soft-delete, project-scope and subject-prefix filters are pinned by one representative case each in the existing full-text specs, not repeated per pass.

## Stories

### US-001: `koda_add_memory` descriptor and MCP text describe notes only

No dependencies. Workdir: `apps/api`.

Change `KODA_ADD_MEMORY` in `koda-tool-descriptors.ts` to the target input schema and description in Design § Integration (`slug`, `type`, `description`, `body`, all required, no `kind`), and `MCP_DESCRIPTIONS.koda_add_memory` in `mcp-tool-catalog.ts` to the note-only first sentence. Remove the descriptor file's `MEMORY_WRITE_KINDS`; verification note: `bunx turbo type-check` and `bunx turbo lint` report no remaining reference.

### US-002: `koda_add_memory` parses, previews and stores notes only

No dependencies. Workdir: `apps/api`.

Change `addMemoryTool`'s `parse`, `preview` and `execute` to the note-only target in Design § Integration: input `{ slug, type, description, body }`, type-checked in the order `slug`, `type`, `body`, `description`, then judged by `noteFieldError` with its field names translated to the tool's own; stored as a NOTE through the existing upsert. Remove `MEMORY_WRITE_KINDS`, `MemoryWriteKind`, `MAX_KEY_CHARS` and `MAX_OBJECT_CHARS` from `add-memory-tool.ts`; verification note: `bunx turbo type-check` and `bunx turbo lint` report no remaining reference.

### US-003: Thread and MCP notes end to end

Depends on US-001, US-002. Workdir: `apps/api`.

Prove the note-only tool through its real entry points: the runner tool-call route a thread uses (propose, approve, stored NOTE, supersede by slug) and the MCP call path (a legacy triple is refused). Rewrite the existing integration specs that propose FACT triples through `koda_add_memory` to note inputs.

### US-004: Search pass order and the description in the substring fallback

No dependencies. Workdir: `apps/api`.

Change `PrismaMemoryItemRepository.findByProjectMemory` to the three-step order in Design § Integration: all words, then any word (only when the probe's `query` holds ` & ` and no `!`), then the substring fallback, whose text term also matches `description` (#456). The probe selects the query's text form beside `numnode`.

### US-005: Search quality against Postgres

Depends on US-004. Workdir: `apps/api`.

Prove the any-word pass and the description fallback against a real database: ranking by matched words, the default TTL filter, the kind filter, paging, an explicit order, the REST route (`GET /projects/:slug/memory?text=`) and the `koda_memory_search` tool.

### Context Files

**US-001**
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `KODA_ADD_MEMORY` and its `MEMORY_WRITE_KINDS`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — `MCP_DESCRIPTIONS.koda_add_memory`, `mcpToolDescriptors()`
- `apps/api/src/memory/memory-note.ts` — the note constants the schema reuses

**US-002**
- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — the tool to change
- `apps/api/src/memory/memory-note.ts` — `noteFieldError` and the note limits
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — `toolDeps()`, the `upsert` spy and the `ctx` fixture

**US-003**
- `apps/api/test/integration/fleet/assistant-add-memory-tool.integration.spec.ts` — the runner tool-call harness
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts` — the `mcpCall`, `postMemory`, `rows` and `activeRow` helpers
- `apps/api/test/integration/audit/audit-memory-system.integration.spec.ts` — the `callTool` MCP helper

**US-004**
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findByProjectMemory`, `findRankedByText`, `findByContains`, `hasSearchLexemes`, `tsQuery`
- `apps/api/src/memory/memory-item-repository.spec.ts` — the unit harness (`rawCalls`, `ranked`)

**US-005**
- `apps/api/test/integration/memory/memory-full-text-search.integration.spec.ts` — the DB and REST harness (its AC-17 drives `GET /projects/:slug/memory?text=`)
- `apps/api/test/integration/fleet/assistant-memory-tools.integration.spec.ts` — the `koda_memory_search` harness and its shared seed
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `koda_memory_search`

### Creates

**US-001**

None.

**US-002**

None.

**US-003**

None.

**US-004**

None.

**US-005**

None.

### Modifies

**US-001**
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — it asserts `KODA_ADD_MEMORY.inputSchema.required` is kind, subject, predicate (line ~260), the kind enum of five kinds (lines ~293-306), the subject and predicate 1..200 bounds and the object maxLength 8192 (lines ~333-337), and that kind excludes DECISION (line ~345); these become assertions on the slug, type, description and body properties as the US-001 ACs state, never deleted outright.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — one new case for the `koda_add_memory` MCP description is added; no existing assertion changes, and the description keeps the sentences its existing cases check (runs at once as the calling agent, the action id, the MCP sentence).

**US-002**
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — its parse, preview and execute cases build triple inputs (kind FACT with subject, predicate, object) and assert the five-kind list, the 4000-character triple object limit and that a triple carrying a description is refused; the tool now takes slug, type, description and body only, so these cases are rewritten to note inputs (the Replaces-line preview cases keep their assertions with a NOTE active item), and the triple-only cases are replaced by the note-field refusals in the US-002 ACs.
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — it parses the triple kind FACT, subject s, predicate p, which now refuses for slug; the input becomes a valid note (slug, type, description, body) and the origin assertion is unchanged.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — its per-key input map gives memory.create the triple kind FACT with subject, predicate and object; that entry becomes a valid note input so the write-tool registration cases keep parsing.

**US-003**
- `apps/api/test/integration/fleet/assistant-add-memory-tool.integration.spec.ts` — its ITEM constant (line ~41), the storedItems/storedItem lookups (lines ~69, ~75) and the beforeEach cleanup (line ~125) key on the FACT triple api / runs on, and its preview assertion expects a header naming FACT; ITEM becomes a note with one fixed slug whose body keeps the word bun (its AC-12 searches text bun), the lookups and the cleanup key on kind NOTE and that slug (the cleanup deletes every row of the slug so no Replaces line leaks between cases), and the preview assertion expects the NOTE header followed by the description and body lines.
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts` — AC-14 seeds the FACT key ac14:tool / uses through postMemory (which hardcodes kind FACT) and reads it back through the rows and activeRow helpers (which filter kind FACT and key on subject and predicate); the seed passes extra kind NOTE with subject ac14-tool, predicate project and a description, the rows and activeRow helpers filter kind NOTE and key on the slug alone, the MCP call sends slug ac14-tool with type feedback and a body, and the case first asserts the seeded item is defined, then keeps the assertions that the call is refused naming memory.update and the seeded item is still active and unchanged.
- `apps/api/test/integration/audit/audit-memory-system.integration.spec.ts` — its `koda_add_memory` MCP calls send kind FACT triples and one assertion expects the audit summary created FACT (line ~219); the calls become valid note inputs keeping the slugs tool (line ~227) and tool-fail (line ~266), the failure case stays a valid note so it still reaches the audit failure path rather than an invalid_input refusal, and the summary assertion expects created NOTE.

**US-004**
- `apps/api/src/memory/memory-item-repository.spec.ts` — the substring cases (the textTerm helper and the falls-back-to-contains case) assert the text term is an OR over exactly subject, predicate and object; the term now also matches description, so those expected objects gain the description contains term with mode insensitive. The ranked() helper gains an optional probe query value (default none, so existing cases keep a probe row without query). The probe assertion (probe SQL contains numnode(websearch_to_tsquery( ) stays true by the Target's no-alias probe form.

**US-005**
- `apps/api/test/integration/memory/memory-full-text-search.integration.spec.ts` — new any-word and description cases are added beside the existing ones; no existing assertion changes.
- `apps/api/test/integration/fleet/assistant-memory-tools.integration.spec.ts` — one new `koda_memory_search` case is added that creates its own note C (updatedAt older than every shared seed row) and deletes it afterwards, so the shared seed's page and total assertions are unchanged.

### Seams

- US-003 consumes US-001's descriptor and US-002's tool through the existing runner tool-call route and MCP path; neither adds a new exported symbol.
- US-005 consumes US-004's repository change through `GET /projects/:slug/memory` and `koda_memory_search`; US-004 adds no new exported symbol.

## Acceptance Criteria

### US-001

- AC-1 [unit] `KODA_ADD_MEMORY.inputSchema.required` equals `['slug', 'type', 'description', 'body']`.
- AC-2 [unit] `KODA_ADD_MEMORY.inputSchema.properties.type.enum` equals `MEMORY_NOTE_TYPES` (`user`, `feedback`, `project`, `reference`).
- AC-3 [unit] `KODA_ADD_MEMORY.inputSchema.properties.slug.pattern` equals `MEMORY_NOTE_SLUG_RE.source`.
- AC-4 [unit] `KODA_ADD_MEMORY.inputSchema.properties.description` has `minLength` 1 and `maxLength` 200.
- AC-5 [unit] `KODA_ADD_MEMORY.inputSchema.properties.body.maxLength` equals `MEMORY_NOTE_BODY_MAX_BYTES` (8192).
- AC-6 [unit] `KODA_ADD_MEMORY.inputSchema.properties` has no `kind` property.
- AC-7 [unit] `KODA_ADD_MEMORY.inputSchema.additionalProperties` is false.
- AC-8 [unit] `KODA_ADD_MEMORY.description` names each of `` `user` ``, `` `feedback` ``, `` `project` `` and `` `reference` `` in backticks.
- AC-9 [unit] The `koda_add_memory` description returned by `mcpToolDescriptors()` names each of `` `user` ``, `` `feedback` ``, `` `project` `` and `` `reference` `` in backticks.

### US-002

- AC-1 [unit] `addMemoryTool(...).parse({ slug: 'deploy-steps', type: 'project', description: 'How to deploy', body: 'Run deploy.sh' })` returns exactly `{ slug: 'deploy-steps', type: 'project', description: 'How to deploy', body: 'Run deploy.sh' }`.
- AC-2 [unit] `parse` given that valid note plus `ownerId: 'someone-else'` and `kind: 'FACT'` returns exactly the same four note fields.
- AC-3 [unit] `parse` with `slug: 'Deploy Steps'` throws `ToolInputError` whose `reason` is `slug`.
- AC-4 [unit] `parse` with `type: 'constraint'` throws `ToolInputError` whose `reason` is `type`.
- AC-5 [unit] `parse` with no `description` throws `ToolInputError` whose `reason` is `description`.
- AC-6 [unit] `parse` with `body: '   '` throws `ToolInputError` whose `reason` is `body`.
- AC-7 [unit] `parse({ kind: 'FACT', subject: 'api', predicate: 'runs on', object: 'bun' })` throws `ToolInputError` whose `reason` is `slug`.
- AC-8 [unit] `parse({ slug: 'Bad Slug', type: 5, description: 'd', body: 'b' })` throws `ToolInputError` whose `reason` is `type`, because type checks run before `noteFieldError`.
- AC-9 [unit] `preview` of a valid note with no active note of that slug answers exactly `Remember in <projectSlug>: NOTE <slug> / <type>`, then the description, then the body, as three lines.
- AC-10 [unit] `execute` of a valid note calls the repository `upsert` with `kind` NOTE, `subject` = slug, `predicate` = type, `object` = body and `description` as given.

### US-003

- AC-1 [integration] Through the runner tool-call route that `assistant-add-memory-tool.integration.spec.ts` drives, the runner holding dev's RUNNING thread job calls `koda_add_memory` with a valid note and is answered pending.
- AC-2 [integration] While that proposal waits for dev, the project has no memory item with that slug.
- AC-3 [integration] After dev approves it through `POST /api/approvals/:id/decisions`, the project has exactly one active memory item of `kind` NOTE with that slug as `subject`.
- AC-4 [integration] That stored item carries the proposed type as `predicate`, the proposed body as `object` and the proposed description as `description`.
- AC-5 [integration] A second proposal with the same slug and a different type, once approved, leaves exactly one active NOTE for the slug, and it carries the new type.
- AC-6 [integration] After that second approval, the item stored by the first approval has status `superseded`.
- AC-7 [integration] In `permissions-memory-routes.integration.spec.ts`, an agent's MCP `koda_add_memory` call with `{ project, kind: 'FACT', subject: 'ac15:tool', predicate: 'uses', object: 'x' }` answers `invalid_input: slug`.
- AC-8 [integration] After that refused MCP call, the project has no memory item whose `subject` is `ac15:tool`.

### US-004

- AC-1 [unit] The lexeme probe's SQL selects `numnode(websearch_to_tsquery(` and `::text AS "query"`, binding the search text and `english`.
- AC-2 [unit] When the probe answers `lexemes` 1 with no `query`, and the all-words ranked query matches nothing, `findByProjectMemory` issues exactly three raw queries before the substring path.
- AC-3 [unit] When the probe answers `query` `'deploy' & !'backup'` and the all-words query matches nothing, no further raw query runs before the substring path.
- AC-4 [unit] When the probe answers `query` `'deploy' & 'backup'` and the all-words query matches nothing, the fourth raw query's SQL contains `replace(` and `' | ')::tsquery`.
- AC-5 [unit] In that case, when the any-word ids query answers ids `mem-2, mem-1` with count 2, `findByProjectMemory` returns records in the order `mem-2`, `mem-1` and `memoryItem.count` is not called.
- AC-6 [unit] When the probe answers `query` `'deploy' & 'backup'` and both ranked passes match nothing, the substring path's text term is an OR over `subject`, `predicate`, `object` and `description`, each a case-insensitive `contains` of the text.
- AC-7 [unit] When the probe answers `query` `'deploy' & 'backup'` and the all-words query matches rows, exactly three raw queries run.

### US-005

Fixtures: five notes in one project, each `kind` NOTE, active, `predicate` `project`, subjects `note-a` to `note-e`, descriptions `label a` to `label e`, with these bodies: A `API integration specs need the compose test Postgres on port 5433.`; B `Run web unit tests with bunx jest.`; C `When a budget window is exceeded, dispatch pauses.`; D `Deploy runs build-images then deploy.sh, which takes a backup.`; E `Restore from the newest dump.` E's `updatedAt` is set later than D's.

- AC-1 [integration] `findByProjectMemory` with `text: 'which postgres port do api integration tests use'` (no note holds `use`) returns A as its first record.
- AC-2 [integration] With `text: 'deploy backup restore'` (no note holds all three), D (two of the words) is listed before E (one word, `restore`).
- AC-3 [integration] With `text: 'deploy backup'`, which D holds both words of, the result is D alone.
- AC-4 [integration] With `status` not given and `text: 'postgres widget'`, the result holds A and not a second NOTE whose `ttlAt` is in the past and whose body holds `postgres`.
- AC-5 [integration] With `kind: 'NOTE'` and `text: 'postgres widget'`, the result holds A and not a FACT row whose object holds `postgres`.
- AC-6 [integration] With `text: 'deploy backup restore'` and page size 1, page 1 and page 2 each answer one record, the two records differ, and `total` is 2.
- AC-7 [integration] With `text: 'deploy backup restore'` and `orderBy: 'updatedAt'`, E comes before D.
- AC-8 [integration] (#456) A note whose description is `中文搜索使用子串匹配` and whose body is `全文检索找不到中文词时改用子串匹配` is returned for `text: '中文搜索'` through `GET /projects/:slug/memory?text=`.
- AC-9 [integration] `koda_memory_search` called in a thread with `text: 'what happens when the budget is exceeded'` answers the `memory:<id>` of C.
