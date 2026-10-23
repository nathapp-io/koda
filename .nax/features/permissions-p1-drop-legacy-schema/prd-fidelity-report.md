# PRD Fidelity — permissions-p1-drop-legacy-schema

**Spec:** `spec.md` at `785c055e` · **PRD:** `prd.json` at `012cb205` (`nax plan --profile native-codex`, then post-plan edits: planner Failure-Handling ACs deleted, per-story Modifies restored from the spec)
**Date:** 2026-10-23
**Verdict:** ready (M1 ruled by the user 2026-10-23: keep the AC)

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC → PRD AC | 51 spec ACs → 58 PRD ACs | 51/51 mapped; 4 compound spec ACs split atomically (US-001 AC-11, US-003 AC-5, AC-7, AC-11) |
| 2. Behavioural fidelity + signature reality | 58 PRD ACs; 6 calls on existing signatures (`setGlobalAdmin`, `findAnyUserAndCreate`, `grantRole`, `fixtureGrantReport`, `findUserActor`, `roleClaim`) | 0 degraded; 0 signature contradictions; 1 orphan file-content AC (M1) |
| 3. Orphan PRD ACs | 7 orphans | 7 planner ACs from Failure Handling deleted post-plan (US-001 2, US-002 3, US-003 2, US-004 1 duplicate of AC-4/5); 3 kept: US-004 AC-9, US-005 AC-3, US-006 AC-1 |
| 3b. Dependencies | 6 stories | sets match: US-001 [], US-002 [US-001], US-003 [US-002], US-004 [US-003], US-005 [], US-006 [] |
| 4. File roles | 26 contextFiles, 8 expectedFiles | every spec `Creates` in its own `expectedFiles`, none in `contextFiles`; every `Context Files` entry present and on disk; no cross-story produced reads |
| 5. Meta-AC / correction survival | 9 spec-review corrections | all reach a `description` or an AC (registration re-read, `setGlobalAdmin` delete-gated revocation, `bumpTokenVersionFailure`, `CreateProjectInviteInput` in the repository row, invite mail `roleName`, plain assignee class, `removeProjectBindings` removal, `useAuth` web change) |
| 5c. PRD-AC satisfiability | 3 invocation-shaped ACs over existing endpoints (US-002 AC-9..11 via `/role-bindings` → `MembershipService`) | all reach the bump through `RoleAdminService` → `MembershipService.createBinding` / `removeBinding` |
| 6. Out of scope | 10 spec bullets → 10 `prd.outOfScope` | all present, none inverted, one `US-002 only:` bullet correctly prefixed |
| 7. Terminal cleanup | US-004 | removals carry the type-check/lint gate note; its ACs are migration-outcome and regression pins, no additive feature work |
| 8. Modifies → modifiedFiles | 107 spec paths (one per bullet) | 107 entries restored by path (5/20/41/41/0/0), each with its spec reason |
| 9. Forward-reference drift | `roleClaim`, `userResponse`, `bumpTokenVersion`, `bumpTokenVersionFailure`, `UserAccountState`, `revokeIfNoGlobalAdmin` | one spelling each across all stories |

## Findings

### Major

**M1. US-006 AC-1 is a planner-added file-content assertion.** `[review] After the deletion, the AuthUser interface declaration in apps/web/composables/useAuth.ts contains no explicit role property.` The spec gives US-006 no ACs (user ruling 2026-10-23: a type-check-only deletion story). The AC is satisfiable and fail-first (the property exists today), but it reads source text rather than behaviour. Options: keep it (nax always has one criterion to check for the story), or delete it to match the ruling exactly (the story then carries zero ACs and only its gate note). Recommendation: keep.

### Minor

- **US-004 AC-9** (planner): `fixtureGrantReport(db, { type: 'USER', id: 'missing-user' })` answers `{ hasGlobalBinding: false, globalProjectRoleBindings: 0 }`. No spec source; it matches the function's existing early return once the legacy fields go. Kept.
- **US-005 AC-3** (planner): `koda auth me` exits 2 when `authControllerMe` rejects. No spec source; it pins existing behaviour (`auth.spec.ts` 'exits non-zero on API error'). Kept.
- **US-001 and US-002 sit at the 15-AC cap.** No headroom if a reviewer later asks for another criterion.

## AC map

| Spec | PRD |
|:--|:--|
| US-001 AC-1..10 | AC-1..10 |
| US-001 AC-11 | AC-11 (rejects), AC-12 (`sign` not called) |
| US-001 AC-12..14 | AC-13..15 |
| US-002 AC-1..15 | AC-1..15 |
| US-003 AC-1..4 | AC-1..4 |
| US-003 AC-5 | AC-5 (201), AC-6 (claim MEMBER) |
| US-003 AC-6 | AC-7 |
| US-003 AC-7 | AC-8 (409), AC-9 (no user) |
| US-003 AC-8..10 | AC-10..12 |
| US-003 AC-11 | AC-13 (binding), AC-14 (tokenVersion) |
| US-003 AC-12 | AC-15 |
| US-004 AC-1..8 | AC-1..8 |
| US-005 AC-1..2 | AC-1..2 |
| — | US-004 AC-9, US-005 AC-3, US-006 AC-1 (orphans, see above) |
