# Fleet S1 Slice 2a — Jobs: Dispatch, Placement, Cancel, Requeue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** Slice 2 was planned as one document (Tasks 0-20) and split into 2a and 2b after its review (READY AFTER FIXES, all applied). Task numbers are kept from the unified plan so references between the two plans stay valid: **2a = Tasks 0-12, 18, 20a; 2b = Tasks 0b, 13-17, 19, 20b.** Decision numbers D1-D20 are shared.

**Goal:** Ship the user side of fleet jobs as one PR on `feat/fleet-s1-slice2a-jobs`: the four job tables and the active-job index, placement with compare-and-set assignment, dispatch / list / detail / timeline / cancel / requeue, `fleet_job` live events, project-scoped fleet activity, runner/repo delete guards, and the folded issues #159-#162. Assignment queues `ASSIGN`/`CANCEL` commands that no runner consumes until 2b ships the sync endpoint, the same way slice 1 shipped runner admin before any runner existed.

**Architecture:** `apps/api/src/fleet/jobs/` holds the repository, the pure state table and placement rules, `JobTransitionsService` (every state change, server timeline event, activity, live event), `PlacementService` with the in-process `RunnerNotifier`, and the project-scoped controller. Every mutating path is one short `txManager.run`; live events and runner wake-ups go out after commit.

**Tech Stack:** NestJS 11 (Fastify in production, Express in the HTTP test harness) + Prisma 6.19 on PostgreSQL 16, `@nathapp/nestjs-*` 3.3.0, `@nestjs/schedule`, Jest + ts-jest + supertest, Bun 1.4.2 workspaces + Turborepo.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`. Slice 1 plan: `docs/superpowers/plans/2026-09-29-fleet-s1-slice-1-foundation.md` (decisions D1-D10 still hold unless changed here). Sections for 2a: §1 live events, §2, §2.1, §2.2, §3.4 job rows, §4, §5.1, §5.3 cancel/requeue, §5.4, §6.1, §6.4, §8 activity. Companion plan: `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2b-runner-sync.md`.

## Global Constraints

From the spec, the repo rules (`.nax/context.md`, `.nax/mono/apps/api/context.md`) and slice 1; every task includes them.

- API stays single-instance. Postgres only. Long-poll notifier and sweeps are in process.
- **No Prisma enums** (repo rule, slice 1 D1): enum-like columns are `String` with the values in a comment; the values live as `const` objects in `apps/api/src/common/enums.ts`.
- `BigInt` and `Decimal` never reach JSON: every response DTO maps them to `string` and Swagger declares `type: String` (spec §2).
- The API imports `@nathapp/fleet-protocol` with `import type` only (slice 1 D3, enforced by `protocol.spec.ts`).
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses with i18n prefixes, repository (interface + `Symbol` token in `domain/*.domain.ts`) → service → controller, `txManager.run` for multi-write work. Inside `txManager.run`, `this.prisma.client` is the transaction client (nestjs-prisma patches it with an AsyncLocalStorage proxy), including `$queryRaw`/`$executeRaw`.
- A unique violation aborts the Postgres transaction: any lookup after a caught `P2002` runs **outside** the `txManager.run` that failed.
- User-facing strings: `apps/api/src/i18n/{en,zh}/fleet.json`, both languages, same keys.
- Response DTO fields are string-literal unions, never a TS `enum` from a package.
- Secrets (git tokens, runner keys) are never logged, never stored, never put in `FleetCommand.payload` or `FleetActivity.payload` (`FleetActivityService.record` already throws on secret-looking keys).
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (Task 20a).
- All ten CI checks are required on `main`.

Plan-level rules:

- Branch `feat/fleet-s1-slice2a-jobs` in the main checkout (`repos/koda`), from `main` @ `7929924b` (slice 1, #156). Nothing else in development in parallel.
- API specs: `cd apps/api && bun run test:scoped <paths>` (sets `KODA_DB_TESTS=1` for integration paths). Never two DB jest runs at once. Start the test DB once: `cd apps/api && bun run test:db:up`.
- ts-jest type-checks every spec. After any signature change run `cd apps/api && bunx tsc --noEmit -p tsconfig.json` and fix every broken spec in the same task.
- Integration suites that log in more than four times or enroll more than nine runners copy the throttler reset from `test/integration/fleet/runner-enrollment.integration.spec.ts` (`beforeEach`).
- No emojis. Conventional commits, no attribution trailer.

## Plan decisions beyond the spec

This is the slice 2 decision register. Rows marked **(2b)** are implemented by the 2b plan and listed here so the data model built in 2a already fits them.

| # | Decision | Why |
|:--|:--|:--|
| D1 | Slice 1 D1 continues: `FleetJob.state`, `.command`, `FleetCommand.type`, `.ackResult` are `String` columns; values in `common/enums.ts` (`FleetJobState`, `FleetJobKind`, `FleetCommandType`, `FleetCommandAckResult`). | Repo rule. |
| D2 | `FleetJobEvent` gets a **server** `seq` (timeline order, from `FleetJob.eventSeq`) plus `leaseEpoch` and a nullable `runnerSeq`. Runner dedup key = `(jobId, leaseEpoch, runnerSeq)`; timeline key = `(jobId, seq)`. `FleetJob.ackedRunnerSeq` holds the cumulative ack for the current epoch and resets to 0 on every assignment. | Spec §2 keys events on `(jobId, seq)`, but (a) a requeued job's new runner starts again at seq 1 and (b) the server writes `state` events too (§5.4). One runner-seq namespace per epoch, one server timeline. |
| D3 (2b) | `FleetJobArtifact` gets `leaseEpoch` and `@@unique([jobId, kind, leaseEpoch])`; download serves the highest epoch. Keys are per attempt, `jobs/<jobId>/<epoch>/<uuid>.tar.gz` (spec §8 drew `jobs/<jobId>/<epoch>.tar.gz`); the row is repointed in the recording transaction and the replaced file deleted after commit. | "Re-upload for the same job and epoch replaces" (spec §3.3) needs the epoch on the row; a per-attempt key means a failed or fenced re-upload can never overwrite or delete the last good bundle. |
| D4 | Server-owned terminal transitions of a job that had a runner (cancel of an unacked assign, sweep CRASHED, rejected READOPT) **bump `leaseEpoch`**, so a late runner is fenced (§6.2) and gets `ABANDON`. Every transition into a terminal state marks that job's pending non-`ABANDON` commands `ackResult = 'withdrawn'`. | Without the bump, a runner that received an assign we then cancelled still matches `(runnerId, leaseEpoch)` and could keep writing. |
| D5 (2b) | Sync step 1 (spec §3.2) is several short transactions — one per reported job, one for acks, one for boot reconcile, one for placement fill — none held across the long-poll wait or forge HTTP. Git tokens are minted after those commit. | Keeps locks short; avoids lock-order cycles between job rows and runner rows. |
| D6 (2b) | A runner-reported transition not in the §5.4 table, and an event whose payload is malformed, is **stored and not applied** (the ack advances), logged, and recorded as `job.event_rejected` activity. Only a duplicate `runnerSeq` with a different payload blocks the ack (spec §3.2). | Refusing to store would make the runner resend the same bad event forever. |
| D7 (2b) | Additive protocol fields (protocol version stays 1): response `unknownJobIds` (jobs the server does not know: the runner abandons them) and `gitTokenErrors: [{jobId, reason}]`; the `ASSIGN` payload shape is fixed in the package. | The spec's `ABANDON` needs a job row (FK); a mint failure needs a reason the daemon can log. |
| D8 (2b) | `ASSIGN` acked `rejected` → job FAILED (`stateReason = 'assign rejected: …'`). `CANCEL` acked `rejected` (runner does not hold the job) → CANCELLED (`'cancel: runner does not hold job'`). Acks are matched to the command row (`runnerId`, `leaseEpoch`); an ack whose job has since moved epochs is marked `stale` and queues `ABANDON`. | Spec defines ack semantics only for `READOPT`. |
| D9 | New CASL subject `FleetJob`: global ADMIN and project ADMIN `manage`; project DEVELOPER `create` + `update`; agents nothing (S1 dispatch is human-only). Read routes use `ProjectMembershipGuard` alone (any member). Cancel: `update` on `FleetJob` **or** requester (checked in the service with the resolved ability). | Spec §2.2. Agents are not named in §2.2; the conservative reading is "no". |
| D10 | Duplicate active job → 409 whose message carries the active job id (`fleet.jobs.409` with `{activeJobId}`); the job list gains a `feature` filter so a client can fetch it. | The global exception filter emits only `{ret, message}`; there is no data field for the id. |
| D11 (2b) | The silence sweep crashes `UPLOADING` jobs too, and runs only when `FLEET_SWEEP_ENABLED` (default on, off under `NODE_ENV=test`); tests call `sweep(now)`. | An `UPLOADING` job on a dead machine would otherwise never end. Same default rule as the outbox relay. |
| D12 (2b) | Bundle upload body: production (Fastify) registers an `application/gzip` pass-through content parser in `main.ts`; the HTTP test harness is Express (`bootHttpApp` → `NestFactory.create` default), where the request itself is the stream. The handler reads `req.body` when it is a stream, else `req`. A unit spec drives the Fastify parser with `inject`. | `bootHttpApp` and `main.ts` use different adapters; both must work. |
| D13 (2b) | The 1 MiB sync body cap (spec §3.2) is the existing global JSON cap (`registerRawBodyHook`, KODA-12) plus Fastify's default `bodyLimit`; nothing new, and not re-tested on the Express harness. | Already enforced in production. |
| D14 | `FleetActivity` gains `projectId String?` (set on job rows) so `GET /fleet/activity` can show project members their projects' job rows (spec §8; slice 1 D9 deferred it). Non-admin users are filtered to their memberships; agents get 403. | A join through `jobId` has no FK and no index. |
| D15 | `FleetJob.repoId` cascades on repo delete (delete is refused while any job is non-terminal); artifact files of cascaded jobs stay on disk (artifact retention is S2a). `runnerId`/`pinnedRunnerId` set null on runner delete (spec §2). | Spec §2 allows deleting a repo whose jobs are all terminal. |
| D16 | **#161 ruling:** `nax.protocols` must be non-empty and unique; at most 64 profiles, names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; at most 16 providers per profile; at most 64 credentials; `expires`, when present, must parse as a date. Dispatch `profiles` use the same name rule, at most 8, and may not start with `koda-job-` (reserved for the runner's per-job profile, spec §5.2 step 3). | Placement needs a runnable protocol and a comparable expiry; a bounded name set keeps the check cheap. |
| D17 | GitHub commit identity in the `ASSIGN` payload: `<slug>[bot]` / `<slug>[bot]@users.noreply.github.com` (no bot-user-id lookup). GitLab: `FLEET_GITLAB_BOT_NAME` / `FLEET_GITLAB_BOT_EMAIL`. | The id-prefixed noreply form needs an extra API call; the plain form is valid for commits. |
| D18 | A pinned runner id that does not exist → 404 `fleet.runners`; a pinned runner with a permanent misfit → 422 `fleet.dispatch` with the rule. | Spec §4 names the 422 case only. |
| D19 (2b) | Attribution (spec §7.1) takes owner/name from the job's `FleetRepo` and only the PR/MR number from `resultPrUrl` (untrusted runner input); an `attributedAt` compare-and-set makes it one comment. | A runner must not be able to make koda comment on another repo. |
| D20 (2b) | The runner sync route skips the global 100/min IP throttle (defined in 2b Task 14). | Runners share NAT addresses and sync often; a 429 delays acks and cancels. |

## Review Focus

1. **Two machines race for one job**: a dispatch-time placement and a fill for one runner run at once; exactly one `ASSIGN` exists and `leaseEpoch` moved once. Task 10.
2. **Cancel of an assigned job whose runner never took it**: the job ends CANCELLED, the `ASSIGN` is withdrawn and the epoch is bumped, so a runner that got the assign late is fenced once 2b lands. Task 12.
3. **Requeue into an active duplicate**: a FAILED job requeued while another job for the same (repo, feature) is QUEUED answers 409 naming that job, and the requeued job stays FAILED. Task 12.
4. **Who may cancel**: a VIEWER who requested the job can cancel it; another VIEWER cannot; a finished job answers 409, never 500. Task 12.
5. **Pinned runner verdicts**: unknown pin 404, a permanently unfit pin (disabled, tools, sandbox, provider) 422, an offline pin queues. Task 11.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `apps/api/src/config/fleet.config.ts`, `env.validation.ts`, `src/common/test-helpers/fleet-config.ts` (new), `global-stubs.module.ts` | Slice 2 settings (2b's settings included, so config lands once) | 1 |
| `apps/api/src/fleet/git-broker/fleet-http-client.ts`, `test/helpers/fake-forge.ts` | #160 | 2 |
| `apps/api/src/fleet/common/capabilities.ts`, `packages/fleet-protocol/src/index.ts` | #161 | 3 |
| `apps/api/src/fleet/runners/enrollment-retention.processor.ts` (new), `prisma-runner.repository.ts`, `domain/runner.domain.ts` | #162 | 4 |
| `packages/fleet-protocol/src/index.ts`, `apps/api/src/fleet/common/protocol.ts`, `apps/api/src/common/enums.ts`, `apps/api/src/fleet/jobs/job-state.ts` (new) | Wire types (2b's sync types included), enums, transition table | 5 |
| `apps/api/prisma/schema.prisma`, `prisma/migrations/20260930090000_fleet_jobs/migration.sql` (new), `test/helpers/partial-indexes.ts` (new), `test/global-setup.ts` | Job tables (all four, so 2b needs no migration) + partial index | 6 |
| `apps/api/src/fleet/jobs/placement-rules.ts` (new) | Pure placement rules | 7 |
| `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, `prisma-fleet-job.repository.ts` (new) | Job, event, command, artifact persistence | 8 |
| `apps/api/src/live/live-event.ts`, `apps/api/src/fleet/jobs/job-transitions.service.ts`, `fleet-job-live.publisher.ts` (new) | State changes, server events, live events | 9 |
| `apps/api/src/fleet/jobs/placement.service.ts`, `runner-notifier.ts`, `assign-payload.ts`, `git-broker/clone-url.ts` (new), `test/helpers/fleet-fixtures.ts` (new) | Assignment with CAS | 10 |
| `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `fleet-jobs.controller.ts`, `dto/*`, `fleet-jobs.module.ts`, CASL factory | Dispatch and reads | 11 |
| same service/controller | Cancel, requeue | 12 |
| `apps/api/src/fleet/activity/*`, runners/repos services and repositories | Activity view, delete guards | 18 |
| `openapi.json`, `.nax/mono/apps/api/context.md`, slice 1 plan (#159) | Contract, guidance | 20a |

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Confirm the branch and base**

Run: `git -C repos/koda status -sb && git -C repos/koda log --oneline -1`
Expected: `## feat/fleet-s1-slice2a-jobs` and `7929924b feat(fleet): S1 slice 1 — protocol, runner identity, repo registry (#156)`.

- [ ] **Step 2: Start the test DB and record baselines**

```bash
cd apps/api && bun run test:db:up
bun run test 2>&1 | tail -5                                  # api unit
bun run test:scoped test/integration/fleet 2>&1 | tail -5    # fleet integration
bunx tsc --noEmit -p tsconfig.json                           # must be clean
```
Record the suite/test counts for the PR description ("Baseline").

---

### Task 1: Fleet config for slice 2

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`, `apps/api/src/config/env.validation.ts`, `apps/api/src/config/fleet.config.spec.ts`
- Create: `apps/api/src/common/test-helpers/fleet-config.ts`
- Modify: `apps/api/src/common/test-helpers/global-stubs.module.ts:80-90` (`mockFleetConfig`)

**Interfaces:**
- Produces: `IFleetConfig` gains `runnerOfflineSec: number`, `jobCrashSec: number`, `syncWaitMs: number`, `sweepEnabled: boolean`, `bundleMaxBytes: number`, `artifactDir: string` (absolute), `gitlabBotName: string`, `gitlabBotEmail: string`, `enrollmentRetentionDays: number | null`.
- Produces: `testFleetConfig(overrides?: Partial<IFleetConfig>): IFleetConfig` for unit specs.

- [ ] **Step 1: Write the failing tests** (append to `fleet.config.spec.ts`)

```ts
  it('defaults the slice 2 settings outside tests', () => {
    process.env.NODE_ENV = 'production';
    for (const k of ['FLEET_RUNNER_OFFLINE_SEC', 'FLEET_JOB_CRASH_SEC', 'FLEET_SYNC_WAIT_MS', 'FLEET_SWEEP_ENABLED',
      'FLEET_BUNDLE_MAX_BYTES', 'FLEET_ARTIFACT_DIR', 'FLEET_GITLAB_BOT_NAME', 'FLEET_GITLAB_BOT_EMAIL',
      'FLEET_ENROLLMENT_RETENTION_DAYS']) delete process.env[k];
    const cfg = fleetConfig();
    expect(cfg).toEqual(expect.objectContaining({
      runnerOfflineSec: 90, jobCrashSec: 300, syncWaitMs: 25_000, sweepEnabled: true,
      bundleMaxBytes: 200 * 1024 * 1024, gitlabBotName: 'koda-fleet', enrollmentRetentionDays: 30,
    }));
    expect(cfg.artifactDir).toMatch(/data[/\\]fleet-artifacts$/);
    expect(cfg.artifactDir.startsWith('/') || /^[A-Z]:/i.test(cfg.artifactDir)).toBe(true);
  });

  it('turns the sweep and the enrollment purge off under NODE_ENV=test unless overridden', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.FLEET_SWEEP_ENABLED;
    delete process.env.FLEET_ENROLLMENT_RETENTION_DAYS;
    expect(fleetConfig()).toEqual(expect.objectContaining({ sweepEnabled: false, enrollmentRetentionDays: null }));
    process.env.FLEET_SWEEP_ENABLED = 'TRUE';
    process.env.FLEET_ENROLLMENT_RETENTION_DAYS = '7';
    expect(fleetConfig()).toEqual(expect.objectContaining({ sweepEnabled: true, enrollmentRetentionDays: 7 }));
    process.env.FLEET_ENROLLMENT_RETENTION_DAYS = '0';
    expect(fleetConfig().enrollmentRetentionDays).toBeNull();
  });

  it.each([
    ['FLEET_RUNNER_OFFLINE_SEC', '5'],
    ['FLEET_JOB_CRASH_SEC', '10'],
    ['FLEET_SYNC_WAIT_MS', '-1'],
    ['FLEET_SWEEP_ENABLED', 'yes'],
    ['FLEET_BUNDLE_MAX_BYTES', '10'],
    ['FLEET_GITLAB_BOT_EMAIL', 'not-an-email'],
    ['FLEET_ENROLLMENT_RETENTION_DAYS', '-3'],
  ])('refuses boot on a bad slice 2 value %s=%s', (key, value) => {
    expect(() => validate({ ...BASE, [key]: value })).toThrow();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts`
Expected: FAIL (`runnerOfflineSec` undefined; Joi accepts the bad values).

- [ ] **Step 3: Implement**

Replace `apps/api/src/config/fleet.config.ts` with:

```ts
import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';
import { resolve } from 'path';

export const FLEET_CFG = 'fleet';

export interface IFleetConfig {
  githubAppId: string | undefined;
  githubAppPrivateKeyFile: string | undefined;
  githubAppSlug: string | undefined;
  enrollmentTtlSec: number;
  httpTimeoutMs: number;
  /** A runner is offline after this many seconds without a sync (spec §4, §5.3). */
  runnerOfflineSec: number;
  /** An active job of a silent runner becomes CRASHED after this many seconds (spec §5.3). */
  jobCrashSec: number;
  /** Long-poll wait when a sync has nothing to return (spec §3.2); 0 answers at once. */
  syncWaitMs: number;
  /** In-process silence sweep (plan D11). */
  sweepEnabled: boolean;
  bundleMaxBytes: number;
  /** Absolute root of LocalDiskArtifactStore (spec §8). */
  artifactDir: string;
  gitlabBotName: string;
  gitlabBotEmail: string;
  /** Days a consumed or expired enrollment row survives (#162); null disables the purge. */
  enrollmentRetentionDays: number | null;
}

export class FleetConfigSchema {
  @IsOptional() @IsString() GITHUB_APP_ID: string;
  @IsOptional() @IsString() GITHUB_APP_PRIVATE_KEY_FILE: string;
  @IsOptional() @IsString() GITHUB_APP_SLUG: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_TTL_SEC: string;
  @IsOptional() @IsString() FLEET_HTTP_TIMEOUT_MS: string;
  @IsOptional() @IsString() FLEET_RUNNER_OFFLINE_SEC: string;
  @IsOptional() @IsString() FLEET_JOB_CRASH_SEC: string;
  @IsOptional() @IsString() FLEET_SYNC_WAIT_MS: string;
  @IsOptional() @IsString() FLEET_SWEEP_ENABLED: string;
  @IsOptional() @IsString() FLEET_BUNDLE_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_ARTIFACT_DIR: string;
  @IsOptional() @IsString() FLEET_GITLAB_BOT_NAME: string;
  @IsOptional() @IsString() FLEET_GITLAB_BOT_EMAIL: string;
  @IsOptional() @IsString() FLEET_ENROLLMENT_RETENTION_DAYS: string;
}

const int = (key: string, fallback: number): number => Number.parseInt(process.env[key] ?? String(fallback), 10);
const isTest = (): boolean => process.env['NODE_ENV'] === 'test';

/** Same default rule as OUTBOX_RETENTION_DAYS: 30 outside tests, off in tests, 0 is the kill switch. */
function retentionDays(): number | null {
  const raw = process.env['FLEET_ENROLLMENT_RETENTION_DAYS'];
  if (raw === undefined) return isTest() ? null : 30;
  const days = Number.parseInt(raw, 10);
  return days > 0 ? days : null;
}

export const fleetConfig = registerAs(FLEET_CFG, (): IFleetConfig => {
  validateUtil(process.env, FleetConfigSchema);
  const sweep = process.env['FLEET_SWEEP_ENABLED'];
  return {
    githubAppId: process.env['GITHUB_APP_ID'] || undefined,
    githubAppPrivateKeyFile: process.env['GITHUB_APP_PRIVATE_KEY_FILE'] || undefined,
    githubAppSlug: process.env['GITHUB_APP_SLUG'] || undefined,
    enrollmentTtlSec: int('FLEET_ENROLLMENT_TTL_SEC', 86_400),
    httpTimeoutMs: int('FLEET_HTTP_TIMEOUT_MS', 10_000),
    runnerOfflineSec: int('FLEET_RUNNER_OFFLINE_SEC', 90),
    jobCrashSec: int('FLEET_JOB_CRASH_SEC', 300),
    syncWaitMs: int('FLEET_SYNC_WAIT_MS', 25_000),
    sweepEnabled: sweep !== undefined ? sweep.toLowerCase() === 'true' : !isTest(),
    bundleMaxBytes: int('FLEET_BUNDLE_MAX_BYTES', 200 * 1024 * 1024),
    artifactDir: resolve(process.env['FLEET_ARTIFACT_DIR'] || './data/fleet-artifacts'),
    gitlabBotName: process.env['FLEET_GITLAB_BOT_NAME'] || 'koda-fleet',
    gitlabBotEmail: process.env['FLEET_GITLAB_BOT_EMAIL'] || 'koda-fleet@users.noreply.invalid',
    enrollmentRetentionDays: retentionDays(),
  };
});

