# PRD fidelity: permissions-p2-context-guard

Spec `a7af7293`, PRD from `nax plan --profile native-codex-ds` (2026-10-24), reviewed by a fresh reviewer (spec-review Phase 9).

**Verdict:** PASS after patches. No blockers.

**What survived planning unchanged:**
- All 61 spec ACs, with identifiers intact.
- Dependencies and workdirs.
- `outOfScope`: the 14 bullets.
- `modifiedFiles`: 0/0/1/0/34/38/36/30/23/33 per story, with full reasons.
- The conversion rules (actor table, narrowest scope, sentinel, production gap), present in US-005 to US-010.

## Patches applied to prd.json

1. US-001 AC9 asserted both the error type and its message. It is reverted to "rejects with an error whose message is …", as the spec writes it (the type is AC6). This keeps US-001 at 15 ACs with none of them compound.
2. Deleted the duplicate sentinel ACs (the planner-added "the unproxied client rejects `$executeRaw` SELECT 1 …") in US-005, US-006, US-007, US-009 and US-010. Each restated US-004's `expectGuardActive` contract.
3. US-007 AC4 had gained a new assertion on the returned live event. It is reworded to the spec's intent: `onJobEnded` runs inside the job's RUNNER context with the guard active. The saved-session assertion stays in its own AC.
4. US-005's description Scope list was missing `assistant-actions-propose.integration.spec.ts`, which is in `modifiedFiles`. It is restored.

## Planner additions kept

All of these are faithful to the spec:
- US-001 AC15: record mode resolves to the query's result.
- US-003 AC8: markRetry returns the row to `pending`.
- US-003 AC9: the fan-out still rejects with `OutboxFanOutError`.
- US-007: the saved-session AC.

## Noted, not changed

- The conversion stories' production-gap rule (rule 6) lets a story edit a production entry. No `modifiedFiles` entry authorises a production file for those stories. This comes from the spec, and two spec-review passes accepted it.

Final AC counts: 15/7/9/13/3/2/6/3/3/4.
