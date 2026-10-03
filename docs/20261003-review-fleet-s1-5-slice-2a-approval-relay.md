# Deep Code Review: Fleet S1.5 Slice 2a — Approval Relay and Protocol v2

**Date:** 2026-10-03
**Reviewer:** Subrina (AI)
**Branch:** `feat/fleet-s1-5-approvals-relay` (24 commits, base `8e2fe423` = main)
**Scope:** 129 files, +7608/-205 — `packages/fleet-protocol`, `apps/api` (fleet jobs/schedules/approvals/sync), `apps/runner` (approvals, supervisor, executor, journal, daemon), `apps/cli`, `apps/web` (types/i18n), `openapi.json`, migration
**Plan:** `docs/superpowers/plans/2026-10-03-fleet-s1-5-slice-2a-approval-relay.md` (D255-D287)

---

## Overall Grade: A (92/100)

The branch implements the approval relay exactly as planned: protocol v2 stays additive (v1 syncs still accepted and tested), every lost/late/failed path ends in nax's deny, the FleetJob-before-FleetApproval lock order is honored at all four bash entry points (report processor, job transitions, decide, expiry sweeper), and the runner's receiver is loopback-only with constant-time signature verification, a pinned callback URL, and a 64 KiB body cap. Tests are exemplary: all six plan Review Focus scenarios have explicit specs (spoofed split, decide-vs-sweeper race, READOPT re-bind, re-sent answer, relay misfit placement, D277 headless prompts), and the API integration suite drives the whole ask-to-delivery loop against a real database. Verification in this review: API fleet units 551/551, API integration (3 relay-related suites) 22/22, runner 1049/1049, CLI 20/20, web parity 35/35, type-check clean in api/runner/cli, ESLint clean with `--max-warnings=0`. The only findings are two LOW observability/hygiene items and a cosmetic schema-format nit; nothing blocks merge.

---

## Verification Evidence (run during this review)

| Check | Command | Result |
|:------|:--------|:-------|
| API fleet units | `cd apps/api && bun run test:scoped src/fleet` | 61 suites, 551 tests PASS |
| API relay integrations | `bun run test:scoped test/integration/fleet/fleet-approval-relay... fleet-approval-repository... fleet-job-repository...` | 3 suites, 22 tests PASS |
| Runner | `cd apps/runner && bun run test` | 74 files, 1049 tests PASS |
| CLI | `bun run test -- src/commands/fleet-approval.spec.ts` | 20 tests PASS |
| Web i18n parity | `bun run test -- tests/i18n/fleet-locale-parity.spec.ts` | 35 tests PASS |
| Type-check | api / runner / cli `bun run type-check` | clean |
| Lint | api `src/fleet`+`src/common`, runner `src`+`test` via ESLint `--max-warnings=0` | clean |
| OpenAPI freshness | `fleet-openapi.contract.spec.ts` (in the fleet run) | PASS — committed `openapi.json` matches controllers |

Not executed here (environment-gated, noted as residual risk): `apps/runner/test/integration/approval-relay.integration.spec.ts` (needs a built API + `KODA_DB_TESTS=1`) and `test/live/nax-triggers.live.spec.ts` (needs a nax checkout). Both were reviewed by read.

---

## Plan Compliance (spec/decision spot-checks)