export function isGitHubAppConfigured(cfg: Pick<IFleetConfig, 'githubAppId' | 'githubAppPrivateKeyFile' | 'githubAppSlug'>): boolean {
  return Boolean(cfg.githubAppId && cfg.githubAppPrivateKeyFile && cfg.githubAppSlug);
}
```

In `env.validation.ts`, after `FLEET_HTTP_TIMEOUT_MS`:

```ts
  FLEET_RUNNER_OFFLINE_SEC: Joi.number().integer().min(10).max(3_600).optional(),
  FLEET_JOB_CRASH_SEC: Joi.number().integer().min(30).max(86_400).optional(),
  FLEET_SYNC_WAIT_MS: Joi.number().integer().min(0).max(60_000).optional(),
  FLEET_SWEEP_ENABLED: Joi.string().pattern(/^(true|false)$/i).optional(),
  FLEET_BUNDLE_MAX_BYTES: Joi.number().integer().min(1_024).max(2_147_483_647).optional(),
  FLEET_ARTIFACT_DIR: Joi.string().optional(),
  FLEET_GITLAB_BOT_NAME: Joi.string().max(100).optional(),
  FLEET_GITLAB_BOT_EMAIL: Joi.string().email({ tlds: false }).optional(),
  FLEET_ENROLLMENT_RETENTION_DAYS: Joi.number().integer().min(0).max(3_650).optional(),
```

Create `apps/api/src/common/test-helpers/fleet-config.ts`:

```ts
import type { IFleetConfig } from '../../config/fleet.config';

/** A complete IFleetConfig for unit specs; override only what the spec cares about. */
export function testFleetConfig(overrides: Partial<IFleetConfig> = {}): IFleetConfig {
  return {
    githubAppId: undefined,
    githubAppPrivateKeyFile: undefined,
    githubAppSlug: undefined,
    enrollmentTtlSec: 86_400,
    httpTimeoutMs: 10_000,
    runnerOfflineSec: 90,
    jobCrashSec: 300,
    syncWaitMs: 0,
    sweepEnabled: false,
    bundleMaxBytes: 200 * 1024 * 1024,
    artifactDir: '/tmp/koda-fleet-artifacts-unit',
    gitlabBotName: 'koda-fleet',
    gitlabBotEmail: 'koda-fleet@users.noreply.invalid',
    enrollmentRetentionDays: null,
    ...overrides,
  };
}
```

In `global-stubs.module.ts`, replace the literal `mockFleetConfig` object with `export const mockFleetConfig: IFleetConfig = testFleetConfig();` (keep the `export`; import the helper). Then run `grep -rn "enrollmentTtlSec:" apps/api/src apps/api/test` and switch every other hand-built `IFleetConfig` literal in specs to `testFleetConfig({...})`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/config/fleet.config.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config apps/api/src/common/test-helpers
git commit -m "feat(fleet): slice 2 settings (offline, crash, sync wait, sweep, bundles, retention)"
```

---

### Task 2: #160 — `provider_error` for an unparseable provider body

**Files:**
- Modify: `apps/api/src/fleet/git-broker/fleet-http-client.ts:29-38`, `apps/api/src/fleet/git-broker/fleet-http-client.spec.ts`
- Modify: `apps/api/test/helpers/fake-forge.ts` (`FakeReply.rawBody`)

**Interfaces:**
- Produces: `FakeReply.rawBody?: string` — sent verbatim instead of `JSON.stringify(body)`.

- [ ] **Step 1: Write the failing test** (append to `fleet-http-client.spec.ts`)

```ts
  it('maps a 200 whose body is not JSON to provider_error, not provider_unreachable (#160)', async () => {
    forge.routes.set('GET /html', () => ({ status: 200, rawBody: '<html>proxy error</html>', headers: { 'content-type': 'text/html' } }));
    await expect(client.request('GET', `${forge.url}/html`, {})).rejects.toMatchObject({ reason: 'provider_error' });
  });

  it('returns an undefined body for an empty 204', async () => {
    forge.routes.set('GET /empty', () => ({ status: 204 }));
    await expect(client.request('GET', `${forge.url}/empty`, {})).resolves.toEqual({ status: 204, body: undefined });
  });
```

- [ ] **Step 2: Add `rawBody` to the fake forge**

In `fake-forge.ts`: add `rawBody?: string` to `FakeReply`; replace both `JSON.stringify(reply.body)` computations with

```ts
const payload = reply.rawBody ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
```

and use `payload` in the stall and the normal branch.

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/git-broker/fleet-http-client.spec.ts`
Expected: FAIL — reason is `provider_unreachable`.

- [ ] **Step 4: Implement**

Replace the body-reading block of `FleetHttpClient.request` (from `let parsed` to the final `return`) with:

```ts
    let text: string;
    try {
      text = await response.text();
    } catch {
      // The timeout signal bounds the whole exchange, not just the fetch: a provider that
      // stalls or resets mid-body maps to provider_unreachable (plan D8, spec §7.1).
      throw new RepoCheckException('provider_unreachable');
    }
    if (!text) return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      // #160: the provider answered, but not with JSON (for example a proxy's HTML error page).
      throw new RepoCheckException('provider_error');
    }
```

- [ ] **Step 5: Run to verify pass, then the repo-check suites**

Run: `cd apps/api && bun run test:scoped src/fleet/git-broker && bun run test:scoped test/integration/fleet/fleet-repos.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/git-broker apps/api/test/helpers/fake-forge.ts
git commit -m "fix(fleet): report provider_error for unparseable provider bodies (#160)"
```

---

### Task 3: #161 — tighten runner capabilities

**Files:**
- Modify: `apps/api/src/fleet/common/capabilities.ts`, `apps/api/src/fleet/common/capabilities.spec.ts`
- Modify: `packages/fleet-protocol/src/index.ts` (doc comments on `RunnerCapabilities`)

**Interfaces:**
- Produces: `PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, `MAX_PROFILES = 64`, `MAX_PROVIDERS_PER_PROFILE = 16`, `MAX_CREDENTIALS = 64` (exported from `capabilities.ts`; Task 11 reuses `PROFILE_NAME_RE`).

- [ ] **Step 1: Write the failing tests** (extend the `it.each` table in `capabilities.spec.ts`)

```ts
    ['no protocols (#161)', { ...valid, nax: { version: '1', protocols: [] } }],
    ['duplicate protocols', { ...valid, nax: { version: '1', protocols: ['native', 'native'] } }],
    ['a profile name with a slash', { ...valid, profiles: { 'a/b': valid.profiles.native } }],
    ['a 65-character profile name', { ...valid, profiles: { ['p'.repeat(65)]: valid.profiles.native } }],
    ['65 profiles', { ...valid, profiles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, valid.profiles.native])) }],
    ['17 providers in a profile', { ...valid, profiles: { p: { protocol: 'native', providers: Array.from({ length: 17 }, (_, i) => `x${i}`), sandbox: false } } }],
    ['65 credentials', { ...valid, credentials: Array.from({ length: 65 }, (_, i) => ({ providerId: `x${i}`, kind: 'api-key' })) }],
    ['an unparseable expiry', { ...valid, credentials: [{ providerId: 'x', kind: 'oauth', expires: 'soon' }] }],
```

and add:

```ts
  it('keeps a parseable credential expiry', () => {
    const raw = { ...valid, credentials: [{ providerId: 'claude', kind: 'oauth', expires: '2026-10-01T00:00:00.000Z' }] };
    expect(parseCapabilities(raw).credentials).toEqual(raw.credentials);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/common/capabilities.spec.ts`
Expected: FAIL on the new rows.

- [ ] **Step 3: Implement** (in `capabilities.ts`)

Add the exported constants after `MAX_CAPABILITIES_BYTES`:

```ts
/** #161: bounded names (same rule as dispatch profiles, Task 11) and bounded collections. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_PROFILES = 64;
export const MAX_PROVIDERS_PER_PROFILE = 16;
export const MAX_CREDENTIALS = 64;
```

Change `parseProfile` to check the name and provider count:

```ts
function parseProfile(name: string, v: unknown): ProfileNeeds {
  if (!PROFILE_NAME_RE.test(name)) fail(`profile name ${name.slice(0, 70)}`);
  if (!isObj(v) || !PROTOCOLS.includes(v.protocol as NaxProtocol) || !isStrArray(v.providers) || !isBool(v.sandbox)) {
    fail(`profile ${name}`);
  }
  if ((v.providers as string[]).length > MAX_PROVIDERS_PER_PROFILE) fail(`profile ${name} providers`);
  return { protocol: v.protocol as NaxProtocol, providers: [...(v.providers as string[])], sandbox: v.sandbox as boolean };
}
```

Replace the `nax` check line with:

```ts
  if (
    !isObj(nax) || !isStr(nax.version) || !Array.isArray(nax.protocols) || nax.protocols.length === 0 ||
    !nax.protocols.every((p) => PROTOCOLS.includes(p)) || new Set(nax.protocols).size !== nax.protocols.length
  ) fail('nax');
```

After `if (!isObj(profiles)) fail('profiles');` add `if (Object.keys(profiles).length > MAX_PROFILES) fail('too many profiles');`; after `if (!Array.isArray(credentials)) fail('credentials');` add `if (credentials.length > MAX_CREDENTIALS) fail('too many credentials');`. In the credential map, extend the check:

```ts
    if (!isObj(c) || !isStr(c.providerId) || !isStr(c.kind) || (c.expires !== undefined && (!isStr(c.expires) || Number.isNaN(Date.parse(c.expires))))) fail(`credential ${i}`);
```

In `packages/fleet-protocol/src/index.ts`, document the rules on `RunnerCapabilities`:

```ts
/**
 * Validated by the server (#161): `nax.protocols` non-empty and unique; at most 64 profiles
 * named /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, each with at most 16 providers; at most 64
 * credentials; `expires` must parse as a date. Whole report at most 64 KiB.
 */
```

- [ ] **Step 4: Run to verify pass, including enrollment**

Run: `cd apps/api && bun run test:scoped src/fleet/common test/integration/fleet/runner-enrollment.integration.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/common packages/fleet-protocol/src/index.ts
git commit -m "fix(fleet): require a nax protocol and bound profile names in capabilities (#161)"
```

---

### Task 4: #162 — enrollment retention purge

**Files:**
- Modify: `apps/api/src/fleet/runners/domain/runner.domain.ts`, `apps/api/src/fleet/runners/prisma-runner.repository.ts`, `apps/api/src/fleet/runners/runners.module.ts`
- Create: `apps/api/src/fleet/runners/enrollment-retention.processor.ts`, `enrollment-retention.processor.spec.ts`
- Test: `apps/api/test/integration/fleet/enrollment-retention.integration.spec.ts` (new)

**Interfaces:**
- Produces: `IRunnerRepository.deleteSpentEnrollmentsBefore(before: Date): Promise<number>` — deletes rows with `usedAt < before`, and never-used rows with `expiresAt < before`.
- Produces: `EnrollmentRetentionProcessor.scheduledPurge(): Promise<void>`, cron `'30 4 * * *'`.

- [ ] **Step 1: Write the failing unit test** — `enrollment-retention.processor.spec.ts`

```ts
import { Reflector } from '@nestjs/core';
import { EnrollmentRetentionProcessor } from './enrollment-retention.processor';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

describe('EnrollmentRetentionProcessor', () => {
  const repo = { deleteSpentEnrollmentsBefore: jest.fn() };
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('runs daily at 04:30 (03:00 memory governance, 04:00 outbox retention)', () => {
    const p = new EnrollmentRetentionProcessor(repo as never, testFleetConfig());
    expect(new Reflector().get('SCHEDULE_CRON_OPTIONS', p.scheduledPurge)).toMatchObject({ cronTime: '30 4 * * *' });
  });

  it('deletes rows spent before the retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T04:30:00.000Z'));
    repo.deleteSpentEnrollmentsBefore.mockResolvedValue(3);
    await new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: 30 })).scheduledPurge();
    expect(repo.deleteSpentEnrollmentsBefore).toHaveBeenCalledWith(new Date('2026-10-01T04:30:00.000Z'));
  });

  it('does nothing when retention is disabled', async () => {
    await new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: null })).scheduledPurge();
    expect(repo.deleteSpentEnrollmentsBefore).not.toHaveBeenCalled();
  });

  it('swallows a failed purge (the next night is the retry)', async () => {
    repo.deleteSpentEnrollmentsBefore.mockRejectedValue(new Error('db down'));
    await expect(new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: 30 })).scheduledPurge()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing integration test** — `test/integration/fleet/enrollment-retention.integration.spec.ts`

```ts
/**
 * #162 — spent enrollment rows are purged by the two date columns (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/enrollment-retention.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaRunnerRepository } from '../../../src/fleet/runners/prisma-runner.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('enrollment retention (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaRunnerRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deletes used-before-cutoff and expired-unused-before-cutoff rows only', async () => {
    const row = (tokenHash: string, expiresAt: Date, usedAt: Date | null) =>
      prisma.runnerEnrollment.create({ data: { tokenHash, labels: [], expiresAt, usedAt, createdById: 'u' } });
    await row('used-old', day(30), day(1));          // used long ago, expiry in the future -> deleted
    await row('expired-old', day(2), null);          // never used, expired long ago -> deleted
    await row('used-recent', day(30), day(20));      // kept
    await row('open', day(30), null);                // kept: never used, not expired
    await row('expired-recent', day(19), null);      // kept: expired after the cutoff

    expect(await repo.deleteSpentEnrollmentsBefore(day(10))).toBe(2);
    const left = (await prisma.runnerEnrollment.findMany({ select: { tokenHash: true } })).map((r) => r.tokenHash).sort();
    expect(left).toEqual(['expired-recent', 'open', 'used-recent']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/runners/enrollment-retention.processor.spec.ts test/integration/fleet/enrollment-retention.integration.spec.ts`
Expected: FAIL — module not found / method missing.

- [ ] **Step 4: Implement**

`runner.domain.ts`, add to `IRunnerRepository`:

```ts
  /** #162: deletes consumed rows used before `before` and never-used rows that expired before it. */
  deleteSpentEnrollmentsBefore(before: Date): Promise<number>;
```

`prisma-runner.repository.ts`:

```ts
  async deleteSpentEnrollmentsBefore(before: Date): Promise<number> {
    const { count } = await this.db.runnerEnrollment.deleteMany({
      where: { OR: [{ usedAt: { lt: before } }, { usedAt: null, expiresAt: { lt: before } }] },
    });
    return count;
  }
```

`enrollment-retention.processor.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IRunnerRepository, RUNNER_REPOSITORY } from './domain/runner.domain';

/**
 * #162: nightly purge of spent runner enrollment rows, the fleet analogue of the
 * outbox retention purge (#135). A used or expired token is inert; the trail lives
 * in FleetActivity (`enrollment.created`, `runner.enrolled`). 04:30 avoids memory
 * governance (03:00) and outbox retention (04:00). Errors are logged and swallowed.
 */
@Injectable()
export class EnrollmentRetentionProcessor {
  private readonly logger = new Logger(EnrollmentRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: Pick<IRunnerRepository, 'deleteSpentEnrollmentsBefore'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'enrollmentRetentionDays'>,
  ) {}

  @Cron('30 4 * * *')
  async scheduledPurge(): Promise<void> {
    const days = this.config.enrollmentRetentionDays;
    if (days === null || days <= 0) return;
    const before = new Date(Date.now() - days * EnrollmentRetentionProcessor.DAY_MS);
    try {
      const deleted = await this.repo.deleteSpentEnrollmentsBefore(before);
      this.logger.log(`Purged ${deleted} spent runner enrollment(s) older than ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Enrollment retention purge failed, will retry next run: ${message}`);
    }
  }
}
```

Register it in `runners.module.ts` `providers`.

- [ ] **Step 5: Run to verify pass**

Run: same as Step 3, then `bunx tsc --noEmit -p tsconfig.json`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/runners apps/api/test/integration/fleet/enrollment-retention.integration.spec.ts
git commit -m "feat(fleet): nightly purge of spent runner enrollment rows (#162)"
```

---

### Task 5: Protocol wire types, API enums, the transition table

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts`
- Modify: `apps/api/src/fleet/common/protocol.ts` (type re-exports), `apps/api/src/fleet/common/protocol.spec.ts`
- Modify: `apps/api/src/common/enums.ts`
- Create: `apps/api/src/fleet/jobs/job-state.ts`, `apps/api/src/fleet/jobs/job-state.spec.ts`

**Interfaces:**
- Produces (package, type-only in the API): `FleetJobStateName`, `FleetJobKindName`, `FleetCommandTypeName`, `RunnerEventType`, `StateEventPayload`, `SnapshotEventPayload`, `LifecycleEventPayload`, `LogEventPayload`, `RunnerEvent`, `JobReport`, `CommandAckResult`, `CommandAck`, `TokenRequest`, `SyncRequest`, `GitIdentity`, `AssignPayload`, `ReadoptPayload`, `AbandonPayload`, `FleetCommandOut`, `GitToken`, `GitTokenError`, `JobAck`, `SyncResponse`.
- Produces (API): `FleetJobState`, `FleetJobKind`, `FleetCommandType`, `FleetCommandAckResult` consts + types in `common/enums.ts`.
- Produces (`job-state.ts`): `ACTIVE_STATES`, `RUNNER_HELD_STATES`, `TERMINAL_STATES` (readonly `FleetJobState[]`), `isTerminal(state: string): boolean`, `canTransition(from: string, to: string, by: TransitionActor): boolean`, `type TransitionActor = 'server' | 'runner'`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/fleet/jobs/job-state.spec.ts`:

```ts
import { ACTIVE_STATES, canTransition, isTerminal, TERMINAL_STATES } from './job-state';

describe('job state table (spec §5.4)', () => {
  it.each([
    ['QUEUED', 'ASSIGNED', 'server'],
    ['QUEUED', 'CANCELLED', 'server'],
    ['ASSIGNED', 'CANCELLED', 'server'],
    ['ASSIGNED', 'CRASHED', 'server'],
    ['RUNNING', 'CRASHED', 'server'],
    ['UPLOADING', 'CRASHED', 'server'], // plan D11
    ['CRASHED', 'QUEUED', 'server'],
    ['FAILED', 'QUEUED', 'server'],
    ['CANCELLED', 'QUEUED', 'server'],
    ['ASSIGNED', 'RUNNING', 'runner'],
    ['ASSIGNED', 'FAILED', 'runner'],
    ['ASSIGNED', 'CANCELLED', 'runner'],
    ['RUNNING', 'UPLOADING', 'runner'],
    ['RUNNING', 'CANCELLED', 'runner'],
    ['UPLOADING', 'COMPLETED', 'runner'],
    ['UPLOADING', 'FAILED', 'runner'],
    ['UPLOADING', 'ESCALATED', 'runner'],
    ['UPLOADING', 'CANCELLED', 'runner'],
  ])('allows %s -> %s by %s', (from, to, by) => {
    expect(canTransition(from, to, by as 'server' | 'runner')).toBe(true);
  });

  it.each([
    ['QUEUED', 'RUNNING', 'runner'],
    ['RUNNING', 'COMPLETED', 'runner'],
    ['RUNNING', 'FAILED', 'runner'],
    ['COMPLETED', 'QUEUED', 'server'],
    ['ESCALATED', 'QUEUED', 'server'],
    ['RUNNING', 'CANCELLED', 'server'],
    ['CRASHED', 'RUNNING', 'runner'],
    ['QUEUED', 'QUEUED', 'server'],
    ['BOGUS', 'QUEUED', 'server'],
    ['constructor', 'QUEUED', 'server'],
  ])('refuses %s -> %s by %s', (from, to, by) => {
    expect(canTransition(from, to, by as 'server' | 'runner')).toBe(false);
  });

  it('partitions the states', () => {
    expect([...ACTIVE_STATES, ...TERMINAL_STATES].sort()).toEqual(
      ['ASSIGNED', 'CANCELLED', 'COMPLETED', 'CRASHED', 'ESCALATED', 'FAILED', 'QUEUED', 'RUNNING', 'UPLOADING'],
    );
    expect(isTerminal('ESCALATED')).toBe(true);
    expect(isTerminal('UPLOADING')).toBe(false);
  });
});
```

Append to `apps/api/src/fleet/common/protocol.spec.ts`:

```ts
import type { FleetCommandTypeName, FleetJobKindName, FleetJobStateName } from '@nathapp/fleet-protocol';
import { FleetCommandType, FleetJobKind, FleetJobState } from '../../common/enums';

describe('API enums match the protocol unions', () => {
  // Record<Union, true> fails to compile if a union member is missing or extra.
  const states: Record<FleetJobStateName, true> = {
    QUEUED: true, ASSIGNED: true, RUNNING: true, UPLOADING: true, COMPLETED: true,
    FAILED: true, ESCALATED: true, CRASHED: true, CANCELLED: true,
  };
  const kinds: Record<FleetJobKindName, true> = { RUN: true, PLAN: true };
  const commands: Record<FleetCommandTypeName, true> = { ASSIGN: true, CANCEL: true, READOPT: true, ABANDON: true };

  it.each([
    ['FleetJobState', FleetJobState, states],
    ['FleetJobKind', FleetJobKind, kinds],
    ['FleetCommandType', FleetCommandType, commands],
  ])('%s', (_name, apiConst, union) => {
    expect(Object.values(apiConst).sort()).toEqual(Object.keys(union).sort());
  });
});
```

(Type imports keep the source guard green: it only forbids value imports from the package.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-state.spec.ts src/fleet/common/protocol.spec.ts`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Add the wire types** (append to `packages/fleet-protocol/src/index.ts`)

```ts
// ---- Slice 2: jobs and sync (spec §3.2, §5) ----

export type FleetJobStateName =
  | 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'UPLOADING'
  | 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CRASHED' | 'CANCELLED';
export type FleetJobKindName = 'RUN' | 'PLAN';
export type FleetCommandTypeName = 'ASSIGN' | 'CANCEL' | 'READOPT' | 'ABANDON';
export type RunnerEventType = 'state' | 'snapshot' | 'lifecycle' | 'log';

/** A runner-reported transition (§5.4 runner-owned rows only). */
export interface StateEventPayload { to: FleetJobStateName; reason?: string; exitCode?: number }

/** Mirror of nax status.json (§5.2 step 5). Every field optional; absent = unchanged. */
export interface SnapshotEventPayload {
  naxRunId?: string;
  naxLogRunId?: string;
  naxCostRunId?: string;
  progress?: Record<string, unknown>;
  currentStoryId?: string | null;
  currentPhase?: string | null;
  /** Decimal string, at most 4 fraction digits, e.g. "1.2345". */
  costSpentUsd?: string;
  heartbeatAt?: string;
  finishResult?: string;
  escalationReason?: string;
  resultBranch?: string;
  resultSha?: string;
  resultPrUrl?: string;
  /** Log events dropped by the runner's rate limit since the last snapshot (§3.2). */
  droppedLogs?: number;
}

export interface LifecycleEventPayload { level: 'info' | 'warn' | 'error'; message: string }
/** At most 8 KiB of text (§3.2). */
export interface LogEventPayload { stream: 'stdout' | 'stderr' | 'run'; text: string }

export interface RunnerEvent {
  /** Per job and lease epoch, starting at 1, contiguous. */
  seq: number;
  type: RunnerEventType;
  payload: StateEventPayload | SnapshotEventPayload | LifecycleEventPayload | LogEventPayload;
}

export interface JobReport { jobId: string; leaseEpoch: number; events: RunnerEvent[] }
export type CommandAckResult = 'ok' | 'rejected';
export interface CommandAck { commandId: string; leaseEpoch: number; result: CommandAckResult; detail?: string }
export interface TokenRequest { jobId: string; leaseEpoch: number }

export interface SyncRequest {
  protocolVersion: number;
  bootId: string;
  daemonVersion: string;
  /** Sent on the first sync after boot and whenever it changes. */
  capabilities?: RunnerCapabilities;
  freeSlots: number;
  jobs: JobReport[];
  commandAcks: CommandAck[];
  tokenRequests: TokenRequest[];
}

export interface GitIdentity { name: string; email: string }

/** ASSIGN carries everything the runner needs; never a secret (git tokens come via gitTokens). */
export interface AssignPayload {
  jobId: string;
  command: FleetJobKindName;
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string; defaultBranch: string; cloneUrl: string };
  ref: string;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  /** Decimal string. */
  maxCostUsd: string;
  bashMode: 'raw';
  gitIdentity: GitIdentity;
}
export interface ReadoptPayload { naxRunId: string | null }
export interface AbandonPayload { reason: 'stale_lease' | 'job_terminal' }

