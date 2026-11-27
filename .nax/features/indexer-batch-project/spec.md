# SPEC: Code-intel indexer: syntax-only rejection and one compiler project per batch

Closes: #528

## Summary

`AstIndexService.indexCommit` parses every file of a commit through `CodeGraphService.parseSourceFile`, which builds a
new in-memory ts-morph `Project` per file and rejects the file on any error-category diagnostic with a code from 1000
to 1999 taken from `getPreEmitDiagnostics()`. This feature makes two changes. First, a file is rejected only for
syntactic diagnostics, so decorated NestJS classes are indexed again. Second, the indexer reuses one in-memory project
for all files of one `indexCommit` call, through a new `CodeGraphService.extractBatch`. Each file is added, its
symbols are extracted, and it is removed again, so files never see each other. The project is dropped when the call
returns. Extraction output for each file stays what a fresh project would produce.

## Motivation

Measured on 2026-11-27 (Bun 1.4.5, ts-morph 28.0.0, macOS arm64) over the 1,055 non-spec `.ts` files under
`apps/api/src` (excluding `generated/`), with the same extraction logic:

| Variant | Time | Peak RSS | Parse rejections |
|---|---:|---:|---:|
| Today: fresh project per file, pre-emit diagnostics | n/a | n/a | 318 |
| Fresh project per file, syntactic diagnostics only | 47.7 s | 713 MiB | 0 |
| One project per batch, file removed after extraction, syntactic diagnostics only | 1.9 s | 386 MiB | 0 |

- **Decorated files are rejected today.** The semantic grammar check reports `TS1206 Decorators are not valid here`
  for constructor parameter decorators such as `@Inject(TRANSACTION_MANAGER)`, because the in-memory project does not
  set `experimentalDecorators`. TS1206 is in the 1000-1999 range, so `parseSourceFile` throws `Parse error: ...` and
  every NestJS service or controller with a decorated constructor parameter lands in `fileErrors` with no symbols.
- **A new project per file** loads and type-checks the default lib files again for every file. The api container's
  memory ceiling for the planned production stack has to leave room for this peak.
- "Parse rejections" counts only the rejection rule. The benchmark did not read JSDoc, so files with a top-level
  arrow-function variable still fail on the real tree through the known `extractSymbols` `TypeError` (see Out of
  Scope); this feature does not bring those files to zero errors.
- The last two rows produce byte-identical extraction output, and a file with a real syntax error
  (`export function broken( {`) is still rejected with `TS1005 '}' expected`.

## Design

### Calls made in this spec

- **Rejection rule.** A file is rejected when the program's syntactic diagnostics for its source file contain at
  least one diagnostic of category Error. The error text is `Parse error: ` followed by the diagnostics' message texts
  joined with `; `, the same format as today. Semantic diagnostics (type errors, unresolved imports, decorator grammar
  checks) no longer reject a file. ts-morph exposes the syntactic diagnostics through
  `project.getProgram().getSyntacticDiagnostics(sourceFile)`. `parseSourceFile` and `extractBatch` share one private
  helper that applies this rule, so both get the fix.
- **Batch lifecycle.** `extractBatch(files)` constructs exactly one `new Project({ useInMemoryFileSystem: true })` per
  call when `files` is non-empty. For each file, in input order:
  1. `project.createSourceFile(path, content, { overwrite: true })`
  2. apply the rejection rule
  3. call `this.extractSymbols(parsed)` (the existing public method, unchanged)
  4. `project.removeSourceFile(sourceFile)` in a `finally`, so a rejected or throwing file is also removed before
     the next file is added

  One try covers steps 1 to 3, so a throw from `createSourceFile` also becomes an error result. The `finally`
  removes the source file only when step 1 created it.

  The project is a local variable and is not stored on the service, so no project survives between calls.
- **Isolation.** Because each file is removed before the next one is added, a file never resolves imports or types
  from another file in the same batch. Its symbols and signatures equal what `extractSymbols(parseSourceFile(path,
  content))` returns for it alone.
- **Result shape.** One `FileExtraction` per input file, in input order. A thrown `Error` becomes its `message`; any
  other thrown value becomes `String(value)`. `extractBatch` never throws for a per-file failure.
