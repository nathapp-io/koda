# Deep Code Review: Track 1 Slice 5 — SSE Live Ticket Updates

**Date:** 2026-09-27
**Reviewer:** Subrina (AI)
**Branch:** `feat/track1-sse` (merge-base `main` @ `bba91e23`; head `5e96e7c6`; 16 commits ahead, spec + plan + implementation)
**Plan:** `docs/superpowers/plans/2026-09-26-track-1-slice-5-sse.md`
**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` § "Slice 5 — SSE live ticket updates" (re-designed 2026-09-26)
**Scope:** 65 files changed (~6.8k insertions, ~92 deletions) across `apps/api`, `apps/web`, `.github/workflows/ci.yml`, docs. No `openapi.json` / `apps/cli` change (endpoint is `@ApiExcludeEndpoint()`), as required.
**Stack:** NestJS 11 + Fastify (API) / Express (integration), Prisma 6 / Postgres 16, `@nathapp/nestjs-*` 3.3.0 (outbox fan-out), Nuxt 3.21 / Nitro 2 / h3 1.15, Jest + supertest + Node `fetch` streaming, Playwright.

---

## Overall Grade: A- (88/100)

This is a well-executed slice. The hard parts are done correctly and are actually pinned by tests:
content-free events are derived from the existing `ticket_event` outbox fan-out (no new producer path),
the bus is keyed by project and never throws into the relay, the stream re-validates access every
heartbeat and closes on revocation/membership loss/`exp`, the Nuxt route aborts the upstream on client
disconnect (the leak the plan called out), and the web client is a framework-free `EventSource` core with
dedupe, resync and auth-aware backoff. Atomicity of the new `COMMENT_ADDED` write is real: the events
repository reads through the `@nathapp/nestjs-prisma` AsyncLocalStorage transaction proxy and `OutboxService`
reads the tx client, so the comment, the `TicketEvent` row and the outbox row genuinely share one transaction.

I found **no CRITICAL or HIGH defect**. The remaining items are one MEDIUM functional gap (transition
comments do not appear live) and a set of small LOW robustness/test-quality notes. All five plan
review-focus items are verified by tests I ran locally; the full API integration+e2e suite is green.

**Verified locally (evidence, not assertion):**

| Check | Result |
|:--|:--|
| `bun run type-check` — api | clean |
| `bun run type-check` — web | clean |
| `bun run lint --max-warnings=0` — api | clean |
| `bun run lint` — web | clean |
| `bun run test` — api unit (DB stopped) | **178 suites / 2126 tests pass** |
| `bun run test` — web | **108 suites / 2014 tests pass** |
| `bun run test:integration` (PG16 on 5433) | **98 suites passed, 1 skipped; 1615 tests passed, 20 skipped** |
| Slice-5 integration suites re-run explicitly | **2 suites / 10 tests pass** (`comments/comment-event`, `live/live-stream`) |
| `openapi.json` / `apps/cli/src/generated` diff vs `main` | none |

**Plan review-focus mapping (all confirmed):**

| # | Item | Test that pins it | Result |
|:--|:--|:--|:--|
| 1 | Closed browser tab releases the API stream (proxy aborts upstream) | `apps/web/tests/server/live-proxy.spec.ts` ("aborts the upstream request when the client goes away"); `apps/web/tests/e2e/live-board.spec.ts` (6 visits then a transition still arrives) | pass (unit); e2e not run here |
| 2 | Member removed / user disabled closes the stream within one heartbeat | `apps/api/test/integration/live/live-stream.integration.spec.ts` ("removing the member closes their stream within one heartbeat"); `live-stream.spec.ts` (lost access / failing check) | pass |
| 3 | Another project's events never arrive | `project-event-bus.spec.ts` (isolation); `live-stream.integration.spec.ts` (project B → nothing on A) | pass |
| 4 | Crafted slug rejected by the proxy | `apps/web/tests/server/live-proxy.spec.ts` (traversal / `a/b` / uppercase / query → null / 400, no upstream call) | pass |
| 5 | Live ticket update keeps an open edit form (no `refresh()`) | `apps/web/tests/pages/live-wiring.spec.ts` (no `refresh(` in live handlers; `ticketData.value = await`) | pass |

---

## Fixes applied (review follow-up, 2026-09-27)

All findings below were fixed test-first on this branch (each failing test was watched fail before the
change, except the ENH-1 pin, whose teeth were proven by temporarily removing the transaction and
watching it fail — comment row count 3 vs expected 2 — then reverting).

| ID | Status | Change |
|:--|:--|:--|
| BUG-1 | **Fixed** | Ticket detail reloads the comment thread for **any** ticket event (not only `commented`), so a transition's VERIFICATION/FIX_REPORT/REVIEW comment now appears live. `apps/web/pages/[project]/tickets/[ref].vue`; pinned by a new `live-wiring.spec.ts` case asserting no `event.action === 'commented'` gate. |
| ENH-1 | **Fixed** | New DB-backed integration case `rolls the comment back when the event write fails` (`comment-event.integration.spec.ts`): rejects `TicketEventService.create` once and asserts no comment row committed. Teeth verified by mutating the service to skip the transaction. |
| ENH-2 | **Fixed** | `reloadLoaded()` refetches loaded pages **sequentially** instead of `Promise.all`, and aborts the loop as soon as a newer reload supersedes it. Pinned by a new `useTicketBoardPages.spec.ts` concurrency test (max in-flight `fetchPage` === 1). |
| ENH-3 | **Fixed** | Removed the unreachable server-sent `error`-frame branch (the API only emits `ready`/`ping`/`ticket`), restoring the `onerror`-only handler and deleting the three fake-only tests. |
| ENH-4 | **Fixed** | `env.validation.ts` `LIVE_HEARTBEAT_MS` is now `Joi.string().pattern(/^\d+$/).custom(≥100)`, matching the class-validator `@Matches(/^\d+$/)`; `1e3` / `100.0` now rejected. Pinned by a new `env.validation.spec.ts` case. |
| ENH-5 | **Fixed** | Dropped the hop-by-hop `connection: keep-alive` from `LIVE_STREAM_HEADERS`; the test now asserts it is absent. |
| INFO-1 | **Won't fix** | The acquire-before-subscribe window is inherent to returning a 429 and is covered by teardown in practice; no leak observed. |

**Re-verified after the fixes:** api unit **178 / 2126**, web **108 / 2014**, type-check + lint clean both
apps, full integration+e2e **98 suites / 1615 tests pass**; `openapi.json` / CLI unchanged.

---

## Findings

### 🔴 CRITICAL

None.

### 🟠 HIGH

None.

### 🟡 MEDIUM

#### BUG-1 (Fixed): Transition-generated comments never appear live on an open ticket detail

**Severity:** MEDIUM | **Category:** Bug / functional gap against the slice goal

The slice goal is that people see each other's "create, edit, transition, assign, **comment**, delete"
changes on the board **and ticket detail**. Transitions create a comment
(`TicketTransitionsService.executeTransitionInternal`, `ticket-transitions.service.ts:526-534`: `verify`,
`fix`, `verify-fix`, `reject` all pass a `commentType`/`commentBody`), but they emit **only** a
`status_changed` event (`:557`). On the detail page the live handler refreshes the comment thread only for
the `commented` action:

```ts
// apps/web/pages/[project]/tickets/[ref].vue:109-118
onEvent: (event) => {
  if (!ticket.value || event.ticketId !== ticket.value.id) return
  if (event.action === 'deleted') { ticketDeleted.value = true; return }
  liveTicketReload.trigger()
  if (event.action === 'commented') void reloadCommentsSilently()   // <- transitioned/updated do not reload comments
},
```

So when B is watching ticket T and A clicks **Verify** with a message, B sees the status badge move but
**not** A's verification comment until a manual reload. The API behaviour is deliberate
(`Global Constraints`: "Comments created inside a transition keep emitting only `status_changed`"), but
the web layer can close the gap without touching the API: reload comments for any event that targets the
open ticket (a `transitioned`/`updated` event implies the ticket changed), not just `commented`.

**Risk:** Under-delivers the stated goal for the most comment-bearing transitions (verify/fix/review), and
is invisible in tests because `live-board.spec.ts` adds its "new comment" through a plain comment POST.
**Fix (web only):**
```ts
onEvent: (event) => {
  if (!ticket.value || event.ticketId !== ticket.value.id) return
  if (event.action === 'deleted') { ticketDeleted.value = true; return }
  liveTicketReload.trigger()
  void reloadCommentsSilently()   // comments may have changed for any ticket event
},
```
(`commented` is a subset; the extra fetch on a status-only event is cheap and debounced by the ticket reload.)

### 🟢 LOW

#### ENH-1 (Fixed): Comment-write atomicity is not pinned by a rollback-forcing test

**Severity:** LOW | **Category:** Test quality

The central claim — comment row + `TicketEvent` row + outbox row commit or roll back together — is
supported by the implementation (the Prisma ALS proxy routes `prisma.client` and `OutboxService.record`
uses `txManager.getClient()`), but the tests only assert the happy path and call order:
`comments.service.spec.ts` ("writes the comment, the TicketEvent and the outbox row inside one
transaction") uses a pass-through mock `txManager.run`, and
`test/integration/comments/comment-event.integration.spec.ts` asserts the three rows exist **after success**
only. No test forces `ticketEventService.create`/`outbox.record` to fail and asserts the comment row is
absent.
**Fix:** add one DB-backed integration case that stubs the event write to throw (or points at a
non-existent project) and asserts no `Comment` row was committed for that ticket.

#### ENH-2 (Fixed): `reloadLoaded()` fires one parallel request per loaded page on every live event

**Severity:** LOW | **Category:** Performance

```ts
// apps/web/composables/useTicketBoardPages.ts:64
const pages = await Promise.all(Array.from({ length: loadedThrough }, (_, i) => fetchPage(i + 1)))
```
A board with N loaded pages reloads all N in parallel each time the 300 ms debounce fires. With page size
100 this is bounded in practice, but a user who clicked "Load more" many times will burst N requests per
event from every open tab. Consider always refetching page 1 and only the pages currently in view, or
capping the refetched depth.

#### ENH-3 (Fixed): The server-sent `error` frame path is dead code against the current API

**Severity:** LOW | **Category:** Dead code / maintenance

`project-event-stream.ts:132-138` (added in `5e96e7c6`) treats a payload-bearing `error` frame as terminal.
The API's `createLiveStream` only ever emits `ready`, `ping` and `ticket` (`live-stream.ts:34,36,50`); it
never sends an `error` event, so this branch is exercised only by the fake in
`tests/lib/project-event-stream.spec.ts`. It is harmless, but it is production code with no production
trigger, and a real browser may surface a server `error` frame as a plain connection error (no `.data`)
anyway, in which case the existing `readyState === CLOSED` path covers it.
**Fix:** either have the API emit a content-free `error` frame before closing (making it real), or drop the
extra listener and rely on the socket-close/readyState path. (The current-source guard makes it safe either
way.)

#### ENH-4 (Fixed): `LIVE_HEARTBEAT_MS` class-validator rule and Joi rule are not strictly equivalent

**Severity:** LOW | **Category:** Config / consistency

`live.config.ts:17-19` validates `@Matches(/^\d+$/)` while `env.validation.ts:31-34` uses
`Joi.number().integer().min(100)`. Inputs like `1e3` or `100.0` pass Joi (numeric coercion) but fail the
digits-only matcher, and vice-versa for leading zeros (`'007'`). Both validators run at boot, so the app
fails closed rather than diverging at runtime, and the plan's "keep the two rules equivalent" constraint is
only approximately met. Align them (e.g. `.regex(/^\d+$/)` + `.min(100)` on the Joi side) or rely on one
validator.

#### ENH-5 (Fixed): `connection: keep-alive` is a hop-by-hop header

**Severity:** LOW | **Category:** HTTP hygiene

`LIVE_STREAM_HEADERS` (`server/utils/live-proxy.ts:18`) sets `connection: keep-alive`. Node/Nitro serves
HTTP/1.1 today so this is accepted, but hop-by-hop headers are invalid under HTTP/2 and some proxies strip
or reject them. Consider dropping it and relying on the SSE `content-type`/`cache-control`/`x-accel-buffering`
headers, which are the ones that matter.

#### INFO-1: Stream slot is acquired before the Observable is subscribed

**Severity:** INFO | **Category:** Robustness

`LiveController.events` calls `streams.tryAcquire(...)` and then returns a cold `createLiveStream(...)`
Observable whose RxJS teardown releases the slot (`live.controller.ts:45-56`). This is the right trade-off to
be able to return a 429 response, and the window is theoretical (Nest subscribes immediately after the
handler resolves; a failed subscription would still route through teardown on the first write). Recorded for
completeness only — no change recommended unless a leak is ever observed.

---

## By-Design / Known Residuals (acknowledged, not defects against this branch)

1. **Transition comments emit only `status_changed`.** Explicit spec constraint; BUG-1 is the resulting web
   gap, not an API bug.
2. **Single-instance bus.** `ProjectEventBus` and `LiveStreamRegistry` are in-process; a multi-replica API
   would not fan out across instances. Documented in `docs/architecture.md` and the spec ("no Redis").
3. **At-least-once delivery.** Outbox re-delivery is expected; the client drops duplicates by event id over a
   200-entry window (`project-event-stream.ts:79-85`). An event redelivered after 200 newer events could be
   processed twice; acceptable for a refetch-on-event UI.
4. **`stream.ts` content-free by construction.** `toLiveEvent` reads only `id`/`action`/`projectId`/`ticketId`/
   `actorId`/`timestamp` and never `data`; the integration test asserts the created payload has no `title`
   and the comment payload is not in the outbox. Good.

---

## Positives worth recording

- **No new producer path.** Live events hang off the existing `ticket_event` fan-out
  (`TicketLiveSubscriber` registers on `FanOutPublisher`), so nothing else needs to know about the bus; the
  handler never throws, so it cannot cause an outbox retry.
- **`toLiveEvent` is defensive in the right place.** It rejects non-objects / missing ids, drops unknown
  actions, and uses an own-property check on `TICKET_ACTION_TO_LIVE` (commit `69498d11`) so a prototype-chain
  key like `toString` can never become an action.
- **Access re-validation is correct and cheap.** `stillAllowed` re-runs `getPrincipal` (60 s cached
  `tokenVersion`/`disabled`) **and** a live `assertProjectMembership`; a throwing check is treated as lost
  access, and the stream completes. Teardown (bus unsubscribe + timer clear + slot release) runs exactly
  once whether the client leaves or the server closes.
- **Timer hygiene.** Both the heartbeat interval and the expiry timeout are clamped to `2^31-1` ms, and an
  already-expired token completes right after `ready`. `checking` prevents overlapping access checks.
- **The Nuxt stream route does the one thing the catch-all cannot.** It aborts the upstream fetch on the
  **response** `close` event (not request `close`, which fires early for bodiless GETs), and a non-200
  upstream is passed through with its status — which is exactly what makes `EventSource` go terminal instead
  of hot-looping. Slug validation reuses the API's project-slug rule.
- **Client is framework-free and well factored.** `createProjectEventStream` takes injectable deps
  (EventSource, refreshAuth, timers), which is why the 14-case unit suite can drive transient/terminal/reopen
  paths deterministically, including "close() during an in-flight auth refresh".
- **Comment write is genuinely transactional and content-free.** `recordCommentAdded` mirrors
  `TicketsService.recordTicketEvent`, writes `data: { commentId }` only, and the outbox row carries
  `{ projectId, eventId }`.
- **Test discipline.** Real-module DI test (`live.module.spec.ts`), real-HTTP streaming integration suite
  (`sse-client.ts` avoids supertest buffering), source-level wiring pins for Nuxt pages, en/zh parity for the
  new locale key, and a CI `e2e` job (build mode, Postgres, `SKIP_KB_E2E`).
- **Conventions.** No `console.log` in the API, no `process.env` outside config/test files, no new `any`,
  i18n prefixes (`live.40003`, `live.429`) present in both languages, immutable spread updates in the bus and
  registry.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | BUG-1 | XS | Reload comments on any ticket event for the open ticket (not only `commented`) |
| P1 | ENH-1 | S | Add a rollback-forcing integration test for the comment transaction |
| P2 | ENH-4 | XS | Make the Joi and class-validator `LIVE_HEARTBEAT_MS` rules equivalent |
| P3 | ENH-2 | S | Bound/reduce parallel page refetches in `reloadLoaded()` |
| P4 | ENH-3 | XS | Remove or wire the dead `error`-frame branch |
| P5 | ENH-5 | XS | Drop the hop-by-hop `connection: keep-alive` header |

All P0–P5 above are fixed on this branch; INFO-1 is a deliberate won't-fix. See "Fixes applied".

---

## Verification appendix

- Evidence gathered from source, from the installed `@nathapp/*` packages (`nestjs-prisma`
  `patchWithTransactionProxy` / `prisma.module.js`, `nestjs-outbox` `outbox.service.js` `getClient()`,
  `nestjs-common` exception codes `40003`/`429`), from h3's `sendStream`, and from live test runs — not
  inferred.
- Commands were run from the branch head `5e96e7c6`. The test Postgres was already running on 5433
  (`koda-postgres-test-1`); `test:integration` reset and migrated it itself.
- `openapi.json` and `apps/cli/src/generated` are unchanged vs `main` (verified in the branch diffstat),
  consistent with `@ApiExcludeEndpoint()`.
- **Not run here:** the Playwright web e2e suite (`bun run test:e2e`) — it requires building the web app and
  spawning the full API+web stack, and is out of scope for a read-only review. The proxy-abort behaviour it
  pins is covered at the unit level by `tests/server/live-proxy.spec.ts`; the plan reports it green.
- No push, PR, or deployment was performed.
