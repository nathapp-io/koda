# PRD Fidelity Report: fleet-knowledge-embed-and-run-progress

**Spec:** `spec.md` (`c8a1a82f`)
**PRD:** `prd.json`, planned with `--profile cross-agent,cc-plan`. Modifies reasons repaired by hand in `3c3a21ad`.
**Date:** 2026-10-16
**Phase:** spec-review Phase 9
**Verdict:** ready. 0 blockers, 0 majors, 2 minors. The one major found was fixed before this report.

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC to PRD AC | 64 spec ACs, 64 PRD ACs | 64/64 matched after normalisation, 0 missing |
| 2. Behavioural fidelity | 64 ACs | 0 degraded, 0 file-content/grep ACs, same symbols, inputs and outputs |
| 3. Orphan PRD ACs | 64 | 0 |
| 3b. Dependency fidelity | 6 stories | 6/6 sets equal (US-004 and US-005 depend on US-003; the rest have none) |
| 4a. Creates to expectedFiles | 3 files (US-006) | 3/3 in `expectedFiles`, 0 self-created files in `contextFiles` |
| 4b. Context Files to contextFiles | 27 entries | 27/27 present and on disk |
| 4c. Upstream-produced reads | 0 | n/a. No cross-story produced files. |
| 4d. Planner additions | 1 | minor: US-006 also reads `apps/web/tests/components/fleet-job-stories.spec.ts`, an existing harness it modifies |
| 5. Meta-AC survival | 0 meta-ACs | n/a |
| 5b. Correction survival | 13 review corrections | 13/13 in a `description` or an AC, none only in `analysis` |
| 5c. PRD-AC satisfiability | 3 invocation ACs: US-004 `Watcher.tick` to `sink.snapshot`; US-003 sync route to stored `postRun`; US-002 indexer to `embedBatch`/`embed` | paths exist, no guard outside the fixtures |
| 6a-e. Out of scope | 14 spec bullets, 14 `prd.outOfScope` | 14/14, 0 orphans, 0 inverted into ACs; the 2 story deferrals keep their `US-00N only:` prefix |
| 7. Terminal cleanup | none in spec | n/a |
| 8. Modifies to modifiedFiles | 21 distinct paths | 21/21 have an entry; see Finding F1 |
| 9. Forward-reference drift | 6 new symbols | each spelled one way: `KNOWN_PHASES`, `phaseLabelKey`, `KNOWLEDGE_EMBED_BATCH`, `EMBED_REQUEST_TIMEOUT_MS`, `FILE_EMBED_DEADLINE_MS`, `workflowStep` |

## Findings

### F1. Major, fixed: merged Modifies reasons dropped the second authorisation

- The spec has two bullets per file in two places: US-001 `markdown-chunker.spec.ts` (AC-9 paragraph test, AC-9 heading-glue test) and US-002 `knowledge-repo-indexer.spec.ts` (`fixture()`, AC-6).
- `nax plan` merged each pair into one `modifiedFiles` entry and kept only the first reason. That left the heading-glue test change and the AC-6 test change unauthorised.
- **Fix applied:** both reasons joined into the entry (`... Also: ...`). Only `modifiedFiles[].reason` changed.
- **Planner trap:** a spec should write one bullet per file, with all reasons in that one bullet.

### F2. Minor: AC text normalised

The planner dropped the backticks around each AC's leading symbol name, and turned four-backtick code spans into ```` ```ts ````. The assertions, inputs and expected values are unchanged.

### F3. Minor: one `suggestedCriteria` entry per story

All six follow from the spec. Each is a narrower case of a stated rule: a tilde fence, a retry vector of the wrong length, the OpenAPI `maxLength`, `current` without `phase`, an omitted `workflow`, and an empty phase string. None adds scope.

## Spec AC to PRD destination

Every spec AC `US-00N` #k maps to PRD `userStories[US-00N].acceptanceCriteria[k-1]`, in the same order:
US-001 13, US-002 12, US-003 8, US-004 10, US-005 13, US-006 8.
