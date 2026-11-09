# Integration Test Runtime — Design

Status: proposed
Date: 2026-11-09
Branch: `feat/ci-integration-runtime`

## Problem

The `integration` CI job is the pipeline's only long pole: 14m33s–19m40s across the
last nine runs (mean ~17.5m), while every other job finishes in under 2 minutes. The
`e2e` job is ~7m. The goal is a normal-PR integration job at **≤ 7 minutes** without
dropping any suite, weakening assertions, or changing the required-check contract.

## Measured baseline

Source: GitHub Actions run `42637614111` (PR #419), job `integration`.

| Phase | Measurement |
| --- | ---: |
| Job wall time | 19m19s |
| Checkout + install + Prisma generate + build API | ~49s |
| `vitest run test/integration test/e2e` | 18m26s |
| Vitest duration | 1105.02s |
| — tests bucket | 1065.48s |
| — import / transform / setup | 31.91s / 14.10s / 2.43s |
| Files / tests | 571 files, 6284 tests (6264 passed, 20 skipped) |
| `db-shared` | 558 files, 6067 tests, 1055s |
| `db-isolated` | 10 files, 134 tests, 10s |

There is no hot file: the slowest single file is 30.9s (2.8% of the run). The time is
spread across 571 files that run **serially** (`fileParallelism: false`) because every
file shares one Postgres schema and `resetDb()` truncates it.

### Where the time actually is

- **Not app boot.** 399 files call `bootHttpApp`, but a local probe of the helper
  measured `319ms` total (`AppFactory.create` 116ms, `app.init()` 203ms). The earlier
  "boot files own 93% of the run" reading was the *files'* total time, not boot time.
- **Test bodies and fixtures.** 6284 tests average ~169ms each. One 27-test fleet file
  spends 29.8s in test bodies and only 0.3s in boot.
- **Fixture bcrypt is the largest single reducible cost.** `seedFleetHttpWorld`
  (`apps/api/test/helpers/fleet-fixtures.ts`) is used by **226 spec files**. Per call
  it performs four cost-12 bcrypt hashes (one registration + three `/api/admin/users`
  creations) and three cost-12 bcrypt comparisons (logins). On this workstation
  `bcrypt.hash(..., 12)` = 273ms and `bcrypt.compare(..., cost-12 hash)` = 276ms, so
  the seed costs ~1.9s per file, or **~430s across the suite**. CI CPUs are slower.
- **No late-run DI drift.** Pearson r between file position and duration is **−0.344**
  (later files are faster: boot-file median 2.79s in the first fifth vs 2.14s in the
  last fifth). store-erp's sequential-batching fix does not apply here.

### store-erp comparison

Read from `wc-store-erp/repos/store-erp`:

| Technique | Evidence / decision for koda |
| --- | --- |
| Per-worker MySQL/Redis stores + `maxWorkers: 4` | Same total CPU as CI sharding; would keep one job but is a larger, riskier change to DB provisioning and test isolation. Not adopted now. |
| Five sequential shards when forced to one worker (29.8% CI win) | Their win came from DI drift in long-lived workers. koda shows the opposite (r = −0.344), so batching would only add cold starts. Rejected. |
| Batched DB reset transport | koda's `resetDb()` is already a single `TRUNCATE ... CASCADE`. Nothing to gain. |
| One immutable fixture password hash reused across users | Directly applicable and adopted here; koda already uses cost-4 hashes in auth fixtures, so a precomputed cost-4 fixture hash is consistent with existing practice. |
| Suite consolidation to cut app boots | The real long-term lever, but a large test-structure project. Deferred. |

## Decisions

1. **Shard the integration job four ways in CI** (adopted, commit `591781cf`).
   Each shard gets its own Postgres service container and its own `koda_test`, so the
   existing run lock, schema reset and per-file `resetDb()` semantics are unchanged.
   Vitest hashes spec paths and slices the hash order, so shard assignment is
   deterministic and every file runs exactly once.
   Simulating the split against the real per-file CI durations gives test work of
   248s / 302s / 246s / 269s (max 302s). Adding ~50s of job setup puts the slowest
   shard at ~6 minutes.
   A tiny aggregator job named `integration` preserves the branch-protection check
   name; a matrix alone would only publish `integration shard n/4`.

2. **Use a precomputed cost-4 fixture password hash and seed secondary users
   directly** (this plan). A real bcrypt hash of `TEST_PASSWORD` is computed once per
   worker; fixture users are inserted with it plus the member baseline binding, then
   logged in through the real `/api/auth/login` endpoint. Real registration/login
   coverage remains in the auth suites; no production hashing cost changes.

3. **Do not adopt sequential batching or per-worker DB parallelism** (see table).

4. **Defer suite consolidation and app-boot sharing.** They reduce total work but
   change test structure; they are not needed to hit the wall-time target.

## Acceptance criteria

- All 571 DB spec files execute exactly once across the four shards; the run still
  reports 6264 passed / 20 skipped (or a strictly explained superset).
- The required check named `integration` still reports, and fails if any shard fails.
- Normal-PR integration wall time p90 **≤ 7 minutes** (target ~6m).
- No new skips, no weakened assertions, no lowered production bcrypt cost.
- Real `/api/auth/register` and `/api/auth/login` paths remain exercised by the auth
  and seed suites.

## Verification record (local, 2026-11-10)

Runner: macOS, 10 CPUs, 25.7 GB RAM, Node 22, Bun 1.4.4, compose Postgres 16 on
port 5433.

### Fixture cohort (adoption evidence)

Two world-seeded files (`assistant-thread-direct`, `fleet-approvals-api`), three
alternating runs each:

| Variant | Command duration | Tests bucket |
| --- | ---: | ---: |
| Control (before direct seeding) | 12.52s / 10.68s / 10.07s | 6.61s / 5.71s / 5.83s |
| Candidate (after direct seeding) | 7.93s / 7.56s / 7.81s | 2.79s / 3.39s / 2.72s |

The two-file cohort loses ~2.7–3.0s of `beforeAll` work per run (~1.4–1.5s per
world-seeded file), with identical 28 test identities. The whole fleet directory
(217 matched files, 1841 tests) passed in 442.56s after the change; the API unit
suite passed 854 files / 11,389 tests.

### Full-file identity across fresh processes

The single-process full command (`bun run test:integration`) is **not a valid gate
on this workstation**: late in the run, ten files hit Vitest's 10s `beforeAll` hook
timeout, `app` stayed undefined, and the worker exited unexpectedly
(`[vitest-pool]: Worker forks emitted error`) after 358–372 of 571 files. The
failures are late-run hook timeouts and derived `close()` TypeErrors, not assertion
failures; the same files pass in a fresh process. This is the long-lived-worker
degradation that bounded shards address.

Coverage was therefore verified by running every directory (and the 17 root-level
specs) in fresh processes: **571/571 files passed**, including the four auth files
run unchanged in Task 3. One transient `407 Proxy Authentication Required` in
`permissions/membership-agent-roster.integration.spec.ts` passed when the file ran
alone; it is the known proxy-flake documented in `test/helpers/no-env-proxy.ts`, and
that file does not use the changed fixture.

### Consequence for shard width

Four shards put ~143 files in each worker, well below the ~360-file point where the
single process degraded locally. The CI run remains the authoritative identity
check (sum of per-shard `Test Files` must be 571).
