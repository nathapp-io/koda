# SPEC: CLI knowledge-base list and add output

## Summary

Make the human output of `koda kb list` and `koda kb add` reflect the existing API responses. Keep their machine-readable output compatible with scripts.

## Motivation

The November 25 review reproduced two CLI defects with responses from the KB controller. In finding 16, list starts a table and exits 1 because it expects an object with an `items` field. The API returns an array. In finding 17, add reports an undefined document count because the response describes the indexing outcome for one source. Both defects can be corrected within the CLI.

## Design

### Integration

The baseline descriptions locate the current handlers. The target descriptions define the change.

- `kbCommand(program: Command): void` in `apps/cli/src/commands/kb.ts` registers both actions. **List baseline:** its success formatter assumes `data.items` and `data.total`. **Target:** consume the unwrapped document array; format the display fields from each row and preserve every returned field in JSON.
- **Add baseline:** the success formatter reads `docCount`. **Target:** consume the executed result with `indexed` and `sourceId`, plus `id` on an indexed result. Select the human message by the returned boolean and keep the original object for JSON.
- Read-only producers: `RagService.listDocuments(projectId, limit)` returns `Promise<KbResultDto[]>`. Each row carries `id`, `source`, `sourceId`, `content`, `createdAt`, score, similarity, metadata and provenance. `KbDocumentAddition.prepare` supplies the success objects `{ indexed: true, id, sourceId }` and `{ indexed: false, sourceId }`. The controllers wrap these values in the existing success envelope.
- Existing client boundaries are the generated list/add operations, `unwrap<T>(response)` and `finishSuccess()`. The earlier slow-reader JSON test exercises real stdout completion. The producer examples in `docs/review-evidence/20261125/cli-kb-contract.ts` can be consulted without importing API code into the CLI.

### CLI behavior

For `kb list`, retain the ID, Source and Created columns. Source shows the API's source type (for example, `manual`). Created shows the UTC calendar date from `createdAt`. Display rows in API order and finish with `Shown: N`, where N is the length of the returned array. The request is capped at 100 rows, so the footer describes this response. An empty response still prints the headings and `Shown: 0`.

For an executed `kb add --file example.md`, print exactly one outcome line to stdout. For example, `Indexed example.md.` for `indexed: true` or `Not indexed: example.md.` for `indexed: false`. Use the returned `sourceId`. Both are successful API responses and retain exit 0.

In JSON mode stdout is the complete unwrapped payload, pretty-printed with two-space indentation and a terminating newline. For example, an empty list prints `[]`. A completed add can print:

```json
{
  "indexed": true,
  "id": "doc-1",
  "sourceId": "example.md"
}
```

### Failure handling

An HTTP success carrying `indexed: false` is a reported outcome. A refused or failed request continues through the existing CLI error path and writes its diagnostic to stderr. A pending approval continues through the existing approval path, with exit 5. Other error mappings and retry policy are outside this change.

## Out of Scope

- Changes to API responses, OpenAPI, generated client files, storage, indexing and embedding behavior.
- New pagination controls, changes to the 100-row request limit, and project-wide document counts.
- Changes to argument validation, project selection, approval handling, transport failures, malformed-response policy or retry behavior.
- Changes to other KB commands, the global configuration store, or shared CLI output completion.

## Stories

### US-001 — Render the KB document list and indexing outcome

Workdir: apps/cli

No dependencies.

Correct the two success formatters in place. Exercise the registered Commander actions with generated-client responses shaped like the controller envelopes. Keep the existing project lookup, request arguments and output-completion coverage. Run the CLI package's tests, type-check and lint.

### Context Files

**US-001**
- `apps/cli/src/commands/kb.ts` — command registration and current success branches.
- `apps/api/src/rag/dto/kb-result.dto.ts` — fields of a returned document.
- `apps/api/src/rag/kb-document-addition.service.ts` — both executed indexing outcomes.
- `apps/cli/src/cli-output-completion.integration.spec.ts` — full JSON delivery to a slow reader.
- `docs/review-evidence/20261125/cli-kb-contract.ts` — evidence for the controller envelope shapes.

### Creates

None. Extend the existing CLI command tests.

### Modifies

**US-001**
- `apps/cli/src/commands/kb.ts` — replace the list object's items and total assumptions with array rendering and a displayed-row count; replace the add document count with the returned indexing outcome while preserving the unwrapped JSON.
- `apps/cli/src/commands/kb.spec.ts` — replace the items/total fixture and JSON assertion with array fixtures; use real source types for the Source column; replace source/docCount add assertions with both indexed outcomes and exact JSON payload checks. Preserve the request, error and completion assertions.
- `apps/cli/src/commands/kb-us003-5.spec.ts` — supply a successful empty array for the list response in the project-resolution fixture; keep the resolved slug assertion and missing-project behavior.

### Seams

One story changes two existing actions. Both already reach their generated operation. The change introduces no exported symbol.

## Acceptance Criteria

### US-001

Exercise the registered commands with successful `{ ret: 0, data: ... }` responses unless an HTTP error is explicitly named. For human list output, compare the table as columns and rows so spacing can accommodate different ID lengths.

- [cli] Given an empty document array, `kb list` prints the ID, Source and Created headings followed by the zero-row footer `Shown: 0`.
- [cli] Given two rows in the order `doc-B`, `doc-A`, `kb list` renders those two IDs in that order.
- [cli] For those two rows, the final line of `kb list` stdout is `Shown: 2`.
- [cli] For a row with source `manual`, sourceId `example.md` and createdAt `2026-01-11T00:30:00+02:00`, the `kb list` table row reads `doc-B`, `manual`, `2026-01-10` in its three columns when the row ID is `doc-B`.
- [cli] For a 100-row response, the final line of `kb list` stdout is `Shown: 100`.
- [cli] For both an empty and a populated valid document array, human `kb list` completes with exit 0.
- [cli] With empty or populated data, `kb list --json` writes the full API array as two-space-indented JSON followed by a newline, including every returned row field.
- [cli] When the generated-client fixture returns `{ indexed: true, id: "doc-1", sourceId: "stored.md" }`, the single stdout line from human `kb add --file example.md` is `Indexed stored.md.`.
- [cli] When the generated-client fixture returns `{ indexed: false, sourceId: "stored.md" }`, the single stdout line from human `kb add --file example.md` is `Not indexed: stored.md.`.
- [cli] For each executed indexing outcome, `kb add --file example.md` completes with exit 0.
- [cli] For either executed indexing outcome, `kb add --file example.md --json` writes the exact unwrapped API object as two-space-indented JSON followed by a newline.