- **indexCommit.** Calls `this.codeGraph.extractBatch(files)` once, with every file the call received, and no longer
  calls `parseSourceFile` or `extractSymbols` itself. Everything else stays as today:
  - `filesToReplace`, so a failing file's old symbols are still deleted
  - `fileErrors`, `filesIndexed` and `logger.warn` per failing file
  - symbol id assignment, `resolveRelationships`, the transaction and `onIndexed`

### Integration

Read only (unchanged, verified 2026-11-27 at `5a23ffd6a`):

```ts
// apps/api/src/code-intel/code-graph.service.ts
export interface ParsedSourceFile { path: string; content: string; ast: SourceFile }   // ts-morph SourceFile
export interface ExtractedSymbol { name: string; kind: 'class' | 'method' | 'function' | 'interface' | 'enum';
  file: string; startLine: number; endLine: number; signature?: string; callers: string[]; callees: string[];
  docComment?: string }
extractSymbols(parsed: ParsedSourceFile): ExtractedSymbol[]
resolveRelationships(symbols: ResolvedSymbol[]): void

// apps/api/src/code-intel/ast-index.service.ts
export interface SourceFile { path: string; content: string }
```

Changed. The baseline only locates the code; implement the target.

- `CodeGraphService.parseSourceFile`
  - Baseline: `parseSourceFile(path: string, content: string): ParsedSourceFile`. Builds a fresh project and rejects
    on `getPreEmitDiagnostics()` errors with codes 1000-1999.
  - Target: same signature, still a fresh project per call, rejection rule as in "Calls made in this spec".
- `CodeGraphService.extractBatch` (new, exported through the class):
  ```ts
  export type FileExtraction =
    | { path: string; symbols: ExtractedSymbol[] }
    | { path: string; error: string };

  extractBatch(files: ReadonlyArray<{ path: string; content: string }>): FileExtraction[]
  ```
- `AstIndexService.indexCommit` (the US-002 test stubs give `extractBatch` a default of one symbols result per file,
  or `[]` for an empty list, never a bare `vi.fn()` that returns `undefined`)
  - Baseline: a per-file loop that calls `parseSourceFile` and then `extractSymbols`, each inside its own try/catch.
  - Target: the signature is unchanged, `(repoId, commitHash, files, projectId, onIndexed?) =>
    Promise<SymbolIndexResult>`. One `extractBatch(files)` call, and the loop walks its results.

Patterns to follow: the existing `code-graph.service.spec.ts` builds `new CodeGraphService()` directly with no DI.
`ast-index.project-scope.spec.ts` builds `AstIndexService` with plain object stubs and a pass-through transaction
manager. Tests use Vitest (`vi.*`).

### Failure Handling

| Case | Behaviour |
|---|---|
| File with a syntactic error (`export function broken( {`) | result `{ path, error }`, error starts with `Parse error: ` and includes `'}' expected` |
| File with only semantic errors (`const n: number = 'x';`) | extracted normally, no error |
| File with a decorated constructor parameter | extracted normally, no error |
| `extractSymbols` throws an `Error` for one file | result `{ path, error: <message> }`; later files in the batch still extract |
| `extractSymbols` throws a non-Error value | result `{ path, error: String(value) }` |
| Same path twice in one batch | two results; each holds the symbols of its own content |
| Empty `files` | returns `[]` |
| `indexCommit` receives an error result | path in `fileErrors` and `filesToReplace`, not counted in `filesIndexed` |

## Out of Scope

- Filtering non-TypeScript paths: `changedFiles` from a push includes `.md`, `.json` and other files, and they still go through the parser as today.
- The known `TypeError` in `extractSymbols` for top-level arrow-function variables (ts-morph `VariableDeclaration` has no `getJsDocs`, documented in `code-graph.service.spec.ts`): it is not fixed here and surfaces as an error result.
- Cross-file type resolution inside a batch: files stay isolated on purpose, so signatures do not change.
- Changing the in-memory project's compiler options (for example `experimentalDecorators`): syntax-only rejection makes it unnecessary.
- Backfilling symbols for files rejected before this change: each file is indexed again on the next commit that touches it.
- A resident or service-wide shared project, worker threads, or parallel extraction.
- A Rust or Oxc based extractor.
- Removing `parseSourceFile` from `CodeGraphService`: it stays public, with the new rejection rule.
- Memory or timing assertions in tests: the measurements above are evidence, not acceptance criteria.

