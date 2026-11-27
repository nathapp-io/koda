# Spec Review — .nax/features/indexer-batch-project/spec.md (PRD fidelity)
**Reviewed against:** koda-wk-review-fixes at `c8c457251` (spec `9640cc330`, PRD from `nax plan --profile native-codex-ds`, 2026-11-27)
**Date:** 2026-11-27
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request; they ran before planning, verdict ready)
**Verdict:** ✅ ready

## Summary
- Phase 9: 19 of 19 spec ACs matched to PRD ACs, and 19 of 19 behaviourally faithful.
  - Dependency sets: 2 of 2 stories match.
  - File-role entries: 9 checked (2 expectedFiles, 7 contextFiles).
  - Modifies: 3 of 3 paths have their own `modifiedFiles` entry.
  - Out of scope: 9 of 9 spec exclusions present in `prd.outOfScope`.
  - Spec-review corrections: 4 checked, 4 delivered in a description or an AC.
  - Invocation ACs re-traced: 3.
  - Forward references re-swept: 4 symbols.
  - Findings: 0 blockers, 0 majors, 3 minors.

## Check 1-2: AC mapping and behavioural fidelity

| Spec AC | PRD destination | Drift |
|---|---|---|
| US-001 AC-1..13 | US-001 AC-1..13 (same order) | none. AC-1 fixture made concrete as `declare function Inject(_t: string): ParameterDecorator;`, consistent with the spec's "declared function" |
| US-002 AC-1..6 | US-002 AC-1..6 (same order) | none. AC-3 gained concrete inputs (the `alpha` symbol shape and the `indexCommit` arguments), same assertions |

- No AC was rewritten into a file-content or grep assertion.
- **Signature reality:** `indexCommit` is called with 4 arguments in US-002 AC-1, AC-3 and AC-6, matching the real 5-parameter signature, whose fifth parameter `onIndexed` is optional. `parseSourceFile(path, content)` in US-001 AC-1 and AC-7 matches.
- **Numbering:** the planner warned that ACs cite other ACs by number. These are US-001 AC-2 → AC-1, and US-002 AC-2 → AC-1, AC-4 → AC-3 and AC-5 → AC-3. Numbering is preserved 1:1 inside each story, so every reference resolves.

## Check 3: Orphan PRD ACs
None. Both stories have `suggestedCriteria: none`.

## Check 3b: Dependency fidelity
US-001 `[]` matches "No dependencies.". US-002 `["US-001"]` matches "Depends on US-001.".

## Check 4: File roles
- **4a.** US-001 `expectedFiles` = `code-graph.batch.spec.ts`, and US-002 `expectedFiles` = `ast-index.batch.spec.ts`. Neither appears in its own story's `contextFiles`.
- **4b.** Every spec `Context Files` entry exists on disk and is present in the PRD.
- **4c.** `code-graph.service.ts` is modified by US-001 and kept in US-002's `contextFiles`. That is correct.
- **4d.** The planner added `ast-index.service.spec.ts` and `test/unit/ast-index.service.unit.spec.ts` to US-002's `contextFiles`. These are helpful existing files, and both are also `modifiedFiles` (Minor 2).

## Check 5: Meta-ACs and correction survival
- There are no meta-ACs in the spec.
- The four phase 1-8 corrections reached run-time text:
  1. The try covers create and extract, with the conditional remove in `finally`: in US-001's description.
  2. The `extractBatch` stub default is never `undefined`: in US-002's description.
  3. One `logger.warn` per failing file: US-002 AC-5.
  4. Parse rejections are qualified against the arrow-function `TypeError`: covered by the out-of-scope bullet on every story, and by US-001's "Preserve ... the known top-level arrow-variable TypeError".
- No correction lives only in `analysis`.
- **5c.** Three invocation-shaped ACs were re-traced:
  - US-001 AC-11 spies `extractSymbols`, an existing symbol, called from `extractBatch`, which is new.
  - US-002 AC-1 asserts a call to `extractBatch`, which is new.
  - US-002 AC-2 asserts `parseSourceFile` is never called.

  None has two endpoints that already exist, so no Class B trace applies.

## Check 6: Out of scope
- **6a.** All 9 spec bullets are present verbatim.
- **6c.** None became an AC.
- **6d.** No story contradicts an exclusion. US-002's `**Scope** — Out:` adds one planner exclusion (Minor 3).

## Check 7: Terminal cleanup
Not applicable, because the spec has no removal story.

## Check 8: Modifies
There are 3 spec paths and 3 `modifiedFiles` entries. Each reason opens cleanly, with no swallowed comma path.

## Check 9: Forward-reference re-sweep
These are spelled identically in the spec, both descriptions and every AC:
- `extractBatch`
- `FileExtraction`
- `code-graph.batch.spec.ts`
- `ast-index.batch.spec.ts`

## Minor findings
1. **US-001 description, test implementation paragraph.**
   - Problem: it says a bodyless non-ambient `function Inject(...)` "would introduce an unrelated syntax error". Verified with ts-morph 28, it gives no syntactic diagnostic, only a semantic `TS2391` plus `TS1206`. The rationale is wrong.
   - Why it doesn't matter: the instruction it supports (use `declare function`) is valid and matches the ACs.
   - Fix: none needed before the run.
2. **US-002 `contextFiles`.** It carries two files that are also `modifiedFiles`. This is extra existing context and is harmless.
3. **US-002 `**Scope** — Out:`.** It adds "Changing extractSymbols, outbox/REST wiring, repository schema, or transaction/audit architecture is excluded". This exclusion has no spec source, but it agrees with the spec and blocks no AC.

## Recommendation
Proceed to `nax run -f indexer-batch-project`. No PRD patch or re-plan is needed.