export interface FleetCommandOut {
  commandId: string;
  type: FleetCommandTypeName;
  jobId: string;
  leaseEpoch: number;
  payload: AssignPayload | ReadoptPayload | AbandonPayload | Record<string, never>;
}

export interface GitToken { jobId: string; token: string; expiresAt: string; username: 'x-access-token' | 'oauth2' }
export interface GitTokenError { jobId: string; reason: string }
export interface JobAck { jobId: string; ackedSeq: number }

export interface SyncResponse {
  jobAcks: JobAck[];
  commands: FleetCommandOut[];
  gitTokens: GitToken[];
  /** Plan D7: why a requested token was not minted (fixed reason codes). */
  gitTokenErrors: GitTokenError[];
  /** Plan D7: reported jobs the server does not know; the runner abandons them. */
  unknownJobIds: string[];
  nextPollAfterMs?: number;
}
```

In `apps/api/src/fleet/common/protocol.ts`, extend the `export type { … } from '@nathapp/fleet-protocol'` list with every new name above.

- [ ] **Step 4: Add the API enums** (append to `apps/api/src/common/enums.ts`)

```ts
/** Fleet S1: FleetJob.state (spec §2, §5.4). */
export const FleetJobState = {
  QUEUED: 'QUEUED', ASSIGNED: 'ASSIGNED', RUNNING: 'RUNNING', UPLOADING: 'UPLOADING',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', ESCALATED: 'ESCALATED', CRASHED: 'CRASHED', CANCELLED: 'CANCELLED',
} as const;
export type FleetJobState = (typeof FleetJobState)[keyof typeof FleetJobState];

/** Fleet S1: FleetJob.command. */
export const FleetJobKind = { RUN: 'RUN', PLAN: 'PLAN' } as const;
export type FleetJobKind = (typeof FleetJobKind)[keyof typeof FleetJobKind];

/** Fleet S1: FleetCommand.type. */
export const FleetCommandType = { ASSIGN: 'ASSIGN', CANCEL: 'CANCEL', READOPT: 'READOPT', ABANDON: 'ABANDON' } as const;
export type FleetCommandType = (typeof FleetCommandType)[keyof typeof FleetCommandType];

/** Fleet S1: FleetCommand.ackResult. `withdrawn` and `stale` are server-set (plan D4, D8). */
export const FleetCommandAckResult = { OK: 'ok', REJECTED: 'rejected', WITHDRAWN: 'withdrawn', STALE: 'stale' } as const;
export type FleetCommandAckResult = (typeof FleetCommandAckResult)[keyof typeof FleetCommandAckResult];
```

- [ ] **Step 5: Implement the table** — `apps/api/src/fleet/jobs/job-state.ts`

```ts
import { FleetJobState } from '../../common/enums';

export type TransitionActor = 'server' | 'runner';

const S = FleetJobState;

/** States covered by the partial unique index on (repoId, feature) (spec §2, §6.4). */
export const ACTIVE_STATES: readonly FleetJobState[] = [S.QUEUED, S.ASSIGNED, S.RUNNING, S.UPLOADING];
/** States in which a runner holds the job (fence, broker, sweep). */
export const RUNNER_HELD_STATES: readonly FleetJobState[] = [S.ASSIGNED, S.RUNNING, S.UPLOADING];
export const TERMINAL_STATES: readonly FleetJobState[] = [S.COMPLETED, S.FAILED, S.ESCALATED, S.CRASHED, S.CANCELLED];

const table = (rows: Array<[FleetJobState, FleetJobState[]]>): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(rows.map(([from, to]) => [from, new Set(to)]));

/** Spec §5.4 server-owned rows, plus UPLOADING -> CRASHED (plan D11). */
const SERVER = table([
  [S.QUEUED, [S.ASSIGNED, S.CANCELLED]],
  [S.ASSIGNED, [S.CANCELLED, S.CRASHED]],
  [S.RUNNING, [S.CRASHED]],
  [S.UPLOADING, [S.CRASHED]],
  [S.CRASHED, [S.QUEUED]],
  [S.FAILED, [S.QUEUED]],
  [S.CANCELLED, [S.QUEUED]],
]);

/** Spec §5.4 runner-reported rows. */
const RUNNER = table([
  [S.ASSIGNED, [S.RUNNING, S.FAILED, S.CANCELLED]],
  [S.RUNNING, [S.UPLOADING, S.CANCELLED]],
  [S.UPLOADING, [S.COMPLETED, S.FAILED, S.ESCALATED, S.CANCELLED]],
]);

export function canTransition(from: string, to: string, by: TransitionActor): boolean {
  return (by === 'server' ? SERVER : RUNNER).get(from)?.has(to) ?? false;
}

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-state.spec.ts src/fleet/common/protocol.spec.ts && bunx tsc --noEmit -p tsconfig.json && (cd ../../packages/fleet-protocol && bun run type-check)`
Expected: PASS, both type checks clean.

- [ ] **Step 7: Commit**

```bash
git add packages/fleet-protocol apps/api/src/fleet/common apps/api/src/common/enums.ts apps/api/src/fleet/jobs
git commit -m "feat(fleet): sync wire types, job enums and the state transition table"
```

---

### Task 6: Job tables, migration, partial unique index in tests

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260930090000_fleet_jobs/migration.sql`
- Create: `apps/api/test/helpers/partial-indexes.ts`, `apps/api/test/unit/fleet/partial-indexes.spec.ts`
- Modify: `apps/api/test/global-setup.ts`
- Test: `apps/api/test/integration/fleet/fleet-jobs-schema.integration.spec.ts` (new)

**Interfaces:**
- Produces: Prisma models `FleetJob`, `FleetJobEvent`, `FleetCommand`, `FleetJobArtifact`; `FleetActivity.projectId`; `PARTIAL_UNIQUE_INDEXES: readonly string[]`; index name `FleetJob_active_repo_feature_key`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/unit/fleet/partial-indexes.spec.ts`:

```ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PARTIAL_UNIQUE_INDEXES } from '../../helpers/partial-indexes';

describe('partial unique indexes', () => {
  const dir = join(__dirname, '../../../prisma/migrations');
  const allSql = readdirSync(dir)
    .filter((name) => /^\d{14}_/.test(name))
    .map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'))
    .join('\n');

  it.each(PARTIAL_UNIQUE_INDEXES.map((sql) => [sql]))('is shipped verbatim by a migration: %s', (sql) => {
    // Tests build the schema with `prisma db push`, which cannot express partial indexes;
    // global-setup replays these statements, so they must equal what production migrates.
    expect(allSql).toContain(sql);
  });
});
```

`apps/api/test/integration/fleet/fleet-jobs-schema.integration.spec.ts`:

```ts
/**
 * Fleet S1 slice 2 — job tables, the active (repoId, feature) index and the migration (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20260930090000_fleet_jobs';

describeIntegration('fleet job schema (PG)', () => {
  const prisma = new PrismaClient();
  let ids: { projectId: string; repoId: string; userId: string };

  const job = (feature: string, state = 'QUEUED') => prisma.fleetJob.create({
    data: {
      projectId: ids.projectId, repoId: ids.repoId, ref: 'main', command: 'RUN', feature, profiles: [],
      maxCostUsd: new Prisma.Decimal('5.5'), selectorLabels: [], requestedById: ids.userId, state,
    },
  });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    ids = { projectId: project.id, repoId: repo.id, userId: user.id };
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows one active job per (repo, feature) and any number of finished ones', async () => {
    await job('feat-a', 'COMPLETED');
    await job('feat-a', 'CANCELLED');
    const active = await job('feat-a');
    await expect(job('feat-a')).rejects.toMatchObject({ code: 'P2002' });
    await expect(job('feat-a', 'RUNNING')).rejects.toMatchObject({ code: 'P2002' });
    await job('feat-b');
    await prisma.fleetJob.update({ where: { id: active.id }, data: { state: 'FAILED' } });
    await expect(job('feat-a')).resolves.toBeDefined();
  });

  it('keeps Decimal cost and dedups runner events per (job, epoch, runnerSeq) but not server events', async () => {
    const j = await job('feat-events');
    expect(j.maxCostUsd.toString()).toBe('5.5');
    expect(j.costSpentUsd.toString()).toBe('0');
    const ev = (seq: number, leaseEpoch: number, runnerSeq: number | null) =>
      prisma.fleetJobEvent.create({ data: { jobId: j.id, seq, leaseEpoch, runnerSeq, type: 'log', payload: {} } });
    await ev(1, 1, 1);
    await ev(2, 1, null);
    await ev(3, 1, null);
    await ev(4, 2, 1); // a new epoch restarts runner seq
    await expect(ev(5, 1, 1)).rejects.toMatchObject({ code: 'P2002' });
    await expect(ev(4, 3, 9)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades events, commands and artifacts with the job, and nulls runner references on runner delete', async () => {
    const runner = await prisma.runner.create({
      data: {
        name: 'r1', apiKeyHash: 'h1', os: 'linux', arch: 'x64', labels: [], capabilities: {}, daemonVersion: '0.1.0',
        protocolVersion: 1, bootId: 'b1', lastSeenAt: new Date(), createdById: ids.userId,
      },
    });
    const j = await job('feat-cascade', 'CANCELLED');
    await prisma.fleetJob.update({ where: { id: j.id }, data: { runnerId: runner.id, pinnedRunnerId: runner.id } });
    await prisma.fleetCommand.create({ data: { runnerId: runner.id, jobId: j.id, type: 'ASSIGN', leaseEpoch: 1, payload: {} } });
    await prisma.fleetJobArtifact.create({
      data: { jobId: j.id, leaseEpoch: 1, kind: 'bundle', storageKey: `jobs/${j.id}/1.tar.gz`, sizeBytes: BigInt(10), sha256: 'a'.repeat(64) },
    });
    await prisma.runner.delete({ where: { id: runner.id } });
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } });
    expect([after.runnerId, after.pinnedRunnerId]).toEqual([null, null]);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id } })).toBe(0);

    await prisma.fleetJob.delete({ where: { id: j.id } });
    expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(0);
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_jobs_mig', MIGRATION);
      await applyMigration(scratch.db, MIGRATION);
    });
    afterAll(async () => {
      await scratch.drop();
    });

    it('creates the partial unique index', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'fleet_jobs_mig' AND indexname = 'FleetJob_active_repo_feature_key'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
      expect(rows[0].indexdef).toMatch(/WHERE/);
    });
  });
});
```

(`User` requires `email` and `passwordHash`; `Project` requires `name`, `slug`, `key` — checked against `schema.prisma` at `7929924b`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped test/unit/fleet/partial-indexes.spec.ts test/integration/fleet/fleet-jobs-schema.integration.spec.ts`
Expected: FAIL — helper and models missing.

- [ ] **Step 3: Add the models** to `apps/api/prisma/schema.prisma` (after `FleetActivity`)

```prisma
/// Fleet S1 slice 2 (spec §2). One dispatched nax run or plan.
model FleetJob {
  id                String    @id @default(cuid())
  projectId         String
  repoId            String
  ref               String
  command           String    // RUN | PLAN
  feature           String
  planFrom          String?   // repo-relative spec path, PLAN only
  profiles          String[]
  maxCostUsd        Decimal   @db.Decimal(12, 4)
  bashMode          String    @default("raw") // S1 accepts raw only
  selectorLabels    String[]
  pinnedRunnerId    String?
  runnerId          String?
  runnerBootId      String?
  leaseEpoch        Int       @default(0)
  state             String    @default("QUEUED") // QUEUED | ASSIGNED | RUNNING | UPLOADING | COMPLETED | FAILED | ESCALATED | CRASHED | CANCELLED
  stateReason       String?
  requestedById     String
  queuedAt          DateTime  @default(now())
  assignedAt        DateTime?
  startedAt         DateTime?
  finishedAt        DateTime?
  cancelRequestedAt DateTime?
  naxRunId          String?
  naxLogRunId       String?
  naxCostRunId      String?
  progress          Json?
  currentStoryId    String?
  currentPhase      String?
  costSpentUsd      Decimal   @default(0) @db.Decimal(12, 4)
  lastHeartbeatAt   DateTime?
  finishResult      String?
  escalationReason  String?
  exitCode          Int?
  resultBranch      String?
  resultSha         String?
  resultPrUrl       String?
  eventSeq          Int       @default(0) // server timeline counter (plan D2)
  ackedRunnerSeq    Int       @default(0) // cumulative runner ack for leaseEpoch (plan D2)
  attributedAt      DateTime? // PR/MR attribution comment posted (plan D19)
  updatedAt         DateTime  @updatedAt

  project      Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  repo         FleetRepo          @relation(fields: [repoId], references: [id], onDelete: Cascade)
  runner       Runner?            @relation("FleetJobRunner", fields: [runnerId], references: [id], onDelete: SetNull)
  pinnedRunner Runner?            @relation("FleetJobPinnedRunner", fields: [pinnedRunnerId], references: [id], onDelete: SetNull)
  requestedBy  User               @relation("FleetJobRequestedBy", fields: [requestedById], references: [id])
  events       FleetJobEvent[]
  commands     FleetCommand[]
  artifacts    FleetJobArtifact[]

  @@index([state])
  @@index([runnerId, state])
  @@index([projectId, queuedAt])
}

/// Job timeline. Runner events dedup on (jobId, leaseEpoch, runnerSeq); server events have runnerSeq null (plan D2).
model FleetJobEvent {
  id         String   @id @default(cuid())
  jobId      String
  seq        Int      // server timeline order
  leaseEpoch Int
  runnerSeq  Int?
  type       String   // state | snapshot | lifecycle | log
  payload    Json
  createdAt  DateTime @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, seq])
  @@unique([jobId, leaseEpoch, runnerSeq])
}

/// Server -> runner command, re-sent until acked (spec §3.2). id is the idempotency key.
model FleetCommand {
  id          String    @id @default(cuid())
  runnerId    String
  jobId       String
  type        String    // ASSIGN | CANCEL | READOPT | ABANDON
  leaseEpoch  Int
  payload     Json      // never a secret
  createdAt   DateTime  @default(now())
  deliveredAt DateTime?
  ackedAt     DateTime?
  ackResult   String?   // ok | rejected | withdrawn | stale

  runner Runner   @relation(fields: [runnerId], references: [id], onDelete: Cascade)
  job    FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([runnerId, ackedAt])
  @@index([jobId])
}

/// Uploaded run bundle, one per job and lease epoch (plan D3).
model FleetJobArtifact {
  id         String   @id @default(cuid())
  jobId      String
  leaseEpoch Int
  kind       String   // bundle
  storageKey String
  sizeBytes  BigInt
  sha256     String
  createdAt  DateTime @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, kind, leaseEpoch])
}
```

Back-relations (add the field lines to the existing models):
- `User`: `fleetJobs FleetJob[] @relation("FleetJobRequestedBy")`
- `Project`: `fleetJobs FleetJob[]`
- `FleetRepo`: `jobs FleetJob[]`
- `Runner`: `jobs FleetJob[] @relation("FleetJobRunner")`, `pinnedJobs FleetJob[] @relation("FleetJobPinnedRunner")`, `commands FleetCommand[]`

`FleetActivity` (plan D14): add `projectId String? // set on job rows` and `@@index([projectId])`; change its `entityType` comment to `// runner | enrollment | repo | job`.

Run `cd apps/api && bunx prisma format && bunx prisma validate && bun run db:generate`.

- [ ] **Step 4: Write the migration**

```bash
cd apps/api
git show main:apps/api/prisma/schema.prisma > "$TMPDIR/schema-main.prisma"
mkdir -p prisma/migrations/20260930090000_fleet_jobs
bunx prisma migrate diff \
  --from-schema-datamodel "$TMPDIR/schema-main.prisma" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260930090000_fleet_jobs/migration.sql
```

Review the generated SQL: it must only `CREATE TABLE` the four new tables, `ALTER TABLE "FleetActivity" ADD COLUMN "projectId" TEXT`, create the indexes and foreign keys above, and touch nothing else. Put this line at the top:

```sql
-- Fleet S1 slice 2: jobs, events, commands, artifacts; FleetActivity.projectId (plan D14).
```

and append at the end (Prisma cannot express it; spec §2):

```sql
-- Active-job guard (spec §2, §6.4). Also replayed by test/global-setup.ts after `prisma db push`.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_active_repo_feature_key" ON "FleetJob" ("repoId", "feature") WHERE "state" IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING');
```

- [ ] **Step 5: Replay the index in tests**

`apps/api/test/helpers/partial-indexes.ts`:

```ts
/**
 * Partial unique indexes that `prisma db push` cannot create. Each statement is shipped
 * verbatim by a migration (pinned by test/unit/fleet/partial-indexes.spec.ts) and replayed
 * by test/global-setup.ts after the push.
 */
export const PARTIAL_UNIQUE_INDEXES: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_active_repo_feature_key" ON "FleetJob" ("repoId", "feature") WHERE "state" IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING')`,
];
```

In `test/global-setup.ts`, import `PrismaClient` and `PARTIAL_UNIQUE_INDEXES`, and after the `execSync(... db push ...)` call add:

```ts
  // `db push` cannot express partial indexes; replay the ones migrations ship (plan D2 of slice 1).
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    for (const statement of PARTIAL_UNIQUE_INDEXES) await prisma.$executeRawUnsafe(statement);
  } finally {
    await prisma.$disconnect();
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && bun run test:scoped test/unit/fleet/partial-indexes.spec.ts test/integration/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS (the new schema spec and every slice 1 fleet suite).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/test/helpers/partial-indexes.ts apps/api/test/global-setup.ts apps/api/test/unit/fleet apps/api/test/integration/fleet/fleet-jobs-schema.integration.spec.ts
git commit -m "feat(fleet): job, event, command and artifact tables with the active-job index"
```

---

### Task 7: Placement rules (pure)

**Files:**
- Create: `apps/api/src/fleet/jobs/placement-rules.ts`, `apps/api/src/fleet/jobs/placement-rules.spec.ts`

**Interfaces:**
- Produces:
  - `type MisfitReason = 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing' | 'provider_expired' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity'`
  - `PERMANENT_MISFITS: ReadonlySet<MisfitReason>`
  - `interface PlacementJob { repoId: string; provider: 'github' | 'gitlab'; profiles: readonly string[]; selectorLabels: readonly string[]; pinnedRunnerId: string | null }`
  - `interface PlacementRunner { id: string; name: string; enabled: boolean; lastSeenAt: Date; labels: readonly string[]; capacity: number; capabilities: RunnerCapabilities }`
  - `interface RunnerLoad { active: number; repoIds: ReadonlySet<string> }`, `EMPTY_LOAD`
  - `firstMisfit(job, runner, load, now: Date, offlineSec: number): MisfitReason | null`
  - `orderCandidates<T extends { runner: PlacementRunner; load: RunnerLoad }>(fits: readonly T[]): T[]`

- [ ] **Step 1: Write the failing test** — `placement-rules.spec.ts`

```ts
import type { RunnerCapabilities } from '../common/protocol';
import { EMPTY_LOAD, firstMisfit, orderCandidates, PERMANENT_MISFITS, PlacementJob, PlacementRunner } from './placement-rules';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const caps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [{ providerId: 'deepseek', kind: 'api-key' }],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
  ...over,
});
const runner = (over: Partial<PlacementRunner> = {}): PlacementRunner => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 10_000),
  labels: ['linux', 'gpu'], capacity: 1, capabilities: caps(), ...over,
});
const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  repoId: 'repo-1', provider: 'github', profiles: ['fast'], selectorLabels: ['linux'], pinnedRunnerId: null, ...over,
});
const misfit = (j: PlacementJob, r: PlacementRunner, load = EMPTY_LOAD) => firstMisfit(j, r, load, NOW, 90);

