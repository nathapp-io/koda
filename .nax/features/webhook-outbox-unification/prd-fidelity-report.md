# PRD Fidelity Report — webhook-outbox-unification

**Spec:** `docs/specs/SPEC-webhook-outbox-unification.md` (completed-through-phase-6)
**PRD:** `.nax/features/webhook-outbox-unification/prd.json` (profile: `cross-agent-mm`)
**Date:** 2026-07-06
**Verdict:** ✅ ready — major finding patched into `prd.json`

## Summary

- 19/19 spec ACs mapped 1:1 into PRD `acceptanceCriteria`, all preserved as behavioral runtime tests (Given/When/Then), no degradation into file-content/grep assertions, no dropped arguments.
- Story structure, dependency DAG (US-001 → US-002 → {US-003, US-004}), and `Workdir: apps/api` all preserved exactly.
- `contextFiles`/`expectedFiles` split is correct in every story: no self-created file placed in `contextFiles`; upstream-produced files (e.g. `webhook-delivery.handler.ts` in US-002/US-003) correctly kept in the consumer's `contextFiles`.
- No orphan PRD ACs introducing new scope (no new enum values, status codes, config keys, or validation behavior beyond the spec).
- 1 major finding: a design decision from the spec's Design section didn't carry into any story's Design Notes.
- 2 minor findings: informational only, no action required.

## Phase 9 — PRD Fidelity

### Major — Design Decision #5 (direct instantiation) not carried into any story
**Spec reference:** Design § Design Decisions, item 5 (`docs/specs/SPEC-webhook-outbox-unification.md`): "Unit tests for `WebhookDeliveryHandler` and `WebhookDispatcherService` use direct instantiation... not `Test.createTestingModule`... matching the existing style already used in `outbox-fan-out-registry.spec.ts`."
**PRD reality:** US-001's and US-004's Design Notes carry decisions #1, #2, and #4 verbatim, but decision #5 is absent from both. Since nax story sessions are scoped to their own story's description/contextFiles rather than the full spec, the implementing agent for US-001 (`WebhookDeliveryHandler.handle()` tests) and US-004 (`WebhookDispatcherService.dispatch()` tests) has no signal to avoid `Test.createTestingModule` for these two lifecycle-free classes — exactly the convention violation the spec-review Phase 3 pass caught and fixed in the spec itself.
**Status:** Fixed. Appended the direct-instantiation note to both US-001's and US-004's Design Notes in `prd.json` (2026-07-06). This was a targeted text addition, not a structural `contextFiles`/`expectedFiles` change, so a hand-edit was appropriate rather than a full re-plan. JSON validated after the edit.

### Minor — US-002 splits spec AC10 into two overlapping PRD ACs
**Spec reference:** US-002, AC10 (single AC: DI smoke test resolves `WebhookDeliveryHandler`).
**PRD reality:** US-002 has 2 `acceptanceCriteria`; the second ("...provides only a mocked `PrismaWebhookRepository` and no database-backed Prisma provider... does not throw") asserts the same outcome as the first (resolves without throwing / is defined) with no new behavior — it emphasizes "no DB provider" but doesn't test anything AC1 doesn't already cover.
**Recommended fix:** No action required — redundant, not incorrect. Could be merged back to one AC if the user wants a leaner PRD, but doesn't introduce drift or scope bleed.

### Minor — Extra existing files added to `contextFiles` in US-003 and US-004
**Spec reference:** US-003 Context Files (4 files), US-004 Context Files (3 files).
**PRD reality:** US-003's `contextFiles` adds `webhook.module.ts` (5 total); US-004's adds `outbox.service.ts` and `ticket-transitions.service.ts` (5 total). All three are pre-existing files, not spec-listed creates.
**Recommended fix:** None — per the file-role rule, extra *existing* files added to `contextFiles` are helpful additions (useful reading context: US-003 needs to see where `WebhookDeliveryHandler` is exported from; US-004 benefits from seeing the `enqueue` signature and the unchanged caller), not a fidelity problem.

## Recommendations

1. Add the direct-instantiation testing note to US-001 and US-004's Design Notes in `prd.json` before the first story starts (the one substantive gap found).
2. Optional: collapse US-002's two overlapping ACs into one if a leaner PRD is preferred — not required.
3. No other changes needed; proceed to implementation.
