# PRD Fidelity Report — track3-outbound-ssrf

**Spec:** `.nax/features/track3-outbound-ssrf/spec.md` @ `068448fe`
**PRD:** `.nax/features/track3-outbound-ssrf/prd.json` (`nax plan --profile native`, 2026-09-27, hand-patched as below)
**Phase:** spec-review Phase 9 (re-run after the hand patches)
**Verdict:** ✅ ready

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC → PRD AC mapping | 55 spec ACs → 58 PRD ACs (US-001 11→11, US-002 15→15, US-003 15→16, US-004 14→16) | every spec AC mapped; 2 low-score matches (US-002 #5, #14) checked by hand, carried through unchanged |
| 2. Behavioural fidelity | 58 PRD ACs | no AC turned into a file-content check; exact strings kept (`EBLOCKED_DESTINATION`, reason and error codes, `1 fan-out handler(s) failed for webhook_delivery: blocked_destination`) |
| 3. Orphan PRD ACs | 3 planner-added | all traced: US-003 #16 → Failure Handling row (unresolvable → 400); US-004 #15 → Failure Handling row (stored `http` URL refused at delivery); US-004 #16 → US-004 Modifies reason for `webhook-delivery.handler.spec.ts` (error propagates unchanged) |
| 4. File roles | 16 context, 12 creates, 18 modifies paths | no Creates file in `contextFiles`; no Context File dropped (after patch A); 2 helpful extra context files (US-001 `app.module.ts`, US-004 `webhook.module.ts`, both edited by the story) |
| 5. Meta-AC / correction survival | 3 review corrections (table-driven classifier ACs, `assertStaticTarget` steps 2-8, dto.spec rationale) | all present in `acceptanceCriteria` / `description` / `modifiedFiles` reasons, not only in `analysis` |
| 5c. Satisfiability of invocation ACs over existing endpoints | 1 (US-004 #14) | `FanOutPublisher.publish` → `WebhookOutboxSubscriber.handleWebhookDelivery` → `WebhookDeliveryHandler.handle` reaches the handler |
| 6. Out of Scope | 10 spec bullets | 10/10 in `prd.outOfScope`; `US-002 only:` prefix kept; no exclusion appears in any AC (after patch B) |
| 7. Terminal cleanup | n/a | spec has no cleanup story |
| 8. Modifies → modifiedFiles by path | 18 spec paths | 18 entries with reasons; 1 path corrected (patch C) |
| 9. Forward-reference drift | 18 symbols new in this spec | no drift; near-name pairs are distinct symbols by design (`webhookConfig` / `IWebhookConfig` / `mockWebhookConfig`, `EBLOCKED_DESTINATION` / `blocked_destination`) |

## Patches applied to prd.json (no re-plan)

- **A. US-003 `contextFiles`: restored `apps/api/test/unit/i18n/projects-translation-keys.spec.ts`** (MAJOR §4b). It is an existing tracked file and the pattern US-003 AC 15 copies. The planner dropped it ("Spec Context Files entries absent from the resulting story — not backfilled").
- **B. US-004: removed the planner-added AC "relay retries with normal backoff and marks it dead"** (BLOCKER §6c). It turned the spec's first Out of Scope bullet into work that tests the unchanged `@nathapp/nestjs-outbox` relay. The spec's Failure Handling row was reworded in `068448fe` so a re-plan does not bring it back.
- **C. US-003 `modifiedFiles`: `apps/api/openapi.json` → `openapi.json`** (MAJOR §8). The spec path `openapi.json` is repo-root relative (the file lives at the repo root; `apps/api/openapi.json` does not exist). The planner rebased it under the story's workdir `apps/api`, which authorised a file that does not exist and left the real one unauthorised. Diff checked: only that one field changed.

## Notes

- Story-size gate: US-003 and US-004 have 16 ACs against `maxAcCount` 15; the resolved `storySizeGate.action` is `warn` (global config), so this is informational.
- Patch C looks like a planner path-mapping defect: a bare repo-root path in a monorepo story's `### Modifies` gets rebased into the story's workdir. Candidate nax issue after reproducing on a minimal spec; not verified beyond this PRD.