| Plan item | Verdict | Evidence |
|:----------|:--------|:---------|
| D255/D256/D283 detail parser (ambiguity -> raw, cut-summary deny-only) | OK | `apps/runner/src/approvals/detail-parser.ts:39-45`, `ask-payload.ts:64-66`, spec "spoofed split" (Review Focus 1) |
| D257 deadline = nax `createdAt + timeout`; koda caps at own timeout | OK | `ask-payload.ts:50`, `approval-closer.ts:99` (`Math.min`) |
| D258 relay capability gated on nax >= 0.83.0; static mode never offers it | OK | `apps/runner/src/nax/nax-cli.ts` (`RELAY_MIN_NAX_VERSION`), `nax-probe.ts:147`, runner-config untouched |
| D260 RUNNER/SYSTEM actors with `responsibleUserId` | OK | `approval-closer.ts:35-40` |
| D261 born-closed ask: activity + live event, no webhook | OK | `approval-closer.ts:105-115`, unit + integration specs |
| D262 `approval.expired` activity | OK | `closedAction`, `approval-closer.ts:43-44` |
| D263/D264 closeForJob + type-filtered withdraw on every RUNNING exit; `approvalLive` threaded through sync/sweeper/acks | OK | `job-transitions.service.ts:58-71`, `fleet-sweeper.ts:50-60`, `command-ack.processor.ts`, `sync.service.ts:59-85` |
| D265 expired-at-decide commits, then 409 | OK | `approvals.service.ts:167-172` (close in tx, throw after) |
| D266/D267 `mayDecideBash`, truncated deny-only, option offer checks | OK | `approvals.service.ts:45`, `bash-decision.ts` |
| D268 ack stored as `outcome.delivery`; no live event; stale acks stale | OK | `command-ack.processor.ts:60-66` |
| D269 malformed ask = rejected event, not sync failure | OK | `event-payloads.ts:108-112`, integration spec `fleet-approval-relay.integration.spec.ts:177` |
| D270/D271 `approvals_relay` permanent misfit, checked first; strict `{relay: true}` capability | OK | `placement-rules.ts:49-50`, `capabilities-core.ts:95-96` |
| D272 `pendingApprovals` via one grouped count (list) / one id (get, cancel, requeue); dispatch 0 | OK | `fleet-jobs.service.ts:97-102,145-150,231,237` |
| D273/D285/D286 relay lifecycle (prepare/resume/close/release per epoch, re-prepare re-binds or fresh port, no duplicate events) | OK | `host-executor.ts:91-93,215-219,230-237`, `approval-relay.ts:45-88,138-141`, `job-run.ts:95-127,191-194` |
| D274 callback URL pinned to `http://127.0.0.1:<port>/nax/interact/<id>` | OK | `nax-callback.ts:7-26`, spec at `approval-relay.spec.ts:77-81` |
| D275 profile overlay (0600, webhook plugin, triggers false, callbackPort 0) | OK | `job-profile.ts:29-44,52-56` |
| D276 inline 10 s answer; re-sent command deduped by applied-command record | OK | `command-handler.ts:50-55,85-90`, `nax-callback.ts:29-43` |
| D277 size-gate/paused prompts answered headless; others skip + warn | OK | `approval-relay.ts:32-36,124-131`, spec at `approval-relay.spec.ts:83-94` |
| D278/D285 journal tables per (jobId, leaseEpoch); daemon start sweeps orphans | OK | `journal/schema.ts`, `journal.ts:200-244`, `daemon.ts:118` |
| D279/D280/D281 schedules template, CLI decide/show, web types+labels | OK | diffs reviewed; web parity test updated and green |
| D284 secret in 0600 profile/journal (accepted trust boundary) | documented | `job-profile.ts:51` |
| A8 no command text / rawDetail in webhooks or activity | OK | `approval-payloads.ts` (whitelist fields only) |
| Protocol deploy order (server accepts v1+v2) | OK | `protocol.ts:50`, integration spec `:185` "a v1 sync is still accepted" |

---

## Findings

### 🔴 CRITICAL

None.

### 🟡 MEDIUM

None.

### 🟢 LOW

#### ENH-1: Receiver swallows `onRequest` failures without any log
**Severity:** LOW | **Category:** Reliability/Observability
`apps/runner/src/approvals/approval-receiver.ts:48`

```ts
const status = await options.onRequest(body).catch(() => 500);
```

**Risk:** If the journal transaction in `ApprovalRelay.onRequest` throws (sqlite busy, disk error), nax gets 500 and denies — correct fail-closed behavior — but the runner operator has no signal at all; nothing reaches the log or the job's lifecycle events. Every other failure path on this branch leaves a trace.
**Fix:** Catch inside the relay's `onRequest` (or pass the rejection through) and emit `events.lifecycle('error', ...)` plus a `log.error` before returning 500. A test asserting the lifecycle row would lock it in.

#### BUG-2: `answer()` has a theoretical re-insert window between POST success and ask deletion
**Severity:** LOW | **Category:** Bug (race, plan-accepted)
`apps/runner/src/approvals/approval-relay.ts:101-106`

