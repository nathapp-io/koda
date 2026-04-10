# SPEC: Graphify KB Integration

## Summary

Extend Koda's knowledge base with code-structure documents ingested from a
[Graphify](https://github.com/safishamsi/graphify) knowledge graph. Developers
or CI pipelines run `graphify .` locally to build a `graph.json` representing
their codebase, then push it to Koda via a new CLI command. Koda stores each
graph node as a `source:'code'` document in LanceDB so that KB searches return
both tickets and relevant code entities side by side. Each project opts in
explicitly via a `graphifyEnabled` flag — disabling the flag purges all code
nodes for that project.

## Motivation

Koda's KB currently indexes only closed tickets and manually uploaded docs.
Developers searching for context around a bug or feature have no way to surface
related code entities (classes, functions, modules) from the actual codebase.
Graphify already produces a deterministic, embeddable knowledge graph from
source code with zero LLM cost. Ingesting its output into LanceDB gives Koda's
hybrid vector + FTS search a code layer without any changes to the retrieval
path. The push model (developer or CI pushes `graph.json` to Koda) avoids
running Python on the Koda server and keeps the API server stateless with
respect to codebase locations.

## Design

### Approach

Graphify outputs a `graph.json` file in NetworkX node-link format. The CLI
reads this file and POSTs the node/link arrays to a new API endpoint. The API
converts each node into an embeddable text chunk and calls the existing
`indexDocument()` pipeline. No new vector store, embedding provider, or
retrieval path is needed — only a new ingestion adapter.

### graph.json Format (Graphify output)

Graphify's `graphify-out/graph.json` follows NetworkX node-link format:

```json
{
  "directed": false,
  "multigraph": false,
  "graph": {},
  "nodes": [
    {
      "id": "node_abc123",
      "label": "AuthService",
      "type": "class",
      "source_file": "src/auth/auth.service.ts",
      "community": 0
    },
    {
      "id": "node_def456",
      "label": "validateToken",
      "type": "method",
      "source_file": "src/auth/auth.service.ts",
      "community": 0
    }
  ],
  "links": [
    {
      "source": "node_abc123",
      "target": "node_def456",
      "relation": "contains",
      "confidence": "EXTRACTED"
    }
  ]
}
```

### Import Request Body

The CLI strips the NetworkX envelope and sends only `nodes` and `links`:

```typescript
interface GraphifyNodeDto {
  id: string;
  label: string;
  type?: string;        // 'class' | 'function' | 'method' | 'module' | etc.
  source_file?: string;
  community?: number;
}

interface GraphifyLinkDto {
  source: string;  // node id
  target: string;  // node id
  relation?: string;
}

// POST /projects/:slug/kb/import/graphify body
interface ImportGraphifyDto {
  nodes: GraphifyNodeDto[];
  links?: GraphifyLinkDto[];
}
```

### Node → Embeddable Text Conversion

Each node becomes a content string incorporating its neighbors:

```
"{type} {label} in {source_file}: {relation} {neighbor_label}, {relation} {neighbor_label}"
```

Example:
```
"class AuthService in src/auth/auth.service.ts: contains validateToken, calls JwtService"
```

Nodes with no `source_file` omit the `in …` part. Nodes with no links emit
only `"{type} {label}"`. The `type` field defaults to `"node"` when absent.

### New RagService Method

```typescript
// Deletes all documents where source = sourceType for a given project.
// Returns the count of rows deleted (query before delete).
async deleteAllBySourceType(
  projectId: string,
  sourceType: 'code' | 'ticket' | 'doc' | 'manual',
): Promise<number>
```

### Import Service Method

```typescript
// In RagService:
async importGraphify(
  projectId: string,
  nodes: GraphifyNodeDto[],
  links: GraphifyLinkDto[],
): Promise<{ imported: number; cleared: number }>
```

Steps:
1. Call `deleteAllBySourceType(projectId, 'code')` → `cleared`
2. For each node, build content string using link adjacency
3. Call `indexDocument()` for each node with:
   - `source: 'code'`
   - `sourceId: node.id`
   - `content`: computed text string
   - `metadata: { label: node.label, type: node.type ?? 'node', source_file: node.source_file ?? null, community: node.community ?? null }`
4. Return `{ imported: nodes.length, cleared }`

### Import Endpoint

```
POST /projects/:slug/kb/import/graphify
Auth: JWT or API key — ADMIN role required
Body: ImportGraphifyDto
Response 200: { ret: 0, data: { imported: number; cleared: number } }
Response 400: project not found or graphifyEnabled is false
Response 403: caller is not ADMIN
```

### Existing Types Extended

| File | Change |
|:-----|:-------|
| `apps/api/prisma/schema.prisma` | Add `graphifyEnabled Boolean @default(false)` to `Project` |
| `apps/api/src/rag/rag.service.ts` | Extend `source` union in `IndexDocumentInput` to include `'code'`; add `deleteAllBySourceType()` and `importGraphify()` |
| `apps/api/src/rag/dto/add-document.dto.ts` | Extend `source` `@IsIn` array to include `'code'` |
| `apps/api/src/rag/rag.controller.ts` | Add `POST kb/import/graphify` route |
| `apps/api/src/projects/dto/update-project.dto.ts` | Add optional `graphifyEnabled?: boolean` |
| `apps/api/src/projects/dto/project-response.dto.ts` | Add `graphifyEnabled: boolean`; update `from()` |
| `apps/api/src/projects/projects.service.ts` | Inject `RagService`; on `graphifyEnabled` flip to `false`, call `deleteAllBySourceType` |
| `apps/api/src/projects/projects.module.ts` | Import `RagModule` |
| `apps/api/src/i18n/en/rag.json` | Add `"graphifyDisabled"` and `"graphifyImportSuccess"` keys |
| `apps/api/src/i18n/zh/rag.json` | Same keys in Chinese |
| `apps/cli/src/commands/kb.ts` | Add `import` sub-command |

### Failure Handling

- If `graphifyEnabled` is `false` on the project → return `ValidationAppException`
  using i18n key `rag.graphifyDisabled`; import is rejected before any nodes are processed
- If embedding fails for a node → existing fallback in `indexDocument()` stores a
  zero vector and continues (fail-open, same as existing behaviour)
- If `graph.json` contains zero nodes → import succeeds with `{ imported: 0, cleared: N }`
- Toggling `graphifyEnabled` from `true` → `false`: `deleteAllBySourceType` is
  called in the same request as the project update; failure logs at warn level but
  does not roll back the flag change
- CLI: file not found → exit 1 with message to stderr; API error → `handleApiError(err)`

### CLI Behaviour

```
Command : koda kb import --project <slug> --graphify <path>
Flags   : --project <slug>   (required)
          --graphify <path>  path to graph.json (required)
          --json             output raw JSON response
Exit 0  : import succeeded
Exit 1  : file not found or unreadable
Exit 2  : auth not configured
Exit 3  : validation error (missing flag)
stdout  : success message or JSON when --json
stderr  : errors and warnings

Human-readable success:
  ✓ Graphify import complete: 42 code nodes indexed (15 cleared)

No-nodes output:
  ✓ Graphify import complete: 0 code nodes indexed (0 cleared)
```

## Stories

### US-001 — Schema, Type Extensions & RagService Methods

No dependencies.

Add `graphifyEnabled` to the Project model, extend the `source` union with
`'code'`, surface the flag in project DTOs, and add the two new `RagService`
methods (`deleteAllBySourceType`, `importGraphify`) with their unit tests.

**Files to create/modify:**

```
apps/api/
├── prisma/
│   ├── schema.prisma                          ← MODIFY — add graphifyEnabled
│   └── migrations/                            ← NEW migration
└── src/
    ├── rag/
    │   ├── rag.service.ts                     ← MODIFY — source union + 2 new methods
    │   ├── rag.service.spec.ts                ← MODIFY — tests for new methods
    │   └── dto/
    │       └── add-document.dto.ts            ← MODIFY — add 'code' to IsIn
    ├── projects/
    │   └── dto/
    │       ├── update-project.dto.ts          ← MODIFY — add graphifyEnabled
    │       └── project-response.dto.ts        ← MODIFY — add graphifyEnabled + from()
    └── i18n/
        ├── en/rag.json                        ← MODIFY — add graphifyDisabled key
        └── zh/rag.json                        ← MODIFY — add graphifyDisabled key
```

### Context Files
- `apps/api/prisma/schema.prisma` — Project model; add field beside `autoIndexOnClose`
- `apps/api/src/rag/rag.service.ts` — `IndexDocumentInput`, `deleteBySource()`, `indexDocument()` patterns to follow
- `apps/api/src/rag/rag.service.spec.ts` — existing unit test patterns for RagService
- `apps/api/src/rag/dto/add-document.dto.ts` — source union to extend
- `apps/api/src/projects/dto/update-project.dto.ts` — `autoIndexOnClose` pattern to follow
- `apps/api/src/projects/dto/project-response.dto.ts` — `from()` pattern to follow
- `apps/api/src/i18n/en/rag.json` — existing i18n keys

### Acceptance Criteria

- `Project.graphifyEnabled` defaults to `false` when a project is created with no `graphifyEnabled` field
- `AddDocumentDto` accepts `source: 'code'` without a validation error
- `AddDocumentDto` rejects any `source` value not in `['ticket', 'doc', 'manual', 'code']` with a 400
- `IndexDocumentInput.source` type includes `'code'` as a valid literal
- `RagService.deleteAllBySourceType(projectId, 'code')` deletes all records where `source = 'code'` for the given project and returns the count of records deleted
- `RagService.deleteAllBySourceType(projectId, 'code')` returns `0` when no `source:'code'` records exist
- `RagService.importGraphify(projectId, nodes, links)` calls `deleteAllBySourceType(projectId, 'code')` before indexing any nodes
- `RagService.importGraphify(projectId, nodes, [])` with an empty links array indexes each node with content `"{type} {label} in {source_file}"`
- `RagService.importGraphify(projectId, nodes, links)` builds content that includes `"{relation} {neighbor_label}"` for each link where the node is the source
- `RagService.importGraphify(projectId, nodes, links)` calls `indexDocument()` with `source: 'code'`, `sourceId: node.id`, and `metadata` containing `label`, `type`, `source_file`, `community`
- `RagService.importGraphify(projectId, [], [])` returns `{ imported: 0, cleared: N }` where `N` is the count from `deleteAllBySourceType`
- `ProjectResponseDto.from(project)` maps `project.graphifyEnabled` to `dto.graphifyEnabled`
- `UpdateProjectDto` accepts `graphifyEnabled: true` without a validation error
- i18n key `rag.graphifyDisabled` exists in both `en/rag.json` and `zh/rag.json`

---

### US-002 — Import Endpoint

Depends on **US-001**.

Add `POST /projects/:slug/kb/import/graphify` to `RagController`. Guard it to
ADMIN role. Wire through `RagService.importGraphify()`. Update the e2e spec.

**Files to create/modify:**

```
apps/api/src/
└── rag/
    ├── rag.controller.ts                      ← MODIFY — add import route
    ├── dto/
    │   └── import-graphify.dto.ts             ← NEW — ImportGraphifyDto + sub-DTOs
    └── rag.controller.spec.ts (if exists)     ← MODIFY if present
apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts  ← MODIFY — add import endpoint tests
```

### Context Files
- `apps/api/src/rag/rag.controller.ts` — existing admin-guarded routes (`deleteDocument`, `optimizeTable`) to follow for ADMIN check pattern
- `apps/api/src/rag/dto/add-document.dto.ts` — DTO structure to follow
- `apps/api/src/rag/rag.service.ts` — `importGraphify()` signature (added in US-001)
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — e2e test patterns to follow

### Acceptance Criteria

- `POST /projects/:slug/kb/import/graphify` with a valid body and ADMIN auth returns `{ ret: 0, data: { imported: number, cleared: number } }`
- `POST /projects/:slug/kb/import/graphify` returns 403 when the caller does not have ADMIN role
- `POST /projects/:slug/kb/import/graphify` returns 404 when the project slug does not exist
- `POST /projects/:slug/kb/import/graphify` returns 400 when `project.graphifyEnabled` is `false`
- `POST /projects/:slug/kb/import/graphify` with `nodes: []` returns `{ imported: 0, cleared: 0 }` and does not call `indexDocument`
- `ImportGraphifyDto` rejects a body missing `nodes` with a 400 validation error
- `ImportGraphifyDto` accepts a body with `nodes` present and `links` absent (links optional)
- The import route calls `ragService.importGraphify(project.id, dto.nodes, dto.links ?? [])` and returns its result
- e2e spec covers: happy-path import, 403 non-admin, 400 graphify disabled

---

### US-003 — Toggle Enforcement & Cleanup in ProjectsService

Depends on **US-001**.

When a project update sets `graphifyEnabled` from `true` to `false`,
`ProjectsService.update()` must call
`ragService.deleteAllBySourceType(projectId, 'code')` to purge stale code nodes.
Wire `RagModule` into `ProjectsModule`.

**Files to create/modify:**

```
apps/api/src/projects/
├── projects.service.ts                        ← MODIFY — inject RagService, add purge on toggle-off
├── projects.module.ts                         ← MODIFY — import RagModule
└── projects.service.spec.ts                   ← MODIFY — add tests for toggle-off purge
```

### Context Files
- `apps/api/src/projects/projects.service.ts` — `update()` method to extend
- `apps/api/src/projects/projects.module.ts` — existing module imports pattern
- `apps/api/src/rag/rag.module.ts` — exports to verify `RagService` is exported
- `apps/api/src/projects/projects.service.spec.ts` — existing unit test patterns

### Acceptance Criteria

- `ProjectsService.update()` calls `ragService.deleteAllBySourceType(projectId, 'code')` when `graphifyEnabled` changes from `true` to `false` in the update payload
- `ProjectsService.update()` does not call `ragService.deleteAllBySourceType` when `graphifyEnabled` is not present in the update payload
- `ProjectsService.update()` does not call `ragService.deleteAllBySourceType` when `graphifyEnabled` changes from `false` to `true`
- `ProjectsService.update()` does not call `ragService.deleteAllBySourceType` when `graphifyEnabled` is `true` in both current state and update payload
- When `ragService.deleteAllBySourceType` throws, `ProjectsService.update()` logs a warning at warn level and does not re-throw (the flag change is persisted regardless)
- `RagModule` is imported in `ProjectsModule` so `RagService` is available via DI in `ProjectsService`

---

### US-004 — CLI `koda kb import --graphify`

Depends on **US-002**.

Add an `import` sub-command to `apps/cli/src/commands/kb.ts` that reads a
`graph.json` file and POSTs its nodes/links to the import endpoint.

**Files to create/modify:**

```
apps/cli/src/
└── commands/
    ├── kb.ts                                  ← MODIFY — add import sub-command
    └── kb.spec.ts                             ← MODIFY — add import command tests
```

### Context Files
- `apps/cli/src/commands/kb.ts` — existing `koda kb search/list/add` patterns to follow exactly
- `apps/cli/src/commands/kb.spec.ts` — existing CLI unit test patterns
- `apps/cli/src/utils/auth.ts` — `resolveAuth({})` pattern
- `apps/cli/src/utils/api.ts` — `unwrap(response)` pattern
- `apps/cli/src/utils/error.ts` — `handleApiError(err)` pattern
- `apps/cli/src/generated/index.ts` — locate the generated KB import service name

### CLI Behaviour

```
koda kb import --project <slug> --graphify <path-to-graph.json> [--json]
```

Steps the command takes:
1. Resolve auth via `resolveAuth({})` — exit 2 if missing
2. Read file at `<path>` — exit 1 with stderr message if not found or not valid JSON
3. Parse `{ nodes, links }` from the file (other top-level keys are ignored)
4. Configure client and call the generated import service method
5. On success: print human message or JSON; exit 0
6. On API error: `handleApiError(err)`

### Acceptance Criteria

- `koda kb import --project koda --graphify ./graph.json` exits 0 and prints `✓ Graphify import complete: {imported} code nodes indexed ({cleared} cleared)` to stdout
- `koda kb import --project koda --graphify ./graph.json --json` exits 0 and prints raw JSON to stdout
- `koda kb import --project koda --graphify ./missing.json` exits 1 and writes a file-not-found message to stderr
- `koda kb import --project koda --graphify ./invalid.json` (non-JSON content) exits 1 and writes a parse-error message to stderr
- `koda kb import` with missing `--project` exits 3
- `koda kb import` with missing `--graphify` exits 3
- When auth config is absent, exits 2 without calling the API
- The command sends `{ nodes, links }` extracted from the parsed file — it does not send other top-level keys from the graph.json

## Acceptance Criteria

*(Per-story ACs are listed inline above. Summary of cross-cutting constraints:)*

- `source: 'code'` documents appear in `POST /projects/:slug/kb/search` results alongside `source: 'ticket'` and `source: 'manual'` documents (no search path changes required — existing RRF handles all sources)
- `graphifyEnabled: false` on a project causes `POST /kb/import/graphify` to return 400; it does not silently accept and discard the payload
- Re-running `koda kb import` on a project clears all previous `source:'code'` nodes before inserting new ones (idempotent rebuild)
- All new i18n strings exist in both `en/` and `zh/` with non-empty values
- `bun run test` passes in `apps/api` and `apps/cli` after all stories

## Dependency Order

```
US-001 (schema + types + RagService methods — no dependencies)
  ├→ US-002 (import endpoint — needs source:'code' type and importGraphify())
  ├→ US-003 (toggle cleanup — needs deleteAllBySourceType())
  └→ US-004 (CLI command — needs US-002 endpoint to exist)
```

US-002 and US-003 can run in parallel after US-001. US-004 depends on US-002.

## Files Summary

| File | Action | Story |
|:-----|:-------|:------|
| `apps/api/prisma/schema.prisma` | MODIFY — add `graphifyEnabled` | US-001 |
| `apps/api/prisma/migrations/` | NEW migration | US-001 |
| `apps/api/src/rag/rag.service.ts` | MODIFY — source union, `deleteAllBySourceType`, `importGraphify` | US-001 |
| `apps/api/src/rag/rag.service.spec.ts` | MODIFY — tests for new methods | US-001 |
| `apps/api/src/rag/dto/add-document.dto.ts` | MODIFY — add `'code'` to `IsIn` | US-001 |
| `apps/api/src/projects/dto/update-project.dto.ts` | MODIFY — add `graphifyEnabled` | US-001 |
| `apps/api/src/projects/dto/project-response.dto.ts` | MODIFY — add `graphifyEnabled`, update `from()` | US-001 |
| `apps/api/src/i18n/en/rag.json` | MODIFY — add `graphifyDisabled` | US-001 |
| `apps/api/src/i18n/zh/rag.json` | MODIFY — add `graphifyDisabled` | US-001 |
| `apps/api/src/rag/dto/import-graphify.dto.ts` | CREATE — `ImportGraphifyDto`, `GraphifyNodeDto`, `GraphifyLinkDto` | US-002 |
| `apps/api/src/rag/rag.controller.ts` | MODIFY — add import route | US-002 |
| `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` | MODIFY — add import endpoint e2e tests | US-002 |
| `apps/api/src/projects/projects.service.ts` | MODIFY — inject `RagService`, purge on toggle-off | US-003 |
| `apps/api/src/projects/projects.module.ts` | MODIFY — import `RagModule` | US-003 |
| `apps/api/src/projects/projects.service.spec.ts` | MODIFY — toggle-off purge tests | US-003 |
| `apps/cli/src/commands/kb.ts` | MODIFY — add `import` sub-command | US-004 |
| `apps/cli/src/commands/kb.spec.ts` | MODIFY — add import command tests | US-004 |
