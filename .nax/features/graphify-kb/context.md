# Feature Context — graphify-kb

_Hand-authored after US-001 and US-002. Updated after US-003. Date: 2026-04-15. Source: diff (dd319ea→eb18a30, 4796a03→819df23) + adversarial review findings from US-001/002/003._

## Decisions

- **Idempotent import via full clear-then-insert**
  `deleteAllBySourceType(projectId, 'code')` runs before indexing any node, always. No diff/merge. Re-importing produces no duplicates. `cleared` count = records deleted; `imported` count = `nodes.length` (all attempted, regardless of per-node embed failure). Fail-open per node: embed/index failure logs + continues, does not abort import.
  _Source: prd.json analysis; confirmed by US-002 importGraphify implementation._

- **Push model — API is stateless**
  No Python on server. Developer/CI builds `graph.json` via `graphify .`, sends to Koda API. No new embedding provider or vector store; existing `indexDocument()` pipeline reused for `source:'code'` nodes.
  _Source: prd.json analysis._

- **Toggle-off is fail-open**
  When `graphifyEnabled` is toggled `true→false`: all `source:'code'` nodes are purged with `deleteAllBySourceType`. If purge fails, log at `warn` level and do NOT roll back the flag change. The flag update commits regardless of purge success.
  _Source: prd.json analysis (US-004)._

## Constraints

- **`source` union must be `'ticket' | 'doc' | 'manual' | 'code'` in ALL four locations** — not just the one you're editing:
  1. `AddDocumentDto` — `@IsIn([...])` decorator and TypeScript type
  2. `IndexDocumentInput` interface — internal LanceDB record type in `rag.service.ts`
  3. `KbResultDto` — TypeScript type annotation **and** `@ApiProperty({ enum: [...] })` decorator (adversarial found this missing in US-001 round 1; fixing only the type annotation without the decorator generates wrong Swagger docs)
  4. `rag.service.ts` cast sites — two `as 'ticket' | 'doc' | 'manual' | 'code'` casts in search result mappers
  _Source: US-001 adversarial finding (error severity, kb-result.dto.ts:10); fixed in commit eb18a30._

- **`ProjectsService.update()` Prisma data object must include every new DTO field explicitly**
  New fields in `UpdateProjectDto` are silently dropped if not also added to the `db.project.update({ data: { ... } })` object. The agent missed `graphifyEnabled` in round 1 despite adding it to the DTO. Adversarial caught it as an abandonment error.
  _Source: US-001 adversarial finding (error severity, projects.service.ts:136); fixed in commit eb18a30._

- **`deleteAllBySourceType` sourceType must be validated before interpolation**
  Naive `table.delete(\`source = '${sourceType}'\`)` is SQL-injectable. Validate `sourceType` against the allowed union `['ticket', 'doc', 'manual', 'code']` before building the filter string. US-002 adversarial flagged this as an error-severity finding; fix was added in commit 819df23.
  _Source: US-002 adversarial finding (error severity, rag.service.ts:534)._

- **`RagModule` must export `RagService`** for `ProjectsModule` to inject it. Dependency is one-way: `projects → rag`. Do NOT import `ProjectsModule` from `RagModule` — circular dependency.
  _Source: prd.json analysis (US-004 constraint)._

- **i18n keys must exist in BOTH `en/rag.json` AND `zh/rag.json`** or the NestJS i18n module throws at startup. Confirmed by US-001: both files were updated in the same commit.
  _Source: US-001 diff (commits 764cf3d); pre-populated spec constraint confirmed._

- **After US-003, regenerate before US-005**: run `bun run api:export-spec && bun run generate` to rebuild `openapi.json` and the CLI generated client. US-005 CLI command depends on the generated import service method. Skip this and US-005 will call a method that doesn't exist.
  _Source: prd.json analysis._

- **Multi-write controller routes must wrap `ragService.*` + `project.update()` in a Prisma transaction**
  US-003 adversarial flagged this as an error-severity finding. Pattern: if a controller calls `ragService.importGraphify()` and then `db.project.update()`, a failure in the second call leaves LanceDB updated but `graphifyLastImportedAt` stale. Wrap both in `db.$transaction([...])` or use `prisma.$transaction(async (tx) => {...})`. Applies anywhere a controller writes to both the vector store and the relational DB in the same request.
  _Source: US-003 adversarial finding (error severity, rag.controller.ts); not fixed on first Opus pass — agent accepted it as advisory but DB integrity risk remains._

