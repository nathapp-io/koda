# SPEC: Memory notes for the nax memory mirror (note kind, full-text search, user scope, export cursor, write mode)

Closes: #376, #377, #378, #379, #380

## Summary

koda becomes the authoritative store for nax's memory slice. A new `NOTE` memory kind stores a nax note (slug, type,
one-line description, Markdown body) as a `MemoryItem`, and a re-saved slug supersedes the old note. Memory text search
moves from a case-insensitive substring match to Postgres full-text search with rank ordering. Memory items gain a
`scope`: `project` (today's behaviour) or `user`, which a principal (a User or an Agent) owns across every project. A new
`GET /projects/:slug/memory/export` route pages every change after a cursor, tombstones included, so nax can keep a local
mirror. A new `POST /memory/notes/:id/retire` route retires a note (nax's forget), leaving a tombstone the export
carries. A read-only `GET /projects/:slug/memory/write-mode` route tells nax whether agent memory writes in the project
wait for approval. The web memory page and the project settings page, and the CLI, follow.

## Motivation

nax's memory slice (nax design `docs/superpowers/specs/2026-11-02-nax-memory-design.md` in the nax repo, sections 6.1,
6.4 and 12) mirrors koda memory into `~/.nax/memory/` and needs five things koda does not have:

- A note-shaped item. `MemoryItem` is a subject/predicate/object triple in the kinds FACT, DECISION, PREFERENCE,
  CONSTRAINT and INCIDENT_PATTERN. That fits decisions, not a Markdown note with a type and a description (#376).
- Keyword recall. `findByProjectMemory` matches `text` with `contains` (ILIKE) over subject, predicate and object, newest
  or most confident first. Stemmed and multi-word queries miss, and nothing is ranked (#377).
- Memory that follows the principal. Every item needs a `projectId`; user-level working agreements cannot be stored once
  and recalled in every project (#378).
- An incremental feed. The only keyset read is `findActiveAfterId`, by id and active rows only, so supersede, retire and
  soft delete of old rows are invisible to a mirror (#379).
- A server-side write policy. A project that wants agent memory writes reviewed first has no setting for it (#380).

Rulings (2026-11-03): one feature for all five issues. #380 reuses the approval policy engine instead of adding pending
rows: proposal mode IS a project approval policy on `memory.create` for AGENT principals. A user-scoped item is owned
by the calling principal (User or Agent); agents have no owning user, and nax talks to koda with an agent key.

## Design

### Integration

Read-only symbols (verified on `main` @ `997cd9ac`):

- `MemoryController.createMemory(input: CreateMemoryDto, principal)` (`apps/api/src/memory/memory.controller.ts`):
  `POST /memory`, `@ApprovalGated()`, runs `ApprovalRouteGate.run({ key: 'memory.create', variant:
  MEMORY_ROUTE_VARIANTS.create, projectId: input.projectId, input: { memory: input } })`; a pending outcome throws
  `ApprovalPending`, answered `202` with the approval request summary.
- `MemoryRouteCommands` (`apps/api/src/memory/memory-route.commands.ts`): the `rest:memory.create` command parses
  `CreateMemoryDto` and calls `MemoryWriteService.create(principal, input.memory)`; on approval it runs as the original
  requester (`ApprovalExecutionService.execute`).
- `MemoryWriteService.create(principal: KodaPrincipal, input: CreateMemoryDto)` (`memory-write.service.ts`):
  `assertMayWrite(principal, 'memory.create', projectId)` (membership, then `memory.create`), refuses `DECISION`, picks
  the owner, then `repository.upsert(..., { beforeSupersede: writeGuard.replaceCheck(principal, projectId), onWritten:
  memoryAuditHook(audit, key) })`.
- `ApprovalGate.gate`: a USER subject always executes; an AGENT executes when the resolved mode is `none`, otherwise a
  pending request is opened. `memory.create` is approvable with floor `none` and default `none`.
- `ApprovalPolicyService.list(filter: { projectId?: string | null; permissionPattern?: string }, page: { current:
  number; size: number }): Promise<ApprovalPolicyRecord[]>` (`apps/api/src/approvals/approval-policy.service.ts`).
- Project policy routes: `POST /projects/:slug/approval-policies` (body `CreateApprovalPolicyDto`: `permissionPattern`,
  `appliesTo: { kind: 'all' | 'type' | 'role' | 'principal', principalType?, roleId?, principalId? }`, `mode`) and
  `DELETE /projects/:slug/approval-policies/:id`, both `approval.policy.manage`
  (`apps/api/src/approvals/project-approval-policies.controller.ts`).
- `MemoryReadController.getMemory` (`memory-read.controller.ts`): `GET /projects/:slug/memory`,
  `@UseGuards(ProjectMembershipGuard, RequiresGuard)`, `@Requires('memory.read')`, slug resolved by
  `ProjectAccessService.findProjectIdBySlug`, then `MemoryGovernanceService.getProjectMemory(query, page)`.
- `encodeTimelineCursor` / `decodeTimelineCursor` (`apps/api/src/memory/timeline-cursor.ts`): the base64url
  `iso|id` cursor precedent; decode answers null for anything it did not produce.
- `addMemoryTool` (`apps/api/src/fleet/assistant/tools/add-memory-tool.ts`) and `memorySearchTool`
  (`tools/knowledge-tools.ts`), registered from their tool-group classes through `AssistantToolRegistry.register`;
  MCP exposure is derived from the catalog (`mcp/mcp-tool-catalog.ts`, `mcp/mcp-server.factory.ts`).
- Web: `apps/web/pages/[project]/memory.vue`, `apps/web/composables/useMemory.ts`, `apps/web/pages/[project]/settings.vue`
  with its `Settings*Card.vue` components, `apps/web/composables/useApprovalPolicies.ts`.
- CLI: `apps/cli/src/commands/memory.ts` (`retire`, `timeline`, `decisions`, `create`), generated client in
  `apps/cli/src/generated/`.

Mutated symbols. The baseline exists only to locate the code; it is never the interface to implement.

- `MemoryKind` (`apps/api/src/common/enums.ts`).
  Baseline: `{ FACT, DECISION, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN }`.
  Target: the same plus `NOTE: 'NOTE'`.
- `buildActiveKey(_projectId, kind, subject, predicate)` (`prisma-memory-item.repository.ts`).
  Baseline: always `` `${kind}:${subject}:${predicate}` ``.
  Target: `NOTE:<subject>` when `kind` is `NOTE` (the type is not part of a note's key); unchanged for every other kind.
- `PrismaMemoryItemRepository.upsert(item: MemoryItemInput, options?)`.
  Baseline: finds the active row by `{ projectId, kind, subject, predicate, activeKey: { not: null }, deletedAt: null }`;
  the no-op compares `object`, `sourceType`, `sourceId`.
  Target: finds the active row by its key: `{ projectId, activeKey }` for a project item, `{ ownerKey, activeKey }` for
  a user item, `deletedAt: null`; the no-op also compares `predicate` and `description`.
- `PrismaMemoryItemRepository.findActive(projectId, kind, subject, predicate)`.
  Baseline: matches `{ projectId, kind, subject, predicate, activeKey: { not: null }, status: 'active', deletedAt: null }`.
  Target: matches `{ projectId, activeKey: buildActiveKey(projectId, kind, subject, predicate), status: 'active',
  deletedAt: null }`, so `MemoryWriteGuard.assertMayReplace` and the `koda_add_memory` preview find a note re-saved
  with a new type.
- `memoryAuditHook(audit, key)` (`memory-audit.ts`).
  Baseline: the entry's `projectId` is `written.item.projectId`.
  Target: `memoryAuditHook(audit, key, projectId?: string)`; the entry's `projectId` is `written.item.projectId ??
  projectId`.
- `MemoryWriteService.retireTarget` / `assertRetireTarget`.
  Baseline: `assertProjectMembership(item.projectId, ...)` on any item.
  Target: a user row (`scope: 'user'`) answers `NotFoundAppException({}, 'memory.notFound')` before any membership
  check; `retireTarget` still returns `{ projectId: string }`.
- `MemoryItem` / `MemoryItemInput` (`apps/api/src/memory/memory-item-repository.ts`).
  Baseline: `projectId: string`; no `description`, `scope`, `ownerKey`.
  Target: `projectId: string | null` (null exactly for a user item), `description?: string`, `scope: MemoryScope`
  (`'project' | 'user'`), `ownerKey?: string` on the domain; the input takes `description?`, `scope?`, and the repository derives `ownerKey` as
  `` `${ownerType}:${ownerId}` `` when `scope` is `'user'`.
- `ProjectMemoryQuery`.
  Baseline: `{ projectId, kind?, subject?, text?, status?, orderBy? }`.
  Target: adds `owner?: { ownerType: MemoryOwnerType; ownerId: string }` (the caller whose user items are included) and
  `scope?: 'project' | 'user' | 'all'` (default `'all'`); `orderBy` absent with a text that has lexemes means rank order.
- `CreateMemoryDto`. Target: adds `description?: string` and `scope?: 'project' | 'user'`.
- `ListMemoryQuery`. Target: adds `text?: string` (1-100 chars) and `scope?: 'project' | 'user' | 'all'`.
- `MemoryReadController`. Target: gains `@Get('export')` and `@Get('write-mode')`; `getMemory` reads the caller with
  `@Principal()` so it can include the caller's user items.
- `KODA_ADD_MEMORY` / `MEMORY_WRITE_KINDS` (`koda-tool-descriptors.ts`, `add-memory-tool.ts`). Target: the kind enum
  gains `NOTE`; the input gains `description` (max 200).
- `KNOWLEDGE_TOOL_DESCRIPTORS`. Target: gains `KODA_GET_MEMORY`.
- Prisma `MemoryItem` (`apps/api/prisma/schema.prisma`). Target: `projectId String?` with `project Project?` (still
  `onDelete: Cascade`), `description String?`, `scope String @default("project")`, `ownerKey String?`, `searchVector
  Unsupported("tsvector")?` (a generated column), `@@unique([ownerKey, activeKey])`, `@@index([searchVector], type:
  Gin)`, `@@index([projectId, updatedAt, id])`, `@@index([ownerKey, updatedAt, id])`. `@@unique([projectId,
  activeKey])` stays.

### Approach

**Note shape (US-001).** A note is a `MemoryItem` with `kind: 'NOTE'`, `subject` = slug, `predicate` = type, `object` =
Markdown body, `description` = the index line. The limits are nax's own (nax `packages/nax-agent/src/memory/types.ts`)
so a note round-trips: `MEMORY_NOTE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`, `MEMORY_NOTE_TYPES = ['user', 'feedback',
'project', 'reference']`, `MEMORY_NOTE_BODY_MAX_BYTES = 8192` (UTF-8 bytes of `object`), `MEMORY_NOTE_DESCRIPTION_MAX_CHARS
= 200`. They live in a new `apps/api/src/memory/memory-note.ts` with `noteFieldError(input: { kind: string; subject:
string; predicate: string; object?: string; description?: string }): 'subject' | 'predicate' | 'object' | 'description'
| null`, which checks in that field order: for `NOTE` the slug, the type, the body (required, at least one non-whitespace character, at most 8192 UTF-8
bytes), then the
description (required, 1..200 chars after trim); for any other kind only that `description` is absent. The REST write
path and the assistant tool both call it. A note's active key is `NOTE:<slug>`, so re-saving a slug with a new type,
body or description supersedes the old note; an identical restatement (same type, body, description, source) is the
existing no-op.

**Full-text search (US-003).** The migration adds `"searchVector" tsvector GENERATED ALWAYS AS
(to_tsvector('english', coalesce("subject", '') || ' ' || coalesce("predicate", '') || ' ' || coalesce("description",
'') || ' ' || coalesce("object", ''))) STORED` and a GIN index on it. The migration SQL is hand-written; the schema
declares the column as `Unsupported("tsvector")?` so Prisma does not try to drop it. Tests build their schema with
`prisma db push --force-reset` (`test/global-setup.ts`), which would create a plain, never-filled `tsvector`; a new
`test/helpers/memory-search-vector.ts` exports `MEMORY_SEARCH_VECTOR_STATEMENTS` (drop the pushed column, add the
generated column, create the GIN index), `global-setup.ts` replays them after the push next to
`PARTIAL_UNIQUE_INDEXES`, and a unit spec pins that every statement except the drop is shipped verbatim by the
migration. Hand-written index names equal Prisma's defaults: `MemoryItem_searchVector_idx`,
`MemoryItem_ownerKey_activeKey_key`, `MemoryItem_projectId_updatedAt_id_idx`, `MemoryItem_ownerKey_updatedAt_id_idx`. When `ProjectMemoryQuery.text` is
non-blank, the repository first asks Postgres whether `websearch_to_tsquery('english', text)` has any lexeme
(`numnode(...) > 0`). With lexemes, one `$queryRaw` (tagged template, every value bound) selects the page of ids with
every other filter applied in SQL (project or owner, `deletedAt IS NULL`, status, the TTL bound when status is
defaulted, kind, subject prefix), ordered by `ts_rank("searchVector", query) DESC, "updatedAt" DESC, "id" DESC` when
`orderBy` is absent and by the requested `orderBy` (with its existing tiebreakers) otherwise, with `OFFSET`/`LIMIT` from
the page; a second `$queryRaw` counts the matches; the rows are then loaded with Prisma by id and returned in the ranked
order. The subject prefix in SQL is `starts_with("subject", ${prefix})`, so `%` and `_` are literal. Without lexemes
(stopwords only, punctuation) the existing `contains` path runs unchanged; when the full-text count is 0 the `contains`
path also runs, so a Chinese (or other unsegmented) query that the `english` parser cannot split still finds the
substring matches it found before this feature. The text term is
always an `AND` with the TTL bound (S5b US-004 invariant).

**User scope (US-004, US-005).** `scope: 'user'` is accepted only for `kind: 'NOTE'`. The request still names a
`projectId`: membership, `memory.create` and the approval policy are all checked against it exactly as for a project
write, so a project in proposal mode also holds a user note for approval. The stored row has `projectId: null`,
`scope: 'user'`, `ownerType`/`ownerId` = the caller (an `ownerId` in the body is ignored for user scope, even for a
global admin), and `ownerKey` = `` `${ownerType}:${ownerId}` ``. `ownerKey` is set only on user rows, so
`@@unique([ownerKey, activeKey])` keys a principal's user notes and never touches project rows (null `ownerKey` is
distinct in Postgres); `@@unique([projectId, activeKey])` keeps keying project rows (user rows have null `projectId`).
Reads that pass `owner` include the owner's user rows next to the project's rows: `GET /projects/:slug/memory`, the
export, `koda_memory_search` and `koda_get_memory`. Reads that do not pass `owner` (the context builder, governance,
canonical state, review decisions) never see user rows, because every one of them filters on a `projectId`.

**Export (US-006).** `GET /projects/:slug/memory/export?since=<cursor>&take=<n>`, `memory.read`, guarded like the list.
It returns every row of the project plus the caller's user rows with `(updatedAt, id)` strictly after the cursor,
ordered `updatedAt ASC, id ASC`, every status and kind, soft-deleted rows included (they carry `deletedAt`). A row
supersede, retire or soft delete goes through Prisma `update`, which bumps `updatedAt`, so the change reappears after
the cursor. Rows whose `updatedAt` is within `MEMORY_EXPORT_SETTLE_MS = 5000` of the server clock are held back to the
next call, so a transaction that commits late with an earlier `updatedAt` is not skipped. The cursor is
`encodeMemoryExportCursor({ updatedAt, id })` / `decodeMemoryExportCursor(cursor): MemoryExportKey | null` in a new
`apps/api/src/memory/memory-export-cursor.ts`, the same base64url `iso|id` shape as `timeline-cursor.ts`. `take`
defaults to 100, range 1..500. The response is `JsonResponse.Ok({ items: MemoryItem[], nextCursor: string | null,
hasMore: boolean })`: `nextCursor` is the cursor of the last item, or the `since` given when the page is empty (null
when neither exists); `hasMore` is true exactly when `items.length === take`. Rows are returned as stored; fencing is an
LLM-prompt concern and stays in the MCP tools.

**Write mode (US-007).** `GET /projects/:slug/memory/write-mode`, `memory.read`, answers `{ mode: 'direct' |
'proposal', policyId: string | null, source: 'policy' | 'default' | 'not-approvable', agentPolicy: { id: string;
mode: ApprovalMode } | null }`. `MemoryWriteModeService.resolve(projectId, principal)` answers the mode the gate would
apply to the CALLER's own `memory.create` write: it calls `ApprovalPolicyResolver.resolve({ key: 'memory.create',
projectId, subject: { type: principal.type, id: principal.id } })` (the engine's own ranking: project before global,
principal before role before type before all, wildcard patterns included). For an AGENT caller `mode` is `proposal`
when the resolved mode is not `none`; for a USER caller `mode` is always `direct`, because `ApprovalGate.gate` executes
a USER's write directly. `policyId` and `source` come from the resolver's answer. `agentPolicy` is the project's exact
type-AGENT policy (`permissionPattern` `memory.create`, `principalType` `AGENT`, no role, no principal), read with
`ApprovalPolicyService.list({ projectId, permissionPattern: 'memory.create' }, ...)`, or null; it is what the web toggle
edits. Writing the mode is the existing policy routes. The web toggle (US-009) shows proposal when `agentPolicy` exists
with a mode other than `none`; choosing proposal creates `{ permissionPattern: 'memory.create', appliesTo: { kind:
'type', principalType: 'AGENT' }, mode: 'human' }` when `agentPolicy` is null, or patches it to `mode: 'human'` when it
exists in mode `none` (a second create would collide on the selector); choosing direct deletes it.

**Note retire (US-011).** `POST /memory/notes/:id/retire`, body `RetireNoteDto { projectId?: string; reason?: string
}` (`reason` max 500, as `RetireDecisionDto`). The handler carries `@ApprovalGated()` and `@Requires(['memory.create',
'memory.update'], { enforcedBy: 'service' })` like `createMemory`, and runs the gate with key `memory.create` and a new
variant `MEMORY_ROUTE_VARIANTS.retireNote = 'rest:memory.note.retire'`, so a project in proposal mode also holds a note
retire for approval; no new permission key. Before the gate, `MemoryWriteService.retireNoteTarget(principal, id,
projectId?)` resolves the gate's project and runs every check that does not need the row lock, in this order:
1. the row exists and is not soft-deleted, else 404 `memory.notFound`;
2. for a user row, its `ownerKey` is the caller's, else 404 `memory.notFound`;
3. for a user row, the body names `projectId`, else 400 naming `projectId`;
4. membership of the gate's project (a project note's own `projectId`, ignoring any body `projectId`; a user note's
   body `projectId`), a refusal answering 404 `memory.notFound`, as for decisions;
5. the row is a NOTE, else 422 (`MemoryRetireException`);
6. the row is active, else 409 `memory.retireNotActive`.
So a bad target never opens an approval request. `MemoryWriteService.retireNote(principal, id, projectId?, reason?)`
then runs `PrismaMemoryItemRepository.retire`, whose in-lock check repeats steps 1, 2, 5 and 6 on the locked row and
adds the replace check (`MemoryWriteGuard.mayReplace`, 403 `permissions` otherwise; skipped for the caller's own user
note). The row becomes `rejected` with a null `activeKey`; the audit entry is `memory.create` with summary `retired
NOTE` (plus `: <reason>`) and `projectId` = the row's `projectId`, or the body `projectId` for a user note. The route
answers `201` with the retired item. The 422 and 409 messages are reworded in `apps/api/src/i18n/{en,zh}/memory.json` to
cover decisions and notes (en: `retireNotDecision` "Only decisions and notes can be retired", `retireNotActive` "Only
active decisions and notes can be retired"); the keys and `MemoryRetireException` are unchanged.

**Assistant tools (US-002, US-005).** `koda_add_memory` accepts `NOTE` with `description`, through the same
`noteFieldError`; for a NOTE the tool's 4000-character `object` cap does not apply (the 8192-byte note cap does).
`koda_get_memory` reads through a new `MemoryGovernanceService.getMemoryItem(projectId, id, owner?)`, which loads the
row with the repository's `findById` and answers it only when it is not soft-deleted and is either a row of `projectId`
or (after US-005) a user row whose `ownerKey` is the owner's; otherwise null. `KnowledgeTools`' constructor is
unchanged (it already holds `MemoryGovernanceService`). `koda_memory_search` lists a note as its header line plus one fenced line `<slug> <type>
<description>`, never the body. A new `koda_get_memory` (`getMemoryTool` in `tools/knowledge-tools.ts`, `memory.read`, read kind) takes `{ id }` and answers the header
line, the fenced description (notes only) and the fenced body. After US-005 the header line of every listed or fetched
item ends with `scope project` or `scope user`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| US-001: a NOTE write fails `noteFieldError` | 400 `ValidationAppException` naming that field, `memory` domain; nothing written |
| US-001: a non-NOTE write carries `description` | 400 naming `description` |
| US-002: a NOTE tool input fails `noteFieldError` | `ToolInputError` naming that field |
| US-002: `koda_get_memory` id is unknown, soft-deleted, of another project or another principal's user item | tool result `memory item not found`, not an error |
| US-003: the text has no lexemes | the `contains` path runs, results as before this feature |
| US-004: `POST /memory/:id/retire` names a user row | 404 `memory.notFound` |
| US-004: `scope: 'user'` with a kind other than NOTE | 400 naming `scope` |
| US-004: `scope: 'user'` for a project the caller is not a member of | 403, as for a project write |
| US-004: `scope: 'user'` in a project whose `memory.create` AGENT policy is `human`, called by an agent | 202 with the approval request; on approval the user note is written as the agent |
| US-006: `since` is not a cursor this route produced | 400 naming `since` |
| US-006: `take` outside 1..500 or not an integer | 400 naming `take` |
| US-006, US-007: caller not a member / lacks `memory.read` | 403; unknown or soft-deleted project slug | 404 |
| US-011: the retire target is not a NOTE | 422 `MemoryRetireException` |
| US-011: the note is not active | 409 `memory.retireNotActive` |
| US-011: unknown or soft-deleted id, a project note of a project the caller is not a member of, or another principal's user note | 404 `memory.notFound` |
| US-011: the caller's own user note retired without `projectId` in the body | 400 naming `projectId` |
| US-011: a user note retired with a `projectId` the caller is not a member of | 404 `memory.notFound` |
| US-011: a bad target (not a NOTE, not active) in a proposal-mode project | answered 422 / 409 before the gate; no approval request is opened |
| US-011: the caller may not replace another principal's project note | 403 `permissions` |
| US-009: the project's AGENT policy exists in mode `none` and the user chooses proposal | the policy is patched to `human`, never created twice |
| US-009: creating, patching or deleting the policy fails | the error is shown with `extractApiError`, the control returns to the mode the API last reported |
| US-010: an API or network error | stderr message, exit code 1; an invalid option value | exit code 3 |

## Out of Scope

- No pending memory rows and no `status: pending` value: proposal mode is a project approval policy on `memory.create` for AGENT principals (ruling 2026-11-03); an unapproved write simply does not exist yet.
- Proposal mode covers `POST /memory`, `koda_add_memory` and `POST /memory/notes/:id/retire` only (all `memory.create`); `POST /memory/extract` (`memory.extract`) and `POST /memory/decisions` (`memory.decision.record`) keep their own policies and are not switched by the write-mode toggle.
- No project column for the write mode; the mode is derived from approval policies on every read.
- No org-wide memory, and no Agent-to-User ownership: a user-scoped item is owned by the principal that wrote it.
- User scope is NOTE-only; triples (FACT, DECISION, PREFERENCE, CONSTRAINT, INCIDENT_PATTERN) stay project-scoped.
- `POST /memory/:id/retire` stays decision-only; notes retire through `POST /memory/notes/:id/retire` (US-011). No soft delete or hard delete of notes is added.
- US-011 only: no CLI command and no assistant or MCP tool retires a note; nax calls the REST route.
- No hybrid vector plus keyword ranking; the knowledge base (LanceDB) stays the semantic layer.
- `MemoryGovernanceService` (expire, downrank, dedupe, supersession), extraction, canonical state, review decisions and the `/context` builder are unchanged and never read user-scoped rows.
- No MCP twin of the export route (`koda_memory_export`); HTTP is the only export surface.
- Export and list responses are not fenced; fencing stays in the MCP tool text.
- A user note written through project Q is visible to its owner in every project, including a proposal-mode project P that never held it for approval; per-project review of user notes is not added.
- Full-text search uses the `english` configuration only; no Chinese segmentation is added (unsegmented text falls back to the substring match).
- `.nax/rules/api-data.md` and other rule files are not edited by this feature.

## Stories

This feature has 11 stories, one package each: 8 api, 2 web, 1 cli. US-011 (note retire) was added by the user on
2026-11-03 after the first draft; it is numbered last because it depends on US-004 and US-006. It is one capability (koda as the store behind
nax memory); the user chose one feature for all five issues on 2026-11-03. Story-size gate resolved from
`.nax/config.json`: `maxAcCount` 15, `maxBulletPoints` 15, enabled.

### US-001: Store a note as a NOTE memory item through POST /memory

No dependencies. Workdir: apps/api. #376 storage: `MemoryKind.NOTE`, the `description` column (migration), the note
limits and `noteFieldError` in `memory-note.ts`, `CreateMemoryDto.description`, validation in
`MemoryWriteService.create`, the NOTE active key `NOTE:<slug>`, and the key-based active-row lookup in `upsert`.

### US-002: Assistant tools write, list and fetch notes

Depends on US-001. Workdir: apps/api. #376 tools: `koda_add_memory` accepts NOTE and `description` through
`noteFieldError`; `koda_memory_search` lists a note's description and never its body; new read tool `koda_get_memory`
answers one item with its body; descriptor, registry and MCP catalog updates.

### US-003: Full-text search over memory items

Depends on US-001. Workdir: apps/api. #377: the generated `searchVector` column and GIN index (migration), the ranked
full-text path in `findByProjectMemory` with the `contains` fallback, `ListMemoryQuery.text`, and rank order for
`koda_memory_search` when it has a text.

### US-004: Write a user-scoped note

Depends on US-001. Workdir: apps/api. #378 writes: `MemoryScope`, nullable `projectId`, `scope` and `ownerKey` columns
with `@@unique([ownerKey, activeKey])` (migration), `CreateMemoryDto.scope`, the user-scope branch of
`MemoryWriteService.create` and `upsert`.

### US-005: Read user-scoped notes next to project memory

Depends on US-003, US-004. Workdir: apps/api. #378 reads: `ProjectMemoryQuery.owner` and `scope`,
`ListMemoryQuery.scope`, the caller passed by `getMemory`, `koda_memory_search` and `koda_get_memory`, and the
`scope project|user` tag in the tool text.

### US-006: Export memory changes after a cursor

Depends on US-004. Workdir: apps/api. #379: `memory-export-cursor.ts`, `ExportMemoryQuery`, the
`(updatedAt, id)` keyset read with the settle window, the `@@index([projectId, updatedAt, id])` and `@@index([ownerKey,
updatedAt, id])` indexes (migration), and `GET /projects/:slug/memory/export`.

### US-007: Read a project's memory write mode

No dependencies. Workdir: apps/api. #380 read side: `MemoryWriteModeService.resolve` over the approval policies and `GET
/projects/:slug/memory/write-mode`.

### US-008: Web memory page shows notes, scope and text search

Depends on US-001, US-003, US-005. Workdir: apps/web. The kind filter lists all six kinds, a note row shows its
description with the body behind an expand control, a user item carries a scope badge, and a search box sends `text` 300 ms after the last keystroke.

### US-009: Web project settings toggle the memory write mode

Depends on US-007. Workdir: apps/web. A `SettingsMemoryCard` on the project settings page reads the write mode and
switches it by creating, patching or deleting the project `memory.create` AGENT policy through the existing policy routes.

### US-010: CLI notes, user scope, list and search

Depends on US-001, US-003, US-004, US-005. Workdir: apps/cli. Regenerated client; `memory create` takes `--description`
and `--scope`; new `memory list` and `memory search <text>`.

### US-011: Retire a note

Depends on US-004, US-006. Workdir: apps/api. nax forget: `RetireNoteDto`, the `rest:memory.note.retire` command under
`memory.create`, `MemoryWriteService.retireNoteTarget` and `retireNote`, and `POST /memory/notes/:id/retire`.

### Context Files

**US-001**

- `apps/api/src/memory/memory-write.service.ts`
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/memory-item-repository.ts`
- `apps/api/src/memory/dto/create-memory.dto.ts`
- `apps/api/prisma/schema.prisma`

**US-002**

- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts`
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts`
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts`
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts`
- `apps/api/src/memory/memory-note.ts` — created by US-001, the shared note rules

**US-003**

- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/dto/list-memory.query.ts`
- `apps/api/src/memory/memory-governance.service.ts`
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts`
- `apps/api/prisma/migrations/20261116090000_developer_memory_decision_retire/migration.sql` — the latest memory migration, naming and quoting precedent

**US-004**

- `apps/api/src/memory/memory-write.service.ts`
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/memory-write.guard.ts`
- `apps/api/src/memory/memory-audit.ts`
- `apps/api/prisma/schema.prisma`

**US-005**

- `apps/api/src/memory/memory-read.controller.ts`
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/memory-governance.service.ts`
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts`
- `apps/api/src/context/context-builder.service.ts`

**US-006**

- `apps/api/src/memory/memory-read.controller.ts`
- `apps/api/src/memory/timeline-cursor.ts`
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/timeline.controller.ts`
- `apps/api/src/common/dto/koda-page.query.ts`

**US-007**

- `apps/api/src/approvals/approval-policy.service.ts`
- `apps/api/src/approvals/approval-policy.resolver.ts`
- `apps/api/src/approvals/approval-gate.service.ts`
- `apps/api/src/memory/memory-read.controller.ts`
- `apps/api/src/memory/memory.module.ts`

**US-008**

- `apps/web/pages/[project]/memory.vue`
- `apps/web/composables/useMemory.ts`
- `apps/web/tests/pages/memory.spec.ts`
- `apps/web/tests/composables/useMemory.spec.ts`

**US-009**

- `apps/web/pages/[project]/settings.vue`
- `apps/web/components/SettingsKnowledgeCard.vue`
- `apps/web/composables/useApprovalPolicies.ts`
- `apps/web/lib/approval-policies.ts`
- `apps/web/tests/components/settings-knowledge-card.spec.ts`

**US-010**

- `apps/cli/src/commands/memory.ts`
- `apps/cli/src/commands/memory.spec.ts`
- `apps/cli/src/index.ts`

**US-011**

- `apps/api/src/memory/memory.controller.ts`
- `apps/api/src/memory/memory-write.service.ts`
- `apps/api/src/memory/memory-route.commands.ts`
- `apps/api/src/memory/dto/retire-decision.dto.ts`
- `apps/api/src/memory/memory-retire.exception.ts`

### Creates

**US-001**

- `apps/api/src/memory/memory-note.ts`
- `apps/api/src/memory/memory-note.spec.ts`
- `apps/api/prisma/migrations/20261121090000_memory_note_description/migration.sql`
- `apps/api/test/integration/memory/memory-note-write.integration.spec.ts`

**US-002**

- `apps/api/test/integration/fleet/assistant-get-memory-tool.integration.spec.ts`

**US-003**

- `apps/api/test/helpers/memory-search-vector.ts`
- `apps/api/test/unit/memory/memory-search-vector.spec.ts`
- `apps/api/prisma/migrations/20261121090100_memory_full_text_search/migration.sql`
- `apps/api/test/integration/memory/memory-full-text-search.integration.spec.ts`

**US-004**

- `apps/api/prisma/migrations/20261121090200_memory_user_scope/migration.sql`
- `apps/api/test/integration/memory/memory-user-scope-write.integration.spec.ts`

**US-005**

- `apps/api/test/integration/memory/memory-user-scope-read.integration.spec.ts`

**US-006**

- `apps/api/src/memory/memory-export-cursor.ts`
- `apps/api/src/memory/memory-export-cursor.spec.ts`
- `apps/api/src/memory/dto/export-memory.query.ts`
- `apps/api/prisma/migrations/20261121090300_memory_export_indexes/migration.sql`
- `apps/api/test/integration/memory/memory-export.integration.spec.ts`

**US-007**

- `apps/api/src/memory/memory-write-mode.service.ts`
- `apps/api/src/memory/memory-write-mode.service.spec.ts`

**US-009**

- `apps/web/components/SettingsMemoryCard.vue`
- `apps/web/composables/useMemoryWriteMode.ts`
- `apps/web/tests/components/settings-memory-card.spec.ts`

**US-011**

- `apps/api/src/memory/dto/retire-note.dto.ts`
- `apps/api/test/integration/memory/memory-note-retire.integration.spec.ts`

### Modifies

**US-001**

- `apps/api/src/common/enums.ts` — `MemoryKind` gains `NOTE: 'NOTE'`.
- `apps/api/prisma/schema.prisma` — `MemoryItem` gains `description String?`.
- `apps/api/src/memory/memory-item-repository.ts` — `MemoryItem` and `MemoryItemInput` gain `description?: string`.
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findActive` matches by the active key; `buildActiveKey` answers `NOTE:<subject>` for NOTE; `toDomain`/`toPersistenceCreate`/`toPersistenceUpdate` map `description`; `upsert` finds the active row by `{ projectId, activeKey, deletedAt: null }` and its no-op also compares `predicate` and `description`.
- `apps/api/src/memory/dto/create-memory.dto.ts` — gains optional `description` (string, max 200).
- `apps/api/src/memory/memory-write.service.ts` — `create` calls `noteFieldError` and throws `ValidationAppException` naming the field; passes `description` to `upsert`.
- `apps/api/src/memory/prisma-memory-item.repository.additional.spec.ts` — the `describe('findActive')` assertion that pins the `findFirst` where clause on `kind`, `subject` and `predicate` changes to `{ projectId, activeKey, status: 'active', deletedAt: null }`; every behaviour assertion keeps its meaning.
- `apps/api/src/memory/memory.controller.spec.ts` — any closed-world assertion on the created item's fields gains `description` where the fixture sets it; behaviour unchanged.
- `apps/api/src/memory/dto/list-memory.query.spec.ts` — the accepted-kind case may include `NOTE`; the rejection cases are unchanged.
- `openapi.json` — regenerated with `bun run generate` for the new kind and `description` field.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds a POST /memory NOTE happy path (201) and a NOTE-without-description case (400).

**US-002**

- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — `MEMORY_WRITE_KINDS` gains `NOTE`; `KODA_ADD_MEMORY` gains `description` (max 200) and an object cap that names 8192 bytes for notes; new `KODA_GET_MEMORY` added to `KNOWLEDGE_TOOL_DESCRIPTORS`.
- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — `MEMORY_WRITE_KINDS` gains `NOTE`; `parse` calls `noteFieldError` and skips the 4000-character object cap for NOTE; `AddMemoryInput` gains `description?`; `preview` and `execute` carry it.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `memorySearchTool` renders a note's description instead of its body; adds `getMemoryTool` (the `koda_get_memory` tool) next to `memorySearchTool`, and the tool group registers it.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.spec.ts` — the full tool-name lists gain `koda_get_memory`; the per-kind counts go from REPO 22, PROJECT 22, WORKSPACE 23 to 23, 23, 24; the `KODA_ADD_MEMORY.kind` enum pin gains `NOTE`.
- `apps/api/src/fleet/assistant/assistant.module.spec.ts` — the registered tool-name list gains `koda_get_memory`.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts` — the `koda_add_memory` MCP description names notes next to fact, preference, constraint and incident pattern.
- `apps/api/src/memory/memory-governance.service.ts` — adds `getMemoryItem(projectId, id, owner?)`.
- `apps/api/src/memory/memory-governance.service.spec.ts` — `getMemoryItem` cases added; existing cases unchanged.
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.spec.ts` — the MCP tool-name list gains `koda_get_memory`.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — the knowledge tool-name list gains `koda_get_memory`; `koda_get_memory` and NOTE listing cases are added.
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — the case that refuses every kind outside the four write kinds no longer lists `NOTE` as refused; NOTE cases are added.
- `docs/superpowers/specs/2026-10-15-fleet-s5b-koda-assistant-design.md` — the tool table gains a `koda_get_memory` row.

**US-003**

- `apps/api/prisma/schema.prisma` — `MemoryItem` gains `searchVector Unsupported("tsvector")?` and `@@index([searchVector], type: Gin)`.
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findByProjectMemory` takes the full-text path for a text with lexemes.
- `apps/api/src/memory/memory-item-repository.ts` — the `ProjectMemoryQuery.text` comment describes full-text search; `orderBy` absent with text means rank.
- `apps/api/src/memory/dto/list-memory.query.ts` — gains optional `text` (1-100 chars).
- `apps/api/src/memory/dto/list-memory.query.spec.ts` — adds a 101-char `text` rejection case.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `memorySearchTool.execute` passes no `orderBy` when `text` is set and `'updatedAt'` otherwise.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — the assertion that `getProjectMemory` is called with `orderBy: 'updatedAt'` holds only for a search without text; with text it is called without `orderBy`.
- `apps/api/src/fleet/assistant/koda-tool-descriptors.ts` — the `KODA_MEMORY_SEARCH.text` description says full-text, best match first.
- `apps/api/src/memory/prisma-memory-item.repository.additional.spec.ts` — the substring cases that mock Prisma now also stub the lexeme probe (`$queryRaw` answering zero lexemes) so they keep exercising the `contains` path; cases with lexemes live in the new integration spec.
- `apps/api/test/global-setup.ts` — after `PARTIAL_UNIQUE_INDEXES`, replays `MEMORY_SEARCH_VECTOR_STATEMENTS`.
- `apps/api/test/global-setup.spec.ts` — any assertion on the statements replayed after the push gains the search-vector statements.
- `openapi.json` — regenerated for `ListMemoryQuery.text`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds GET /projects/:slug/memory?text= happy path and a 101-char `text` 400 case.

**US-004**

- `apps/api/prisma/schema.prisma` — `MemoryItem.projectId` becomes `String?` with `project Project?`; gains `scope String @default("project")`, `ownerKey String?`, `@@unique([ownerKey, activeKey])`.
- `apps/api/src/common/enums.ts` — adds `MemoryScope = { PROJECT: 'project', USER: 'user' }` and its type.
- `apps/api/src/memory/memory-item-repository.ts` — `MemoryItem.projectId` becomes `string | null`; gains `scope` and `ownerKey?`; `MemoryItemInput` gains `scope?`.
- `apps/api/src/memory/prisma-memory-item.repository.ts` — maps `scope` and `ownerKey`; `upsert` writes a user row with `projectId: null` and finds its active row by `{ ownerKey, activeKey, deletedAt: null }`.
- `apps/api/src/memory/dto/create-memory.dto.ts` — gains optional `scope` (`project` | `user`).
- `apps/api/src/memory/memory-write.service.ts` — `create` handles `scope: 'user'` (NOTE only, owner = caller, `ownerKey`) and passes the request's `projectId` to `memoryAuditHook`; `assertRetireTarget` answers 404 for a user row before the membership check.
- `apps/api/src/memory/memory-audit.ts` — `memoryAuditHook` gains an optional `projectId` used when the item has none.
- `apps/api/src/memory/memory-audit.spec.ts` — a case for a user item with the fallback project is added; existing cases unchanged.
- `apps/api/src/memory/memory.controller.spec.ts` — fixtures that build a `MemoryItem` gain `scope: 'project'`; assertions unchanged.
- `openapi.json` — regenerated for `CreateMemoryDto.scope` and the item's `scope`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds a POST /memory user-scope NOTE case (201) and a user-scope FACT case (400).

**US-005**

- `apps/api/src/memory/memory-item-repository.ts` — `ProjectMemoryQuery` gains `owner?` and `scope?`.
- `apps/api/src/memory/prisma-memory-item.repository.ts` — `findByProjectMemory` (both the `contains` and the full-text path) includes the owner's user rows when `owner` is given, filtered by `scope`.
- `apps/api/src/memory/dto/list-memory.query.ts` — gains optional `scope` (`project` | `user` | `all`).
- `apps/api/src/memory/memory-read.controller.ts` — `getMemory` takes `@Principal()` and passes `owner`.
- `apps/api/src/memory/memory-read.controller.spec.ts` — calls to `getMemory` pass a principal; the asserted `getProjectMemory` query gains `owner`; status codes unchanged.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.ts` — `memorySearchTool` passes `owner` from `ctx.actor` and appends `scope <scope>` to each header line; `getMemoryTool` also finds the caller's user item and appends `scope <scope>` to its header line.
- `apps/api/src/fleet/assistant/tools/knowledge-tools.spec.ts` — header-line assertions of `koda_memory_search` and `koda_get_memory` gain the trailing `scope project`.
- `openapi.json` — regenerated for `ListMemoryQuery.scope`.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds GET /projects/:slug/memory?scope=user (200) and `scope=org` (400).

**US-006**

- `apps/api/prisma/schema.prisma` — `MemoryItem` gains `@@index([projectId, updatedAt, id])` and `@@index([ownerKey, updatedAt, id])`.
- `apps/api/src/memory/prisma-memory-item.repository.ts` — adds `findChangedAfter(scope: { projectId: string; ownerKey: string }, after: MemoryExportKey | null, until: Date, take: number): Promise<MemoryItem[]>`.
- `apps/api/src/memory/memory-governance.service.ts` — adds `exportProjectMemory(projectId, owner, since, take)` composing the cursor, settle window and page.
- `apps/api/src/memory/memory-read.controller.ts` — adds the export Get handler.
- `apps/api/src/memory/memory-read.controller.spec.ts` — export cases added; existing cases unchanged.
- `openapi.json` — regenerated for the export route.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds GET /projects/:slug/memory/export happy path (200) and a bad `since` (400).

**US-007**

- `apps/api/src/memory/memory-read.controller.ts` — adds the write-mode Get handler; the constructor gains `MemoryWriteModeService`.
- `apps/api/src/memory/memory.module.ts` — provides `MemoryWriteModeService`.
- `apps/api/src/memory/memory-read.controller.spec.ts` — the controller construction passes a `MemoryWriteModeService` double; existing assertions unchanged.
- `apps/api/src/memory/memory.module.spec.ts` — the provider list resolves `MemoryWriteModeService`.
- `openapi.json` — regenerated for the write-mode route.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds GET /projects/:slug/memory/write-mode (200) and an unknown slug (404).

**US-008**

- `apps/web/pages/[project]/memory.vue` — `KIND_OPTIONS` lists all six kinds; renders description, expandable body and scope badge; adds the search box.
- `apps/web/composables/useMemory.ts` — `MemoryItem` gains `description?` and `scope`; `loadMemory` sends `text` when non-empty.
- `apps/web/tests/pages/memory.spec.ts` — the `KIND_OPTIONS` pin becomes `['', 'FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN', 'NOTE']`.
- `apps/web/tests/pages/memory-mount.spec.ts` — the stub set gains the components the search box and expand control use; existing assertions unchanged.
- `apps/web/tests/composables/useMemory.spec.ts` — the asserted query of `loadMemory` gains `text` only when a text is set; existing cases unchanged.
- `apps/web/i18n/locales/en.json` — memory page strings for search, scope badge, note body toggle.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.

**US-009**

- `apps/web/pages/[project]/settings.vue` — renders `SettingsMemoryCard`.
- `apps/web/i18n/locales/en.json` — memory write-mode card strings.
- `apps/web/i18n/locales/zh.json` — the same keys in Chinese.

**US-010**

- `apps/cli/src/generated/types.gen.ts` — regenerated with `bun run generate:cli` from the updated openapi.json.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated with `bun run generate:cli`.
- `apps/cli/src/generated/index.ts` — regenerated with `bun run generate:cli`.
- `apps/cli/src/commands/memory.ts` — `create` gains `--description` and `--scope` and lists NOTE in `--kind`, and validates option values before resolving the project; adds `list` and `search`.
- `apps/cli/src/commands/memory.spec.ts` — the registered subcommand list gains `list` and `search`; existing cases unchanged.

**US-011**

- `apps/api/src/memory/memory.controller.ts` — adds the Post handler for notes/:id/retire.
- `apps/api/src/memory/memory-route.commands.ts` — `MEMORY_ROUTE_VARIANTS` gains `retireNote: 'rest:memory.note.retire'`, registered under `memory.create` and running `MemoryWriteService.retireNote`.
- `apps/api/src/memory/memory-write.service.ts` — adds `retireNoteTarget` and `retireNote`.
- `apps/api/src/memory/memory-route.commands.spec.ts` — the exact `toEqual` on `MEMORY_ROUTE_VARIANTS` gains `retireNote: 'rest:memory.note.retire'`; the registered-command Maps are keyed by key and variant instead of key alone, since two commands now share `memory.create`; existing cases unchanged.
- `apps/api/src/permissions/remaining-route-declarations.spec.ts` — gains a row declaring the note retire handler's `@Requires(['memory.create', 'memory.update'], { enforcedBy: 'service' })`; existing rows unchanged.
- `apps/api/src/memory/memory.controller.spec.ts` — note retire cases added; existing cases unchanged.
- `apps/api/src/i18n/en/memory.json` — `retireNotDecision` becomes "Only decisions and notes can be retired" and `retireNotActive` becomes "Only active decisions and notes can be retired".
- `apps/api/src/i18n/zh/memory.json` — `retireNotDecision` becomes "只能撤销决策和笔记" and `retireNotActive` becomes "只能撤销有效的决策和笔记".
- `openapi.json` — regenerated for the note retire route.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — adds POST /memory/notes/:id/retire happy path (201) and a FACT id (422).

### Seams

- US-001 -> US-002: `noteFieldError` (created in US-001) is the only note validator; US-002's `koda_add_memory` parse answers the same field as `POST /memory` for the same bad input.
- US-001 -> US-003: the `description` column is part of `searchVector`.
- US-004 -> US-005, US-006: a user row has `projectId: null` and `ownerKey`; every read that includes user rows filters on `ownerKey` = the caller's.
- US-007 -> US-009: the card reads `GET /projects/:slug/memory/write-mode` and writes through the existing project approval-policy POST, PATCH and DELETE routes.
- API stories -> US-010: the CLI uses the regenerated client only.
- US-006 -> US-011: a retired note is a `rejected` row whose `updatedAt` moved, so the next export carries it as a tombstone.

## Acceptance Criteria

### US-001: Store a note as a NOTE memory item through POST /memory

- `[unit]` `MemoryKind.NOTE` imported from `common/enums` equals `'NOTE'`.
- `[unit]` `noteFieldError({ kind: 'NOTE', subject: 'replay-budget', predicate: 'project', object: 'body', description: 'replay budget' })` returns null.
- `[unit]` `noteFieldError` for a NOTE whose subject is `'Replay Budget'` returns `'subject'`.
- `[unit]` `noteFieldError` for a NOTE whose subject is 65 characters of `a` returns `'subject'`, and 64 characters returns null.
- `[unit]` `noteFieldError` for a NOTE whose predicate is `'misc'` returns `'predicate'`.
- `[unit]` `noteFieldError` for a NOTE whose object is 8193 UTF-8 bytes returns `'object'`, and one of exactly 8192 bytes made of multi-byte characters returns null.
- `[unit]` `noteFieldError` for a NOTE with no object, or an object of only spaces, returns `'object'`.
- `[unit]` `noteFieldError` for a NOTE with no description, or a description of 201 characters, returns `'description'`.
- `[unit]` `noteFieldError({ kind: 'FACT', subject: 's', predicate: 'p', description: 'x' })` returns `'description'`, and the same input without `description` returns null.
- `[unit]` `buildActiveKey('p1', 'NOTE', 'replay-budget', 'project')` returns `'NOTE:replay-budget'`, and `buildActiveKey('p1', 'FACT', 's', 'p')` returns `'FACT:s:p'`.
- `[unit]` `MemoryWriteService.create` for a NOTE input with no description throws `ValidationAppException` whose details name `description` and never calls `upsert`.
- `[integration]` `POST /memory` by a project member with `{ kind: 'NOTE', subject: 'replay-budget', predicate: 'project', object: 'Budget stays 2,048 MiB.', description: 'replay budget' }` answers 201 and the stored row has kind `NOTE` and that description.
- `[integration]` after a NOTE `replay-budget` of type `project`, `upsert` of the same slug with type `feedback` leaves the first row `superseded` with a null `activeKey` and the second `active`.
- `[integration]` `upsert` of a NOTE identical in type, body, description, `sourceType` and `sourceId` to the active one returns the active row's id and writes no row.
- `[integration]` `upsert` of a NOTE that differs from the active one only in description supersedes the active row.

### US-002: Assistant tools write, list and fetch notes

- `[unit]` `addMemoryTool(...).parse({ kind: 'NOTE', subject: 'replay-budget', predicate: 'project', object: 'b', description: 'd' })` returns that input with `description: 'd'`.
- `[unit]` `parse` of a NOTE with subject `'Bad Slug'` throws `ToolInputError` for `subject`, and with predicate `'misc'` for `predicate`.
- `[unit]` `parse` of a NOTE without description throws `ToolInputError` for `description`.
- `[unit]` `parse({ kind: 'FACT', subject: 's', predicate: 'p', description: 'd' })` throws `ToolInputError` for `description`.
- `[unit]` `parse` of a NOTE whose object is 8000 ASCII characters returns it, and of a FACT whose object is 4001 characters throws `ToolInputError` for `object`.
- `[unit]` `preview` of a NOTE `replay-budget` with type `feedback`, while NOTE `replay-budget` of type `project` is active, ends with a `Replaces memory:<id>` line naming the active note.
- `[unit]` `KODA_ADD_MEMORY.inputSchema.properties.kind.enum` equals `['FACT', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN', 'NOTE']` and `properties.description.maxLength` is 200.
- `[unit]` `execute` of a NOTE input calls `PrismaMemoryItemRepository.upsert` with `kind: 'NOTE'` and `description: 'd'` and returns `memory:<id> saved`.
- `[unit]` `preview` of a NOTE input returns text whose first line is `Remember in <slug>: NOTE replay-budget / project` and that contains the description.
- `[unit]` `memorySearchTool(...).execute` over a page holding a NOTE whose object is `'SECRET-BODY'` returns text that contains the fenced line `replay-budget project replay budget` and omits `SECRET-BODY`.
- `[unit]` `memorySearchTool(...).execute` over a FACT still renders the fenced `subject predicate object` line.
- `[unit]` `KODA_GET_MEMORY` is in `KNOWLEDGE_TOOL_DESCRIPTORS` with name `koda_get_memory`, required `id` (1-64 chars) and `additionalProperties: false`, and its tool has key `memory.read`.
- `[unit]` `getMemoryTool(...).execute(ctx, { id })` calls `MemoryGovernanceService.getMemoryItem` with `ctx.projectId` and the id, and for a NOTE it answers the header line `memory:<id> NOTE active ...`, the fenced description and the fenced body.
- `[unit]` `getMemoryTool(...).execute` for an id whose item belongs to another project, is soft-deleted, or does not exist returns `memory item not found`.
- `[unit]` after the knowledge tool group's `onModuleInit`, `AssistantToolRegistry` holds a tool named `koda_get_memory`.
- `[integration]` `MemoryGovernanceService.getMemoryItem(P, id)` returns a NOTE of P, and returns null for a soft-deleted row and for a row of another project.
- `[integration]` an agent holding `memory.read` in the project calls `koda_get_memory` through the MCP server registrations (`kodaMcpToolRegistrations`, which run `AssistantToolExecutor.executeFor` with origin `mcp`) with the project's slug and a NOTE id, and the result contains the note body.

### US-003: Full-text search over memory items

- `[integration]` `findByProjectMemory({ projectId, text: 'deployed runner' }, page)` returns an active item whose object is `'the runner deploys nightly'`.
- `[integration]` `findByProjectMemory` with `text: 'budget'` returns a NOTE whose description contains `budget` and whose subject, predicate and object do not.
- `[integration]` with `orderBy` absent, an item matching `deploy` in subject, predicate and object is returned before an item matching it only in object.
- `[integration]` with `text: 'deploy'` and `orderBy: 'updatedAt'`, matches are returned newest `updatedAt` first regardless of rank.
- `[integration]` `text: 'the'` (no lexemes) returns an item whose subject contains `the`, through the substring path.
- `[integration]` an active item matching the text whose `ttlAt` is in the past is not returned when `status` is not given.
- `[integration]` with `text: 'deploy'` and `status: 'superseded'`, only superseded matches are returned.
- `[integration]` with `text: 'deploy'` and `kind: 'NOTE'`, only NOTE matches are returned.
- `[integration]` a soft-deleted matching item, or a matching item of another project, is not returned.
- `[integration]` with 3 matches and page size 2, page 1 has 2 records and `total` 3, page 2 has the third, and no record appears on both pages.
- `[integration]` a text containing a single quote and a semicolon (`"it's; drop"`) returns a page without error.
- `[integration]` with `text: 'deploy'` and `subject: 'a_b'`, an item whose subject starts with `a_b` matches and one whose subject starts with `axb` does not.
- `[integration]` `text: '预算'` returns an item whose object is `'回放预算保持不变'`, through the substring fallback after zero full-text matches.
- `[unit]` every statement of `MEMORY_SEARCH_VECTOR_STATEMENTS` except the leading column drop is shipped verbatim by a migration under `prisma/migrations`.
- `[unit]` `ListMemoryQuery` with `text` of 101 characters fails validation on `text`, and with 100 characters passes.
- `[unit]` `memorySearchTool(...).execute` with `text: 'deploy'` calls `getProjectMemory` with no `orderBy`, and without `text` calls it with `orderBy: 'updatedAt'`.
- `[integration]` `GET /projects/:slug/memory?text=deployed` by a member answers 200 with the item whose object is `'the runner deploys nightly'`.

### US-004: Write a user-scoped note

- `[unit]` `MemoryScope.USER` imported from `common/enums` equals `'user'` and `MemoryScope.PROJECT` equals `'project'`.
- `[integration]` `POST /memory` by agent A, a member of project P, with `{ projectId: P, scope: 'user', kind: 'NOTE', ... }` answers 201 and the row has `projectId` null, `scope` `'user'`, `ownerType` `'AGENT'`, `ownerId` A and `ownerKey` `'AGENT:<A>'`.
- `[integration]` `POST /memory` with `scope: 'user'` and `kind: 'FACT'` answers 400 naming `scope` and writes nothing.
- `[integration]` `POST /memory` with `scope: 'user'` by an agent that is not a member of `projectId` answers 403 and writes nothing.
- `[integration]` `POST /memory` with `scope: 'user'` by a global admin user with `ownerId` of another user stores the row owned by the admin (`ownerKey` `'USER:<admin>'`).
- `[integration]` `POST /memory` without `scope` stores a row with `scope` `'project'`, the request's `projectId` and a null `ownerKey`.
- `[integration]` agent A writes user NOTE `working-style` through project P and then through project Q: the first row is `superseded` and the second is `active`.
- `[integration]` agents A and B each write user NOTE `working-style`: both rows are `active`.
- `[integration]` agent A writes user NOTE `working-style` and project NOTE `working-style` in P: both rows are `active`.
- `[integration]` with a project P policy `memory.create` for type AGENT in mode `human`, agent A's user-scope `POST /memory` answers 202 with a pending approval request and writes no row; after a user approves the request through `POST /approvals/:id/decisions`, the user row owned by A exists.
- `[integration]` `POST /memory/:id/retire` naming a user row answers 404 `memory.notFound`.
- `[integration]` a user-scope write records one audit entry with key `memory.create`, `resourceType` `'memory-item'`, the new row's id and `projectId` P.

### US-005: Read user-scoped notes next to project memory

- `[integration]` `GET /projects/P/memory` by agent A returns P's project items and A's user items, and each record carries `scope` `'project'` or `'user'`.
- `[integration]` `GET /projects/P/memory` by agent A does not return agent B's user items.
- `[integration]` `GET /projects/P/memory?scope=user` by A returns only A's user items, and `scope=project` returns only P's project items.
- `[unit]` `ListMemoryQuery` with `scope: 'org'` fails validation on `scope`.
- `[integration]` `GET /projects/P/memory?text=working` by A returns A's user NOTE whose description contains `working`, through the full-text path.
- `[integration]` `GET /projects/P/memory?text=the` by A returns A's user NOTE whose subject contains `the`, through the substring path.
- `[integration]` `findByProjectMemory({ projectId: P }, page)` with no `owner` never returns a user row, even when `scope` is `'user'`.
- `[unit]` `MemoryReadController.getMemory` called with an agent principal A passes `owner: { ownerType: 'AGENT', ownerId: A }` to `MemoryGovernanceService.getProjectMemory`.
- `[unit]` `memorySearchTool(...).execute` passes `owner` built from `ctx.actor` to `getProjectMemory`, and each header line ends with `scope project` or `scope user` for the item's scope.
- `[unit]` `getMemoryTool(...).execute` returns an item whose `ownerKey` is the caller's and whose `projectId` is null, with a header line ending `scope user`.
- `[unit]` `getMemoryTool(...).execute` for another principal's user item returns `memory item not found`.

### US-006: Export memory changes after a cursor

- `[unit]` `decodeMemoryExportCursor(encodeMemoryExportCursor({ updatedAt, id }))` returns the same `updatedAt` and `id`.
- `[unit]` `decodeMemoryExportCursor` returns null for `'garbage'`, an empty string, and a base64url string without the separator.
- `[unit]` `ExportMemoryQuery` with `take` 0, 501 or `'1.5'` fails validation on `take`; omitted `take` resolves to 100.
- `[unit]` `MemoryGovernanceService.exportProjectMemory` with a clock at `T` calls `findChangedAfter` with `until` equal to `T - MEMORY_EXPORT_SETTLE_MS` (5000 ms).
- `[integration]` an export with no `since` returns the project's rows ordered `updatedAt` ascending then `id` ascending, including a superseded row, a rejected row and a soft-deleted row with its `deletedAt`.
- `[integration]` a row whose `updatedAt` is less than 5000 ms before the server clock is not returned.
- `[integration]` with 3 rows and `take=2`, the first call returns 2 items, `hasMore` true and `nextCursor` of the second item; a call with that cursor returns the third item and `hasMore` false.
- `[integration]` two rows with the same `updatedAt` split by `take=1` are each returned exactly once across the two calls.
- `[integration]` after a row already exported is superseded, an export with the earlier `nextCursor` returns that row again with `status` `'superseded'`.
- `[integration]` an empty page with `since` returns `items: []`, `hasMore` false and `nextCursor` equal to `since`; an empty page without `since` returns `nextCursor` null.
- `[integration]` an export by agent A includes A's user rows and excludes agent B's user rows and rows of other projects.
- `[integration]` `GET /projects/P/memory/export?since=garbage` answers 400 naming `since`.
- `[integration]` `GET /projects/P/memory/export` by a non-member answers 403, and for an unknown slug answers 404.

### US-007: Read a project's memory write mode

- `[unit]` `MemoryWriteModeService.resolve('p1', agentA)` calls `ApprovalPolicyResolver.resolve` with `{ key: 'memory.create', projectId: 'p1', subject: { type: 'AGENT', id: agentA.id } }`.
- `[unit]` for an AGENT caller whose resolver answer is mode `human` with policy `pol1` and source `policy`, `resolve` returns `mode` `'proposal'`, `policyId` `'pol1'`, `source` `'policy'`.
- `[unit]` for an AGENT caller whose resolver answer is mode `none` with no policy and source `default`, `resolve` returns `mode` `'direct'`, `policyId` null, `source` `'default'`.
- `[unit]` for a USER caller whose resolver answer is mode `human`, `resolve` returns `mode` `'direct'`.
- `[unit]` with a project policy `memory.create`, `principalType` `'AGENT'`, no role, no principal, mode `none`, `resolve` returns `agentPolicy` `{ id, mode: 'none' }`.
- `[unit]` with only a project policy for a role, or for one principal, `resolve` returns `agentPolicy` null.
- `[integration]` with a project P policy `memory.*` for `appliesTo` `all` in mode `human`, `GET /projects/P/memory/write-mode` by an agent member answers 200 with `mode` `'proposal'`, and an agent's `POST /memory` in P answers 202.
- `[integration]` with no `memory.create` policy, `GET /projects/P/memory/write-mode` by an agent member answers 200 with `mode` `'direct'` and `agentPolicy` null.
- `[integration]` `GET /projects/P/memory/write-mode` by a non-member answers 403, and for an unknown slug answers 404.

### US-008: Web memory page shows notes, scope and text search

- `[unit]` the memory page's `KIND_OPTIONS` equals `['', 'FACT', 'DECISION', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN', 'NOTE']`.
- `[unit]` mounting the memory page with a NOTE record renders its description and not its body until the row's expand control is clicked; after the click the body is shown.
- `[unit]` a record with `scope` `'user'` renders the scope badge with the i18n key for user scope; a `'project'` record renders no badge.
- `[unit]` typing `deploy` in the search box makes `loadMemory` call `$api.get` on `/projects/<slug>/memory` with `text: 'deploy'` in the query once 300 ms pass with no further typing, and not before.
- `[unit]` clearing the search box makes the next `loadMemory` call, after the same 300 ms, send no `text` key.
- `[unit]` `useMemory().loadMemory` maps `description` and `scope` from the API record onto `MemoryItem`.
- `[unit]` the memory page renders no hardcoded English for the new controls: the search placeholder, badge and expand label come from `en.json` keys that also exist in `zh.json`.

### US-009: Web project settings toggle the memory write mode

- `[unit]` mounting `SettingsMemoryCard` calls `$api.get` on `/projects/<slug>/memory/write-mode` and shows the `direct` option selected when `agentPolicy` is null.
- `[unit]` with `agentPolicy` null, choosing proposal calls `$api.post` on `/projects/<slug>/approval-policies` with `{ permissionPattern: 'memory.create', appliesTo: { kind: 'type', principalType: 'AGENT' }, mode: 'human' }` and then re-reads the write mode.
- `[unit]` with `agentPolicy` `{ id: 'pol1', mode: 'none' }`, choosing proposal calls `$api.patch` on `/projects/<slug>/approval-policies/pol1` with `{ mode: 'human' }` and sends no `post`.
- `[unit]` with `agentPolicy` `{ id: 'pol1', mode: 'human' }`, the proposal option is selected, and choosing direct calls `$api.delete` on `/projects/<slug>/approval-policies/pol1` and then re-reads the write mode.
- `[unit]` when `useProjectPermissions(slug).permissions.value.has('approval.policy.manage')` is false, both options are disabled and no write is sent.
- `[unit]` when the policy `post` rejects, the card shows the message from `extractApiError` and the selected option returns to `direct`.
- `[unit]` the project settings page renders `SettingsMemoryCard` with the project slug.

### US-010: CLI notes, user scope, list and search

- `[cli]` `koda memory create --project alpha --kind NOTE --subject replay-budget --predicate project --object "body" --description "replay budget"` posts `kind: 'NOTE'` and `description: 'replay budget'` and exits 0.
- `[cli]` `koda memory create ... --scope user` posts `scope: 'user'`; `--scope org` prints an error to stderr and exits 3 without calling the API.
- `[cli]` `koda memory list --project alpha --kind NOTE --scope user --json` calls `GET /projects/alpha/memory` with `kind=NOTE` and `scope=user` and prints the page as `JSON.stringify(data, null, 2)`.
- `[cli]` `koda memory list --project alpha` without `--json` prints one line per record with id, kind, scope and the description for a NOTE or `subject predicate` otherwise.
- `[cli]` `koda memory search "deployed runner" --project alpha` calls `GET /projects/alpha/memory` with `text=deployed runner` and exits 0.
- `[cli]` `koda memory list --page 0` prints an error to stderr and exits 3 without calling the API.
- `[cli]` when the API answers 403, `koda memory list` prints the error to stderr and exits 1.

### US-011: Retire a note

- `[integration]` `POST /memory/notes/:id/retire` by the agent that owns an active project NOTE answers 201, and the row is `rejected` with a null `activeKey`.
- `[integration]` after that retire, with the system clock advanced past `MEMORY_EXPORT_SETTLE_MS` (`updatedAt` is set client-side, so a faked clock moves it), an export with the cursor taken before the retire returns the row with `status` `'rejected'`.
- `[integration]` after that retire, `POST /memory` of a NOTE with the same slug in the same project stores a new `active` row.
- `[integration]` `POST /memory/notes/:id/retire` for a FACT id answers 422 and leaves the row `active`.
- `[integration]` `POST /memory/notes/:id/retire` for a superseded NOTE answers 409 `memory.retireNotActive`.
- `[integration]` for an unknown id, a soft-deleted NOTE, or a NOTE of a project the caller is not a member of, the route answers 404 `memory.notFound`.
- `[integration]` agent B, a project member without an any-row `memory.update` grant, retiring agent A's project NOTE answers 403 and leaves the row `active`.
- `[integration]` agent A retiring its own user NOTE with `{ projectId: P }`, P a project A is a member of, answers 201 and the row is `rejected`.
- `[integration]` agent B retiring agent A's user NOTE with `{ projectId: P }` answers 404 and leaves the row `active`.
- `[integration]` agent A retiring its own user NOTE without `projectId` in the body answers 400 naming `projectId`, and with a `projectId` A is not a member of answers 404.
- `[integration]` in a project P whose `memory.create` AGENT policy is `human`, an agent's retire of a FACT id answers 422 and opens no approval request.
- `[integration]` with a project P policy `memory.create` for type AGENT in mode `human`, agent A's retire of its project NOTE answers 202 with a pending approval request and the row stays `active`; after a user approves it through `POST /approvals/:id/decisions`, the row is `rejected`.
- `[integration]` a retire with `reason: 'stale'` records one audit entry with key `memory.create`, the row's id and summary `retired NOTE: stale`.
- `[unit]` `RetireNoteDto` with a 501-character `reason` fails validation on `reason`.
