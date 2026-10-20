# PRD Fidelity Report — permissions-p1-enforce-fleet

**Spec:** `.nax/features/permissions-p1-enforce-fleet/spec.md` · **PRD:** `prd.json` (nax plan `--profile cross-agent`, 2026-10-20, then two hand edits, see below)
**Reviewed at:** `7c2a49d3` · **Phase:** spec-review Phase 9 (inline)
**Verdict:** ✅ PASS — 0 blockers, 0 majors, 3 minors

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC → PRD AC mapping | 104 spec ACs over 8 stories → 168 PRD ACs (every PRD AC carries a `spec AC-N` provenance tag except 5 failure-contract ACs) | every spec AC mapped, none missing |
| 2. Behavioural fidelity | the compound splits read in full for US-001 (23) and US-005 (26); the call shapes of `FleetJobsService.cancel`, `SchedulesService.create`, `ConfigJobsService.submitDrift`, `FleetJobOutcomeRecorder.onTerminal`, `PrAttributionService.attribute` checked against the real signatures | no degradation, no file-content ACs, signatures match |
| 3. Orphan PRD ACs | 5 untagged `[failure contract]` ACs | each traces to a spec Failure Handling row and agrees with it; no new scope |
| 3b. Dependency fidelity | 8 stories | dependency sets and workdirs identical |
| 4a. Creates → expectedFiles | 5 spec paths (US-001, US-002) | all present; no self-created file in `contextFiles` |
| 4b/c. Context Files → contextFiles | 39 spec paths | all present (US-003..US-008 keep `requires.guard.ts`, which already exists) |
| 5. Meta-AC survival | 0 meta-ACs in spec | n/a |
| 5c. PRD-AC satisfiability (invocation ACs over existing endpoints) | 4: `onTerminal` → failure comment `events.record`; `cancel` (QUEUED) → `transitions.apply` → `activity.record`; `ScheduleTicker.runOnce` → `dispatchFresh`; `POST …/fleet/jobs` RUN → `onRunDispatched` | all paths exist |
| 6. Out-of-scope preservation | 17 spec bullets → 18 PRD entries | all 17 present, none inverted into an AC, story `Scope — Out:` bullets list only cross-story boundaries (no contradiction); `US-003 only:` / `US-005 only:` prefixes kept |
| 7. Terminal cleanup | no cleanup story in spec | n/a |
| 8. Modifies → modifiedFiles (by path) | 17 paths | all present, each with its own reason, no comma-led reason |
| 9. Forward-reference drift | 14 new symbols (`runWithActor`, `currentActor`, `actorTypeFor`, `ActionContextInterceptor`, `ActionContextModule`, `projectIdsWithKey`, `findAccessibleProjectIds`, `countPendingAllProjects`, `startForDispatch`, `responsibleUserOf`, `findAgentDisplayName`, `FleetJobOutcomeRecorder`, `fleet.approvalSelfDecide`, `fleet.activity.read` scope) | spelled identically everywhere |

## Hand edits to the planned PRD (recorded)

1. Removed 4 planner-added `[failure contract]` ACs about a runner principal (US-004, US-006, US-008 ×2): the spec puts a runner test out of scope, and their outcome on project routes is unverified (166 ACs).
2. Security ruling (user, 2026-10-20): US-006 AC 2 now names a job requested by a user, two ACs pin `fleet.approvalSelfDecide` (spec AC 15), and the story description carries the rule and its i18n messages (168 ACs).

## Minors

1. **Planner-added test files in `expectedFiles`** (US-001: 4, US-002: 3), e.g. `apps/api/test/integration/permissions/enforce-fleet-foundations.integration.spec.ts`. Helpful create hints; not in the spec's Creates. No action.
2. **One orphan out-of-scope entry**: "What P2 adds later (out of scope here): on-behalf-of, the approval block, …" was lifted from Design prose. It repeats the spec's P2 bullet and contradicts no AC. No action.
3. **AC sizes above `maxAcCount` 15** after splitting: US-001 23, US-002 15, US-003 23, US-004 20, US-005 26, US-006 27, US-007 14, US-008 20. The gate warns only (precedent: enforce-core PR #313). No action.

## Ready

The PRD faithfully carries the spec. Next: `bun run test:db:up` in `apps/api`, then `nax run -f permissions-p1-enforce-fleet`.
