# PRD Fidelity Report — permissions-p2-audit-knowledge

Phase 9 (fresh reviewer) of `prd.json` (`nax plan --profile native-codex-ds`) against `spec.md` (`38243e71`).

Verdict: PASS after patches.

- 51/51 spec ACs mapped (13/14/13/11), none missing, weakened or contradicted. Status codes, keys, actor/origin, summaries, the "never prints" exclusions, EMBEDDING_PROVIDER=fake, VCS_ENCRYPTION_KEY, the partial `vi.mock` of `src/vcs/factory` and the fact body's `sourceId: 'note-1'` all survive in the descriptions or ACs.
- Dependencies (US-003 -> US-002 only), workdir `apps/api` for all, expectedFiles (1/3/1/1), modifiedFiles (6/5/12/11, reasons verbatim) and all 16 outOfScope bullets (including the `US-001 only:` x2 and `US-004 only:` prefixed ones) survived. contextFiles: spec entries all present (US-001/US-003 capped at 5 by the planner, `audit-recorder.service.ts` and `rag.controller.spec.ts` added, minor); US-002 and US-004 unchanged.
- Descriptions agree with the Design: `this.prisma.withTransaction(…, { isolationLevel: 'Serializable' })`, KB entries recorded after the store call, derived indexes record nothing, the push index records once per indexed commit as SYSTEM/codeintel.
- Planner additions (all failure-table / design-call derived): 14 kept as ADDED-OK, 4 DUP, 12 ADDED-BAD.

Additions classified:
- ADDED-OK: US-001 #37, #38 (refused add/delete leave rows unchanged); US-002 #26 (refused replace persists nothing); US-003 #22 (lastError on handler failure), #24 (cleanup writes stay after a rejected record), #25 (per-project catch logs, next project runs); US-004 #21 (lastError on push failure), #28, #29, #30 (`files: []` route: 201 zero counts, no symbol write, no entry). Also the splits of spec ACs 7/9/10/11/12 in US-001 and the count-pair/atomic splits elsewhere.
- DUP: US-001 #28 (restates AC13); US-002 #27 (restates AC3 + AC14); US-003 #21 (restates AC6 and the rollback in the description), #23 (restates AC12).
- ADDED-BAD (tests something the spec puts Out of Scope): US-001 #29-#32 (second source's `deleteBySource` throws; `US-001 only:` bullet), #33-#35 and #36 (rejected `record` after delete / graphify import / optimize; `US-001 only:` bullet); US-004 #22-#27 (push with no files, no VCS connection, no encryption key; `US-004 only:` bullet).

Patches applied:
1. US-001: deleted #28 (DUP of the AC13 unit pair).
2. US-001: deleted #29-#32 (out-of-scope second-source-throws test).
3. US-001: deleted #33-#36 (out-of-scope rejected-record-after-delete/import/optimize tests).
4. US-002: deleted #27 (DUP, vague "no mutation").
5. US-003: deleted #21 (DUP of AC6) and #23 (DUP of AC12).
6. US-004: deleted #22-#27 (out-of-scope early-return tests).
7. US-003 #22 and US-004 #21: removed the unpinnable clause "its rejected publish remains eligible for the existing relay retry path" (outbox infrastructure, nothing a test can assert); the lastError assertion stays.

Notes for the caller (not patched):
- `test/integration/memory/memory-controller.unit.spec.ts` defines a local 3-argument `MemoryController` simulator (line 53), not the production class, so the spec's Modifies entry ("its direct `new MemoryController(...)` passes mockAuditRecorder") is probably a no-op or a type error. The PRD keeps the Modifies reason verbatim and the US-002 description tells the implementer to inspect it first. A spec fix would be to drop that entry; spec.md was not edited.
- US-001 and US-003 descriptions refer to "the shared analysis"; `analysis` is inert at run time, but the descriptions carry the needed fixtures themselves, so nothing is lost.

AC counts after patches: 29/26/23/24 (were 38/27/25/30; faithful one-assertion splits kept past the warn-only 15 cap, as in the sibling features).
6. US-002: dropped the modifiedFiles entry for test/integration/memory/memory-controller.unit.spec.ts (it defines a local simulator, not the production MemoryController); spec Modifies fixed to match.