describe('placement rules (spec §4)', () => {
  it('fits a matching runner', () => {
    expect(misfit(job(), runner())).toBeNull();
  });

  it.each([
    ['disabled', job(), runner({ enabled: false })],
    ['offline', job(), runner({ lastSeenAt: new Date(NOW.getTime() - 91_000) })],
    ['labels', job({ selectorLabels: ['linux', 'mac'] }), runner()],
    ['executor', job(), runner({ capabilities: caps({ executors: [] }) })],
    ['protocol', job(), runner({ capabilities: caps({ nax: { version: '1', protocols: ['acp'] } }) })],
    ['provider_missing', job(), runner({ capabilities: caps({ credentials: [] }) })],
    ['provider_expired', job(), runner({ capabilities: caps({ credentials: [{ providerId: 'deepseek', kind: 'oauth', expires: '2026-10-01T11:59:59.000Z' }] }) })],
    ['sandbox', job(), runner({ capabilities: caps({ sandbox: { available: false, probedAt: 'x' } }) })],
    ['tools', job({ provider: 'gitlab' }), runner()],
    ['tools', job(), runner({ capabilities: caps({ tools: { git: false, gh: true, glab: true } }) })],
  ])('reports %s', (reason, j, r) => {
    expect(misfit(j, r)).toBe(reason);
  });

  it('reports busy_repo before capacity, and capacity when full', () => {
    expect(misfit(job(), runner({ capacity: 2 }), { active: 1, repoIds: new Set(['repo-1']) })).toBe('busy_repo');
    expect(misfit(job(), runner({ capacity: 2 }), { active: 2, repoIds: new Set(['other']) })).toBe('capacity');
    expect(misfit(job(), runner({ capacity: 2 }), { active: 1, repoIds: new Set(['other']) })).toBeNull();
  });

  it('skips the needs check for a profile the runner does not know (repo-provided, spec §2.1)', () => {
    expect(misfit(job({ profiles: ['repo-only'] }), runner({ capabilities: caps({ credentials: [] }) }))).toBeNull();
  });

  it('never treats an inherited object key as a machine profile', () => {
    expect(misfit(job({ profiles: ['constructor', 'toString'] }), runner())).toBeNull();
  });

  it('ignores selector labels for a pinned job', () => {
    expect(misfit(job({ pinnedRunnerId: 'r1', selectorLabels: ['mac'] }), runner())).toBeNull();
  });

  it('classifies waiting reasons as not permanent', () => {
    expect(['offline', 'busy_repo', 'capacity', 'labels'].some((r) => PERMANENT_MISFITS.has(r as never))).toBe(false);
    expect(PERMANENT_MISFITS.has('disabled')).toBe(true);
  });

  it('orders by fewest active jobs, then oldest lastSeenAt, then id', () => {
    const a = { runner: runner({ id: 'a', lastSeenAt: new Date(3) }), load: { active: 1, repoIds: new Set<string>() } };
    const b = { runner: runner({ id: 'b', lastSeenAt: new Date(2) }), load: { active: 0, repoIds: new Set<string>() } };
    const c = { runner: runner({ id: 'c', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    const d = { runner: runner({ id: 'd', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    expect(orderCandidates([a, b, d, c]).map((x) => x.runner.id)).toEqual(['c', 'd', 'b', 'a']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `placement-rules.ts`

```ts
import type { RunnerCapabilities } from '../common/protocol';

/** The first placement rule a runner fails (spec §4), reported per runner at dispatch. */
export type MisfitReason =
  | 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_expired' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity';

/** A pinned job whose runner fails one of these can never run there: 422 at dispatch (spec §4). */
export const PERMANENT_MISFITS: ReadonlySet<MisfitReason> = new Set<MisfitReason>([
  'disabled', 'executor', 'protocol', 'provider_missing', 'provider_expired', 'sandbox', 'tools',
]);

export interface PlacementJob {
  repoId: string;
  provider: 'github' | 'gitlab';
  profiles: readonly string[];
  selectorLabels: readonly string[];
  pinnedRunnerId: string | null;
}

export interface PlacementRunner {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date;
  labels: readonly string[];
  capacity: number;
  capabilities: RunnerCapabilities;
}

/** The runner's active jobs (ASSIGNED, RUNNING, UPLOADING). */
export interface RunnerLoad {
  active: number;
  repoIds: ReadonlySet<string>;
}

export const EMPTY_LOAD: RunnerLoad = Object.freeze({ active: 0, repoIds: new Set<string>() });

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function capabilityMisfit(job: PlacementJob, caps: RunnerCapabilities, now: Date): MisfitReason | null {
  for (const name of job.profiles) {
    // A name the runner does not report is repo-provided and unknowable before clone (spec §2.1).
    if (!own(caps.profiles, name)) continue;
    const needs = caps.profiles[name];
    if (!caps.nax.protocols.includes(needs.protocol)) return 'protocol';
    for (const provider of needs.providers) {
      const credential = caps.credentials.find((c) => c.providerId === provider);
      if (!credential) return 'provider_missing';
      if (credential.expires !== undefined && Date.parse(credential.expires) <= now.getTime()) return 'provider_expired';
    }
    if (needs.sandbox && !caps.sandbox.available) return 'sandbox';
  }
  const forgeTool = job.provider === 'github' ? caps.tools.gh : caps.tools.glab;
  if (!caps.tools.git || !forgeTool) return 'tools';
  return null;
}

/** Spec §4 steps 1-3, in order. Pinned jobs ignore selector labels (the pin is the candidate set). */
export function firstMisfit(job: PlacementJob, runner: PlacementRunner, load: RunnerLoad, now: Date, offlineSec: number): MisfitReason | null {
  if (!runner.enabled) return 'disabled';
  if (now.getTime() - runner.lastSeenAt.getTime() > offlineSec * 1000) return 'offline';
  if (job.pinnedRunnerId === null && !job.selectorLabels.every((label) => runner.labels.includes(label))) return 'labels';
  if (!runner.capabilities.executors.includes('host')) return 'executor';
  const capability = capabilityMisfit(job, runner.capabilities, now);
  if (capability) return capability;
  if (load.repoIds.has(job.repoId)) return 'busy_repo';
  if (load.active >= runner.capacity) return 'capacity';
  return null;
}

/** Spec §4 step 4: fewest active jobs, then oldest lastSeenAt; id breaks ties deterministically. */
export function orderCandidates<T extends { runner: PlacementRunner; load: RunnerLoad }>(fits: readonly T[]): T[] {
  return [...fits].sort(
    (a, b) =>
      a.load.active - b.load.active ||
      a.runner.lastSeenAt.getTime() - b.runner.lastSeenAt.getTime() ||
      a.runner.id.localeCompare(b.runner.id),
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/jobs/placement-rules.ts apps/api/src/fleet/jobs/placement-rules.spec.ts
git commit -m "feat(fleet): pure placement rules and candidate ordering"
```

---

### Task 8: Job repository

**Files:**
- Create: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts` (new)

**Interfaces:**
- Consumes: `PlacementRunner` (Task 7), enums (Task 5), `RUNNER_HELD_STATES` (Task 5).
- Produces (all in `fleet-job.domain.ts`):
  - `FLEET_JOB_REPOSITORY` symbol; `DuplicateActiveJobError` (thrown by `createJob` on the partial index).
  - `FleetJobRecord` (every `FleetJob` column; `maxCostUsd`/`costSpentUsd` as decimal **strings**, `state: FleetJobState`, `command: FleetJobKind`).
  - `NewFleetJob`, `FleetJobPatch` (subset of record columns plus `bumpEpoch?: boolean`), `FleetJobFilters`.
  - `FleetJobEventRecord`, `FleetCommandRecord`, `FleetArtifactRecord`, `FleetRepoRef`, `ActiveJobRef`, `PlacementRunnerRow = PlacementRunner & { bootId: string }`.
  - `IFleetJobRepository` (methods listed in Step 3).

- [ ] **Step 1: Write the failing test** — `test/integration/fleet/fleet-job-repository.integration.spec.ts`

```ts
/**
 * Fleet S1 slice 2 — job repository on PG: CAS assignment, the active-job error,
 * event sequencing, command lifecycle, row locks.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { DuplicateActiveJobError, NewFleetJob } from '../../../src/fleet/jobs/domain/fleet-job.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const bind = (client: unknown) => new PrismaFleetJobRepository({ client } as unknown as PrismaService<PrismaClient>);

describeIntegration('PrismaFleetJobRepository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = bind(prisma);
  let base: Omit<NewFleetJob, 'feature'>;
  let runnerId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const fleetRepo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(7), createdById: user.id },
    });
    const runner = await prisma.runner.create({
      data: {
        name: 'r1', apiKeyHash: 'h1', os: 'linux', arch: 'x64', labels: ['linux'], capabilities: { executors: ['host'] },
        daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1', lastSeenAt: new Date(), createdById: user.id,
      },
    });
    runnerId = runner.id;
    base = {
      projectId: project.id, repoId: fleetRepo.id, ref: 'main', command: 'RUN', planFrom: null, profiles: ['fast'],
      maxCostUsd: '5.25', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, requestedById: user.id,
    };
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a job with decimal strings and refuses an active duplicate', async () => {
    const job = await repo.createJob({ ...base, feature: 'dup' });
    expect(job).toEqual(expect.objectContaining({ state: 'QUEUED', leaseEpoch: 0, maxCostUsd: '5.25', costSpentUsd: '0' }));
    await expect(repo.createJob({ ...base, feature: 'dup' })).rejects.toBeInstanceOf(DuplicateActiveJobError);
    await expect(repo.findActiveJobId(base.repoId, 'dup')).resolves.toBe(job.id);
  });

  it('assigns with compare-and-set: two racing assignments, one winner, epoch moves once', async () => {
    const job = await repo.createJob({ ...base, feature: 'race' });
    const now = new Date('2026-10-01T12:34:56.789Z');
    const results = await Promise.all([
      bind(new PrismaClient()).casAssign(job.id, runnerId, 'boot-1', now),
      bind(new PrismaClient()).casAssign(job.id, runnerId, 'boot-1', now),
    ]);
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const after = await repo.findById(job.id);
    expect(after).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId, runnerBootId: 'boot-1', leaseEpoch: 1, ackedRunnerSeq: 0, assignedAt: now }));
  });

  it('numbers the timeline and finds runner events by (epoch, runnerSeq)', async () => {
    const job = await repo.createJob({ ...base, feature: 'events' });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: null, type: 'state', payload: { to: 'ASSIGNED' } });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: 2, type: 'log', payload: { text: 'b' } });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: 1, type: 'log', payload: { text: 'a' } });
    const page = await repo.findEventPage(job.id, { current: 1, size: 10 });
    expect(page.records.map((e) => [e.seq, e.runnerSeq])).toEqual([[1, null], [2, 2], [3, 1]]);
    expect((await repo.findRunnerEvents(job.id, 1, [1, 5])).map((e) => e.runnerSeq)).toEqual([1]);
    expect((await repo.findRunnerEventsAfter(job.id, 1, 1)).map((e) => e.runnerSeq)).toEqual([2]);
    expect((await repo.findById(job.id))?.eventSeq).toBe(3);
  });

  it('returns pending commands until acked, and withdraws all but ABANDON', async () => {
    const job = await repo.createJob({ ...base, feature: 'cmds' });
    const assign = await repo.createCommand({ runnerId, jobId: job.id, type: 'ASSIGN', leaseEpoch: 1, payload: { a: 1 } });
    await repo.createCommand({ runnerId, jobId: job.id, type: 'ABANDON', leaseEpoch: 0, payload: { reason: 'stale_lease' } });
    await repo.markDelivered([assign.id], new Date());
    expect((await repo.findPendingCommands(runnerId)).map((c) => c.type).sort()).toEqual(['ABANDON', 'ASSIGN']);
    expect(await repo.withdrawPendingCommands(job.id, new Date())).toBe(1);
    expect((await repo.findPendingCommands(runnerId)).map((c) => c.type)).toEqual(['ABANDON']);
    expect((await repo.findCommand(assign.id))?.ackResult).toBe('withdrawn');
  });

  it('skips a job row another transaction holds when asked to', async () => {
    const job = await repo.createJob({ ...base, feature: 'locks' });
    await prisma.$transaction(async (tx) => {
      await expect(bind(tx).lockById(job.id)).resolves.toEqual(expect.objectContaining({ id: job.id }));
      await expect(bind(new PrismaClient()).lockById(job.id, { skipLocked: true })).resolves.toBeNull();
    });
  });

  it('reads runners and loads for placement', async () => {
    const [row] = await repo.findPlacementRunners([runnerId]);
    expect(row).toEqual(expect.objectContaining({ id: runnerId, name: 'r1', bootId: 'boot-1', enabled: true, capacity: 1 }));
    await expect(repo.lockRunners([runnerId])).resolves.toEqual([runnerId]);
    const loads = await repo.findActiveLoads([runnerId]);
    expect(loads.every((l) => l.runnerId === runnerId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the domain** — `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`

```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetCommandType, FleetJobKind, FleetJobState } from '../../../common/enums';
import type { PlacementRunner } from '../placement-rules';

export const FLEET_JOB_REPOSITORY = Symbol('FLEET_JOB_REPOSITORY');

/** createJob hit the partial unique index on active (repoId, feature) (spec §6.4). */
export class DuplicateActiveJobError extends Error {
  constructor() {
    super('an active job already exists for this repo and feature');
  }
}

export interface FleetJobRecord {
  id: string;
  projectId: string;
  repoId: string;
  ref: string;
  command: FleetJobKind;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  /** Decimal as string. */
  maxCostUsd: string;
  bashMode: string;
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  runnerId: string | null;
  runnerBootId: string | null;
  leaseEpoch: number;
  state: FleetJobState;
  stateReason: string | null;
  requestedById: string;
  queuedAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  naxRunId: string | null;
  naxLogRunId: string | null;
  naxCostRunId: string | null;
  progress: unknown;
  currentStoryId: string | null;
  currentPhase: string | null;
  /** Decimal as string. */
  costSpentUsd: string;
  lastHeartbeatAt: Date | null;
  finishResult: string | null;
  escalationReason: string | null;
  exitCode: number | null;
  resultBranch: string | null;
  resultSha: string | null;
  resultPrUrl: string | null;
  eventSeq: number;
  ackedRunnerSeq: number;
  attributedAt: Date | null;
  updatedAt: Date;
}

export interface NewFleetJob {
  projectId: string;
  repoId: string;
  ref: string;
  command: FleetJobKind;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  maxCostUsd: string;
  bashMode: 'raw';
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  requestedById: string;
}

type Mutable =
  | 'state' | 'stateReason' | 'runnerId' | 'runnerBootId' | 'assignedAt' | 'startedAt' | 'finishedAt'
  | 'cancelRequestedAt' | 'naxRunId' | 'naxLogRunId' | 'naxCostRunId' | 'progress' | 'currentStoryId'
  | 'currentPhase' | 'costSpentUsd' | 'lastHeartbeatAt' | 'finishResult' | 'escalationReason' | 'exitCode'
  | 'resultBranch' | 'resultSha' | 'resultPrUrl' | 'ackedRunnerSeq';

/** Columns a transition, snapshot or requeue may change. `bumpEpoch` adds one to leaseEpoch (plan D4). */
export type FleetJobPatch = Partial<Pick<FleetJobRecord, Mutable>> & { bumpEpoch?: boolean };

export interface FleetJobFilters {
  projectId: string;
  state?: string;
  repoId?: string;
  runnerId?: string;
  requestedById?: string;
  feature?: string;
}

export interface FleetJobEventRecord {
  id: string;
  jobId: string;
  seq: number;
  leaseEpoch: number;
  runnerSeq: number | null;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface FleetCommandRecord {
  id: string;
  runnerId: string;
  jobId: string;
  type: FleetCommandType;
  leaseEpoch: number;
  payload: unknown;
  createdAt: Date;
  deliveredAt: Date | null;
  ackedAt: Date | null;
  ackResult: string | null;
}

export interface FleetArtifactRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  kind: string;
  storageKey: string;
  sizeBytes: bigint;
  sha256: string;
  createdAt: Date;
}

export interface FleetRepoRef {
  id: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
}

export interface ActiveJobRef {
  runnerId: string;
  repoId: string;
}

export type PlacementRunnerRow = PlacementRunner & { bootId: string };

export interface IFleetJobRepository {
  findRepo(repoId: string): Promise<FleetRepoRef | null>;
  /** @throws DuplicateActiveJobError */
  createJob(data: NewFleetJob): Promise<FleetJobRecord>;
  findActiveJobId(repoId: string, feature: string): Promise<string | null>;
  findById(id: string): Promise<FleetJobRecord | null>;
  /** SELECT … FOR UPDATE (inside txManager.run). With skipLocked, null when another transaction holds the row. */
  lockById(id: string, opts?: { skipLocked?: boolean }): Promise<FleetJobRecord | null>;
  findPage(filters: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobRecord>>;
  /** Spec §6.1. New leaseEpoch, or null when the job was no longer QUEUED. Resets ackedRunnerSeq. */
  casAssign(jobId: string, runnerId: string, runnerBootId: string, now: Date): Promise<number | null>;
  update(id: string, patch: FleetJobPatch): Promise<FleetJobRecord>;
  /** Oldest first. */
  findQueuedIds(limit: number): Promise<string[]>;
  findRunnerHeld(runnerId: string): Promise<FleetJobRecord[]>;
  /** Jobs held by a runner whose lastSeenAt is before the cutoff. */
  findSilentHeldIds(runnerSeenBefore: Date): Promise<string[]>;

  findPlacementRunners(ids?: readonly string[]): Promise<PlacementRunnerRow[]>;
  /** Locks runner rows in id order (all when ids is undefined); returns the locked ids. */
  lockRunners(ids?: readonly string[]): Promise<string[]>;
  findActiveLoads(runnerIds: readonly string[]): Promise<ActiveJobRef[]>;

  /** Takes the next server seq from FleetJob.eventSeq (row-locked by the increment). */
  appendEvent(jobId: string, event: { leaseEpoch: number; runnerSeq: number | null; type: string; payload: unknown }): Promise<FleetJobEventRecord>;
  findRunnerEvents(jobId: string, leaseEpoch: number, runnerSeqs: readonly number[]): Promise<FleetJobEventRecord[]>;
  /** Runner events of the epoch with runnerSeq > after, ascending by runnerSeq. */
  findRunnerEventsAfter(jobId: string, leaseEpoch: number, afterRunnerSeq: number): Promise<FleetJobEventRecord[]>;
  findEventPage(jobId: string, page: IPageOption): Promise<IPageResult<FleetJobEventRecord>>;

  createCommand(command: { runnerId: string; jobId: string; type: FleetCommandType; leaseEpoch: number; payload: object }): Promise<FleetCommandRecord>;
  /** Unacked commands for the runner, oldest first. */
  findPendingCommands(runnerId: string): Promise<FleetCommandRecord[]>;
  markDelivered(ids: readonly string[], now: Date): Promise<void>;
  findCommand(id: string): Promise<FleetCommandRecord | null>;
  ackCommand(id: string, result: string, now: Date): Promise<void>;
  findPendingCommand(filter: { jobId: string; type: FleetCommandType; runnerId?: string; leaseEpoch?: number }): Promise<FleetCommandRecord | null>;
  /** Plan D4: marks the job's pending non-ABANDON commands withdrawn; returns how many. */
  withdrawPendingCommands(jobId: string, now: Date): Promise<number>;

  upsertArtifact(artifact: Omit<FleetArtifactRecord, 'id' | 'createdAt'>): Promise<FleetArtifactRecord>;
  findLatestArtifact(jobId: string, kind: string): Promise<FleetArtifactRecord | null>;

  /** Plan D19: sets attributedAt when still null; true when this call claimed it. */
  claimAttribution(jobId: string, now: Date): Promise<boolean>;
  findUserDisplayName(userId: string): Promise<string | null>;
}
```

- [ ] **Step 4: Implement** — `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`

```ts
import { Injectable } from '@nestjs/common';
import { FleetCommand as FleetCommandRow, FleetJob as JobRow, Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { FleetCommandAckResult, FleetCommandType, FleetJobState, FleetJobKind } from '../../common/enums';
import type { RunnerCapabilities } from '../common/protocol';
import { ACTIVE_STATES, RUNNER_HELD_STATES } from './job-state';
import {
  ActiveJobRef, DuplicateActiveJobError, FleetArtifactRecord, FleetCommandRecord, FleetJobEventRecord, FleetJobFilters,
  FleetJobPatch, FleetJobRecord, FleetRepoRef, IFleetJobRepository, NewFleetJob, PlacementRunnerRow,
} from './domain/fleet-job.domain';

const toJob = (r: JobRow): FleetJobRecord => ({
  ...r,
  command: r.command as FleetJobKind,
  state: r.state as FleetJobState,
  maxCostUsd: r.maxCostUsd.toString(),
  costSpentUsd: r.costSpentUsd.toString(),
});

const toCommand = (r: FleetCommandRow): FleetCommandRecord => ({ ...r, type: r.type as FleetCommandType });

@Injectable()
export class PrismaFleetJobRepository implements IFleetJobRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findRepo(repoId: string): Promise<FleetRepoRef | null> {
    const r = await this.db.fleetRepo.findUnique({
      where: { id: repoId },
      select: { id: true, projectId: true, provider: true, owner: true, name: true, defaultBranch: true, githubInstallationId: true },
    });
    return r ? { ...r, provider: r.provider as FleetRepoRef['provider'] } : null;
  }

  async createJob(data: NewFleetJob): Promise<FleetJobRecord> {
    try {
      return toJob(await this.db.fleetJob.create({ data: { ...data, maxCostUsd: new Prisma.Decimal(data.maxCostUsd) } }));
    } catch (error) {
      // The only unique constraint a new row can hit is the active (repoId, feature) index.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateActiveJobError();
      throw error;
    }
  }

  async findActiveJobId(repoId: string, feature: string): Promise<string | null> {
    const row = await this.db.fleetJob.findFirst({
      where: { repoId, feature, state: { in: [...ACTIVE_STATES] } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findById(id: string): Promise<FleetJobRecord | null> {
    const r = await this.db.fleetJob.findUnique({ where: { id } });
    return r ? toJob(r) : null;
  }

  async lockById(id: string, opts: { skipLocked?: boolean } = {}): Promise<FleetJobRecord | null> {
    const mode = opts.skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql`FOR UPDATE`;
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FleetJob" WHERE "id" = ${id} ${mode}`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPage(f: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobRecord>> {
    const where: Prisma.FleetJobWhereInput = {
      projectId: f.projectId,
      ...(f.state ? { state: f.state } : {}),
      ...(f.repoId ? { repoId: f.repoId } : {}),
      ...(f.runnerId ? { runnerId: f.runnerId } : {}),
      ...(f.requestedById ? { requestedById: f.requestedById } : {}),
      ...(f.feature ? { feature: f.feature } : {}),
    };
    const rows = await Paginate(this.db.fleetJob, page, { where, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((m: JobRow) => toJob(m));
  }

  async casAssign(jobId: string, runnerId: string, runnerBootId: string, now: Date): Promise<number | null> {
    // Prisma stores DateTime as UTC in `timestamp(3)`; bind the ISO string and cast, so the session
    // time zone can never shift it (a zone in the input is ignored for `timestamp without time zone`).
    const at = now.toISOString();
    const rows = await this.db.$queryRaw<Array<{ leaseEpoch: number }>>`
      UPDATE "FleetJob"
         SET "state" = 'ASSIGNED', "runnerId" = ${runnerId}, "runnerBootId" = ${runnerBootId},
             "leaseEpoch" = "leaseEpoch" + 1, "assignedAt" = CAST(${at} AS timestamp(3)),
             "ackedRunnerSeq" = 0, "updatedAt" = CAST(${at} AS timestamp(3))
       WHERE "id" = ${jobId} AND "state" = 'QUEUED'
   RETURNING "leaseEpoch"`;
    return rows[0]?.leaseEpoch ?? null;
  }

  async update(id: string, patch: FleetJobPatch): Promise<FleetJobRecord> {
    const { bumpEpoch, costSpentUsd, progress, ...rest } = patch;
    const data: Prisma.FleetJobUpdateInput = {
      ...rest,
      ...(costSpentUsd !== undefined ? { costSpentUsd: new Prisma.Decimal(costSpentUsd) } : {}),
      ...(progress !== undefined ? { progress: progress === null ? Prisma.DbNull : (progress as Prisma.InputJsonValue) } : {}),
      ...(bumpEpoch ? { leaseEpoch: { increment: 1 } } : {}),
    };
    return toJob(await this.db.fleetJob.update({ where: { id }, data }));
  }

  async findQueuedIds(limit: number): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.QUEUED }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findRunnerHeld(runnerId: string): Promise<FleetJobRecord[]> {
    const rows = await this.db.fleetJob.findMany({ where: { runnerId, state: { in: [...RUNNER_HELD_STATES] } }, orderBy: { id: 'asc' } });
    return rows.map(toJob);
  }

  async findSilentHeldIds(runnerSeenBefore: Date): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: { in: [...RUNNER_HELD_STATES] }, runner: { lastSeenAt: { lt: runnerSeenBefore } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findPlacementRunners(ids?: readonly string[]): Promise<PlacementRunnerRow[]> {
    const rows = await this.db.runner.findMany({
      where: ids ? { id: { in: [...ids] } } : {},
      orderBy: { id: 'asc' },
      select: { id: true, name: true, enabled: true, lastSeenAt: true, labels: true, capacity: true, capabilities: true, bootId: true },
    });
    // Stored capabilities were validated by parseCapabilities at enroll/sync time.
    return rows.map((r) => ({ ...r, capabilities: r.capabilities as unknown as RunnerCapabilities }));
  }

  async lockRunners(ids?: readonly string[]): Promise<string[]> {
    if (ids && ids.length === 0) return [];
    const filter = ids ? Prisma.sql`WHERE "id" IN (${Prisma.join([...ids])})` : Prisma.empty;
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Runner" ${filter} ORDER BY "id" FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  async findActiveLoads(runnerIds: readonly string[]): Promise<ActiveJobRef[]> {
    if (runnerIds.length === 0) return [];
    const rows = await this.db.fleetJob.findMany({
      where: { runnerId: { in: [...runnerIds] }, state: { in: [...RUNNER_HELD_STATES] } },
      select: { runnerId: true, repoId: true },
    });
    return rows.map((r) => ({ runnerId: r.runnerId as string, repoId: r.repoId }));
  }

  async appendEvent(jobId: string, e: { leaseEpoch: number; runnerSeq: number | null; type: string; payload: unknown }): Promise<FleetJobEventRecord> {
    const { eventSeq } = await this.db.fleetJob.update({ where: { id: jobId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    return this.db.fleetJobEvent.create({
      data: { jobId, seq: eventSeq, leaseEpoch: e.leaseEpoch, runnerSeq: e.runnerSeq, type: e.type, payload: e.payload as Prisma.InputJsonValue },
    });
  }

  findRunnerEvents(jobId: string, leaseEpoch: number, runnerSeqs: readonly number[]): Promise<FleetJobEventRecord[]> {
    return this.db.fleetJobEvent.findMany({ where: { jobId, leaseEpoch, runnerSeq: { in: [...runnerSeqs] } }, orderBy: { runnerSeq: 'asc' } });
  }

  findRunnerEventsAfter(jobId: string, leaseEpoch: number, afterRunnerSeq: number): Promise<FleetJobEventRecord[]> {
    return this.db.fleetJobEvent.findMany({ where: { jobId, leaseEpoch, runnerSeq: { gt: afterRunnerSeq } }, orderBy: { runnerSeq: 'asc' } });
  }

  async findEventPage(jobId: string, page: IPageOption): Promise<IPageResult<FleetJobEventRecord>> {
    const rows = await Paginate(this.db.fleetJobEvent, page, { where: { jobId }, orderBy: [{ seq: 'asc' }] });
    return rows.remap((m: FleetJobEventRecord) => m);
  }

  async createCommand(c: { runnerId: string; jobId: string; type: FleetCommandType; leaseEpoch: number; payload: object }): Promise<FleetCommandRecord> {
    return toCommand(await this.db.fleetCommand.create({ data: { ...c, payload: c.payload as Prisma.InputJsonValue } }));
  }

  async findPendingCommands(runnerId: string): Promise<FleetCommandRecord[]> {
    const rows = await this.db.fleetCommand.findMany({ where: { runnerId, ackedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toCommand);
  }

  async markDelivered(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db.fleetCommand.updateMany({ where: { id: { in: [...ids] }, deliveredAt: null }, data: { deliveredAt: now } });
  }

  async findCommand(id: string): Promise<FleetCommandRecord | null> {
    const r = await this.db.fleetCommand.findUnique({ where: { id } });
    return r ? toCommand(r) : null;
  }

  async ackCommand(id: string, result: string, now: Date): Promise<void> {
    await this.db.fleetCommand.updateMany({ where: { id, ackedAt: null }, data: { ackedAt: now, ackResult: result } });
  }

  async findPendingCommand(f: { jobId: string; type: FleetCommandType; runnerId?: string; leaseEpoch?: number }): Promise<FleetCommandRecord | null> {
    const r = await this.db.fleetCommand.findFirst({
      where: {
        jobId: f.jobId, type: f.type, ackedAt: null,
        ...(f.runnerId ? { runnerId: f.runnerId } : {}),
        ...(f.leaseEpoch !== undefined ? { leaseEpoch: f.leaseEpoch } : {}),
      },
    });
    return r ? toCommand(r) : null;
  }

  async withdrawPendingCommands(jobId: string, now: Date): Promise<number> {
    const { count } = await this.db.fleetCommand.updateMany({
      where: { jobId, ackedAt: null, type: { not: FleetCommandType.ABANDON } },
      data: { ackedAt: now, ackResult: FleetCommandAckResult.WITHDRAWN },
    });
    return count;
  }

  upsertArtifact(a: Omit<FleetArtifactRecord, 'id' | 'createdAt'>): Promise<FleetArtifactRecord> {
    return this.db.fleetJobArtifact.upsert({
      where: { jobId_kind_leaseEpoch: { jobId: a.jobId, kind: a.kind, leaseEpoch: a.leaseEpoch } },
      create: a,
      update: { storageKey: a.storageKey, sizeBytes: a.sizeBytes, sha256: a.sha256, createdAt: new Date() },
    });
  }

  findLatestArtifact(jobId: string, kind: string): Promise<FleetArtifactRecord | null> {
    return this.db.fleetJobArtifact.findFirst({ where: { jobId, kind }, orderBy: { leaseEpoch: 'desc' } });
  }

  async claimAttribution(jobId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.fleetJob.updateMany({ where: { id: jobId, attributedAt: null }, data: { attributedAt: now } });
    return count === 1;
  }

  /** Name only: the value lands in a PR/MR comment, possibly on a public repo, so never the email. */
  async findUserDisplayName(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS. (If Prisma names the compound unique input differently than `jobId_kind_leaseEpoch`, use the name `tsc` reports; Prisma derives it from the field list.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/jobs/domain apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts
git commit -m "feat(fleet): job repository with compare-and-set assignment and event sequencing"
```

---

### Task 9: Transitions, server events, `fleet_job` live events

**Files:**
- Modify: `apps/api/src/live/live-event.ts` (union), any file `tsc` flags after the change
- Modify: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts`, `fleet-activity.service.ts`, `fleet-activity.service.spec.ts`, `prisma-fleet-activity.repository.ts`, `dto/fleet-activity.dto.ts` (`projectId`, entity `job`)
- Create: `apps/api/src/fleet/jobs/fleet-job-live.publisher.ts`, `apps/api/src/fleet/jobs/job-transitions.service.ts`, `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `apps/api/src/fleet/jobs/fleet-jobs.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts` (import `FleetJobsModule`)

**Interfaces:**
- Consumes: `IFleetJobRepository` (Task 8), `canTransition`/`isTerminal` (Task 5).
- Produces:
  - `LiveTicketEvent` (the old `LiveEvent` interface, renamed), `LiveFleetJobEvent { id: string; type: 'fleet_job'; projectId: string; jobId: string; state: string; at: string }`, `type LiveEvent = LiveTicketEvent | LiveFleetJobEvent`. `toLiveEvent` returns `LiveTicketEvent | null`.
  - `FleetActivityEntry` gains `projectId?: string | null`; `FleetEntityType` gains `'job'`.
  - `FleetJobLivePublisher { event(job: Pick<FleetJobRecord, 'id' | 'projectId' | 'state'>): LiveFleetJobEvent; publish(events: readonly LiveFleetJobEvent[]): void }`
  - `InvalidTransitionError extends Error { from; to; by }`
  - `JobTransitionsService`:
    - `apply(input: { job: FleetJobRecord; to: FleetJobState; by: TransitionActor; now: Date; actor: TransitionActorRef; reason?: string | null; extra?: FleetJobPatch }): Promise<{ job: FleetJobRecord; live: LiveFleetJobEvent }>` — validates, updates, then `record`.
    - `record(input: { before: FleetJobRecord; after: FleetJobRecord; by: TransitionActor; now: Date; actor: TransitionActorRef; reason?: string | null }): Promise<LiveFleetJobEvent>` — server `state` event + activity + withdraw on terminal; for rows already changed (placement CAS).
    - `type TransitionActorRef = { type: FleetActorType; id: string }`; `SYSTEM_ACTOR = { type: 'SYSTEM', id: 'system' }`.

- [ ] **Step 1: Write the failing test** — `job-transitions.service.spec.ts`

```ts
import { InvalidTransitionError, JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: 'run-1', runnerBootId: 'b1',
  leaseEpoch: 2, state: 'ASSIGNED', stateReason: null, requestedById: 'u1', queuedAt: NOW, assignedAt: NOW,
  startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
  progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0', lastHeartbeatAt: null, finishResult: null,
  escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null, eventSeq: 0,
  ackedRunnerSeq: 0, attributedAt: null, updatedAt: NOW, ...over,
});

describe('JobTransitionsService', () => {
  const repo = {
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => job({ ...(patch as Partial<FleetJobRecord>), leaseEpoch: patch.bumpEpoch ? 3 : 2 })),
    appendEvent: jest.fn(),
    withdrawPendingCommands: jest.fn(),
  };
  const activity = { record: jest.fn() };
  const live = { event: jest.fn((j: FleetJobRecord) => ({ id: 'e', type: 'fleet_job', projectId: j.projectId, jobId: j.id, state: j.state, at: NOW.toISOString() })), publish: jest.fn() };
  const svc = new JobTransitionsService(repo as never, activity as never, live as never);
  afterEach(() => jest.clearAllMocks());

  it('refuses a transition outside the table', async () => {
    await expect(svc.apply({ job: job({ state: 'RUNNING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: SYSTEM_ACTOR }))
      .rejects.toBeInstanceOf(InvalidTransitionError);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('stamps startedAt on RUNNING and writes the server event and activity', async () => {
    const { job: after, live: ev } = await svc.apply({ job: job(), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ state: 'RUNNING', startedAt: NOW, stateReason: null }));
    expect(repo.appendEvent).toHaveBeenCalledWith('j1', { leaseEpoch: 2, runnerSeq: null, type: 'state', payload: { from: 'ASSIGNED', to: 'RUNNING', by: 'runner', reason: null } });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'RUNNER', action: 'job.running', entityType: 'job', entityId: 'j1', jobId: 'j1', projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(repo.withdrawPendingCommands).not.toHaveBeenCalled();
    expect(ev).toEqual(expect.objectContaining({ type: 'fleet_job', jobId: after.id, state: 'RUNNING' }));
  });

  it('bumps the epoch and withdraws commands on a server-owned terminal transition of a held job (plan D4)', async () => {
    await svc.apply({ job: job(), to: 'CANCELLED', by: 'server', now: NOW, actor: SYSTEM_ACTOR, reason: 'cancelled before start' });
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ state: 'CANCELLED', finishedAt: NOW, bumpEpoch: true, stateReason: 'cancelled before start' }));
    expect(repo.withdrawPendingCommands).toHaveBeenCalledWith('j1', NOW);
  });

  it('does not bump for a runner-reported terminal state or a never-assigned job', async () => {
    await svc.apply({ job: job({ state: 'UPLOADING' }), to: 'COMPLETED', by: 'runner', now: NOW, actor: SYSTEM_ACTOR });
    await svc.apply({ job: job({ state: 'QUEUED', runnerId: null }), to: 'CANCELLED', by: 'server', now: NOW, actor: SYSTEM_ACTOR });
    for (const [, patch] of repo.update.mock.calls) expect(patch).not.toHaveProperty('bumpEpoch');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/job-transitions.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Live event union** — in `apps/api/src/live/live-event.ts` rename the interface `LiveEvent` to `LiveTicketEvent`, change `toLiveEvent`'s return type to `LiveTicketEvent | null`, update the header comment ("`type` is a union: `ticket` since Track 1 Slice 5, `fleet_job` since fleet S1"), and add:

```ts
/**
 * Fleet S1 (spec §1): content-free job change; the page refetches the job.
 * `projectId` is required: ProjectEventBus routes on it.
 */
export interface LiveFleetJobEvent {
  id: string;
  type: 'fleet_job';
  projectId: string;
  jobId: string;
  state: string;
  at: string;
}

export type LiveEvent = LiveTicketEvent | LiveFleetJobEvent;
```

Run `cd apps/api && bunx tsc --noEmit -p tsconfig.json`; every consumer that reads a ticket-only field on `LiveEvent` narrows on `event.type === 'ticket'` or is retyped to `LiveTicketEvent`. `live-stream.ts` forwards `type` as the SSE event name, so fleet events reach browsers as `fleet_job` and the web's `ticket` listener ignores them (slice 4 adds the listener).

- [ ] **Step 4: Activity carries the project** — in `fleet-activity.domain.ts`: `FleetEntityType = 'runner' | 'enrollment' | 'repo' | 'job'`; add `projectId?: string | null` to `FleetActivityEntry` and `projectId: string | null` to `FleetActivityRecord`. In `FleetActivityService.record` pass `projectId: entry.projectId ?? null` to `repo.create`, and add `projectId: null` to the exact-match expectation in `fleet-activity.service.spec.ts:10-13` (it uses `toHaveBeenCalledWith` on the full row). Add `projectId` to `FleetActivityDto` (`@ApiPropertyOptional({ type: String, nullable: true })`) and its `from`. In `ListFleetActivityQuery` extend the `entityType` enum with `'job'`.

- [ ] **Step 5: Implement the publisher** — `fleet-job-live.publisher.ts`

```ts
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { FleetJobRecord } from './domain/fleet-job.domain';

/** Builds fleet_job live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class FleetJobLivePublisher {
  constructor(private readonly bus: ProjectEventBus) {}

  event(job: Pick<FleetJobRecord, 'id' | 'projectId' | 'state'>): LiveFleetJobEvent {
    return { id: randomUUID(), type: 'fleet_job', projectId: job.projectId, jobId: job.id, state: job.state, at: new Date().toISOString() };
  }

  publish(events: readonly LiveFleetJobEvent[]): void {
    for (const event of events) this.bus.publish(event);
  }
}
```

- [ ] **Step 6: Implement the transitions** — `job-transitions.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { FleetActorType, FleetJobState } from '../../common/enums';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { canTransition, isTerminal, TransitionActor } from './job-state';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { FLEET_JOB_REPOSITORY, FleetJobPatch, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';

export interface TransitionActorRef {
  type: FleetActorType;
  id: string;
}

export const SYSTEM_ACTOR: TransitionActorRef = Object.freeze({ type: 'SYSTEM', id: 'system' });

export class InvalidTransitionError extends Error {
  constructor(readonly from: string, readonly to: string, readonly by: TransitionActor) {
    super(`transition ${from} -> ${to} by ${by} is not allowed`);
  }
}

/**
 * Every job state change goes through here (spec §5.4): table check, timestamps, the
 * plan D4 epoch bump, a server `state` event, FleetActivity. Call inside txManager.run;
 * publish the returned live event after commit.
 */
@Injectable()
export class JobTransitionsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'update' | 'appendEvent' | 'withdrawPendingCommands'>,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
  ) {}

  async apply(input: {
    job: FleetJobRecord; to: FleetJobState; by: TransitionActor; now: Date; actor: TransitionActorRef;
    reason?: string | null; extra?: FleetJobPatch;
  }): Promise<{ job: FleetJobRecord; live: LiveFleetJobEvent }> {
    const { job, to, by, now } = input;
    if (!canTransition(job.state, to, by)) throw new InvalidTransitionError(job.state, to, by);
    const terminal = isTerminal(to);
    const bump = by === 'server' && terminal && job.runnerId !== null;
    const patch: FleetJobPatch = {
      ...(input.extra ?? {}),
      state: to,
      stateReason: input.reason ?? null,
      ...(to === 'RUNNING' ? { startedAt: now } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      ...(bump ? { bumpEpoch: true } : {}),
    };
    const after = await this.repo.update(job.id, patch);
    const live = await this.record({ before: job, after, by, now, actor: input.actor, reason: input.reason });
    return { job: after, live };
  }

  async record(input: {
    before: FleetJobRecord; after: FleetJobRecord; by: TransitionActor; now: Date; actor: TransitionActorRef; reason?: string | null;
  }): Promise<LiveFleetJobEvent> {
    const { before, after, by, now } = input;
    const reason = input.reason ?? null;
    if (isTerminal(after.state)) await this.repo.withdrawPendingCommands(after.id, now);
    await this.repo.appendEvent(after.id, {
      leaseEpoch: after.leaseEpoch, runnerSeq: null, type: 'state', payload: { from: before.state, to: after.state, by, reason },
    });
    await this.activity.record({
      actorType: input.actor.type, actorId: input.actor.id, action: `job.${after.state.toLowerCase()}`,
      entityType: 'job', entityId: after.id, jobId: after.id, projectId: after.projectId,
      responsibleUserId: after.requestedById, payload: { from: before.state, to: after.state, reason },
    });
    return this.live.event(after);
  }
}
```

- [ ] **Step 7: Module shell** — `fleet-jobs.module.ts`

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService } from './job-transitions.service';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { FLEET_JOB_REPOSITORY } from './domain/fleet-job.domain';

/** Fleet jobs (spec §4-§6). Tasks 10-12 add placement, the notifier, dispatch and the controller. */
@Module({
  imports: [PrismaModule, FleetActivityModule, LiveModule],
  providers: [
    PrismaFleetJobRepository,
    { provide: FLEET_JOB_REPOSITORY, useExisting: PrismaFleetJobRepository },
    FleetJobLivePublisher,
    JobTransitionsService,
  ],
  exports: [FLEET_JOB_REPOSITORY, FleetJobLivePublisher, JobTransitionsService],
})
export class FleetJobsModule {}
```

Add `FleetJobsModule` to `FleetModule.imports`, and extend `fleet.module.spec.ts` if it lists the imported modules.

- [ ] **Step 8: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet src/live && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/live apps/api/src/fleet
git commit -m "feat(fleet): job transitions with server events, activity and fleet_job live events"
```

---

### Task 10: Placement service and runner notifier

**Files:**
- Create: `apps/api/src/fleet/jobs/runner-notifier.ts`, `runner-notifier.spec.ts`
- Create: `apps/api/src/fleet/git-broker/clone-url.ts`, `clone-url.spec.ts`
- Create: `apps/api/src/fleet/jobs/assign-payload.ts`, `apps/api/src/fleet/jobs/placement.service.ts`
- Create: `apps/api/test/helpers/fleet-fixtures.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts`
- Test: `apps/api/test/integration/fleet/placement.integration.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 7, 8, 9.
- Produces:
  - `RunnerNotifier { notify(runnerId: string): void; wait(runnerId: string, ms: number, ready: () => Promise<boolean>): Promise<void>; waiterCount(runnerId: string): number }`
  - `forgeWebBase(apiUrl: string): string`, `cloneUrlFor(repo: { provider: 'github' | 'gitlab'; owner: string; name: string }, cfg: { githubApiUrl: string; gitlabApiUrl: string }): string`
  - `gitIdentityFor(provider: 'github' | 'gitlab', cfg: Pick<IFleetConfig, 'githubAppSlug' | 'gitlabBotName' | 'gitlabBotEmail'>): GitIdentity`, `buildAssignPayload(job: FleetJobRecord, repo: FleetRepoRef, cloneUrl: string, identity: GitIdentity): AssignPayload`
  - `PlacementOutcome { assigned: boolean; runnerId: string | null; leaseEpoch: number | null; misfits: Array<{ runnerId: string; name: string; reason: MisfitReason }> }`
  - `PlacementService { placeJob(jobId: string, now?: Date): Promise<PlacementOutcome>; fillRunner(runnerId: string, freeSlots: number, now?: Date): Promise<number>; evaluatePinned(pinnedRunnerId: string, job: PlacementJob, now?: Date): Promise<MisfitReason | null | 'not_found'> }`
  - Fixtures: `seedFleetBase(prisma): Promise<{ adminId, projectId, projectSlug, repoId }>`, `insertRunner(prisma, over?): Promise<{ id: string }>`, `FLEET_CAPS` (a valid `RunnerCapabilities` with profile `fast`).

- [ ] **Step 1: Write the failing unit tests**

`runner-notifier.spec.ts`:

```ts
import { RunnerNotifier } from './runner-notifier';

describe('RunnerNotifier', () => {
  it('returns at once when ready() already has work', async () => {
    const n = new RunnerNotifier();
    const started = Date.now();
    await n.wait('r1', 5_000, async () => true);
    expect(Date.now() - started).toBeLessThan(100);
    expect(n.waiterCount('r1')).toBe(0);
  });

  it('wakes on notify, and a notify during ready() is not lost', async () => {
    const n = new RunnerNotifier();
    const started = Date.now();
    await n.wait('r1', 5_000, async () => {
      n.notify('r1'); // the command landed between the caller's read and the wait
      return false;
    });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('times out, only wakes its own runner, and cleans up', async () => {
    const n = new RunnerNotifier();
    const waiting = n.wait('r1', 50, async () => false);
    expect(n.waiterCount('r1')).toBe(1);
    n.notify('r2');
    await waiting;
    expect(n.waiterCount('r1')).toBe(0);
  });

  it('does not wait at all for ms <= 0', async () => {
    const ready = jest.fn();
    await new RunnerNotifier().wait('r1', 0, ready);
    expect(ready).not.toHaveBeenCalled();
  });
});
```

`clone-url.spec.ts`:

```ts
import { cloneUrlFor, forgeWebBase } from './clone-url';

describe('clone urls', () => {
  it.each([
    ['https://api.github.com', 'https://github.com'],
    ['https://ghe.acme.io/api/v3', 'https://ghe.acme.io'],
    ['https://gitlab.com/api/v4', 'https://gitlab.com'],
    ['https://gitlab.acme.io/gitlab/api/v4/', 'https://gitlab.acme.io/gitlab'],
    ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'],
  ])('%s -> %s', (api, web) => {
    expect(forgeWebBase(api)).toBe(web);
  });

  it('builds https clone urls, nested GitLab groups included', () => {
    const cfg = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };
    expect(cloneUrlFor({ provider: 'github', owner: 'acme', name: 'app' }, cfg)).toBe('https://github.com/acme/app.git');
    expect(cloneUrlFor({ provider: 'gitlab', owner: 'acme/platform', name: 'api' }, cfg)).toBe('https://gitlab.com/acme/platform/api.git');
  });
});
```

- [ ] **Step 2: Write the fixtures** — `apps/api/test/helpers/fleet-fixtures.ts`

```ts
import { PrismaClient } from '@prisma/client';
import type { RunnerCapabilities } from '../../src/fleet/common/protocol';

export const FLEET_CAPS: RunnerCapabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', kind: 'api-key' }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
};

let seq = 0;

/** An admin, a project `web` and a GitHub fleet repo acme/app, straight into PG. */
export async function seedFleetBase(prisma: PrismaClient): Promise<{ adminId: string; projectId: string; projectSlug: string; repoId: string }> {
  const admin = await prisma.user.create({ data: { email: `admin${++seq}@koda.test`, passwordHash: 'x', role: 'ADMIN' } });
  const slug = `web${seq}`;
  const project = await prisma.project.create({ data: { name: slug, slug, key: `W${seq}` } });
  const repo = await prisma.fleetRepo.create({
    data: { projectId: project.id, provider: 'github', owner: 'acme', name: `app${seq}`, defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: admin.id },
  });
  return { adminId: admin.id, projectId: project.id, projectSlug: slug, repoId: repo.id };
}

/** A runner row without a usable key (for placement-level tests; HTTP tests enroll instead). */
export async function insertRunner(prisma: PrismaClient, over: Partial<{ name: string; labels: string[]; capacity: number; enabled: boolean; lastSeenAt: Date; capabilities: RunnerCapabilities; bootId: string; createdById: string }> = {}): Promise<{ id: string }> {
  const n = ++seq;
  return prisma.runner.create({
    data: {
      name: over.name ?? `runner-${n}`, apiKeyHash: `hash-${n}`, os: 'linux', arch: 'x64', labels: over.labels ?? ['linux'],
      capacity: over.capacity ?? 1, capabilities: (over.capabilities ?? FLEET_CAPS) as object, daemonVersion: '0.1.0',
      protocolVersion: 1, bootId: over.bootId ?? 'boot-1', enabled: over.enabled ?? true,
      lastSeenAt: over.lastSeenAt ?? new Date(), createdById: over.createdById ?? 'seed',
    },
    select: { id: true },
  });
}
```

- [ ] **Step 3: Write the failing integration test** — `test/integration/fleet/placement.integration.spec.ts`

```ts
/**
 * Fleet S1 slice 2 — placement on PG: exactly one assignment under races (spec §6.1).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/placement.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet placement (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;

  const queue = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    placement = app.get(PlacementService);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('assigns to the best runner and queues one ASSIGN carrying no secret', async () => {
    const busy = await insertRunner(prisma, { capacity: 2 });
    const idle = await insertRunner(prisma, { capacity: 2 });
    const other = await queue('other', { state: 'RUNNING', runnerId: busy.id, leaseEpoch: 1 });
    const job = await queue('feat');
    const outcome = await placement.placeJob(job.id);
    expect(outcome).toEqual(expect.objectContaining({ assigned: true, runnerId: idle.id, leaseEpoch: 1 }));
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: job.id } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({ type: 'ASSIGN', runnerId: idle.id, leaseEpoch: 1 }));
    expect(commands[0].payload).toEqual(expect.objectContaining({
      jobId: job.id, feature: 'feat', maxCostUsd: '5', bashMode: 'raw',
      repo: expect.objectContaining({ provider: 'github', owner: 'acme', cloneUrl: expect.stringMatching(/\.git$/) }),
    }));
    expect(JSON.stringify(commands[0].payload)).not.toMatch(/token|ghs_/i);
    expect(other.id).toBeDefined();
  });

  it('keeps a job QUEUED and reports every runner with its first failing rule', async () => {
    const off = await insertRunner(prisma, { enabled: false });
    const mac = await insertRunner(prisma, { labels: ['mac'] });
    const job = await queue('lonely', { selectorLabels: ['linux'] });
    const outcome = await placement.placeJob(job.id);
    expect(outcome.assigned).toBe(false);
    expect(outcome.misfits).toEqual(expect.arrayContaining([
      expect.objectContaining({ runnerId: off.id, reason: 'disabled' }),
      expect.objectContaining({ runnerId: mac.id, reason: 'labels' }),
    ]));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('QUEUED');
  });

  it('never assigns one job twice when dispatch placement and a sync fill race', async () => {
    const r = await insertRunner(prisma, { capacity: 3 });
    for (let i = 0; i < 5; i += 1) {
      const job = await queue(`race-${i}`);
      await Promise.all([placement.placeJob(job.id), placement.fillRunner(r.id, 3), placement.placeJob(job.id)]);
      const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.leaseEpoch).toBeLessThanOrEqual(1);
      expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'ASSIGN' } })).toBe(after.state === 'ASSIGNED' ? 1 : 0);
      await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED' } });
    }
  });

  it('fills a runner up to min(freeSlots, capacity - active), oldest first, one job per repo', async () => {
    const r = await insertRunner(prisma, { capacity: 2 });
    const first = await queue('a');
    await queue('b'); // same repo as `a`: busy_repo once `a` is assigned
    expect(await placement.fillRunner(r.id, 5)).toBe(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('ASSIGNED');
  });

  it('skips a disabled runner on fill and honours pins', async () => {
    const disabled = await insertRunner(prisma, { enabled: false });
    const pinnedTo = await insertRunner(prisma);
    const other = await insertRunner(prisma);
    await queue('p', { pinnedRunnerId: pinnedTo.id });
    expect(await placement.fillRunner(disabled.id, 1)).toBe(0);
    expect(await placement.fillRunner(other.id, 1)).toBe(0);
    expect(await placement.fillRunner(pinnedTo.id, 1)).toBe(1);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/runner-notifier.spec.ts src/fleet/git-broker/clone-url.spec.ts test/integration/fleet/placement.integration.spec.ts`
Expected: FAIL — modules missing.

- [ ] **Step 5: Implement the notifier** — `runner-notifier.ts`

```ts
import { Injectable } from '@nestjs/common';

/**
 * In-process long-poll wake-ups keyed by runner id (spec §3.2; single API instance).
 * `wait` registers before calling `ready()`, so a notify that lands between the
 * caller's last read and the wait still wakes it.
 */
@Injectable()
export class RunnerNotifier {
  private waiters: ReadonlyMap<string, ReadonlySet<() => void>> = new Map();

  notify(runnerId: string): void {
    for (const wake of this.waiters.get(runnerId) ?? []) wake();
  }

  waiterCount(runnerId: string): number {
    return this.waiters.get(runnerId)?.size ?? 0;
  }

  async wait(runnerId: string, ms: number, ready: () => Promise<boolean>): Promise<void> {
    if (ms <= 0) return;
    let wake: () => void = () => undefined;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.add(runnerId, wake);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (await ready()) return;
      await Promise.race([woken, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally {
      if (timer) clearTimeout(timer);
      this.remove(runnerId, wake);
    }
  }

  private add(runnerId: string, wake: () => void): void {
    this.waiters = new Map([...this.waiters, [runnerId, new Set([...(this.waiters.get(runnerId) ?? []), wake])]]);
  }

  private remove(runnerId: string, wake: () => void): void {
    const rest = [...(this.waiters.get(runnerId) ?? [])].filter((w) => w !== wake);
    const next = new Map(this.waiters);
    if (rest.length > 0) next.set(runnerId, new Set(rest));
    else next.delete(runnerId);
    this.waiters = next;
  }
}
```

- [ ] **Step 6: Implement clone urls and the ASSIGN payload**

`apps/api/src/fleet/git-broker/clone-url.ts`:

```ts
/** Web base of a forge from its REST API base: api.github.com -> github.com, strip /api/vN. */
export function forgeWebBase(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname.startsWith('api.')) url.hostname = url.hostname.slice('api.'.length);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
  return url.toString().replace(/\/+$/, '');
}

/** HTTPS clone url; git credentials come from the per-job helper (spec §7.2), never the url. */
export function cloneUrlFor(
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string },
  cfg: { githubApiUrl: string; gitlabApiUrl: string },
): string {
  const base = forgeWebBase(repo.provider === 'github' ? cfg.githubApiUrl : cfg.gitlabApiUrl);
  return `${base}/${repo.owner}/${repo.name}.git`;
}
```

`apps/api/src/fleet/jobs/assign-payload.ts`:

```ts
import type { IFleetConfig } from '../../config/fleet.config';
import type { AssignPayload, GitIdentity } from '../common/protocol';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

/** Plan D17: the App bot for GitHub, the configured bot for GitLab. */
export function gitIdentityFor(
  provider: 'github' | 'gitlab',
  cfg: Pick<IFleetConfig, 'githubAppSlug' | 'gitlabBotName' | 'gitlabBotEmail'>,
): GitIdentity {
  if (provider === 'gitlab') return { name: cfg.gitlabBotName, email: cfg.gitlabBotEmail };
  const bot = `${cfg.githubAppSlug ?? 'koda-fleet'}[bot]`;
  return { name: bot, email: `${bot}@users.noreply.github.com` };
}

export function buildAssignPayload(job: FleetJobRecord, repo: FleetRepoRef, cloneUrl: string, gitIdentity: GitIdentity): AssignPayload {
  return {
    jobId: job.id,
    command: job.command,
    repo: { provider: repo.provider, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, cloneUrl },
    ref: job.ref,
    feature: job.feature,
    planFrom: job.planFrom,
    profiles: [...job.profiles],
    maxCostUsd: job.maxCostUsd,
    bashMode: 'raw',
    gitIdentity,
  };
}
```

- [ ] **Step 7: Implement placement** — `placement.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandType, FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { cloneUrlFor } from '../git-broker/clone-url';
import { buildAssignPayload, gitIdentityFor } from './assign-payload';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';
import { EMPTY_LOAD, firstMisfit, MisfitReason, orderCandidates, PlacementJob, RunnerLoad } from './placement-rules';
import { RunnerNotifier } from './runner-notifier';
import {
  ActiveJobRef, FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository, PlacementRunnerRow,
} from './domain/fleet-job.domain';

export interface PlacementOutcome {
  assigned: boolean;
  runnerId: string | null;
  leaseEpoch: number | null;
  misfits: Array<{ runnerId: string; name: string; reason: MisfitReason }>;
}

/** Oldest-first scan window per fill. 50 unplaceable old jobs can hide newer ones from a runner; fine at S1 scale (home fleet). */
const QUEUED_SCAN_LIMIT = 50;

const toLoads = (refs: readonly ActiveJobRef[]): ReadonlyMap<string, RunnerLoad> =>
  refs.reduce((acc, { runnerId, repoId }) => {
    const prev = acc.get(runnerId) ?? EMPTY_LOAD;
    return new Map([...acc, [runnerId, { active: prev.active + 1, repoIds: new Set([...prev.repoIds, repoId]) }]]);
  }, new Map<string, RunnerLoad>());

export const toPlacementJob = (job: Pick<FleetJobRecord, 'repoId' | 'profiles' | 'selectorLabels' | 'pinnedRunnerId'>, repo: Pick<FleetRepoRef, 'provider'>): PlacementJob => ({
  repoId: job.repoId, provider: repo.provider, profiles: job.profiles, selectorLabels: job.selectorLabels, pinnedRunnerId: job.pinnedRunnerId,
});

/**
 * Spec §4 + §6.1. placeJob runs at dispatch and requeue; fillRunner when a runner syncs
 * with free slots. Runner rows are locked in id order before counting load; fillRunner
 * takes job rows with SKIP LOCKED, so the two never wait on each other in a cycle.
 */
@Injectable()
export class PlacementService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl' | 'gitlabApiUrl'>,
  ) {}

  /** Dispatch-time check of a pin (spec §4): null = fits now, a reason = does not, 'not_found' = no such runner. */
  async evaluatePinned(pinnedRunnerId: string, job: PlacementJob, now = new Date()): Promise<MisfitReason | null | 'not_found'> {
    const [runner] = await this.repo.findPlacementRunners([pinnedRunnerId]);
    if (!runner) return 'not_found';
    const loads = toLoads(await this.repo.findActiveLoads([runner.id]));
    return firstMisfit(job, runner, loads.get(runner.id) ?? EMPTY_LOAD, now, this.fleetConfig.runnerOfflineSec);
  }

  async placeJob(jobId: string, now = new Date()): Promise<PlacementOutcome> {
    const { outcome, live } = await this.txManager.run(async () => {
      const job = await this.repo.lockById(jobId);
      if (!job || job.state !== FleetJobState.QUEUED) {
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [] as LiveFleetJobEvent[] };
      }
      const repo = await this.repo.findRepo(job.repoId);
      if (!repo) throw new Error(`fleet repo ${job.repoId} missing for job ${job.id}`);
      const ids = await this.repo.lockRunners(job.pinnedRunnerId ? [job.pinnedRunnerId] : undefined);
      const runners = await this.repo.findPlacementRunners(ids);
      const loads = toLoads(await this.repo.findActiveLoads(ids));
      const placementJob = toPlacementJob(job, repo);
      const evaluated = runners.map((runner) => {
        const load = loads.get(runner.id) ?? EMPTY_LOAD;
        return { runner, load, reason: firstMisfit(placementJob, runner, load, now, this.fleetConfig.runnerOfflineSec) };
      });
      const misfits = evaluated
        .filter((e) => e.reason !== null)
        .map((e) => ({ runnerId: e.runner.id, name: e.runner.name, reason: e.reason as MisfitReason }));
      const [best] = orderCandidates(evaluated.filter((e) => e.reason === null));
      if (!best) return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits }, live: [] };
      const assigned = await this.assign(job, repo, best.runner, now);
      if (!assigned) return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits }, live: [] };
      return { outcome: { assigned: true, runnerId: best.runner.id, leaseEpoch: assigned.leaseEpoch, misfits }, live: [assigned.live] };
    });
    this.live.publish(live);
    if (outcome.runnerId) this.notifier.notify(outcome.runnerId);
    return outcome;
  }

  /** Assigns up to min(freeSlots, capacity - active) QUEUED jobs to one runner; returns how many. */
  async fillRunner(runnerId: string, freeSlots: number, now = new Date()): Promise<number> {
    if (freeSlots <= 0) return 0;
    const live = await this.txManager.run(async () => {
      const locked = await this.repo.lockRunners([runnerId]);
      const [runner] = await this.repo.findPlacementRunners(locked);
      if (!runner || !runner.enabled) return [] as LiveFleetJobEvent[];
      let load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = Math.min(freeSlots, runner.capacity - load.active);
      const events: LiveFleetJobEvent[] = [];
      for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
        if (slots <= 0) break;
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED) continue;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
        const repo = await this.repo.findRepo(job.repoId);
        if (!repo || firstMisfit(toPlacementJob(job, repo), runner, load, now, this.fleetConfig.runnerOfflineSec) !== null) continue;
        const assigned = await this.assign(job, repo, runner, now);
        if (!assigned) continue;
        events.push(assigned.live);
        slots -= 1;
        load = { active: load.active + 1, repoIds: new Set([...load.repoIds, job.repoId]) };
      }
      return events;
    });
    this.live.publish(live);
    if (live.length > 0) this.notifier.notify(runnerId);
    return live.length;
  }

  private async assign(job: FleetJobRecord, repo: FleetRepoRef, runner: PlacementRunnerRow, now: Date): Promise<{ leaseEpoch: number; live: LiveFleetJobEvent } | null> {
    const leaseEpoch = await this.repo.casAssign(job.id, runner.id, runner.bootId, now);
    if (leaseEpoch === null) return null; // another placement won (spec §6.1)
    const after = await this.repo.findById(job.id);
    if (!after) return null;
    const payload = buildAssignPayload(after, repo, cloneUrlFor(repo, this.vcsConfig), gitIdentityFor(repo.provider, this.fleetConfig));
    await this.repo.createCommand({ runnerId: runner.id, jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch, payload });
    const live = await this.transitions.record({ before: job, after, by: 'server', now, actor: SYSTEM_ACTOR, reason: `assigned to ${runner.name}` });
    return { leaseEpoch, live };
  }
}
```

Register `RunnerNotifier` and `PlacementService` in `FleetJobsModule.providers` and `exports`. Check `IVcsConfig` has `githubApiUrl` and `gitlabApiUrl` (slice 1 uses both via `VCS_CFG`).

- [ ] **Step 8: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet/jobs src/fleet/git-broker/clone-url.spec.ts test/integration/fleet/placement.integration.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet apps/api/test/helpers/fleet-fixtures.ts apps/api/test/integration/fleet/placement.integration.spec.ts
git commit -m "feat(fleet): placement with compare-and-set assignment and runner wake-ups"
```

---

### Task 11: Dispatch and read endpoints, `FleetJob` permission

**Files:**
- Modify: `apps/api/src/auth/casl/koda-action.enum.ts` (`KodaSubject` gains `'FleetJob'`), `apps/api/src/auth/casl/koda-casl-ability.factory.ts`, `koda-casl-ability.factory.spec.ts`
- Create: `apps/api/src/fleet/jobs/dispatch-input.ts`, `dispatch-input.spec.ts`, `fleet-dispatch.exception.ts`
- Create: `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts`, `dto/fleet-job.dto.ts`, `dto/fleet-job-event.dto.ts`, `dto/list-fleet-jobs.query.ts`, `dto/fleet-job.dto.spec.ts`
- Create: `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts`, `apps/api/src/i18n/{en,zh}/fleet.json`
- Test: `apps/api/test/integration/fleet/fleet-jobs.integration.spec.ts` (new)

**Interfaces:**
- Consumes: `PlacementService`, `toPlacementJob` (Task 10), `PERMANENT_MISFITS` (Task 7), `PROFILE_NAME_RE` (Task 3), `LABEL_PATTERN` (`runners/dto/create-enrollment.dto.ts`), `JobTransitionsService`, `FleetJobLivePublisher` (Task 9).
- Produces:
  - `FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/` (nax `validateFeatureName`), `GIT_REF_RE`, `normalizeDispatch(dto: DispatchFleetJobDto, defaultBranch: string): Omit<NewFleetJob, 'projectId' | 'requestedById'>` (throws `ValidationAppException(..., 'fleet.dispatchInput')`).
  - `FleetDispatchException(reason: MisfitReason)` — 422.
  - `FleetJobDto.from(r: FleetJobRecord)`, `FleetJobEventDto.from(r)`, `DispatchResultDto { job: FleetJobDto; placement: { assigned: boolean; runnerId: string | null; misfits: Array<{ runnerId; name; reason }> } }`.
  - `FleetJobsService { dispatch(actorId, projectId, dto): Promise<DispatchResultDto>; list(filters, page); get(projectId, id): Promise<FleetJobDto>; events(projectId, id, page) }`
  - Routes: `POST /projects/:slug/fleet/jobs` (create `FleetJob`), `GET /projects/:slug/fleet/jobs`, `GET …/:id`, `GET …/:id/events` (project member).

- [ ] **Step 1: Write the failing unit tests**

Append to `koda-casl-ability.factory.spec.ts` (reuse its `makeUser`/agent helpers):

```ts
  describe('FleetJob (fleet S1, plan D9)', () => {
    const factory = new KodaCaslAbilityFactory();

    it.each([
      ['ADMIN', true, true],
      ['DEVELOPER', true, true],
      ['VIEWER', false, false],
    ])('project %s: create=%s update=%s', async (projectRole, create, update) => {
      const ability = await factory.createForUser(makeUser({ projectRole }));
      expect(ability.can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(create);
      expect(ability.can(CaslPermissionAction.UPDATE, 'FleetJob')).toBe(update);
    });

    it('lets a global admin manage fleet jobs and never an agent', async () => {
      expect((await factory.createForUser(makeUser({ role: 'ADMIN' }))).can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(true);
      const agent = await factory.createForUser(makeAgent({ agentRoles: ['DEVELOPER'] }));
      expect(agent.can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(false);
      expect(agent.can(CaslPermissionAction.UPDATE, 'FleetJob')).toBe(false);
    });
  });
```

(Append as a top-level `describe`; `makeUser` and `makeAgent` are the file's existing helpers at lines 7 and 21. `CaslPermissionAction` comes from `@nathapp/nestjs-auth` if the file does not import it yet.)

`dispatch-input.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { GIT_REF_RE, normalizeDispatch } from './dispatch-input';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

const dto = (over: Partial<DispatchFleetJobDto> = {}): DispatchFleetJobDto =>
  Object.assign({ repoId: 'repo-1', command: 'RUN', feature: 'auth-flow', maxCostUsd: 5 }, over) as DispatchFleetJobDto;

describe('normalizeDispatch (spec §5.1)', () => {
  it('fills defaults', () => {
    expect(normalizeDispatch(dto(), 'trunk')).toEqual({
      repoId: 'repo-1', ref: 'trunk', command: 'RUN', feature: 'auth-flow', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null,
    });
  });

  it('keeps profile order and sorts/dedups labels', () => {
    const out = normalizeDispatch(dto({ profiles: ['b', 'a'], selectorLabels: ['linux', 'gpu', 'linux'] }), 'main');
    expect(out.profiles).toEqual(['b', 'a']);
    expect(out.selectorLabels).toEqual(['gpu', 'linux']);
  });

  it.each([
    ['PLAN without planFrom', dto({ command: 'PLAN' })],
    ['RUN with planFrom', dto({ planFrom: 'docs/spec.md' })],
    ['absolute planFrom', dto({ command: 'PLAN', planFrom: '/etc/passwd' })],
    ['planFrom escaping the repo', dto({ command: 'PLAN', planFrom: 'docs/../../x.md' })],
    ['planFrom with a backslash', dto({ command: 'PLAN', planFrom: 'docs\\spec.md' })],
    ['planFrom starting with a dash', dto({ command: 'PLAN', planFrom: '-rf.md' })],
    ['a reserved per-job profile', dto({ profiles: ['koda-job-abc'] })],
    ['a duplicate profile', dto({ profiles: ['fast', 'fast'] })],
    ['a feature with ..', dto({ feature: 'a..b' })],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeDispatch(input, 'main')).toThrow(ValidationAppException);
  });

  it.each([['main', true], ['feature/x', true], ['v1.2.3', true], ['-x', false], ['a..b', false], ['a//b', false], ['x.lock', false], ['x/', false], ['a b', false]])(
    'ref %s valid=%s', (ref, ok) => {
      expect(GIT_REF_RE.test(ref)).toBe(ok);
    },
  );
});
```

`dto/fleet-job.dto.spec.ts` (spec §2: every fleet DTO serialises):

```ts
import { FleetJobDto } from './fleet-job.dto';
import { FleetJobEventDto } from './fleet-job-event.dto';

describe('fleet job DTOs', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  it('serialise with decimals and dates as strings and hide internal columns', () => {
    const dto = FleetJobDto.from({
      id: 'j', projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5.5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: 'boot',
      leaseEpoch: 1, state: 'QUEUED', stateReason: null, requestedById: 'u', queuedAt: now, assignedAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
      progress: null, currentStoryId: null, currentPhase: null, costSpentUsd: '0.1234', lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      eventSeq: 3, ackedRunnerSeq: 2, attributedAt: null, updatedAt: now,
    });
    const json = JSON.parse(JSON.stringify(dto));
    expect(json).toEqual(expect.objectContaining({ maxCostUsd: '5.5', costSpentUsd: '0.1234', queuedAt: now.toISOString() }));
    for (const hidden of ['runnerBootId', 'eventSeq', 'ackedRunnerSeq', 'attributedAt']) expect(json).not.toHaveProperty(hidden);
    expect(JSON.stringify(FleetJobEventDto.from({ id: 'e', jobId: 'j', seq: 1, leaseEpoch: 0, runnerSeq: null, type: 'state', payload: {}, createdAt: now }))).toContain('"seq":1');
  });
});
```

- [ ] **Step 2a: Add the HTTP seed helper** (append to `apps/api/test/helpers/fleet-fixtures.ts`)

```ts
import request from 'supertest';
import { data, loginToken, TEST_PASSWORD } from './http-app';

type Who = 'root' | 'dev' | 'viewer' | 'outsider';

export interface FleetHttpWorld {
  tokens: Record<Who, string>;
  ids: Record<Who, string>;
  projectId: string;
  opsProjectId: string;
  repoId: string;
  foreignRepoId: string;
}

/**
 * Root admin (registered), projects `web` and `ops`, users dev (DEVELOPER on web), viewer
 * (VIEWER on web) and outsider (no membership), GitHub fleet repos acme/app on web (default
 * branch `trunk`) and acme/ops on ops, inserted directly (registration is covered by slice 1).
 * Logs in four times: within the 5/min login throttle.
 */
export async function seedFleetHttpWorld(server: Parameters<typeof request>[0], prisma: PrismaClient): Promise<FleetHttpWorld> {
  const tokens = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  tokens.root = data<{ accessToken: string }>(
    await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
  ).accessToken;
  const asRoot = { Authorization: `Bearer ${tokens.root}` };
  for (const slug of ['web', 'ops']) {
    await request(server).post('/api/projects').set(asRoot).send({ name: slug, slug, key: slug.toUpperCase() }).expect(201);
  }
  for (const [who, role] of [['dev', 'DEVELOPER'], ['viewer', 'VIEWER'], ['outsider', null]] as const) {
    await request(server).post('/api/admin/users').set(asRoot).send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    if (role) await request(server).post('/api/projects/web/members').set(asRoot).send({ email: `${who}@koda.test`, role }).expect(201);
  }
  for (const who of ['root', 'dev', 'viewer', 'outsider'] as const) {
    ids[who] = (await prisma.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` } })).id;
  }
  const web = await prisma.project.findUniqueOrThrow({ where: { slug: 'web' } });
  const ops = await prisma.project.findUniqueOrThrow({ where: { slug: 'ops' } });
  const repo = (projectId: string, name: string, defaultBranch: string) => prisma.fleetRepo.create({
    data: { projectId, provider: 'github', owner: 'acme', name, defaultBranch, githubInstallationId: BigInt(77), createdById: ids.root },
  });
  return {
    tokens, ids, projectId: web.id, opsProjectId: ops.id,
    repoId: (await repo(web.id, 'app', 'trunk')).id,
    foreignRepoId: (await repo(ops.id, 'ops', 'main')).id,
  };
}
```

(Move the `import` lines to the top of the file.)

- [ ] **Step 2: Write the failing integration test** — `test/integration/fleet/fleet-jobs.integration.spec.ts`

```ts
/**
 * Fleet S1 slice 2 — dispatch, reads, permissions and live events over HTTP (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet jobs (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let projectId: string;
  let repoId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const dispatch = (who: keyof FleetHttpWorld['tokens'], body: Record<string, unknown>) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth(who)).send({ repoId, command: 'RUN', maxCostUsd: 5, ...body });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    ({ projectId, repoId } = world);
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets a DEVELOPER dispatch; with no runner the job stays QUEUED on the default branch', async () => {
    const res = data<{ job: { id: string; state: string; ref: string; maxCostUsd: string }; placement: { assigned: boolean; misfits: unknown[] } }>(
      await dispatch('dev', { feature: 'no-runner' }).expect(201),
    );
    expect(res.job).toEqual(expect.objectContaining({ state: 'QUEUED', ref: 'trunk', maxCostUsd: '5' }));
    expect(res.placement).toEqual({ assigned: false, runnerId: null, misfits: [] });
  });

  it('assigns at dispatch when a runner fits and publishes fleet_job live events', async () => {
    const seen: LiveEvent[] = [];
    const off = app.get(ProjectEventBus).subscribe(projectId, (e) => seen.push(e));
    const runner = await insertRunner(prisma);
    const res = data<{ job: { id: string; state: string; runnerId: string } }>(await dispatch('dev', { feature: 'with-runner', profiles: ['fast'] }).expect(201));
    off();
    expect(res.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: runner.id }));
    expect(seen.filter((e) => e.type === 'fleet_job').map((e) => (e as { state: string }).state)).toEqual(['QUEUED', 'ASSIGNED']);
    const events = data<{ records: Array<{ type: string; payload: { to: string } }> }>(
      await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}/events`).set(auth('viewer')).expect(200),
    );
    expect(events.records.map((e) => e.payload.to)).toEqual(['QUEUED', 'ASSIGNED']);
    await prisma.runner.update({ where: { id: runner.id }, data: { enabled: false } });
  });

  it('answers 409 naming the active job for a duplicate (repo, feature)', async () => {
    const first = data<{ job: { id: string } }>(await dispatch('dev', { feature: 'dup' }).expect(201));
    const res = await dispatch('dev', { feature: 'dup' }).expect(409);
    expect(JSON.stringify(res.body)).toContain(first.job.id);
  });

  it.each([
    ['PLAN without planFrom', { feature: 'p1', command: 'PLAN' }],
    ['bashMode gated', { feature: 'p2', bashMode: 'gated' }],
    ['a reserved profile', { feature: 'p3', profiles: ['koda-job-1'] }],
    ['maxCostUsd 0', { feature: 'p4', maxCostUsd: 0 }],
    ['a bad feature', { feature: '../x' }],
  ])('answers 400 for %s', async (_label, body) => {
    await dispatch('dev', body).expect(400);
  });

  it('refuses a repo of another project (404) and viewers/outsiders (403)', async () => {
    await dispatch('dev', { feature: 'x', repoId: world.foreignRepoId }).expect(404);
    await dispatch('viewer', { feature: 'x' }).expect(403);
    await dispatch('outsider', { feature: 'x' }).expect(403);
    await request(server).get('/api/projects/web/fleet/jobs').set(auth('outsider')).expect(403);
  });

  it('handles pins: unknown 404, disabled 422, offline queues', async () => {
    await dispatch('dev', { feature: 'pin-1', pinnedRunnerId: 'nope' }).expect(404);
    const disabled = await insertRunner(prisma, { enabled: false });
    const res = await dispatch('dev', { feature: 'pin-2', pinnedRunnerId: disabled.id }).expect(422);
    expect(JSON.stringify(res.body)).toContain('disabled');
    const offline = await insertRunner(prisma, { lastSeenAt: new Date(Date.now() - 3_600_000) });
    const queued = data<{ job: { state: string } }>(await dispatch('dev', { feature: 'pin-3', pinnedRunnerId: offline.id }).expect(201));
    expect(queued.job.state).toBe('QUEUED');
  });

  it('lists with filters for any member and gets by id within the project only', async () => {
    const list = data<{ records: Array<{ feature: string }> }>(
      await request(server).get('/api/projects/web/fleet/jobs?feature=dup&state=QUEUED').set(auth('viewer')).expect(200),
    );
    expect(list.records.map((r) => r.feature)).toEqual(['dup']);
    const anyJob = await prisma.fleetJob.findFirstOrThrow({ where: { projectId } });
    await request(server).get(`/api/projects/web/fleet/jobs/${anyJob.id}`).set(auth('viewer')).expect(200);
    await request(server).get(`/api/projects/ops/fleet/jobs/${anyJob.id}`).set(auth('root')).expect(404);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/auth/casl src/fleet/jobs test/integration/fleet/fleet-jobs.integration.spec.ts`
Expected: FAIL.

- [ ] **Step 4: CASL** — in `koda-casl-ability.factory.spec.ts:68-73` the global-ADMIN rule count changes: `expect(perms).toHaveLength(9)` becomes `10` (and fix the stale test title to "should have exactly 10 permission rules"). Then in `koda-action.enum.ts` add `| 'FleetJob'` to `KodaSubject`. In `koda-casl-ability.factory.ts`: add `'FleetJob'` to `ADMIN_MANAGEABLE_RESOURCES`; in `projectRolePermissions` add `{ action: CaslPermissionAction.MANAGE, subject: 'FleetJob' }` to the `ADMIN` case and `{ action: CaslPermissionAction.CREATE, subject: 'FleetJob' }, { action: CaslPermissionAction.UPDATE, subject: 'FleetJob' }` to the `DEVELOPER` case. Agents and `VIEWER` get nothing (plan D9). Do **not** add `FleetJob` to `READABLE_RESOURCES`: reads are gated by membership, not CASL.

- [ ] **Step 5: Dispatch input** — `dispatch-input.ts`

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { PROFILE_NAME_RE } from '../common/capabilities';
import type { NewFleetJob } from './domain/fleet-job.domain';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

/** nax validateFeatureName (src/utils/feature-name.ts): a single path segment. */
export const FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** A conservative subset of git check-ref-format. */
export const GIT_REF_RE = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/@+-]{1,255}$/;
/** Reserved for the runner's per-job profile (spec §5.2 step 3). */
export const RESERVED_PROFILE_PREFIX = 'koda-job-';

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

function checkPlanFrom(path: string): string {
  if (path.length === 0 || path.length > 512 || path.startsWith('/') || path.startsWith('-') || /[\\\0]/.test(path)) fail('planFrom');
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail('planFrom');
  return path;
}

/** Spec §5.1 checks the DTO decorators cannot express; returns the insertable fields. */
export function normalizeDispatch(dto: DispatchFleetJobDto, defaultBranch: string): Omit<NewFleetJob, 'projectId' | 'requestedById'> {
  if (!FEATURE_RE.test(dto.feature) || dto.feature.includes('..')) fail('feature');
  if (dto.command === 'PLAN' && !dto.planFrom) fail('planFrom required for PLAN');
  if (dto.command === 'RUN' && dto.planFrom !== undefined) fail('planFrom is only for PLAN');
  const profiles = dto.profiles ?? [];
  if (profiles.some((p) => !PROFILE_NAME_RE.test(p) || p.startsWith(RESERVED_PROFILE_PREFIX))) fail('profiles');
  if (new Set(profiles).size !== profiles.length) fail('duplicate profile');
  const ref = dto.ref ?? defaultBranch;
  if (!GIT_REF_RE.test(ref)) fail('ref');
  return {
    repoId: dto.repoId,
    ref,
    command: dto.command,
    feature: dto.feature,
    planFrom: dto.command === 'PLAN' ? checkPlanFrom(dto.planFrom as string) : null,
    profiles: [...profiles],
    maxCostUsd: String(dto.maxCostUsd),
    bashMode: 'raw',
    selectorLabels: [...new Set(dto.selectorLabels ?? [])].sort(),
    pinnedRunnerId: dto.pinnedRunnerId ?? null,
  };
}
```

`fleet-dispatch.exception.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';
import type { MisfitReason } from './placement-rules';

/** 422: the pinned runner can never run this job (spec §4). */
export class FleetDispatchException extends AppException {
  constructor(readonly reason: MisfitReason) {
    super(422, { reason }, 'fleet.dispatch', 422);
  }
}
```

- [ ] **Step 6: DTOs**

`dto/dispatch-fleet-job.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';

export class DispatchFleetJobDto {
  @ApiProperty() @IsString() @Length(1, 64) declare repoId: string;
  @ApiPropertyOptional({ description: 'Git ref to check out detached; defaults to the repo default branch' })
  @IsOptional() @IsString() @MaxLength(255) ref?: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) @IsIn(['RUN', 'PLAN']) declare command: 'RUN' | 'PLAN';
  @ApiProperty({ description: 'nax feature name' }) @IsString() @MaxLength(128) declare feature: string;
  @ApiPropertyOptional({ description: 'Repo-relative spec path, PLAN only' }) @IsOptional() @IsString() @MaxLength(512) planFrom?: string;
  @ApiPropertyOptional({ type: [String], description: 'nax profile chain, later wins' })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiProperty({ description: 'USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) declare maxCostUsd: number;
  @ApiPropertyOptional({ enum: ['raw'], description: 'Only raw until S1.5' }) @IsOptional() @IsIn(['raw']) bashMode?: 'raw';
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) pinnedRunnerId?: string;
}
```

`dto/fleet-job.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetJobRecord } from '../domain/fleet-job.domain';
import type { MisfitReason } from '../placement-rules';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const STATES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'];

export class FleetJobDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare repoId: string;
  @ApiProperty() declare ref: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) declare command: 'RUN' | 'PLAN';
  @ApiProperty() declare feature: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare planFrom: string | null;
  @ApiProperty({ type: [String] }) declare profiles: string[];
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare maxCostUsd: string;
  @ApiProperty() declare bashMode: string;
  @ApiProperty({ type: [String] }) declare selectorLabels: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare pinnedRunnerId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare runnerId: string | null;
  @ApiProperty() declare leaseEpoch: number;
  @ApiProperty({ enum: STATES }) declare state: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stateReason: string | null;
  @ApiProperty() declare requestedById: string;
  @ApiProperty() declare queuedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare assignedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare startedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare cancelRequestedAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxRunId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxLogRunId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare naxCostRunId: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) declare progress: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) declare currentStoryId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare currentPhase: string | null;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare costSpentUsd: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastHeartbeatAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishResult: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare escalationReason: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) declare exitCode: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultBranch: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultSha: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultPrUrl: string | null;

  /** Internal columns (runnerBootId, eventSeq, ackedRunnerSeq, attributedAt) stay server-side. */
  static from(r: FleetJobRecord): FleetJobDto {
    return Object.assign(new FleetJobDto(), {
      id: r.id, projectId: r.projectId, repoId: r.repoId, ref: r.ref, command: r.command, feature: r.feature,
      planFrom: r.planFrom, profiles: r.profiles, maxCostUsd: r.maxCostUsd, bashMode: r.bashMode,
      selectorLabels: r.selectorLabels, pinnedRunnerId: r.pinnedRunnerId, runnerId: r.runnerId, leaseEpoch: r.leaseEpoch,
      state: r.state, stateReason: r.stateReason, requestedById: r.requestedById, queuedAt: r.queuedAt.toISOString(),
      assignedAt: iso(r.assignedAt), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
      cancelRequestedAt: iso(r.cancelRequestedAt), naxRunId: r.naxRunId, naxLogRunId: r.naxLogRunId,
      naxCostRunId: r.naxCostRunId, progress: r.progress ?? null, currentStoryId: r.currentStoryId,
      currentPhase: r.currentPhase, costSpentUsd: r.costSpentUsd, lastHeartbeatAt: iso(r.lastHeartbeatAt),
      finishResult: r.finishResult, escalationReason: r.escalationReason, exitCode: r.exitCode,
      resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl,
    });
  }
}

export class PlacementMisfitDto {
  @ApiProperty() declare runnerId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['disabled', 'offline', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_expired', 'sandbox', 'tools', 'busy_repo', 'capacity'] })
  declare reason: MisfitReason;
}

export class PlacementSummaryDto {
  @ApiProperty() declare assigned: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) declare runnerId: string | null;
  @ApiProperty({ type: [PlacementMisfitDto] }) declare misfits: PlacementMisfitDto[];
}

export class DispatchResultDto {
  @ApiProperty({ type: FleetJobDto }) declare job: FleetJobDto;
  @ApiProperty({ type: PlacementSummaryDto }) declare placement: PlacementSummaryDto;
}
```

`dto/fleet-job-event.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetJobEventRecord } from '../domain/fleet-job.domain';

export class FleetJobEventDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ description: 'Server timeline order' }) declare seq: number;
  @ApiProperty() declare leaseEpoch: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Runner sequence; null for server events' }) declare runnerSeq: number | null;
  @ApiProperty({ enum: ['state', 'snapshot', 'lifecycle', 'log'] }) declare type: string;
  @ApiProperty({ type: Object }) declare payload: unknown;
  @ApiProperty() declare createdAt: string;

  static from(r: FleetJobEventRecord): FleetJobEventDto {
    return Object.assign(new FleetJobEventDto(), {
      id: r.id, seq: r.seq, leaseEpoch: r.leaseEpoch, runnerSeq: r.runnerSeq, type: r.type, payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    });
  }
}
```

`dto/list-fleet-jobs.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { FleetJobState } from '../../../common/enums';

export class ListFleetJobsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: Object.values(FleetJobState) }) @IsOptional() @IsIn(Object.values(FleetJobState)) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) repoId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) runnerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) requestedById?: string;
  @ApiPropertyOptional({ description: 'nax feature name (plan D10)' }) @IsOptional() @IsString() @MaxLength(128) feature?: string;
}
```

- [ ] **Step 7: Service** — `fleet-jobs.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { normalizeDispatch } from './dispatch-input';
import { FleetDispatchException } from './fleet-dispatch.exception';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';
import { PERMANENT_MISFITS } from './placement-rules';
import { PlacementService, toPlacementJob } from './placement.service';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, FleetJobFilters, FleetJobRecord, IFleetJobRepository } from './domain/fleet-job.domain';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { FleetJobEventDto } from './dto/fleet-job-event.dto';

