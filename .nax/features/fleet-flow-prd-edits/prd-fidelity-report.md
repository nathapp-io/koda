# Spec Review (Phase 9 only) - fleet-flow-prd-edits
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Spec:** .nax/features/fleet-flow-prd-edits/spec.md (76eef8f4, 11 stories, 115 spec ACs)
**PRD:** prd.json (pre-edit snapshot: scratchpad/prd-edits-prd.pre-phase9.json)
**Verdict:** READY-WITH-EDITS

## Summary (Phase 9)
- Spec AC -> PRD AC: 115 of 115 spec ACs matched (US-001..US-011, one-to-one by index, wording only tightened). 0 missing, 0 degraded to grep/file assertions.
- Dependencies: 11 of 11 stories match as sets. Workdirs: 11 of 11 `apps/api`.
- File roles: Creates -> expectedFiles 8 of 8 stories with Creates; 0 self-created files in contextFiles. Upstream-produced contextFiles kept (flow-prd-edits.ts in US-002/003/007/008; fleet-flow-advance-prd-edits.spec.ts in US-010): correct, not findings. Modifies -> modifiedFiles: 19 of 19 paths, one entry each, reasons verbatim (checked by string equality).
- Out of scope: 11 of 11 present in `prd.outOfScope`; none inverted into an AC; no per-story deferral (no `US-00N only:` prefix needed).
- Corrections surviving in description/AC (not analysis): rule 2 absent count -> PLAN (US-006 description + AC3); rule 4 apply_prd_edits in US-010 (description + AC1/AC2); 6000 bytes (US-004 instruction text); truncateFlowText (US-010 description, AC9); `text too long` (US-003 AC7); resultBranch seed on AC-10 verdicts (US-010 Modifies reason).
- Signature reality: PRD ACs naming `apply` (US-007 AC13, US-008 AC11) match code (`{kind:'committed', specSha}`, `'spec write refused'`); `isSingleFileCommit(token, owner, name, base, head, path)` and `putFile(... content: Buffer ...)` match.
- Forward-reference re-sweep: 17 distinct PrdEdit-family symbols across PRD ACs/descriptions; no near-miss spelling variants.
- Meta-ACs: none in spec. Terminal cleanup story: none.

## Edits (prd.json, acceptanceCriteria only)
Signature diff vs snapshot (workdir, dependencies, contextFiles, modifiedFiles, expectedFiles, outOfScope, description for all 11 stories): identical. Only US-004 and US-010 `acceptanceCriteria` moved.

Final AC counts: [12, 14, 12, 11, 6, 10, 13, 11, 9, 15, 9] (spec: [12,14,11,11,6,9,11,10,8,15,8]).

1. US-010 (25 -> 15, gate 15). The spec has exactly 15 ACs, so every planner-added AC had to fold into a spec AC or go.
   - Merged PRD AC16 into AC8 (unchanged outcome also calls recordPrdEdits).
   - Merged PRD AC25 into AC7 (non-empty refusal list recorded unchanged in `refused`).
   - Merged PRD AC17+AC18 into AC12 (planner split of one condition: stopped or re-asked -> no record, no activity).
   - Removed PRD AC19, AC20 (retry outcome records nothing; obligation stays in description "retry -> nothing").
   - Removed PRD AC21 (thread-entry keeps stop; restates the unchanged rule, in description and US-004/006 scope).
   - Removed PRD AC22 (ambiguous finding -> wait_answer: spec says the ambiguity rule is unchanged).
   - Removed PRD AC23, AC24 (answered ambiguous second round -> re-plan; see unfixed finding 1).
2. US-004 (13 -> 11). Removed PRD AC12 and AC13: planner-added decideFlowStep checks (malformed prdEdits; cut `{"findings"` prefix -> verdict_unreadable) whose test would live in flow-step-decision.spec.ts, which US-004 neither modifies nor creates (unauthorised-test-file deadlock; the file belongs to US-006). Malformed prdEdits remains covered by spec AC3 (parser seam) and US-011 AC9 (ticker); the cut-prefix row is unchanged existing behaviour kept in the US-004 description.

## Findings NOT fixed
1. (Minor, spec-level) Rule 4's `hasCurrentAnswers` branch (answered question re-plans in a second PRD round) has no spec AC; the planner covered it in PRD AC23/AC24, which I removed to meet the cap (US-010 spec is already at 15). The behaviour remains in the US-010 description (`replan = planCount < 2 || hasCurrentAnswers`, existing code at flow-step-decision.ts:143-149). Fix by moving it into a spec AC in a story with room, or accept it unpinned.
2. (Minor) Planner-added non-spec ACs left in place, all in authorised files and accurate: US-003 AC12 (append to existing contextFiles), US-006 AC10 (21 findings stops; restates US-010 AC3), US-007 AC13 and US-008 AC11 (regression guards on existing `apply`), US-009 AC9 (FAILED SPEC_REVIEW -> step_failed), US-011 AC9 (malformed prdEdits through the ticker).
3. (Minor, helpful additions) Extra existing contextFiles beyond the spec in US-004, US-007, US-008, US-011 (e.g. flow-verdict.spec.ts, flow-calls.ts, fleet-flow.ticker.ts, test-environment.ts). Not findings per check 4d.
4. (Note) `analysis` is not evidence; no correction relied on it.
