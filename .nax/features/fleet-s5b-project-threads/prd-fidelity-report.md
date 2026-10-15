# PRD Fidelity Report — fleet-s5b-project-threads

**Spec:** `.nax/features/fleet-s5b-project-threads/spec.md` · **PRD:** `prd.json` (nax plan `--profile cross-agent`, plan model `openai-codex/gpt-6.1-sol[high]`, refine)
**Reviewed against:** koda `feat/fleet-s5b-project-threads` at `ce596b77` · **Date:** 2026-10-15
**Phase run:** 9 (PRD fidelity). Phases 1-8 ran twice during spec-writing (fresh reviewers, pass 1 + pass 2; all findings fixed).
**Verdict:** ✅ ready — 0 blockers, 0 majors, 3 minors.

## Summary (evidence)

| Check | Examined | Result |
|:--|:--|:--|
| 1-2 Spec AC → PRD AC, behavioural fidelity | 92 spec ACs / 92 PRD ACs, ordinal match per story | 90 verbatim (backticks stripped by the planner), 1 trailing-punctuation change, 1 clarifier appended; 0 degraded, 0 grep-style |
| 2 Signature reality | invocation ACs naming existing signatures: `parseCapabilitiesCore`, `RunnerSummaryDto.from`, `jobGateKeys`, `parseAssign`, `firstMisfit`, `findThreadAssign` | arities and argument shapes match the spec and the code |
| 3 Orphan PRD ACs | 92 | 0 |
| 3b Dependency fidelity | 7 stories | sets identical: US-001 [], US-002 [US-001], US-003 [US-002], US-004 [US-003], US-005 [US-004], US-006 [US-001], US-007 [US-003] |
| 4a Creates → expectedFiles | 7 spec Creates paths | all in the owning story's `expectedFiles`; no self-created file in `contextFiles` |
| 4b/4c Context Files → contextFiles | 34 spec entries | all present; all exist on disk (no upstream-produced reads in this spec) |
| 4d Planner additions | 2 | minor (below) |
| 5 Meta-AC survival | 0 meta-ACs in the spec | n/a |
| 5b Correction survival | 32 locus tokens for the review-round corrections (repoThreadFields, jobGateKeys widening, costEventData id, placeJob + fillRunnerThreads kind, full ThreadToolContext, superRefine paths, sendRefusalOf kind, ...), searched in each owning story's `description` and ACs | 32/32 present outside `analysis` |
| 5c PRD-AC satisfiability | 4 invocation ACs over existing endpoints (US-004 #1-#3 via `POST .../messages` → `createThreadJob`; US-005 #6 via the send → `PlacementService.placeJob`; US-005 #7 via `POST /api/fleet/runner/sync` → `fillRunnerThreads`) | paths exist; no enabling flag beyond `FLEET_THREADS_ENABLED`, which the existing thread suites already set |
| 6 Out-of-scope preservation | 13 spec bullets / 13 `prd.outOfScope` | all present, none inverted into an AC, none contradicted; the one story-scoped hoist carries `US-004 only:` |
| 7 Terminal-cleanup story | none in the spec | n/a |
| 8 Modifies → modifiedFiles (by path) | 20 spec paths / 20 entries | 1:1 per story, every `reason` populated, none starts mid-sentence |
| 9 Forward-reference drift | 12 new symbols (`ChatThreadKind`, `CHAT_THREAD_KINDS`, `repoThreadFields`, `findAnchor`, `anchorRepoFor`, `buildProjectThreadInstructions`, `buildProjectThreadTools`, `threadScratchDir`, `projectThreads`, `project_threads`, `notRepoThread` / `noFleetRepo`) | one spelling each; the only bare `ThreadKind` is the 1a-R6 ruling text that names the rejected spelling |

## Minor findings

1. **US-004 AC #7 clarifier.** The PRD appends "where <description> is that skill's description" to the `buildProjectThreadInstructions` skill-line AC. It narrows nothing the spec meant (`buildThreadInstructions` renders `skill.description`); accept.
2. **US-003 `expectedFiles` gains `apps/api/src/fleet/threads/thread-input.spec.ts`.** The file does not exist yet; it is the natural home for US-003's eight `validateCreateThread` unit ACs. Helpful addition; accept.
3. **US-004 `contextFiles` gains `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts`** (exists; holds `findAnchor`, whose rule `anchorRepoFor` repeats). Helpful context (§4d); accept.

No PRD patch needed.

## AC map

| Spec AC | PRD AC | Status |
|:--|:--|:--|
| US-001 #1 | US-001 #1 | verbatim |
| US-001 #2 | US-001 #2 | verbatim |
| US-001 #3 | US-001 #3 | verbatim |
| US-001 #4 | US-001 #4 | verbatim |
| US-001 #5 | US-001 #5 | verbatim |
| US-001 #6 | US-001 #6 | verbatim |
| US-001 #7 | US-001 #7 | verbatim |
| US-002 #1 | US-002 #1 | verbatim |
| US-002 #2 | US-002 #2 | verbatim |
| US-002 #3 | US-002 #3 | verbatim |
| US-002 #4 | US-002 #4 | verbatim |
| US-002 #5 | US-002 #5 | verbatim |
| US-002 #6 | US-002 #6 | verbatim |
| US-002 #7 | US-002 #7 | verbatim |
| US-002 #8 | US-002 #8 | verbatim |
| US-002 #9 | US-002 #9 | verbatim |
| US-002 #10 | US-002 #10 | verbatim |
| US-002 #11 | US-002 #11 | verbatim |
| US-002 #12 | US-002 #12 | verbatim |
| US-002 #13 | US-002 #13 | verbatim |
| US-002 #14 | US-002 #14 | verbatim |
| US-002 #15 | US-002 #15 | verbatim |
| US-003 #1 | US-003 #1 | verbatim |
| US-003 #2 | US-003 #2 | verbatim |
| US-003 #3 | US-003 #3 | verbatim |
| US-003 #4 | US-003 #4 | verbatim |
| US-003 #5 | US-003 #5 | verbatim |
| US-003 #6 | US-003 #6 | verbatim |
| US-003 #7 | US-003 #7 | verbatim |
| US-003 #8 | US-003 #8 | verbatim |
| US-003 #9 | US-003 #9 | verbatim |
| US-003 #10 | US-003 #10 | verbatim |
| US-003 #11 | US-003 #11 | verbatim |
| US-003 #12 | US-003 #12 | verbatim |
| US-003 #13 | US-003 #13 | verbatim |
| US-003 #14 | US-003 #14 | verbatim |
| US-004 #1 | US-004 #1 | verbatim |
| US-004 #2 | US-004 #2 | verbatim |
| US-004 #3 | US-004 #3 | verbatim |
| US-004 #4 | US-004 #4 | verbatim |
| US-004 #5 | US-004 #5 | verbatim |
| US-004 #6 | US-004 #6 | verbatim |
| US-004 #7 | US-004 #7 | verbatim + clarifier |
| US-004 #8 | US-004 #8 | verbatim |
| US-004 #9 | US-004 #9 | verbatim |
| US-004 #10 | US-004 #10 | verbatim |
| US-004 #11 | US-004 #11 | verbatim |
| US-004 #12 | US-004 #12 | verbatim |
| US-004 #13 | US-004 #13 | verbatim |
| US-004 #14 | US-004 #14 | verbatim |
| US-005 #1 | US-005 #1 | verbatim |
| US-005 #2 | US-005 #2 | verbatim |
| US-005 #3 | US-005 #3 | verbatim |
| US-005 #4 | US-005 #4 | verbatim |
| US-005 #5 | US-005 #5 | verbatim |
| US-005 #6 | US-005 #6 | verbatim |
| US-005 #7 | US-005 #7 | verbatim |
| US-005 #8 | US-005 #8 | verbatim |
| US-005 #9 | US-005 #9 | verbatim |
| US-005 #10 | US-005 #10 | verbatim |
| US-005 #11 | US-005 #11 | verbatim |
| US-005 #12 | US-005 #12 | verbatim |
| US-005 #13 | US-005 #13 | verbatim |
| US-006 #1 | US-006 #1 | verbatim |
| US-006 #2 | US-006 #2 | verbatim |
| US-006 #3 | US-006 #3 | verbatim |
| US-006 #4 | US-006 #4 | verbatim |
| US-006 #5 | US-006 #5 | verbatim |
| US-006 #6 | US-006 #6 | verbatim |
| US-006 #7 | US-006 #7 | verbatim |
| US-006 #8 | US-006 #8 | verbatim |
| US-006 #9 | US-006 #9 | verbatim |
| US-006 #10 | US-006 #10 | verbatim |
| US-006 #11 | US-006 #11 | verbatim |
| US-006 #12 | US-006 #12 | verbatim |
| US-006 #13 | US-006 #13 | verbatim |
| US-006 #14 | US-006 #14 | verbatim |
| US-007 #1 | US-007 #1 | verbatim |
| US-007 #2 | US-007 #2 | verbatim |
| US-007 #3 | US-007 #3 | verbatim |
| US-007 #4 | US-007 #4 | verbatim |
| US-007 #5 | US-007 #5 | verbatim |
| US-007 #6 | US-007 #6 | verbatim |
| US-007 #7 | US-007 #7 | verbatim |
| US-007 #8 | US-007 #8 | verbatim |
| US-007 #9 | US-007 #9 | verbatim |
| US-007 #10 | US-007 #10 | verbatim |
| US-007 #11 | US-007 #11 | verbatim |
| US-007 #12 | US-007 #12 | verbatim |
| US-007 #13 | US-007 #13 | verbatim |
| US-007 #14 | US-007 #14 | verbatim |
| US-007 #15 | US-007 #15 | verbatim |