@Injectable()
export class FleetJobsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly placement: PlacementService,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Spec §5.1: validate, insert QUEUED (409 on an active duplicate), record, place. */
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto): Promise<DispatchResultDto> {
    const repo = await this.repo.findRepo(dto.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const input = normalizeDispatch(dto, repo.defaultBranch);

    if (input.pinnedRunnerId) {
      const verdict = await this.placement.evaluatePinned(input.pinnedRunnerId, toPlacementJob(input, repo));
      if (verdict === 'not_found') throw new NotFoundAppException({}, 'fleet.runners');
      if (verdict !== null && PERMANENT_MISFITS.has(verdict)) throw new FleetDispatchException(verdict);
    }

    let job: FleetJobRecord;
    try {
      job = await this.txManager.run(async () => {
        const created = await this.repo.createJob({ ...input, projectId, requestedById: actorId });
        await this.repo.appendEvent(created.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({
          actorType: 'USER', actorId, action: 'job.dispatched', entityType: 'job', entityId: created.id, jobId: created.id,
          projectId, responsibleUserId: actorId, payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref },
        });
        return created;
      });
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      // The failed insert aborted that transaction; look the winner up outside it.
      const activeJobId = await this.repo.findActiveJobId(repo.id, input.feature);
      throw new ConflictAppException({ activeJobId: activeJobId ?? 'unknown' }, 'fleet.jobs');
    }

    this.live.publish([this.live.event(job)]);
    const outcome = await this.placement.placeJob(job.id);
    const fresh = (await this.repo.findById(job.id)) ?? job;
    return Object.assign(new DispatchResultDto(), {
      job: FleetJobDto.from(fresh),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }

  async list(filters: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetJobDto.from);
  }

  async get(projectId: string, id: string): Promise<FleetJobDto> {
    return FleetJobDto.from(await this.findInProject(projectId, id));
  }

  async events(projectId: string, id: string, page: IPageOption): Promise<IPageResult<FleetJobEventDto>> {
    await this.findInProject(projectId, id);
    return remapPage(await this.repo.findEventPage(id, page), FleetJobEventDto.from);
  }

  protected async findInProject(projectId: string, id: string): Promise<FleetJobRecord> {
    const job = await this.repo.findById(id);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    return job;
  }
}
```

(`toPlacementJob` takes the normalized input: it has `repoId`, `profiles`, `selectorLabels`, `pinnedRunnerId`.)

- [ ] **Step 8: Controller** — `fleet-jobs.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { FleetJobsService } from './fleet-jobs.service';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { ListFleetJobsQuery } from './dto/list-fleet-jobs.query';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class FleetJobsController {
  constructor(private readonly jobs: FleetJobsService) {}

  @Post()
  @HttpCode(201)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Dispatch a nax run or plan to a fleet runner (project DEVELOPER+)' })
  @ApiResponse({ status: 201, type: DispatchResultDto })
  @ApiResponse({ status: 404, description: 'Repo not in this project, or pinned runner unknown' })
  @ApiResponse({ status: 409, description: 'An active job already runs this (repo, feature); message names it' })
  @ApiResponse({ status: 422, description: 'Pinned runner can never run this job' })
  async dispatch(@Body() dto: DispatchFleetJobDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.dispatch(principal.id, ctx.project.id, dto));
  }

  @Get()
  @ApiOperation({ summary: 'List fleet jobs (project member)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobDto' })
  async list(@Query() rawQuery: ListFleetJobsQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size, state, repoId, runnerId, requestedById, feature } = parseQuery(ListFleetJobsQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.list({ projectId: ctx.project.id, state, repoId, runnerId, requestedById, feature }, { current, size })));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a fleet job (project member)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext) {
    return JsonResponse.Ok(await this.jobs.get(ctx.project.id, id));
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Job timeline, ordered by seq (project member)' })
  @ApiResponse({ status: 200, description: 'Page of FleetJobEventDto' })
  async events(@Param('id') id: string, @Query() rawQuery: KodaPageQuery, @CurrentProject() ctx: ProjectContext) {
    const { current, size } = parseQuery(KodaPageQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.jobs.events(ctx.project.id, id, { current, size })));
  }
}
```

Module: add `ProjectAccessModule` to `FleetJobsModule.imports` (it provides `ProjectMembershipGuard`'s dependencies and `KodaCaslAbilityFactory`), `FleetJobsController` to `controllers`, `FleetJobsService` to `providers`.

- [ ] **Step 9: i18n** — add to both `apps/api/src/i18n/en/fleet.json` and `zh/fleet.json` (Chinese text in `zh`):

```json
  "jobs": { "404": "Fleet job not found", "409": "An active job already runs this feature: {activeJobId}" },
  "jobState": { "409": "The job is {state}; this action is not allowed" },
  "dispatch": { "422": "The pinned runner can never run this job: {reason}" },
  "dispatchInput": { "-2": "Invalid dispatch: {reason}" }
