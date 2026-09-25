# Task 19 Report — H6: merged-PR auto-transition commits

**Status:** DONE
**Branch:** `feat/koda-pr5-background` (HEAD eff69b00)
**Commit:** `fix(vcs): merged-PR auto-transition commits; merged/closed are terminal (H6)`

## Changes

1. **`apps/api/src/vcs/prisma-vcs.repository.ts:306`** — `applyMergedPrTransition()` now writes the FIX_REPORT comment with `authorAgentId: null` instead of `'system'`. There is no `Agent` with id `'system'`, so the insert violated the FK to `Agent.id`, rolled the whole transition back, and the comment + activity were lost while `prState` was still persisted as `merged` (polling never retried). `Comment.authorAgentId` is nullable (`schema.prisma:177`), so no migration is needed.

2. **`apps/api/src/vcs/vcs-pr-sync.service.ts` (`syncPrStatus`, ~:90)** — the state write is now terminal-aware: if `link.prState` is already `'merged'` or `'closed'`, neither the auto-transition nor `updateTicketLinkPrState` runs, so out-of-order/stale events cannot regress a terminal state. Implemented exactly per the brief's snippet (the existing loop body was re-nested under `if (!terminal)`).

3. **NEW `apps/api/test/integration/vcs/vcs-merged-pr.integration.spec.ts`** — integration test over a real SQLite database (`DATABASE_URL=file:./koda-test.ephemeral.db`, seeded via `resetDb()`; skipped when `DATABASE_URL` is unset). Bootstraps project + IN_PROGRESS ticket + TicketLink (`prState: 'open'`, `prNumber: 42`), constructs the real `PrismaVcsRepository` + `VcsPrSyncService` over a real `PrismaService`, and mocks only the VCS provider factory (`createVcsProvider` — the network seam). Three tests:
   - merged event → FIX_REPORT comment row exists with `authorAgentId: null` and `authorUserId: null`, ticket advanced to `VERIFY_FIX`, `prState === 'merged'`;
   - stale `opened` event delivered against a merged link (out-of-order fetch simulated by returning the merged row from `findActiveTicketLinksWithPrs`) → terminal guard: `prState` stays `merged`, still exactly one FIX_REPORT comment, ticket still `VERIFY_FIX`;
   - normal polling query (`findActiveTicketLinksWithPrs`) never returns a merged link → no retry, no second comment.

## RED → GREEN evidence

- **RED** (fix stashed, verified twice — once before implementing, once against the final test code): `Foreign key constraint violated on the foreign key` from `this.db.comment.create()` at `prisma-vcs.repository.ts:300`; assertion failure `Expected length: 1, Received length: 0` (comment absent); the stale-event test failed with `prState` regressed to `'open'` and a second comment created (`Expected: 0, Received: 1`). All 3 tests fail pre-fix.
- **GREEN**: `bunx jest test/integration/vcs/vcs-merged-pr` → 3 passed.

## Test runs

| Command | Result |
|---|---|
| `bunx jest test/integration/vcs/vcs-merged-pr` | 3/3 passed |
| `bunx jest src/vcs` (unit) | 15 suites, 206/206 passed (no unit mock asserted `'system'`; no mock updates needed) |
| `bun run type-check` (apps/api, `tsc --noEmit`) | clean |
| `bunx jest test/integration/vcs` (full dir) | 6 failed suites / 3 failed tests — **identical to the pre-change baseline** (my suite adds 3 passing tests: 448 passed before, 448 passed after out of 451 total) |

## Pre-existing failures investigated (not fixed, per task scope)

- `vcs-controller.spec.ts`, `vcs-connection.service.spec.ts`, `vcs-manual-sync.spec.ts`, `vcs-webhook.integration.spec.ts`, `vcs-webhook-pull-request.integration.spec.ts` — fail to compile: stale specs call controller methods without the `@Principal()` argument (TS2554) and assert removed `webhookSecret` DTO fields (TS2339). Type drift, unrelated to this change.
- `auto-create-pr-on-verified.integration.spec.ts` — 3 behavioral failures (AC14: TicketLink `prNumber`/`prState` persistence after PR creation). Unrelated to the merged-PR flow.
- None of these touch `applyMergedPrTransition` or the sync guard; my change affects none of them.

## Concerns / findings for other tasks

1. **Repository bypasses the transaction client.** `PrismaVcsRepository` always writes via `PrismaService.client` (the ambient pool client) inside `txManager.run(...)`, never via the tx client that `PrismaTransactionManager` provides through AsyncLocalStorage. On SQLite this was observable in the test: a real interactive transaction held a write lock while the pool writes blocked, then the commit expired ("Transaction already closed … 5000 ms"). Atomicity of `applyMergedPrTransition` is therefore not actually guaranteed in production either. The integration test uses a pass-through `ITransactionManager` (`run: fn => fn()`), which is behaviorally equivalent to what the repository actually does, and documented this in the spec. Worth a dedicated task.
2. **Webhook path has no terminal guard.** `VcsWebhookService.handlePullRequestOpened` (`vcs-webhook.service.ts:300`) writes `prState` unconditionally, so a stale/duplicate `opened` webhook can still regress a merged link to `'open'`. The brief scoped the guard to `VcsPrSyncService` only; a follow-up may want the same terminal check (or a repo-level conditional write) on the webhook handlers.