```ts
const posted = await postToNax(ask.callbackUrl, receiver.secret, {...});
if (!posted.ok) return { result: 'rejected', detail: posted.detail };
journal.deletePendingAsk(command.jobId, command.leaseEpoch, p.naxAskId);
```

**Risk:** nax re-POSTing the same ask in the microsecond between the successful answer POST and `deletePendingAsk` would re-insert the row (`INSERT OR IGNORE`), letting a duplicate `APPROVAL_ANSWER` POST twice. In practice the sync loop is serial, nax does not re-POST after a 200 answer, and plan D276 explicitly accepts the equivalent crash window ("never an allow nax did not get" is preserved — the failure direction is only a harmless duplicate answer to an already-answered request). Document-only; a `@design` remark citing D276 at this line would keep future reviews from re-flagging it.
**Fix (optional):** Mark `@design` per D276, or move the delete into the same journal transaction that records the answer's applied-command row.

#### STYLE-3: Misaligned columns in `schema.prisma`
**Severity:** LOW | **Category:** Style
`apps/api/prisma/schema.prisma:727,761` — `approvalTimeoutSec Int    @default(600)` breaks the file's column alignment (both `JobSchedule` and `FleetJob`). Cosmetic; `prisma format` would normalize. Does not affect `prisma generate`/migrate (verified: migration applied cleanly against the test DB).

#### ENH-4: `verifyNax` accepts uppercase hex signatures
**Severity:** LOW | **Category:** Security (harmless looseness)
`apps/runner/src/approvals/nax-callback.ts:15` — `/^[0-9a-f]{64}$/i`. The comparison itself is constant-time and over the decoded bytes, so this is not a vulnerability; nax sends lowercase. Not worth changing; noted for completeness.

### By-design (verified, no action)

- **D276 crash window** (answer recorded lost after nax accepted the POST): approval shows `delivery.rejected: ask_not_pending` on the re-sent command; never an allow nax did not get. Tested by design.
- **D284 trust boundary** (runner user can read the relay secret in the 0600 profile/journal): accepted threat model, consistent with every other runner secret.
- **Runner `strictNullChecks` discipline**: result unions discriminated with `'ask' in r` / `'reason' in r` on the API side (`event-payloads.ts:111`, `approvals.service.ts:148`) and `.ok` narrowing on the runner/CLI side, per the global constraint.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P2 | ENH-1 | S | Log/lifecycle-record receiver `onRequest` failures instead of a silent 500 |
| P3 | BUG-2 | S | `@design` remark citing D276 (or delete-ask in the applied-command tx) |
| P3 | STYLE-3 | S | `prisma format` the two touched models |

---

## Checklist Notes

- **Security:** HMAC-SHA256 with `timingSafeEqual`; loopback bind only; callback URL pinned per D274 (port, path, id equality); 64 KiB body cap enforced twice (Bun `maxRequestBodySize` + byte count); signature verified before JSON parse; strict capability parsing (`approvals` exactly `{relay:true}`); DTO validation on dispatch and both schedule DTOs; decide permission before validation; no secrets in journal/activity/webhook payloads; no command text leaves the approval payload (A8).
- **Memory/resources:** receiver `stop(true)` on close/stopAll/crash paths; sweeper timers cleared on destroy and `unref()`ed; `postToNax` always clears its abort timer in `finally`; journal tables keyed per (jobId, epoch) and pruned on abandon/startup; no unbounded maps (`this.receivers` entries always removed in `close`/`stopAll`).
- **Error handling:** every ask failure mode (bad callback URL, unparsable body, bad payload, receiver 500, callback failure, timeout, job not running) ends in nax deny; sync-level isolation preserved (one bad event/ack/job never fails the sync).
- **Type safety:** protocol unions widened additively; `BashMode` replaces raw `string` across API domain, DTOs, web types; no new `any` in public signatures.
- **Testing:** new production files each carry a spec (9 runner approval files, 4 API files); error paths and races covered; tests use real sqlite/`Bun.serve`/real Postgres rather than mocks for the relay surfaces; deterministic (injected `now`, fixed secrets).

**Recommendation:** Merge-ready once ENH-1 (and ideally the BUG-2 `@design` remark) lands; STYLE-3 can ride along. The two environment-gated suites (runner integration, live triggers) should be run before the release cut per the existing merge-gate policy.