```

zh: `"404": "未找到任务"`, `"409": "该功能已有进行中的任务：{activeJobId}"`; `"jobState": {"409": "任务状态为 {state}，不允许此操作"}`; `"dispatch": {"422": "指定的执行器无法运行此任务：{reason}"}`; `"dispatchInput": {"-2": "无效的派发请求：{reason}"}`.

- [ ] **Step 10: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/auth/casl src/fleet test/integration/fleet/fleet-jobs.integration.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/auth/casl apps/api/src/fleet apps/api/src/i18n apps/api/test/integration/fleet/fleet-jobs.integration.spec.ts
git commit -m "feat(fleet): dispatch and job read endpoints with the FleetJob permission"
```

---

### Task 12: Cancel and requeue

**Files:**
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `fleet-jobs.controller.ts`, `prisma-fleet-job.repository.ts` (`update` maps P2002)
- Test: `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts` (new)

**Interfaces:**
- Produces:
  - `FleetJobsService.cancel(actorId: string, projectId: string, jobId: string, canOperate: boolean): Promise<FleetJobDto>`
  - `FleetJobsService.requeue(actorId: string, projectId: string, jobId: string): Promise<DispatchResultDto>`
  - Routes: `POST /projects/:slug/fleet/jobs/:id/cancel` (member; `update FleetJob` or requester), `POST …/:id/requeue` (`update FleetJob`).
  - `PrismaFleetJobRepository.update` throws `DuplicateActiveJobError` on `P2002` (requeue into an active duplicate).