## Stories

Two stories in one package: the new batch capability and the decorator fix first, then the switch of `indexCommit` to it.

**US-001: Batch extraction and syntax-only rejection.** Workdir: `apps/api`. No dependencies.
`CodeGraphService` gains `extractBatch` and the `FileExtraction` type. `parseSourceFile` and `extractBatch` reject
only on syntactic diagnostics.

**US-002: indexCommit uses extractBatch.** Workdir: `apps/api`. Depends on US-001.
`AstIndexService.indexCommit` replaces its per-file parse loop with one `extractBatch` call and maps the results onto
the existing result, error and replace handling.

### Context Files

**US-001**
- `apps/api/src/code-intel/code-graph.service.ts` — the service being changed
- `apps/api/src/code-intel/code-graph.service.spec.ts` — existing tests and the known arrow-function `TypeError` case

**US-002**
- `apps/api/src/code-intel/ast-index.service.ts` — `indexCommit` being changed
- `apps/api/src/code-intel/code-graph.service.ts` — `extractBatch` and `FileExtraction`, created by US-001, consumed here
- `apps/api/src/code-intel/ast-index.project-scope.spec.ts` — the stub pattern to follow

### Creates

**US-001**
- `apps/api/src/code-intel/code-graph.batch.spec.ts` — tests for `extractBatch` and the rejection rule

**US-002**
- `apps/api/src/code-intel/ast-index.batch.spec.ts` — tests for `indexCommit` over `extractBatch`

### Modifies

US-001 changes no existing test: `code-graph.service.spec.ts` keeps passing (`const = ;` is still a syntactic error).

**US-002**
- `apps/api/src/code-intel/ast-index.service.spec.ts` — its `indexCommit()` cases stub `codeGraph.parseSourceFile` and `codeGraph.extractSymbols` and assert `parseSourceFile` was called with the file's path and content and `extractSymbols` with the parsed value; they switch to stubbing `codeGraph.extractBatch` with `FileExtraction` results. A thrown parse becomes an `{ path, error }` result, and the non-Error case asserts the result's error string is passed through to `fileErrors`. The replacing invariants are US-002 AC-1 to AC-4.
- `apps/api/src/code-intel/ast-index.project-scope.spec.ts` — its `graph` stub's `parseSourceFile` and `extractSymbols` mocks are replaced by an `extractBatch` mock returning one symbols result per file, and the "fails to parse" case returns an error result for the broken file carrying the message `parse error`; the delete-before-upsert order and project-scoped id assertions stay unchanged.
- `apps/api/test/unit/ast-index.service.unit.spec.ts` — its `mockCodeGraph.parseSourceFile` and `mockCodeGraph.extractSymbols` stubs and their call assertions (AC-5 "only the specified file should be parsed", AC-10 per-file parser failure) switch to an `extractBatch` stub. AC-5 asserts `extractBatch` was called once with exactly that file; AC-10 returns an error result for one file and symbols for the others. The replacing invariants are US-002 AC-1 and AC-3.

### Seams

- US-002 consumes `extractBatch` (US-001). US-002 AC-1 stubs `extractBatch` and drives `AstIndexService.indexCommit`, the
  method `CodeCommitOutboxHandler.process` already calls after fetching commit files; no wiring sits between
  `indexCommit` and `extractBatch`. US-002 AC-6 runs `indexCommit` over a real `CodeGraphService`, which proves the
  decorator fix reaches the stored symbols.

## Acceptance Criteria

### US-001