- **Every `i18n/<locale>/<module>.json` must include the `-2` default validation key**
  Koda convention: the `-2` key is the default fallback message for `ValidationAppException`. Modules that omit it (`rag.json` did in US-003) get blocking adversarial findings. Check existing modules (`labels.json`, `projects.json`, `tickets.json`) for the expected shape — usually `"-2": "Validation failed"` or locale-equivalent in zh.
  _Source: US-003 adversarial finding (error severity, i18n/en/rag.json)._

- **`ValidationAppException` expects a numeric i18n key, not a string**
  Pattern `new ValidationAppException({}, 'rag', 'graphifyDisabled' as unknown as number)` is wrong — adversarial flagged the cast. The correct pattern is to define a numeric code in the i18n JSON (e.g. `"40001": "graphify is disabled for this project"`) and pass the numeric literal. String keys only work with other exception classes (e.g. `NotFoundAppException`). Check an existing `ValidationAppException` call site before writing a new one.
  _Source: US-003 adversarial finding (error severity, rag.controller.ts convention violation)._

## Patterns Established

- **Schema field ordering**: new graphify fields go `graphifyEnabled` → `graphifyLastImportedAt` → (existing) `deletedAt` → `createdAt` → `updatedAt`. Match this order in migration and schema or Prisma migration diffs become confusingly noisy.
  _Source: US-001 diff (schema.prisma); mirrors existing `autoIndexOnClose` ordering._

- **`graphifyLastImportedAt` is updated in the controller, not the service**
  The service (`importGraphify`) does not touch `graphifyLastImportedAt`. The controller sets it after a successful import via `ProjectsService.update()`. This is an AC in US-003.
  _Source: spec US-003 AC._

- **Node content format is deterministic**:
  - Has outgoing links: `{type} {label} in {source_file}: {relation} {neighbor_label}, {relation} {neighbor_label}, ...`
  - Isolated node with source_file: `{type} {label} in {source_file}`
  - No source_file: `{type} {label}`
  - type defaults to `'node'` when absent; separator before neighbor list is `': '`; between neighbors is `', '`.
  _Source: US-002 diff (rag.service.ts importGraphify); prd.json analysis._

- **Integration test location**: `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` — all story integration tests for this feature go in the same file.
  _Source: US-001 diff (764cf3d)._

- **Migration style is SQLite** (`PRAGMA defer_foreign_keys`). Existing table is rebuilt via CREATE+INSERT+DROP+RENAME. Do not write Postgres-style `ALTER TABLE ADD COLUMN` migrations.
  _Source: US-001 migration diff._

## Gotchas

- **`@ApiProperty enum` and TypeScript type must be updated together in DTOs** — updating the TypeScript type alone does not update the Swagger schema. The adversarial reviewer specifically targets the `@ApiProperty({ enum: [...] })` decorator independently of the type annotation. Both must include `'code'`.
  _Source: US-001 adversarial finding round 1 (kb-result.dto.ts)._

- **`create()` can rely on DB default for new fields, but `update()` cannot** — `ProjectsService.create()` omits `graphifyEnabled` from the Prisma data object and correctly gets the DB default. But `update()` must include every optional DTO field explicitly; absence = silent discard. Do not assume symmetry between `create` and `update`.
  _Source: US-001 adversarial finding round 1 (projects.service.ts)._

- **Count-before-delete in `deleteAllBySourceType` is slightly racy** — count is computed from a query before the delete runs. Accepted by spec as-is; do not "fix" it by reading from delete response (LanceDB doesn't return delete count natively). Advisory finding in US-002, not blocking.
  _Source: US-002 adversarial finding (warn severity)._

- **Non-null assertion on outgoingLinks must be avoided** — `outgoingLinks.get(id)!.push()` was flagged in US-002. Pattern: store result of `.get()` in a local variable, null-check before pushing.
  _Source: US-002 adversarial finding; fixed in commit 819df23._