- [ ] **Step 1: Write the failing integration test** — `fleet-job-cancel-requeue.integration.spec.ts`

Same header and `beforeAll` shape as `fleet-jobs.integration.spec.ts`: `bootHttpApp`, `prisma`, `world = await seedFleetHttpWorld(server, prisma)`, `({ projectId, repoId, ids } = world)`, and `auth(who)` built from `world.tokens`. Imports additionally `Prisma` from `@prisma/client`. Then:

```ts
  const insertJob = async (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], maxCostUsd: 5, selectorLabels: [],
        requestedById: ids.dev, ...over,
      },
    });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const post = (who: string, id: string, action: 'cancel' | 'requeue') =>
    request(server).post(`/api/projects/web/fleet/jobs/${id}/${action}`).set(auth(who));

  it('cancels a QUEUED job on the server', async () => {
    const job = await insertJob('c-queued');
    await post('dev', job.id, 'cancel').expect(200);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', leaseEpoch: 0 }));
  });

  it('cancels an ASSIGNED job whose assign was never acked: withdraws the ASSIGN and bumps the epoch', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('c-unacked', { state: 'ASSIGNED', runnerId: runner.id, leaseEpoch: 1 });
    const assign = await prisma.fleetCommand.create({ data: { runnerId: runner.id, jobId: job.id, type: 'ASSIGN', leaseEpoch: 1, payload: {} } });
    await post('dev', job.id, 'cancel').expect(200);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', leaseEpoch: 2 }));
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: assign.id } })).toEqual(expect.objectContaining({ ackResult: 'withdrawn' }));
  });

  it('asks the runner to cancel a RUNNING job exactly once', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('c-running', { state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    await post('dev', job.id, 'cancel').expect(200);
    await post('dev', job.id, 'cancel').expect(200);
    expect((await reload(job.id)).cancelRequestedAt).not.toBeNull();
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'CANCEL', ackedAt: null } })).toBe(1);
  });

  it('refuses to cancel a finished job with 409, lets a requester cancel, and forbids other viewers', async () => {
    const done = await insertJob('c-done', { state: 'COMPLETED' });
    await post('dev', done.id, 'cancel').expect(409);
    const mine = await insertJob('c-mine', { requestedById: ids.viewer });
    await post('viewer', mine.id, 'cancel').expect(200);
    const theirs = await insertJob('c-theirs');
    await post('viewer', theirs.id, 'cancel').expect(403);
  });

  it('requeues a CRASHED job: clears the run, bumps the epoch and places it again', async () => {
    const runner = await insertRunner(prisma);
    const job = await insertJob('rq', {
      state: 'CRASHED', runnerId: runner.id, leaseEpoch: 3, naxRunId: 'run-1', costSpentUsd: 1.5, stateReason: 'runner silent', finishedAt: new Date(),
    });
    const res = data<{ job: { state: string; leaseEpoch: number } }>(await post('dev', job.id, 'requeue').expect(200));
    // 3 -> 4 on requeue, 4 -> 5 on the compare-and-set assignment.
    expect(res.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', leaseEpoch: 5 }));
    const after = await reload(job.id);
    expect(after).toEqual(expect.objectContaining({ naxRunId: null, finishedAt: null, ackedRunnerSeq: 0 }));
    expect(after.costSpentUsd.toString()).toBe('0');
  });

  it('refuses requeue of a COMPLETED job, of an active duplicate, and by a viewer', async () => {
    await post('dev', (await insertJob('rq-done', { state: 'COMPLETED' })).id, 'requeue').expect(409);
    const failed = await insertJob('rq-dup', { state: 'FAILED' });
    await insertJob('rq-dup'); // QUEUED duplicate
    const res = await post('dev', failed.id, 'requeue').expect(409);
    expect(JSON.stringify(res.body)).toMatch(/active job/i);
    await post('viewer', (await insertJob('rq-viewer', { state: 'FAILED' })).id, 'requeue').expect(403);
  });
```