- AC-1 [unit] `new CodeGraphService().parseSourceFile('src/svc.ts', content)`, where `content` declares `class Svc { constructor(@Inject('X') private readonly x: string) {} }` with a declared `function Inject(_t: string): ParameterDecorator`, returns a `ParsedSourceFile` with `path` `'src/svc.ts'` instead of throwing.
- AC-2 [unit] `extractBatch([{ path: 'src/svc.ts', content }])`, with the AC-1 content plus a method `run(): number { return 1; }` on `Svc`, returns one result whose `symbols` include a `class` named `Svc` and a `method` named `Svc.run`.
- AC-3 [unit] `extractBatch([{ path: 'src/broken.ts', content: 'export function broken( {' }])` returns one result with `path` `'src/broken.ts'` and an `error` that starts with `Parse error: ` and contains `'}' expected`.
- AC-4 [unit] `extractBatch([{ path: 'src/typed.ts', content: "export const n: number = 'x';\nexport function f(a: number): number { return a; }" }])` returns a `symbols` result containing the function `f`, not an `error`.
- AC-5 [unit] `extractBatch` over three files `src/a.ts` (valid), `src/b.ts` (`export function broken( {`) and `src/c.ts` (valid) returns three results with paths `['src/a.ts', 'src/b.ts', 'src/c.ts']` in that order, an `error` for `src/b.ts` and `symbols` for the other two.
- AC-6 [unit] For a batch of `src/a.ts` (`export interface Foo { id: string }`) followed by `src/b.ts` (`import { Foo } from './a';\nexport function use(f: Foo): void {}`), the `signature` of `use` in the `src/b.ts` result equals the `signature` of `use` from `extractBatch([{ path: 'src/b.ts', content: <same b content> }])` run alone.
- AC-7 [unit] For a fixture holding a class with one method, a function, an interface and an enum, `extractBatch([{ path, content }])[0].symbols` deep-equals `extractSymbols(parseSourceFile(path, content))` for the same `path` and `content`.
- AC-8 [unit] With the ts-morph `Project` constructor spied so it still builds real projects, one `extractBatch` call over three valid files constructs `Project` exactly once.
- AC-9 [unit] With the same `Project` spy, two consecutive `extractBatch` calls of one valid file each construct `Project` twice in total.
- AC-10 [unit] `extractBatch` over `src/arrow.ts` (`const myArrow = () => 42;`), which makes `extractSymbols` throw a `TypeError`, followed by a valid `src/ok.ts`, returns an `error` result carrying that `TypeError`'s message for `src/arrow.ts` and a `symbols` result for `src/ok.ts`.
- AC-11 [unit] With `extractSymbols` spied to throw the string `'boom'` once, `extractBatch([{ path: 'src/a.ts', content: 'export function a() {}' }])` returns `[{ path: 'src/a.ts', error: 'boom' }]`.
- AC-12 [unit] `extractBatch` with the same path `src/dup.ts` twice, first declaring `function one() {}` and then `function two() {}`, returns two results: the first holds only the function `one`, the second only the function `two`.
- AC-13 [unit] `extractBatch([])` returns an empty array.

### US-002

- AC-1 [unit] With `codeGraph.extractBatch` stubbed to return one `symbols` result per file, `indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'A' }, { path: 'src/b.ts', content: 'B' }], 'proj-1')` calls `extractBatch` exactly once, with those two files in that order.
- AC-2 [unit] In the AC-1 setup, `indexCommit` never calls `codeGraph.parseSourceFile`.
- AC-3 [unit] With `extractBatch` returning `[{ path: 'src/a.ts', symbols: [<function alpha>] }, { path: 'src/b.ts', error: 'Parse error: x' }]`, `indexCommit` returns `filesIndexed` `1` and `fileErrors` `[{ path: 'src/b.ts', error: 'Parse error: x' }]`, and calls `symbolStore.deleteByFile` for both `src/a.ts` and `src/b.ts`.
- AC-4 [unit] In the AC-3 setup, `symbolStore.upsertSymbol` is called once, with `id` `'proj-1:acme/widgets:src/a.ts::alpha'`.
- AC-5 [unit] In the AC-3 setup, the service's `logger.warn` is called exactly once, with a message that names `src/b.ts`.
- AC-6 [unit] With a real `CodeGraphService`, a stub `SymbolStore` and a pass-through transaction manager, `indexCommit` over one file declaring `class Svc { constructor(@Inject('X') private readonly x: string) {} run(): number { return 1; } }` (with a declared `function Inject(_t: string): ParameterDecorator`) returns empty `fileErrors` and calls `upsertSymbol` for the symbols named `Svc` and `Svc.run`.