(`insertRunner` capacity defaults to 1; each test that needs a runner creates its own. Placement may pick any free enabled runner, so assertions after a requeue check state and epoch, not which runner.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: FAIL — 404 routes.

- [ ] **Step 3: Map P2002 in `update`** (`prisma-fleet-job.repository.ts`)

Wrap the `return toJob(await this.db.fleetJob.update(...))` in:

```ts
    try {
      return toJob(await this.db.fleetJob.update({ where: { id }, data }));
    } catch (error) {
      // Requeue into a (repoId, feature) that has an active job (spec §5.3: "the partial index still applies").
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateActiveJobError();
      throw error;
    }
```

- [ ] **Step 4: Service** — add to `FleetJobsService` (inject `JobTransitionsService` and `RunnerNotifier` in the constructor):

```ts
  /**
   * Spec §5.3 cancel. QUEUED: server-side. ASSIGNED with the ASSIGN never acked: server-side,
   * the assign withdrawn and the epoch bumped (plan D4). Otherwise: cancelRequestedAt + one
   * CANCEL; the runner reports CANCELLED. Repeating a pending cancel is a no-op.
   */
  async cancel(actorId: string, projectId: string, jobId: string, canOperate: boolean): Promise<FleetJobDto> {
    const now = new Date();
    const actor = { type: 'USER' as const, id: actorId };
    const { job, live, wake } = await this.txManager.run(async () => {
      const current = await this.repo.lockById(jobId);
      if (!current || current.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
      if (!canOperate && current.requestedById !== actorId) throw new ForbiddenAppException({}, 'projects');
      if (isTerminal(current.state)) throw new ConflictAppException({ state: current.state }, 'fleet.jobState');

      if (current.state === FleetJobState.QUEUED) {
        const r = await this.transitions.apply({ job: current, to: 'CANCELLED', by: 'server', now, actor, reason: 'cancelled before assignment' });
        return { ...r, wake: null };
      }
      if (current.state === FleetJobState.ASSIGNED) {
        const unacked = await this.repo.findPendingCommand({ jobId, type: FleetCommandType.ASSIGN, leaseEpoch: current.leaseEpoch });
        if (unacked) {
          const r = await this.transitions.apply({ job: current, to: 'CANCELLED', by: 'server', now, actor, reason: 'cancelled before the runner took it' });
          return { ...r, wake: null };
        }
      }
      if (current.cancelRequestedAt) return { job: current, live: null, wake: null };
      const updated = await this.repo.update(jobId, { cancelRequestedAt: now });
      await this.repo.createCommand({ runnerId: current.runnerId as string, jobId, type: FleetCommandType.CANCEL, leaseEpoch: current.leaseEpoch, payload: {} });
      await this.repo.appendEvent(jobId, { leaseEpoch: current.leaseEpoch, runnerSeq: null, type: 'lifecycle', payload: { level: 'info', message: 'cancel requested' } });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'job.cancel_requested', entityType: 'job', entityId: jobId, jobId,
        projectId, responsibleUserId: current.requestedById, payload: { state: current.state },
      });
      return { job: updated, live: this.live.event(updated), wake: current.runnerId };
    });
    if (live) this.live.publish([live]);
    if (wake) this.notifier.notify(wake);
    return FleetJobDto.from(job);
  }

  /** Spec §5.3 requeue: CRASHED | FAILED | CANCELLED -> QUEUED, run fields cleared, epoch + 1, then placement. */
  async requeue(actorId: string, projectId: string, jobId: string): Promise<DispatchResultDto> {
    const now = new Date();
    let queued: FleetJobRecord;
    let feature = '';
    let repoId = '';
    try {
      const r = await this.txManager.run(async () => {
        const current = await this.repo.lockById(jobId);
        if (!current || current.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
        feature = current.feature;
        repoId = current.repoId;
        if (!canTransition(current.state, FleetJobState.QUEUED, 'server')) throw new ConflictAppException({ state: current.state }, 'fleet.jobState');
        return this.transitions.apply({
          job: current, to: 'QUEUED', by: 'server', now, actor: { type: 'USER', id: actorId }, reason: 'requeued',
          extra: {
            runnerId: null, runnerBootId: null, assignedAt: null, startedAt: null, finishedAt: null, cancelRequestedAt: null,
            naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
            costSpentUsd: '0', lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null,
            resultBranch: null, resultSha: null, resultPrUrl: null, ackedRunnerSeq: 0, bumpEpoch: true,
          },
        });
      });
      queued = r.job;
      this.live.publish([r.live]);
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      const activeJobId = await this.repo.findActiveJobId(repoId, feature);
      throw new ConflictAppException({ activeJobId: activeJobId ?? 'unknown' }, 'fleet.jobs');
    }
    const outcome = await this.placement.placeJob(queued.id);
    const fresh = (await this.repo.findById(queued.id)) ?? queued;
    return Object.assign(new DispatchResultDto(), {
      job: FleetJobDto.from(fresh),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }
```

New imports: `ForbiddenAppException` from `@nathapp/nestjs-common`; `FleetCommandType`, `FleetJobState` from `../../common/enums`; `canTransition`, `isTerminal` from `./job-state`; `JobTransitionsService`; `RunnerNotifier`.

- [ ] **Step 5: Controller** — add to `FleetJobsController` (inject `KodaCaslAbilityFactory`):

```ts
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a job (project DEVELOPER+, or the requester)' })
  @ApiResponse({ status: 200, type: FleetJobDto })
  @ApiResponse({ status: 409, description: 'Job already finished' })
  async cancel(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    const ability = await this.casl.createForUser(withProjectRole(principal, ctx.role));
    const canOperate = ability.can(CaslPermissionAction.UPDATE, 'FleetJob');
    return JsonResponse.Ok(await this.jobs.cancel(principal.id, ctx.project.id, id, canOperate));
  }

  @Post(':id/requeue')
  @HttpCode(200)
  @ProjectPermission([CaslPermissionAction.UPDATE, 'FleetJob'])
  @ApiOperation({ summary: 'Requeue a CRASHED, FAILED or CANCELLED job (project DEVELOPER+)' })
  @ApiResponse({ status: 200, type: DispatchResultDto })
  @ApiResponse({ status: 409, description: 'Job not requeueable, or an active duplicate exists' })
  async requeue(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.jobs.requeue(principal.id, ctx.project.id, id));
  }
```

Imports: `ForbiddenAppException`, `isUserPrincipal`, `withProjectRole` (`../../projects/project-context`), `KodaCaslAbilityFactory` (`../../auth/casl/koda-casl-ability.factory`).

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts
git commit -m "feat(fleet): cancel and requeue with assign withdrawal and epoch fencing"
```

---

### Task 18: Activity for project members; delete guards for runners and repos

**Files:**
- Modify: `apps/api/src/fleet/activity/fleet-activity.controller.ts`, `fleet-activity.service.ts`, `domain/fleet-activity.domain.ts`, `prisma-fleet-activity.repository.ts`, `dto/list-fleet-activity.query.ts`
- Modify: `apps/api/src/fleet/runners/runners.service.ts`, `domain/runner.domain.ts`, `prisma-runner.repository.ts`
- Modify: `apps/api/src/fleet/repos/fleet-repos.service.ts`, `domain/fleet-repo.domain.ts`, `prisma-fleet-repo.repository.ts`
- Modify: `apps/api/src/i18n/{en,zh}/fleet.json`
- Test: `apps/api/test/integration/fleet/fleet-admin-guards.integration.spec.ts` (new)

**Interfaces:**
- Produces:
  - `FleetActivityFilters` gains `jobId?: string` and `projectIds?: readonly string[]` (undefined = no scope, used for global ADMIN).
  - `IFleetActivityRepository.findMemberProjectIds(userId: string): Promise<string[]>`
  - `IRunnerRepository.countUnfinishedJobs(runnerId: string): Promise<number>` (as runner or as pin), `IFleetRepoRepository.countUnfinishedJobs(repoId: string): Promise<number>`
  - `GET /fleet/activity`: global ADMIN sees all; other users see rows whose `projectId` is one of their projects; agents 403 (spec §8, plan D14).
  - Runner/repo delete: 409 `fleet.runnerBusy` / `fleet.repoBusy` while any job is QUEUED, ASSIGNED, RUNNING or UPLOADING (slice 1 D10).

- [ ] **Step 1: Write the failing integration test** — `fleet-admin-guards.integration.spec.ts`

```ts
/**
 * Fleet S1 slice 2 — activity scoping and delete guards (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-admin-guards.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet activity scope and delete guards (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const job = (repoId: string, projectId: string, feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });

  it('shows members only their projects\' job activity; admins see everything', async () => {
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 1, feature: 'act' }).expect(201);
    await request(server).post('/api/fleet/enrollments').set(auth('root')).send({ labels: [] }).expect(201);
    await prisma.fleetActivity.create({ data: { actorType: 'SYSTEM', actorId: 'system', action: 'job.dispatched', entityType: 'job', entityId: 'x', jobId: 'x', projectId: world.opsProjectId, payload: {} } });

    const mine = data<{ records: Array<{ projectId: string | null; entityType: string }> }>(await request(server).get('/api/fleet/activity').set(auth('viewer')).expect(200));
    expect(mine.records.length).toBeGreaterThan(0);
    expect(mine.records.every((r) => r.projectId === world.projectId && r.entityType === 'job')).toBe(true);
    const none = data<{ records: unknown[] }>(await request(server).get('/api/fleet/activity').set(auth('outsider')).expect(200));
    expect(none.records).toEqual([]);
    const all = data<{ records: Array<{ entityType: string }> }>(await request(server).get('/api/fleet/activity?size=100').set(auth('root')).expect(200));
    expect(all.records.map((r) => r.entityType)).toEqual(expect.arrayContaining(['job', 'enrollment']));
    const one = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'act' } });
    const byJob = data<{ records: Array<{ jobId: string }> }>(await request(server).get(`/api/fleet/activity?jobId=${one.id}`).set(auth('dev')).expect(200));
    expect(byJob.records.every((r) => r.jobId === one.id)).toBe(true);
  });

  it('refuses to delete a runner with an unfinished or pinned job, then allows it once all are finished', async () => {
    const r = await insertRunner(prisma);
    const running = await job(world.repoId, world.projectId, 'del-r', { state: 'RUNNING', runnerId: r.id, leaseEpoch: 1 });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: running.id }, data: { state: 'COMPLETED' } });
    const pinned = await job(world.repoId, world.projectId, 'del-pin', { pinnedRunnerId: r.id });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: pinned.id }, data: { state: 'CANCELLED' } });
    await request(server).delete(`/api/fleet/runners/${r.id}`).set(auth('root')).expect(204);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: running.id } })).runnerId).toBeNull();
  });

  it('refuses to delete a repo with an unfinished job; a finished history is deleted with it', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const j = await job(repo.id, world.projectId, 'del-repo');
    await request(server).delete(`/api/fleet/repos/${repo.id}`).set(auth('root')).expect(409);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'FAILED' } });
    await request(server).delete(`/api/fleet/repos/${repo.id}`).set(auth('root')).expect(204);
    expect(await prisma.fleetJob.count({ where: { id: j.id } })).toBe(0);
  });
});
```

(Both slice 1 delete routes answer 204.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-admin-guards.integration.spec.ts`
Expected: FAIL — viewer gets 403 on activity; deletes return 200 with unfinished jobs.

- [ ] **Step 3: Activity scoping**

Domain: add `jobId?: string; projectIds?: readonly string[]` to `FleetActivityFilters`; add `findMemberProjectIds(userId: string): Promise<string[]>` to `IFleetActivityRepository`.

Repository `findPage` where-clause gains:

```ts
      ...(filters.jobId ? { jobId: filters.jobId } : {}),
      ...(filters.projectIds ? { projectId: { in: [...filters.projectIds] } } : {}),
```

and:

```ts
  async findMemberProjectIds(userId: string): Promise<string[]> {
    const rows = await this.db.projectMember.findMany({ where: { userId, project: { deletedAt: null } }, select: { projectId: true } });
    return rows.map((r) => r.projectId);
  }
```

Service: `memberProjectIds(userId: string): Promise<string[]>` delegating to the repository.

Query DTO: add `@ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) jobId?: string;`.

Controller `list` (drop `@RequiredPermission('ADMIN')`):

```ts
  @Get()
  @ApiOperation({ summary: 'List fleet activity: global admin sees all, members see their projects\' job rows' })
  @ApiResponse({ status: 200, description: 'Page of FleetActivityDto' })
  @ApiResponse({ status: 403, description: 'Not a user' })
  async list(@Query() rawQuery: ListFleetActivityQuery, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    const { current, size, entityType, entityId, actorId, jobId } = parseQuery(ListFleetActivityQuery, rawQuery);
    const projectIds = principal.role === 'ADMIN' ? undefined : await this.activity.memberProjectIds(principal.id);
    return JsonResponse.Ok(toPageResult(await this.activity.list({ entityType, entityId, actorId, jobId, projectIds }, { current, size })));
  }
```

Imports: `Principal` from `@nathapp/nestjs-auth`, `ForbiddenAppException` from `@nathapp/nestjs-common`, `KodaPrincipal`/`isUserPrincipal` from `../../auth/principal/koda-principal.types`. Update `fleet-activity.service.spec.ts` for the new filter fields if it constructs filters.

- [ ] **Step 4: Delete guards**

Runner repository (import `ACTIVE_STATES` from `../jobs/job-state`):

```ts
  countUnfinishedJobs(runnerId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { OR: [{ runnerId }, { pinnedRunnerId: runnerId }], state: { in: [...ACTIVE_STATES] } } });
  }
```

Repo repository:

```ts
  countUnfinishedJobs(repoId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { repoId, state: { in: [...ACTIVE_STATES] } } });
  }
```

Both counts must see a stable row, so lock it first (review m6): a placement locks runner rows `FOR UPDATE` and waits; a dispatch's foreign-key check on `FleetRepo` waits on the lock too. Add `lockForDelete(id: string): Promise<void>` to both repositories:

```ts
  // runners
  async lockForDelete(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "Runner" WHERE "id" = ${id} FOR UPDATE`;
  }
  // repos
  async lockForDelete(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "FleetRepo" WHERE "id" = ${id} FOR UPDATE`;
  }
```

A dispatch that waited on the repo lock then fails its foreign key once the repo is gone: in `PrismaFleetJobRepository.createJob`, map `P2003` to `NotFoundAppException({}, 'fleet.repos')` next to the `P2002` mapping.

Add all of these to their domain interfaces. In `RunnersService.remove` and `FleetReposService.remove`, call `lockForDelete(id)` first inside the transaction, then after the not-found check: `if ((await this.repo.countUnfinishedJobs(id)) > 0) throw new ConflictAppException({}, 'fleet.runnerBusy');`. For repos, the same with `'fleet.repoBusy'`. Replace the "Slice 2 adds the active-job 409" comments with a pointer to plan D15. Update the two services' unit specs (mock `countUnfinishedJobs` returning 0, plus one 409 case each).

i18n (`en` / `zh`):

```json
  "runnerBusy": { "409": "The runner has unfinished or pinned jobs; disable it instead" },
  "repoBusy": { "409": "The repository has unfinished jobs" }
```

zh: `"409": "该执行器仍有未完成或已指定的任务，请改为停用"` / `"409": "该仓库仍有未完成的任务"`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet test/integration/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS (no slice 1 suite asserts a non-admin 403 on `/fleet/activity`; the runner-key 401 in `runner-enrollment.integration.spec.ts:76` still holds because the guard refuses runner keys before the controller).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet apps/api/src/i18n apps/api/test/integration/fleet
git commit -m "feat(fleet): project-scoped activity for members and delete guards for busy runners and repos"
```

---

### Task 20a: Contract, guidance, full gates, PR

**Files:**
- Modify: `openapi.json` (generated), `apps/cli/src/generated/**` (generated, untracked)
- Modify: `.nax/mono/apps/api/context.md`, then the generated agent files
- Modify: `docs/superpowers/plans/2026-09-29-fleet-s1-slice-1-foundation.md` (#159, one row)

- [ ] **Step 1: Regenerate the contract**

Run from the repo root: `bun run generate`
Expected: `openapi.json` gains `/api/projects/{slug}/fleet/jobs`, `…/{id}`, `…/{id}/events`, `…/{id}/cancel`, `…/{id}/requeue`; `bun scripts/check-dist-requires.ts` (part of the api build) reports no store paths.

```bash
jq -r '.paths | keys[] | select(test("fleet"))' openapi.json
jq '.components.schemas.FleetJobDto.properties | {maxCostUsd, costSpentUsd}' openapi.json
```
Expected: the new paths; both cost fields `type: string`.

- [ ] **Step 2: CLI still builds**

Run: `cd apps/cli && bunx tsc --noEmit && bunx jest`
Expected: clean and green (no `koda fleet` commands yet; slice 4).

- [ ] **Step 3: Guidance** — extend the `## Fleet (S1)` section of `.nax/mono/apps/api/context.md`:

```markdown
- Jobs (`src/fleet/jobs/`): every state change goes through `JobTransitionsService` (table in `job-state.ts`, spec §5.4). Never write `FleetJob.state` directly.
- Assignment is `casAssign` only (spec §6.1); placement locks runner rows in id order and takes job rows with SKIP LOCKED during a fill.
- Server-owned terminal transitions of a held job bump `leaseEpoch` and withdraw pending commands (plan D4). Requeue bumps it too.
- Publish `fleet_job` live events and wake runners only after the transaction commits.
- Tests build the schema with `prisma db push`; partial unique indexes live in `test/helpers/partial-indexes.ts` and must also be shipped verbatim by a migration.
```

Run `nax generate` and `nax generate --all-packages` from the repo root (local, not billed). Expected: `apps/api/AGENTS.md` / `CLAUDE.md` updated, no other drift.

- [ ] **Step 4: #159** — in the slice 1 plan's "Plan decisions beyond the spec" table, add one row:

```markdown
| D11 (shipped) | A 13th repo-check reason `github_app_key_unreadable` (commit 55b8258b): a set-but-unreadable `GITHUB_APP_PRIVATE_KEY_FILE` or bad PEM is a 422, not a 500. Recorded after merge (#159). |
```

- [ ] **Step 5: Full gates**

```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:integration && cd ../..
git add openapi.json
bun run generate && git diff --exit-code openapi.json
```
Expected: all green; the second generate leaves the staged `openapi.json` unchanged. Record api/web/cli unit and api integration counts against the Task 0 baseline.

- [ ] **Step 6: Security self-check**

```bash
git diff --name-only 7929924b -- apps/api/src | grep -v '\.spec\.ts$' | xargs grep -n "console\.log" || true
```
Expected: no `console.log`. `FleetCommand.payload` (the `ASSIGN` payload) carries no credential: Task 10's test asserts it.

- [ ] **Step 7: Code review before push**

Dispatch a code reviewer over `git diff 7929924b...HEAD` with this plan's Review Focus list and decisions as the brief (repo rule: review before push). Fix CRITICAL/HIGH findings, then re-run Step 5.

- [ ] **Step 8: Commit, push, PR (only after the user approves pushing and opening the PR)**

```bash
git add openapi.json .nax/mono/apps/api/context.md apps/api/AGENTS.md apps/api/CLAUDE.md AGENTS.md CLAUDE.md docs/superpowers/plans/2026-09-29-fleet-s1-slice-1-foundation.md
git commit -m "docs(fleet): slice 2a api guidance, openapi, slice 1 plan reconcile (#159)"
git push -u origin feat/fleet-s1-slice2a-jobs
gh pr create --base main --title "feat(fleet): S1 slice 2a — jobs, placement, dispatch, cancel, requeue" --body-file <(cat <<'EOF'
## Summary
Fleet S1 slice 2a (spec `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`, plan `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2a-jobs.md`).

- Tables FleetJob, FleetJobEvent, FleetCommand, FleetJobArtifact (+ active (repoId, feature) partial unique index, replayed in test global setup).
- Placement with compare-and-set assignment and in-process runner wake-ups.
- Dispatch, list, get, timeline, cancel, requeue under `/projects/:slug/fleet/jobs`; new CASL subject `FleetJob`.
- `fleet_job` live events; project-scoped `GET /fleet/activity`; runner/repo delete refused while jobs are unfinished.
- Folded issues: #160 (provider_error), #161 (capabilities ruling, plan D16), #162 (enrollment retention), #159 (slice 1 plan note).

Closes #159, #160, #161, #162.

## Plan decisions beyond the spec
Register D1-D20 in the plan; 2a implements D1, D2, D4, D9, D10, D14-D18.

## Tests
Baseline vs final counts (api unit, api integration, web, cli).

## Out of scope
Runner sync, fencing of runner writes, git tokens, silence sweep, bundles, attribution (slice 2b); apps/runner (slice 3); web and CLI (slice 4).
EOF
)
```
Expected: PR opened; all ten required checks green.

---

## Self-review (done while writing)

- **Spec coverage (2a share of §13 slice 2):** dispatch (Task 11), placement (Tasks 7, 10), commands queued (Tasks 10, 12), cancel and requeue (Task 12), `fleet_job` live events (Task 9), active-job 409 (Tasks 11, 12), activity view and delete guards (Task 18). Sync, fence, tokens, sweep, bundles and attribution are 2b.
- **Built here for 2b:** all four tables and every repository method 2b calls (events by runner seq, commands, artifacts, `claimAttribution`, `findUserDisplayName`), the protocol sync types, and the slice 2 config settings, so 2b adds no migration and no config.
- **Review Focus:** 1 → Task 10 race test; 2-4 → Task 12 tests; 5 → Task 11 pin test.
