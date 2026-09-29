# Fleet S1 Slice 2b — Runner Sync, Fencing, Git Tokens, Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** Slice 2 was planned as one document (Tasks 0-20) and split into 2a and 2b after its review (READY AFTER FIXES, all applied). Task numbers are kept from the unified plan so references between the two plans stay valid: **2a = Tasks 0-12, 18, 20a; 2b = Tasks 0b, 13-17, 19, 20b.** Decision numbers D1-D20 are shared.

**Prerequisite:** slice 2a (`docs/superpowers/plans/2026-09-29-fleet-s1-slice-2a-jobs.md`) is merged. This plan uses its tables, repository (`IFleetJobRepository`), `JobTransitionsService`, `FleetJobLivePublisher`, `PlacementService`, `RunnerNotifier`, protocol sync types, config settings and test fixtures (`seedFleetHttpWorld`, `insertRunner`, `seedFleetBase`, `FLEET_CAPS`) unchanged. If the 2a review changed any of those signatures, reconcile this plan before Task 13.

**Goal:** Make runners able to work the jobs 2a assigns, as one PR on `feat/fleet-s1-slice2b-runner-sync`: `POST /fleet/runner/sync` (fenced events with dedup and cumulative acks, command acks, boot-id readopt, long-poll), per-job git tokens, the silence sweep, bundle upload/download, and the PR/MR attribution comment.

**Architecture:** `apps/api/src/fleet/sync/` (request parser, event interpretation, `FenceService`, `JobReportProcessor`, `CommandAckProcessor`, `SyncService`, sweeper, attribution), `apps/api/src/fleet/artifacts/` (`ArtifactStore` seam, local disk store, upload and download), and per-job minting in `git-broker/`. Sync step 1 is several short transactions; nothing holds one across the long-poll wait or forge HTTP.

**Tech Stack:** as 2a.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`. Slice 1 plan: `docs/superpowers/plans/2026-09-29-fleet-s1-slice-1-foundation.md` (decisions D1-D10 still hold unless changed here). Sections for 2b: §3.2, §3.3, §5.3 silence and reboot, §6.2, §6.3, §7.1 minting and attribution, §8 artifacts, §12 integration list.

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
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (Task 20b).
- All ten CI checks are required on `main`.

Plan-level rules:

- Branch `feat/fleet-s1-slice2b-runner-sync` in the main checkout (`repos/koda`), from `main` at the 2a merge commit. Start only after 2a is merged; nothing else in development in parallel.
- API specs: `cd apps/api && bun run test:scoped <paths>` (sets `KODA_DB_TESTS=1` for integration paths). Never two DB jest runs at once. Start the test DB once: `cd apps/api && bun run test:db:up`.
- ts-jest type-checks every spec. After any signature change run `cd apps/api && bunx tsc --noEmit -p tsconfig.json` and fix every broken spec in the same task.
- Integration suites that log in more than four times or enroll more than nine runners copy the throttler reset from `test/integration/fleet/runner-enrollment.integration.spec.ts` (`beforeEach`).
- No emojis. Conventional commits, no attribution trailer.

## Plan decisions beyond the spec

The register is in the 2a plan. The rows that govern this plan:

| # | Decision | Why |
|:--|:--|:--|
| D2 | `FleetJobEvent` gets a **server** `seq` (timeline order, from `FleetJob.eventSeq`) plus `leaseEpoch` and a nullable `runnerSeq`. Runner dedup key = `(jobId, leaseEpoch, runnerSeq)`; timeline key = `(jobId, seq)`. `FleetJob.ackedRunnerSeq` holds the cumulative ack for the current epoch and resets to 0 on every assignment. | Spec §2 keys events on `(jobId, seq)`, but (a) a requeued job's new runner starts again at seq 1 and (b) the server writes `state` events too (§5.4). One runner-seq namespace per epoch, one server timeline. |
| D3 | `FleetJobArtifact` gets `leaseEpoch` and `@@unique([jobId, kind, leaseEpoch])`; download serves the highest epoch. Keys are per attempt, `jobs/<jobId>/<epoch>/<uuid>.tar.gz` (spec §8 drew `jobs/<jobId>/<epoch>.tar.gz`); the row is repointed in the recording transaction and the replaced file deleted after commit. | "Re-upload for the same job and epoch replaces" (spec §3.3) needs the epoch on the row; a per-attempt key means a failed or fenced re-upload can never overwrite or delete the last good bundle. |
| D4 | Server-owned terminal transitions of a job that had a runner (cancel of an unacked assign, sweep CRASHED, rejected READOPT) **bump `leaseEpoch`**, so a late runner is fenced (§6.2) and gets `ABANDON`. Every transition into a terminal state marks that job's pending non-`ABANDON` commands `ackResult = 'withdrawn'`. | Without the bump, a runner that received an assign we then cancelled still matches `(runnerId, leaseEpoch)` and could keep writing. |
| D5 | Sync step 1 (spec §3.2) is several short transactions — one per reported job, one for acks, one for boot reconcile, one for placement fill — none held across the long-poll wait or forge HTTP. Git tokens are minted after those commit. | Keeps locks short; avoids lock-order cycles between job rows and runner rows. |
| D6 | A runner-reported transition not in the §5.4 table, and an event whose payload is malformed, is **stored and not applied** (the ack advances), logged, and recorded as `job.event_rejected` activity. Only a duplicate `runnerSeq` with a different payload blocks the ack (spec §3.2). | Refusing to store would make the runner resend the same bad event forever. |
| D7 | Additive protocol fields (protocol version stays 1): response `unknownJobIds` (jobs the server does not know: the runner abandons them) and `gitTokenErrors: [{jobId, reason}]`; the `ASSIGN` payload shape is fixed in the package. | The spec's `ABANDON` needs a job row (FK); a mint failure needs a reason the daemon can log. |
| D8 | `ASSIGN` acked `rejected` → job FAILED (`stateReason = 'assign rejected: …'`). `CANCEL` acked `rejected` (runner does not hold the job) → CANCELLED (`'cancel: runner does not hold job'`). Acks are matched to the command row (`runnerId`, `leaseEpoch`); an ack whose job has since moved epochs is marked `stale` and queues `ABANDON`. | Spec defines ack semantics only for `READOPT`. |
| D11 | The silence sweep crashes `UPLOADING` jobs too, and runs only when `FLEET_SWEEP_ENABLED` (default on, off under `NODE_ENV=test`); tests call `sweep(now)`. | An `UPLOADING` job on a dead machine would otherwise never end. Same default rule as the outbox relay. |
| D12 | Bundle upload body: production (Fastify) registers an `application/gzip` pass-through content parser in `main.ts`; the HTTP test harness is Express (`bootHttpApp` → `NestFactory.create` default), where the request itself is the stream. The handler reads `req.body` when it is a stream, else `req`. A unit spec drives the Fastify parser with `inject`. | `bootHttpApp` and `main.ts` use different adapters; both must work. |
| D13 | The 1 MiB sync body cap (spec §3.2) is the existing global JSON cap (`registerRawBodyHook`, KODA-12) plus Fastify's default `bodyLimit`; nothing new, and not re-tested on the Express harness. | Already enforced in production. |
| D19 | Attribution (spec §7.1) takes owner/name from the job's `FleetRepo` and only the PR/MR number from `resultPrUrl` (untrusted runner input); an `attributedAt` compare-and-set makes it one comment. | A runner must not be able to make koda comment on another repo. |
| D20 | The sync route skips the global 100/min IP throttle, like the SSE stream (`live.controller.ts:33`); defined in Task 14. | Runner-key authenticated; runners share NAT addresses and sync often; a 429 delays acks and cancels. |

## Review Focus

1. **A stale runner keeps talking** (after requeue, a sweep crash, or a cancelled unacked assign): its events, acks, token requests and bundle upload are all refused, nothing is stored, no token is minted, and exactly one `ABANDON` is queued for that `(runner, job, epoch)`, not one per sync. Tasks 14, 15, 17.
2. **Daemon restart mid-run**: a sync with a new `bootId` queues one `READOPT` per held job; later syncs with that boot id queue nothing more; `ok` sets `runnerBootId`, `rejected` ends CRASHED. Reconcile runs every sync, so a crash between steps cannot lose it. Task 14.
3. **Cancel races the runner's terminal report**: the runner reports COMPLETED while a `CANCEL` is pending. Whichever commits first wins, the pending `CANCEL` is withdrawn, and a late ack returns no error. Task 14.
4. **Hostile runner input**: `resultPrUrl` for another repo, a 5 KB `progress`, `costSpentUsd: "abc"`, a NUL byte in a string: bounded, replaced or ignored; one bad job never blocks the rest of a sync; attribution only comments on the job's own repo. Tasks 13, 14, 19.
5. **A replacement bundle that fails** (wrong hash, too large, lease lost mid-upload): the last good bundle stays downloadable. Task 17.

---

## File Structure

| File | Responsibility | Task |
|:--|:--|:--|
| `apps/api/src/fleet/sync/sync-request.parser.ts`, `event-payloads.ts`, `stable-json.ts` (new) | Untrusted sync input | 13 |
| `apps/api/src/fleet/sync/fence.service.ts`, `job-report.processor.ts`, `command-ack.processor.ts`, `sync.service.ts`, `runner-sync.controller.ts`, `sync.module.ts` (new), `test/helpers/fleet-fixtures.ts` (extended) | Sync endpoint | 14 |
| `apps/api/src/fleet/git-broker/git-token.broker.ts`, `gitlab-token.source.ts` (new), `github-app-client.ts` | Per-job tokens | 15 |
| `apps/api/src/fleet/sync/fleet-sweeper.ts` (new) | Silence sweep | 16 |
| `apps/api/src/fleet/artifacts/*` (new), `apps/api/src/common/hooks/bundle-content-parser.ts` (new), `main.ts` | Bundles | 17 |
| `apps/api/src/fleet/sync/pr-attribution.service.ts` (new) | PR/MR comment | 19 |
| `openapi.json`, `.nax/mono/apps/api/context.md` | Contract, guidance | 20b |

---

### Task 0b: Baseline

**Files:** none.

- [ ] **Step 1: Branch from the merged 2a**

```bash
git -C repos/koda checkout main && git -C repos/koda pull --ff-only
git -C repos/koda checkout -b feat/fleet-s1-slice2b-runner-sync
git -C repos/koda log --oneline -1
```
Expected: the 2a merge commit (`feat(fleet): S1 slice 2a …`). Record its sha; Task 20b diffs against it.

- [ ] **Step 2: Confirm the 2a surface this plan builds on**

```bash
cd repos/koda/apps/api
grep -n "casAssign\|findRunnerEventsAfter\|withdrawPendingCommands\|claimAttribution\|upsertArtifact" src/fleet/jobs/domain/fleet-job.domain.ts
grep -n "export function seedFleetHttpWorld\|export async function insertRunner\|export const FLEET_CAPS" test/helpers/fleet-fixtures.ts
grep -n "syncWaitMs\|bundleMaxBytes\|artifactDir" src/config/fleet.config.ts
```
Expected: every name present. If one is missing or renamed, stop and reconcile this plan first.

- [ ] **Step 3: Start the test DB and record baselines**

```bash
cd apps/api && bun run test:db:up
bun run test 2>&1 | tail -5
bun run test:scoped test/integration/fleet 2>&1 | tail -5
bunx tsc --noEmit -p tsconfig.json
```

---

### Task 13: Untrusted sync input — request parser and event interpretation

**Files:**
- Create: `apps/api/src/fleet/sync/sync-request.parser.ts`, `sync-request.parser.spec.ts`
- Create: `apps/api/src/fleet/sync/event-payloads.ts`, `event-payloads.spec.ts`
- Create: `apps/api/src/fleet/sync/stable-json.ts`, `stable-json.spec.ts`
- Modify: `apps/api/src/i18n/{en,zh}/fleet.json`

**Interfaces:**
- Produces:
  - `SYNC_LIMITS = { jobs: 64, eventsPerJob: 500, acks: 256, tokenRequests: 64, payloadBytes: 16_384 }`
  - `ParsedSync = Omit<SyncRequest, 'capabilities'> & { capabilities?: unknown }`; `parseSyncRequest(raw: unknown): ParsedSync` — throws `ValidationAppException(…, 'fleet.sync')`. Does **not** check the protocol version (Task 14 does that first, for the 426).
  - `type EventEffect = { kind: 'transition'; to: FleetJobState; reason: string | null; exitCode: number | null } | { kind: 'mirror'; patch: FleetJobPatch } | { kind: 'none' } | { kind: 'invalid'; reason: string }`
  - `interpretEvent(type: string, payload: unknown): EventEffect`
  - `stableStringify(value: unknown): string` (object keys sorted; Postgres `jsonb` reorders keys, so stored and resent payloads are compared through it).

- [ ] **Step 1: Write the failing tests**

`sync-request.parser.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseSyncRequest } from './sync-request.parser';

const base = { protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 1, jobs: [], commandAcks: [], tokenRequests: [] };
const ev = (seq: number, type = 'log', payload: unknown = { stream: 'run', text: 'x' }) => ({ seq, type, payload });

describe('parseSyncRequest (spec §3.2)', () => {
  it('accepts a full request and defaults missing lists', () => {
    const parsed = parseSyncRequest({
      ...base, jobs: [{ jobId: 'j1', leaseEpoch: 2, events: [ev(1)] }],
      commandAcks: [{ commandId: 'c1', leaseEpoch: 2, result: 'ok' }], tokenRequests: [{ jobId: 'j1', leaseEpoch: 2 }],
    });
    expect(parsed.jobs[0].events[0].seq).toBe(1);
    expect(parseSyncRequest({ protocolVersion: 1, bootId: 'b', daemonVersion: 'd', freeSlots: 0 })).toEqual(
      expect.objectContaining({ jobs: [], commandAcks: [], tokenRequests: [] }),
    );
  });

  it.each([
    ['not an object', 'x'],
    ['negative freeSlots', { ...base, freeSlots: -1 }],
    ['65 free slots', { ...base, freeSlots: 65 }],
    ['empty bootId', { ...base, bootId: '' }],
    ['seq 0', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(0)] }] }],
    ['duplicate seq in one report', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1), ev(1)] }] }],
    ['the same job twice', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [] }, { jobId: 'j', leaseEpoch: 1, events: [] }] }],
    ['an unknown event type', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'shell')] }] }],
    ['a payload that is not an object', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'log', 'text')] }] }],
    ['a payload over 16 KiB', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'log', { text: 'x'.repeat(17_000) })] }] }],
    ['501 events', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: Array.from({ length: 501 }, (_, i) => ev(i + 1)) }] }],
    ['an ack result of maybe', { ...base, commandAcks: [{ commandId: 'c', leaseEpoch: 1, result: 'maybe' }] }],
    ['a fractional lease epoch', { ...base, tokenRequests: [{ jobId: 'j', leaseEpoch: 1.5 }] }],
    ['a 65-character job id', { ...base, tokenRequests: [{ jobId: 'j'.repeat(65), leaseEpoch: 1 }] }],
    ['a NUL in the boot id', { ...base, bootId: 'boot\u0000' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSyncRequest(raw)).toThrow(ValidationAppException);
  });

  it('replaces NUL in event payload strings and keys instead of failing the request (review M2)', () => {
    const parsed = parseSyncRequest({ ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'snapshot', { resultBranch: 'a\u0000b', ['k\u0000']: ['x\u0000'] })] }] });
    expect(parsed.jobs[0].events[0].payload).toEqual({ resultBranch: 'a\uFFFDb', ['k\uFFFD']: ['x\uFFFD'] });
  });
});
```

`event-payloads.spec.ts`:

```ts
import { interpretEvent } from './event-payloads';

describe('interpretEvent', () => {
  it('reads a state event', () => {
    expect(interpretEvent('state', { to: 'RUNNING' })).toEqual({ kind: 'transition', to: 'RUNNING', reason: null, exitCode: null });
    expect(interpretEvent('state', { to: 'FAILED', reason: 'x'.repeat(900), exitCode: 1 })).toEqual(
      expect.objectContaining({ kind: 'transition', to: 'FAILED', exitCode: 1, reason: 'x'.repeat(500) }),
    );
    expect(interpretEvent('state', { to: 'DONE' })).toEqual(expect.objectContaining({ kind: 'invalid' }));
  });

  it('mirrors a snapshot and drops hostile fields instead of failing (review focus 5)', () => {
    const effect = interpretEvent('snapshot', {
      naxRunId: 'run-1', costSpentUsd: '1.2345', currentStoryId: 'US-002', currentPhase: null,
      heartbeatAt: '2026-10-01T00:00:00.000Z', progress: { done: 2, total: 5 },
      resultPrUrl: 'https://github.com/acme/app/pull/7', resultSha: 'abc1234',
    });
    expect(effect).toEqual({
      kind: 'mirror',
      patch: {
        naxRunId: 'run-1', costSpentUsd: '1.2345', currentStoryId: 'US-002', currentPhase: null,
        lastHeartbeatAt: new Date('2026-10-01T00:00:00.000Z'), progress: { done: 2, total: 5 },
        resultPrUrl: 'https://github.com/acme/app/pull/7', resultSha: 'abc1234',
      },
    });
    const hostile = interpretEvent('snapshot', {
      costSpentUsd: 'abc', progress: { blob: 'x'.repeat(5_000) }, resultPrUrl: 'javascript:alert(1)',
      resultSha: 'not-a-sha', heartbeatAt: 'soon', naxRunId: 'r'.repeat(200),
    });
    expect(hostile).toEqual({ kind: 'mirror', patch: {} });
  });

  it('stores lifecycle and log events without effect, and flags an oversized log', () => {
    expect(interpretEvent('lifecycle', { level: 'warn', message: 'watcher error' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'ok' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'x'.repeat(8_193) })).toEqual(expect.objectContaining({ kind: 'invalid' }));
  });
});
```

`stable-json.spec.ts`:

```ts
import { stableStringify } from './stable-json';

it('is independent of key order at every depth', () => {
  expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/sync`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement** — `stable-json.ts`

```ts
/** JSON with object keys sorted at every depth; for comparing payloads that went through jsonb. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
```

`sync-request.parser.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { CommandAck, JobReport, RunnerEvent, SyncRequest, TokenRequest } from '../common/protocol';

export const SYNC_LIMITS = Object.freeze({ jobs: 64, eventsPerJob: 500, acks: 256, tokenRequests: 64, payloadBytes: 16_384 });
const EVENT_TYPES: readonly string[] = ['state', 'snapshot', 'lifecycle', 'log'];
const MAX_INT = 2_147_483_647;

export type ParsedSync = Omit<SyncRequest, 'capabilities'> & { capabilities?: unknown };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');
const isInt = (v: unknown, min: number, max = MAX_INT): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.sync');
}

/**
 * Postgres rejects U+0000 in text and jsonb, which would fail the whole job's transaction and
 * make the runner resend forever. Replace it in every payload string and key; resends are
 * sanitised the same way, so dedup still compares like with like.
 */
export function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\u0000/g, '\uFFFD');
  if (Array.isArray(value)) return value.map(stripNul);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/\u0000/g, '\uFFFD'), stripNul(v)]));
  }
  return value;
}

function list(v: unknown, max: number, name: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail(name);
  return v;
}

function parseEvent(v: unknown): RunnerEvent {
  if (!isObj(v) || !isInt(v.seq, 1) || typeof v.type !== 'string' || !EVENT_TYPES.includes(v.type) || !isObj(v.payload)) fail('event');
  if (Buffer.byteLength(JSON.stringify(v.payload), 'utf8') > SYNC_LIMITS.payloadBytes) fail('event payload too large');
  return { seq: v.seq as number, type: v.type as RunnerEvent['type'], payload: stripNul(v.payload) as RunnerEvent['payload'] };
}

function parseJob(v: unknown): JobReport {
  if (!isObj(v) || !isStr(v.jobId, 64) || !isInt(v.leaseEpoch, 0)) fail('job');
  const events = list(v.events, SYNC_LIMITS.eventsPerJob, 'events').map(parseEvent);
  if (new Set(events.map((e) => e.seq)).size !== events.length) fail('duplicate seq');
  return { jobId: v.jobId as string, leaseEpoch: v.leaseEpoch as number, events };
}

function parseAck(v: unknown): CommandAck {
  if (!isObj(v) || !isStr(v.commandId, 64) || !isInt(v.leaseEpoch, 0) || (v.result !== 'ok' && v.result !== 'rejected')) fail('commandAck');
  if (v.detail !== undefined && (typeof v.detail !== 'string' || v.detail.length > 500 || v.detail.includes('\u0000'))) fail('commandAck detail');
  return { commandId: v.commandId as string, leaseEpoch: v.leaseEpoch as number, result: v.result, ...(v.detail !== undefined ? { detail: v.detail as string } : {}) };
}

function parseTokenRequest(v: unknown): TokenRequest {
  if (!isObj(v) || !isStr(v.jobId, 64) || !isInt(v.leaseEpoch, 0)) fail('tokenRequest');
  return { jobId: v.jobId as string, leaseEpoch: v.leaseEpoch as number };
}

/** Envelope validation of an untrusted runner sync (spec §3.2). Payload semantics: interpretEvent. */
export function parseSyncRequest(raw: unknown): ParsedSync {
  if (!isObj(raw)) fail('body');
  if (!isInt(raw.protocolVersion, 0)) fail('protocolVersion');
  if (!isStr(raw.bootId, 128)) fail('bootId');
  if (!isStr(raw.daemonVersion, 64)) fail('daemonVersion');
  if (!isInt(raw.freeSlots, 0, 64)) fail('freeSlots');
  const jobs = list(raw.jobs, SYNC_LIMITS.jobs, 'jobs').map(parseJob);
  if (new Set(jobs.map((j) => j.jobId)).size !== jobs.length) fail('duplicate job');
  return {
    protocolVersion: raw.protocolVersion as number,
    bootId: raw.bootId as string,
    daemonVersion: raw.daemonVersion as string,
    ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
    freeSlots: raw.freeSlots as number,
    jobs,
    commandAcks: list(raw.commandAcks, SYNC_LIMITS.acks, 'commandAcks').map(parseAck),
    tokenRequests: list(raw.tokenRequests, SYNC_LIMITS.tokenRequests, 'tokenRequests').map(parseTokenRequest),
  };
}
```

`event-payloads.ts`:

```ts
import { FleetJobState } from '../../common/enums';
import type { FleetJobPatch } from '../jobs/domain/fleet-job.domain';

export type EventEffect =
  | { kind: 'transition'; to: FleetJobState; reason: string | null; exitCode: number | null }
  | { kind: 'mirror'; patch: FleetJobPatch }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string };

type Obj = Record<string, unknown>;
const STATES: readonly string[] = Object.values(FleetJobState);
const MAX_PROGRESS_BYTES = 4_096;
const MAX_LOG_BYTES = 8_192;
const COST_RE = /^\d{1,8}(\.\d{1,4})?$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const strOrNull = (v: unknown, max: number): string | null | undefined => (v === null ? null : str(v, max));

function httpUrl(v: unknown): string | undefined {
  const s = str(v, 500);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot -> mirror patch. Fields that fail their bound are dropped, not fatal (review focus 5). */
function mirror(p: Obj): FleetJobPatch {
  const heartbeat = typeof p.heartbeatAt === 'string' && !Number.isNaN(Date.parse(p.heartbeatAt)) ? new Date(p.heartbeatAt) : undefined;
  const progress = typeof p.progress === 'object' && p.progress !== null && !Array.isArray(p.progress) &&
    Buffer.byteLength(JSON.stringify(p.progress), 'utf8') <= MAX_PROGRESS_BYTES ? p.progress : undefined;
  const entries: Array<[keyof FleetJobPatch, unknown]> = [
    ['naxRunId', str(p.naxRunId, 128)],
    ['naxLogRunId', str(p.naxLogRunId, 128)],
    ['naxCostRunId', str(p.naxCostRunId, 128)],
    ['progress', progress],
    ['currentStoryId', strOrNull(p.currentStoryId, 128)],
    ['currentPhase', strOrNull(p.currentPhase, 128)],
    ['costSpentUsd', typeof p.costSpentUsd === 'string' && COST_RE.test(p.costSpentUsd) ? p.costSpentUsd : undefined],
    ['lastHeartbeatAt', heartbeat],
    ['finishResult', str(p.finishResult, 64)],
    ['escalationReason', str(p.escalationReason, 2_000)],
    ['resultBranch', str(p.resultBranch, 255)],
    ['resultSha', typeof p.resultSha === 'string' && SHA_RE.test(p.resultSha) ? p.resultSha : undefined],
    ['resultPrUrl', httpUrl(p.resultPrUrl)],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as FleetJobPatch;
}

/** What a stored runner event does to its job (spec §3.2, §5.4). The parser guarantees payload is an object. */
export function interpretEvent(type: string, payload: unknown): EventEffect {
  const p = (payload ?? {}) as Obj;
  switch (type) {
    case 'state': {
      if (typeof p.to !== 'string' || !STATES.includes(p.to)) return { kind: 'invalid', reason: 'state.to' };
      const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : null;
      const exitCode = Number.isInteger(p.exitCode) ? (p.exitCode as number) : null;
      return { kind: 'transition', to: p.to as FleetJobState, reason, exitCode };
    }
    case 'snapshot':
      return { kind: 'mirror', patch: mirror(p) };
    case 'log':
      if (typeof p.text !== 'string' || Buffer.byteLength(p.text, 'utf8') > MAX_LOG_BYTES) return { kind: 'invalid', reason: 'log.text' };
      return { kind: 'none' };
    case 'lifecycle':
      return { kind: 'none' };
    default:
      return { kind: 'invalid', reason: `type ${type}` };
  }
}
```

i18n (`en` / `zh`): `"sync": { "-2": "Invalid sync request: {reason}" }` / `"sync": { "-2": "无效的同步请求：{reason}" }`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet/sync && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/sync apps/api/src/i18n
git commit -m "feat(fleet): parse untrusted sync requests and interpret runner events"
```

---

### Task 14: The sync endpoint — events, fence, acks, reboot reconcile, long-poll

**Files:**
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, `prisma-fleet-job.repository.ts` (`recordRunnerSync`)
- Create: `apps/api/src/fleet/sync/fence.service.ts`, `job-report.processor.ts`, `command-ack.processor.ts`, `sync.service.ts`, `runner-sync.controller.ts`, `sync.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts`, `apps/api/test/helpers/fleet-fixtures.ts` (`enrollRunner`, `syncBody`)
- Test: `apps/api/test/integration/fleet/runner-sync.integration.spec.ts`, `runner-sync-lifecycle.integration.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 8-13.
- Produces:
  - `IFleetJobRepository.recordRunnerSync(runnerId, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }): Promise<{ previousBootId: string } | null>`
  - `FenceService { holds(job, runnerId, leaseEpoch): boolean; abandon(runnerId, job, leaseEpoch): Promise<boolean> }` — at most one pending `ABANDON` per (runner, job, epoch).
  - `JobReportProcessor.process(runnerId, report: JobReport, now): Promise<{ ack: JobAck | null; unknown: boolean; live: LiveFleetJobEvent[]; terminalJobId: string | null }>`
  - `CommandAckProcessor { process(runnerId, bootId, acks, now): Promise<LiveFleetJobEvent[]>; reconcileBoot(runnerId, bootId, now, rebooted: boolean): Promise<number> }` — reconcile runs on every sync (review M3).
  - `SyncService.sync(runnerId: string, raw: unknown): Promise<SyncResponse>`
  - Route `POST /fleet/runner/sync` (`@RunnerRoute()`, `@SkipThrottle()` — plan D20 below)
  - Fixtures: `enrollRunner(server, adminToken, name, over?)`, `syncBody(over?)`.

**Plan decision D20 (added here):** the sync route skips the global 100/min IP throttle, like the SSE stream (`live.controller.ts:33`). It is runner-key authenticated, a runner with a busy job syncs every few seconds, several runners can share one NAT address, and a 429 would delay acks and cancels.

- [ ] **Step 1: Fixtures** (append to `test/helpers/fleet-fixtures.ts`)

```ts
import type { SyncRequest } from '../../src/fleet/common/protocol';

/** Issues an enrollment token as admin and enrolls a runner over HTTP (enroll is throttled 10/min). */
export async function enrollRunner(
  server: Parameters<typeof request>[0],
  adminToken: string,
  name: string,
  over: { labels?: string[]; capabilities?: RunnerCapabilities; bootId?: string } = {},
): Promise<{ runnerId: string; apiKey: string }> {
  const { token } = data<{ token: string }>(
    await request(server).post('/api/fleet/enrollments').set({ Authorization: `Bearer ${adminToken}` }).send({ labels: over.labels ?? ['linux'] }).expect(201),
  );
  return data(
    await request(server).post('/api/fleet/runner/enroll').send({
      enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: '0.1.0', protocolVersion: 1,
      bootId: over.bootId ?? 'boot-1', labels: [], capabilities: over.capabilities ?? FLEET_CAPS,
    }).expect(201),
  );
}

export const syncBody = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 0, jobs: [], commandAcks: [], tokenRequests: [], ...over,
});
```

- [ ] **Step 2: Write the failing integration tests**

`test/integration/fleet/runner-sync.integration.spec.ts`:

```ts
/**
 * Fleet S1 slice 2 — POST /fleet/runner/sync: delivery, events, dedup, fence (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('runner sync (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}, key = runner.apiKey) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${key}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; state: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const ev = (seq: number, type: string, payload: object) => ({ seq, type: type as 'log', payload: payload as never });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('answers 426 for another protocol version, 400 for garbage, 401 for a user token', async () => {
    const post = (body: unknown, token = runner.apiKey) => request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${token}` }).send(body as object);
    await post({ ...syncBody(), protocolVersion: 99 }).expect(426);
    await post({ ...syncBody(), freeSlots: -1 }).expect(400);
    await post(syncBody(), world.tokens.root).expect(401);
  });

  it('re-sends an ASSIGN until it is acked, then applies events in order and dedups resends', async () => {
    const j = await dispatch('ev');
    expect(j.state).toBe('ASSIGNED');
    const first = await sync();
    const assign = first.commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    expect(assign).toBeDefined();
    expect((await sync()).commands.map((c) => c.commandId)).toContain(assign?.commandId);

    const events = [
      ev(1, 'state', { to: 'RUNNING' }),
      ev(2, 'snapshot', { naxRunId: 'run-1', costSpentUsd: '0.5', currentStoryId: 'US-001', progress: { done: 1 } }),
      ev(3, 'log', { stream: 'run', text: 'hello' }),
    ];
    const res = await sync({ commandAcks: [{ commandId: assign!.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }], jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 3 }]);
    expect(res.commands.map((c) => c.commandId)).not.toContain(assign!.commandId);
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'RUNNING', naxRunId: 'run-1', currentStoryId: 'US-001' }));
    expect((await job(j.id)).costSpentUsd.toString()).toBe('0.5');

    const count = await prisma.fleetJobEvent.count({ where: { jobId: j.id } });
    expect((await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events }] })).jobAcks).toEqual([{ jobId: j.id, ackedSeq: 3 }]);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: j.id } })).toBe(count);
  });

  it('stores events above a gap but acks and applies only the contiguous prefix', async () => {
    const running = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const e = { jobId: running.id, leaseEpoch: running.leaseEpoch };
    expect((await sync({ jobs: [{ ...e, events: [ev(5, 'state', { to: 'UPLOADING' })] }] })).jobAcks).toEqual([{ jobId: running.id, ackedSeq: 3 }]);
    expect((await job(running.id)).state).toBe('RUNNING');
    expect((await sync({ jobs: [{ ...e, events: [ev(4, 'log', { stream: 'run', text: 'gap' })] }] })).jobAcks).toEqual([{ jobId: running.id, ackedSeq: 5 }]);
    expect((await job(running.id)).state).toBe('UPLOADING');
  });

  it('rejects a resent seq with a different payload without advancing or storing', async () => {
    const running = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const before = await prisma.fleetJobEvent.count({ where: { jobId: running.id } });
    const res = await sync({ jobs: [{ jobId: running.id, leaseEpoch: running.leaseEpoch, events: [ev(3, 'log', { stream: 'run', text: 'changed' }), ev(6, 'log', { stream: 'run', text: 'new' })] }] });
    expect(res.jobAcks).toEqual([{ jobId: running.id, ackedSeq: 5 }]);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: running.id } })).toBe(before);
  });

  it('stores but does not apply a transition outside the table, and records why', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    const res = await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [ev(6, 'state', { to: 'QUEUED' })] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 6 }]);
    expect((await job(j.id)).state).toBe('UPLOADING');
    expect(await prisma.fleetActivity.count({ where: { jobId: j.id, action: 'job.event_rejected' } })).toBe(1);
  });

  it('fences a stale epoch: nothing stored, no ack, exactly one ABANDON across repeated syncs (review focus 1)', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch + 1 } }); // as if requeued elsewhere
    const before = await prisma.fleetJobEvent.count({ where: { jobId: j.id } });
    const stale = { jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [ev(7, 'log', { stream: 'run', text: 'late' })] }] };
    const r1 = await sync(stale);
    const r2 = await sync(stale);
    expect(r1.jobAcks).toEqual([]);
    expect(r2.commands.filter((c) => c.type === 'ABANDON' && c.jobId === j.id)).toHaveLength(1);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);
    expect(await prisma.fleetJobEvent.count({ where: { jobId: j.id } })).toBe(before);
  });

  it('stores NUL-bearing strings with a replacement character instead of failing the sync (review M2)', async () => {
    const j = await prisma.fleetJob.findFirstOrThrow({ where: { feature: 'ev' } });
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch - 1 } }); // undo the stale-epoch test's bump
    const held = await job(j.id);
    const res = await sync({ jobs: [{ jobId: j.id, leaseEpoch: held.leaseEpoch, events: [
      ev(7, 'log', { stream: 'run', text: 'nul\u0000here' }), ev(8, 'snapshot', { resultBranch: 'feat\u0000x' }),
    ] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 8 }]);
    expect((await job(j.id)).resultBranch).toBe('feat\uFFFDx');
  });

  it('reports unknown job ids and stores new capabilities', async () => {
    const res = await sync({ jobs: [{ jobId: 'no-such-job', leaseEpoch: 1, events: [] }] });
    expect(res.unknownJobIds).toEqual(['no-such-job']);
    const caps = { ...(await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capabilities as object, sandbox: { available: false, probedAt: '2026-10-02T00:00:00.000Z' } };
    await sync({ capabilities: caps as never });
    expect(((await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capabilities as { sandbox: { available: boolean } }).sandbox.available).toBe(false);
  });

  it('fills free slots on sync, but never for a disabled runner', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { enabled: false } });
    const j = await dispatch('fill');
    expect(j.state).toBe('QUEUED');
    expect((await sync({ freeSlots: 1 })).commands.filter((c) => c.jobId === j.id)).toEqual([]);
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { enabled: true } });
    await prisma.fleetJob.updateMany({ where: { runnerId: runner.runnerId, state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'FAILED' } });
    expect((await sync({ freeSlots: 1 })).commands.filter((c) => c.jobId === j.id && c.type === 'ASSIGN')).toHaveLength(1);
  });
});
```

`test/integration/fleet/runner-sync-lifecycle.integration.spec.ts`:

```ts
/**
 * Fleet S1 slice 2 — sync lifecycle: acks, cancel races, reboot readopt, long-poll wake-up (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-sync-lifecycle.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000); // several syncs here return idle and wait the full FLEET_SYNC_WAIT_MS

describeIntegration('runner sync lifecycle (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const dispatch = async (feature: string, repoId = world.repoId) =>
    data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set(asDev()).send({ repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  /** Dispatch, take the ASSIGN, ack it and report RUNNING. */
  const startRunning = async (feature: string, repoId = world.repoId) => {
    const j = await dispatch(feature, repoId);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });
    return j;
  };
  const finishAll = () => prisma.fleetJob.updateMany({ where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'COMPLETED' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '800';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });
  afterEach(async () => {
    await finishAll();
  });

  it('fails a job whose ASSIGN the runner rejects', async () => {
    const j = await dispatch('rejected');
    const assign = (await sync()).commands.find((c) => c.jobId === j.id)!;
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'rejected', detail: 'workspace root full' }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'FAILED', stateReason: 'assign rejected: workspace root full' }));
  });

  it('delivers CANCEL for a running job and ends CANCELLED when the runner reports it', async () => {
    const j = await startRunning('cancel');
    await request(server).post(`/api/projects/web/fleet/jobs/${j.id}/cancel`).set(asDev()).expect(200);
    const cancel = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'CANCEL')!;
    await sync({
      commandAcks: [{ commandId: cancel.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED' } }] }],
    });
    expect((await job(j.id)).state).toBe('CANCELLED');
  });

  it('lets a terminal report beat a pending CANCEL; the late ack is harmless (review focus 4)', async () => {
    const j = await startRunning('race');
    await request(server).post(`/api/projects/web/fleet/jobs/${j.id}/cancel`).set(asDev()).expect(200);
    const cancel = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'CANCEL')!;
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
      { seq: 2, type: 'state', payload: { to: 'UPLOADING' } }, { seq: 3, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });
    expect((await job(j.id)).state).toBe('COMPLETED');
    expect((await prisma.fleetCommand.findUniqueOrThrow({ where: { id: cancel.commandId } })).ackResult).toBe('withdrawn');
    await sync({ commandAcks: [{ commandId: cancel.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }] });
    expect((await job(j.id)).state).toBe('COMPLETED');
  });

  it('queues one READOPT per held job on a new boot id; ok re-adopts, rejected crashes (review focus 3)', async () => {
    const keep = await startRunning('readopt-ok');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 2 } });
    // Placement never puts two active jobs of one repo on one runner (busy_repo), so use a second repo.
    const repo2 = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'app2', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    const lose = await startRunning('readopt-lost', repo2.id);
    const r1 = await sync({ bootId: 'boot-2' });
    const readopts = r1.commands.filter((c) => c.type === 'READOPT');
    expect(readopts.map((c) => c.jobId).sort()).toEqual([keep.id, lose.id].sort());
    await sync({ bootId: 'boot-2' });
    expect(await prisma.fleetCommand.count({ where: { type: 'READOPT' } })).toBe(2);

    const byJob = new Map(readopts.map((c) => [c.jobId, c]));
    await sync({ bootId: 'boot-2', commandAcks: [
      { commandId: byJob.get(keep.id)!.commandId, leaseEpoch: keep.leaseEpoch, result: 'ok' },
      { commandId: byJob.get(lose.id)!.commandId, leaseEpoch: lose.leaseEpoch, result: 'rejected', detail: 'pid gone' },
    ] });
    expect(await job(keep.id)).toEqual(expect.objectContaining({ state: 'RUNNING', runnerBootId: 'boot-2' }));
    expect(await job(lose.id)).toEqual(expect.objectContaining({ state: 'CRASHED', leaseEpoch: lose.leaseEpoch + 1 }));
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 1, bootId: 'boot-1' } });
  });

  it('holds an idle sync and wakes it as soon as a command lands', async () => {
    const started = Date.now();
    const pending = sync({ bootId: 'boot-1' });
    await new Promise((r) => setTimeout(r, 150));
    const j = await dispatch('wake');
    const res = await pending;
    expect(res.commands.some((c) => c.jobId === j.id && c.type === 'ASSIGN')).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
  });
});
```

(Each test ends its jobs in `afterEach`, so the single-capacity runner is free for the next one.)

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/runner-sync-lifecycle.integration.spec.ts`
Expected: FAIL — 404 on `/fleet/runner/sync`.

- [ ] **Step 4: Repository** — add to `IFleetJobRepository` and implement:

```ts
  /** Updates lastSeenAt and the reported fields; returns the boot id stored before this sync, or null if the runner is gone. */
  recordRunnerSync(runnerId: string, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }): Promise<{ previousBootId: string } | null>;
```

```ts
  async recordRunnerSync(runnerId: string, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }) {
    const before = await this.db.runner.findUnique({ where: { id: runnerId }, select: { bootId: true } });
    if (!before) return null;
    await this.db.runner.update({
      where: { id: runnerId },
      data: {
        lastSeenAt: s.now, bootId: s.bootId, daemonVersion: s.daemonVersion, protocolVersion: s.protocolVersion,
        ...(s.capabilities ? { capabilities: s.capabilities as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return { previousBootId: before.bootId };
  }
```

(`RunnerCapabilities` type import in the domain file from `../../common/protocol`.)

- [ ] **Step 5: Fence** — `sync/fence.service.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FleetCommandType } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_JOB_REPOSITORY, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';

/** Spec §6.2: only the job's current (runnerId, leaseEpoch) may write; anyone else gets ABANDON. */
@Injectable()
export class FenceService {
  private readonly logger = new Logger(FenceService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: Pick<IFleetJobRepository, 'findPendingCommand' | 'createCommand'>,
    private readonly activity: FleetActivityService,
  ) {}

  holds(job: Pick<FleetJobRecord, 'runnerId' | 'leaseEpoch'>, runnerId: string, leaseEpoch: number): boolean {
    return job.runnerId === runnerId && job.leaseEpoch === leaseEpoch;
  }

  /** Inside txManager.run. Queues ABANDON unless one is already pending for (runner, job, epoch). */
  async abandon(runnerId: string, job: FleetJobRecord, leaseEpoch: number): Promise<boolean> {
    if (await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.ABANDON, runnerId, leaseEpoch })) return false;
    // Only reached when the caller does not hold the lease, so the reason is always a stale lease.
    // (`job_terminal` stays in the protocol union for a later "job ended under you" signal.)
    const reason = 'stale_lease';
    await this.repo.createCommand({ runnerId, jobId: job.id, type: FleetCommandType.ABANDON, leaseEpoch, payload: { reason } });
    await this.activity.record({
      actorType: 'SYSTEM', actorId: 'system', action: 'job.abandon_queued', entityType: 'job', entityId: job.id, jobId: job.id,
      projectId: job.projectId, responsibleUserId: job.requestedById, payload: { runnerId, leaseEpoch, reason },
    });
    this.logger.warn(`Fenced runner ${runnerId} on job ${job.id}: holds epoch ${leaseEpoch}, current ${job.leaseEpoch}`);
    return true;
  }
}
```

- [ ] **Step 6: Job reports** — `sync/job-report.processor.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { JobAck, JobReport } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { canTransition, isTerminal } from '../jobs/job-state';
import { JobTransitionsService } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, FleetJobEventRecord, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { interpretEvent } from './event-payloads';
import { FenceService } from './fence.service';
import { stableStringify } from './stable-json';

export interface ReportOutcome {
  ack: JobAck | null;
  unknown: boolean;
  live: LiveFleetJobEvent[];
  terminalJobId: string | null;
}

const NONE: ReportOutcome = Object.freeze({ ack: null, unknown: false, live: [], terminalJobId: null });

/**
 * One job's events from one sync, in one transaction (spec §3.2, plan D2/D5/D6): fence,
 * dedup on (epoch, runnerSeq), store, then apply only the contiguous prefix above the
 * cumulative ack. A resent seq with a different payload rejects the whole report.
 */
@Injectable()
export class JobReportProcessor {
  private readonly logger = new Logger(JobReportProcessor.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  process(runnerId: string, report: JobReport, now: Date): Promise<ReportOutcome> {
    return this.txManager.run(async () => {
      const job = await this.repo.lockById(report.jobId);
      if (!job) return { ...NONE, unknown: true };
      if (!this.fence.holds(job, runnerId, report.leaseEpoch)) {
        await this.fence.abandon(runnerId, job, report.leaseEpoch);
        return NONE;
      }
      const events = [...report.events].sort((a, b) => a.seq - b.seq);
      const stored = new Map((await this.repo.findRunnerEvents(job.id, job.leaseEpoch, events.map((e) => e.seq))).map((e) => [e.runnerSeq, e]));
      const conflict = events.find((e) => {
        const prior = stored.get(e.seq);
        return prior !== undefined && (prior.type !== e.type || stableStringify(prior.payload) !== stableStringify(e.payload));
      });
      if (conflict) {
        this.logger.warn(`Protocol error: job ${job.id} epoch ${job.leaseEpoch} seq ${conflict.seq} resent with a different payload`);
        return { ...NONE, ack: { jobId: job.id, ackedSeq: job.ackedRunnerSeq } };
      }
      for (const e of events) {
        if (!stored.has(e.seq)) await this.repo.appendEvent(job.id, { leaseEpoch: job.leaseEpoch, runnerSeq: e.seq, type: e.type, payload: e.payload });
      }
      return this.applyContiguous(job, runnerId, now);
    });
  }

  private async applyContiguous(job: FleetJobRecord, runnerId: string, now: Date): Promise<ReportOutcome> {
    let current = job;
    let next = job.ackedRunnerSeq + 1;
    let mirrored = false;
    let terminalJobId: string | null = null;
    const live: LiveFleetJobEvent[] = [];
    for (const event of await this.repo.findRunnerEventsAfter(job.id, job.leaseEpoch, job.ackedRunnerSeq)) {
      if (event.runnerSeq !== next) break;
      const applied = await this.applyOne(current, event, runnerId, now);
      current = applied.job;
      if (applied.live) live.push(applied.live);
      mirrored = mirrored || applied.mirrored;
      if (applied.terminal) terminalJobId = current.id;
      next += 1;
    }
    const ackedSeq = next - 1;
    if (ackedSeq !== job.ackedRunnerSeq) current = await this.repo.update(job.id, { ackedRunnerSeq: ackedSeq });
    if (mirrored && live.length === 0) live.push(this.live.event(current));
    return { ack: { jobId: job.id, ackedSeq }, unknown: false, live, terminalJobId };
  }

  private async applyOne(job: FleetJobRecord, event: FleetJobEventRecord, runnerId: string, now: Date): Promise<{ job: FleetJobRecord; live?: LiveFleetJobEvent; mirrored: boolean; terminal: boolean }> {
    const effect = interpretEvent(event.type, event.payload);
    if (effect.kind === 'none') return { job, mirrored: false, terminal: false };
    if (effect.kind === 'mirror') return { job: await this.repo.update(job.id, effect.patch), mirrored: true, terminal: false };
    if (effect.kind === 'transition' && canTransition(job.state, effect.to, 'runner')) {
      const r = await this.transitions.apply({
        job, to: effect.to, by: 'runner', now, actor: { type: 'RUNNER', id: runnerId }, reason: effect.reason,
        extra: effect.exitCode === null ? {} : { exitCode: effect.exitCode },
      });
      return { job: r.job, live: r.live, mirrored: false, terminal: isTerminal(effect.to) };
    }
    const reason = effect.kind === 'invalid' ? effect.reason : `transition ${job.state} -> ${effect.to}`;
    this.logger.warn(`Rejected runner event on job ${job.id} (runnerSeq ${event.runnerSeq}): ${reason}`);
    await this.activity.record({
      actorType: 'RUNNER', actorId: runnerId, action: 'job.event_rejected', entityType: 'job', entityId: job.id, jobId: job.id,
      projectId: job.projectId, responsibleUserId: job.requestedById, payload: { runnerSeq: event.runnerSeq, type: event.type, reason },
    });
    return { job, mirrored: false, terminal: false };
  }
}
```

- [ ] **Step 7: Acks and reboot** — `sync/command-ack.processor.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetCommandAckResult, FleetCommandType, FleetJobState } from '../../common/enums';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { CommandAck } from '../common/protocol';
import { canTransition } from '../jobs/job-state';
import { JobTransitionsService } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from './fence.service';

/** Command acks (spec §3.2, plan D8) and the boot-id reconcile (spec §5.3, C3). */
@Injectable()
export class CommandAckProcessor {
  private readonly logger = new Logger(CommandAckProcessor.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** One transaction per ack, and a failing ack is logged and skipped, so one bad ack never blocks the rest. */
  async process(runnerId: string, bootId: string, acks: readonly CommandAck[], now: Date): Promise<LiveFleetJobEvent[]> {
    const live: LiveFleetJobEvent[] = [];
    for (const ack of acks) {
      try {
        const event = await this.txManager.run(() => this.processOne(runnerId, bootId, ack, now));
        if (event) live.push(event);
      } catch (error) {
        // Left unacked: the runner re-acks it next sync (review M2).
        this.logger.error(`Ack ${ack.commandId} from runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    return live;
  }

  private async processOne(runnerId: string, bootId: string, ack: CommandAck, now: Date): Promise<LiveFleetJobEvent | null> {
    const command = await this.repo.findCommand(ack.commandId);
    if (!command || command.runnerId !== runnerId || command.leaseEpoch !== ack.leaseEpoch) {
      this.logger.warn(`Ignoring ack for unknown or foreign command ${ack.commandId} from runner ${runnerId}`);
      return null;
    }
    if (command.ackedAt) return null; // already applied, withdrawn or stale: idempotent
    if (command.type === FleetCommandType.ABANDON) {
      await this.repo.ackCommand(command.id, ack.result, now);
      return null;
    }
    const job = await this.repo.lockById(command.jobId);
    if (!job || !this.fence.holds(job, runnerId, command.leaseEpoch)) {
      await this.repo.ackCommand(command.id, FleetCommandAckResult.STALE, now);
      if (job) await this.fence.abandon(runnerId, job, command.leaseEpoch);
      return null;
    }
    await this.repo.ackCommand(command.id, ack.result, now);
    const actor = { type: 'RUNNER' as const, id: runnerId };
    const detail = (ack.detail ?? '').slice(0, 200);

    if (command.type === FleetCommandType.READOPT) {
      if (ack.result === 'ok') {
        await this.repo.update(job.id, { runnerBootId: bootId });
        return null;
      }
      return (await this.transitions.apply({ job, to: FleetJobState.CRASHED, by: 'server', now, actor, reason: `readopt rejected: ${detail}` })).live;
    }
    if (ack.result === 'ok') return null;
    if (command.type === FleetCommandType.ASSIGN && canTransition(job.state, FleetJobState.FAILED, 'runner')) {
      return (await this.transitions.apply({ job, to: FleetJobState.FAILED, by: 'runner', now, actor, reason: `assign rejected: ${detail}` })).live;
    }
    if (command.type === FleetCommandType.CANCEL && canTransition(job.state, FleetJobState.CANCELLED, 'runner')) {
      return (await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'runner', now, actor, reason: 'cancel: runner does not hold job' })).live;
    }
    return null;
  }

  /**
   * Runs on every sync. Held jobs whose runnerBootId differs from the reported boot (the daemon
   * restarted) get one READOPT each; an ASSIGN never acked is simply re-sent (it is still pending).
   * `rebooted` only decides whether a `runner.rebooted` activity row is written.
   */
  async reconcileBoot(runnerId: string, bootId: string, now: Date, rebooted: boolean): Promise<number> {
    return this.txManager.run(async () => {
      let queued = 0;
      for (const job of await this.repo.findRunnerHeld(runnerId)) {
        if (job.runnerBootId === bootId) continue;
        const pendingAssign = job.state === FleetJobState.ASSIGNED
          ? await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.ASSIGN, leaseEpoch: job.leaseEpoch })
          : null;
        if (pendingAssign) {
          await this.repo.update(job.id, { runnerBootId: bootId });
          continue;
        }
        if (await this.repo.findPendingCommand({ jobId: job.id, type: FleetCommandType.READOPT, leaseEpoch: job.leaseEpoch })) continue;
        await this.repo.createCommand({ runnerId, jobId: job.id, type: FleetCommandType.READOPT, leaseEpoch: job.leaseEpoch, payload: { naxRunId: job.naxRunId } });
        queued += 1;
      }
      if (rebooted || queued > 0) {
        await this.activity.record({
          actorType: 'RUNNER', actorId: runnerId, action: 'runner.rebooted', entityType: 'runner', entityId: runnerId,
          payload: { readopts: queued, at: now.toISOString() },
        });
      }
      return queued;
    });
  }
}
```

- [ ] **Step 8: Orchestration and route** — `sync/sync.service.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { parseCapabilities } from '../common/capabilities';
import { isSupportedProtocolVersion } from '../common/protocol';
import type { FleetCommandOut, JobAck, SyncResponse } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ProtocolVersionException } from '../runners/protocol-version.exception';
import { CommandAckProcessor } from './command-ack.processor';
import { JobReportProcessor } from './job-report.processor';
import { parseSyncRequest } from './sync-request.parser';

/**
 * POST /fleet/runner/sync (spec §3.2). Step 1 is several short transactions (plan D5):
 * acks, one per reported job, boot reconcile, placement fill. Step 2, only when there is
 * nothing to return: wait for a command, holding no transaction or connection.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly reports: JobReportProcessor,
    private readonly acks: CommandAckProcessor,
    private readonly placement: PlacementService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'syncWaitMs'>,
  ) {}

  async sync(runnerId: string, raw: unknown): Promise<SyncResponse> {
    const version = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).protocolVersion : undefined;
    if (!isSupportedProtocolVersion(version)) throw new ProtocolVersionException(version);
    const req = parseSyncRequest(raw);
    const capabilities = req.capabilities === undefined ? undefined : parseCapabilities(req.capabilities);
    const now = new Date();
    const seen = await this.repo.recordRunnerSync(runnerId, {
      now, bootId: req.bootId, daemonVersion: req.daemonVersion, protocolVersion: req.protocolVersion, capabilities,
    });
    if (!seen) throw new AuthException({}, 'fleet.runnerAuth');

    const live: LiveFleetJobEvent[] = [...(await this.acks.process(runnerId, req.bootId, req.commandAcks, now))];
    const jobAcks: JobAck[] = [];
    const unknownJobIds: string[] = [];
    const terminalJobIds: string[] = [];
    for (const report of req.jobs) {
      // One failing job must not block the rest of the sync (review M2): no ack for it, the runner resends it.
      try {
        const outcome = await this.reports.process(runnerId, report, now);
        if (outcome.ack) jobAcks.push(outcome.ack);
        if (outcome.unknown) unknownJobIds.push(report.jobId);
        if (outcome.terminalJobId) terminalJobIds.push(outcome.terminalJobId);
        live.push(...outcome.live);
      } catch (error) {
        this.logger.error(`Sync: job ${report.jobId} from runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    // Every sync, not only when the boot id changed (review M3): a crash between recording the new
    // boot id and queueing READOPT must not strand held jobs. Idempotent through runnerBootId and
    // the pending-READOPT check.
    try {
      await this.acks.reconcileBoot(runnerId, req.bootId, now, seen.previousBootId !== req.bootId);
    } catch (error) {
      this.logger.error(`Sync: boot reconcile for runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    this.live.publish(live);
    if (req.freeSlots > 0) await this.placement.fillRunner(runnerId, req.freeSlots, now);
    await this.afterTerminal(terminalJobIds);

    const tokens = await this.grantTokens(runnerId, req.tokenRequests, now);
    let commands = await this.deliver(runnerId, now);
    const idle = jobAcks.length === 0 && unknownJobIds.length === 0 && commands.length === 0 &&
      tokens.gitTokens.length === 0 && tokens.gitTokenErrors.length === 0 && tokens.unknownJobIds.length === 0;
    if (idle) {
      await this.notifier.wait(runnerId, this.fleetConfig.syncWaitMs, async () => (await this.repo.findPendingCommands(runnerId)).length > 0);
      commands = await this.deliver(runnerId, new Date());
    }
    return {
      jobAcks, commands, gitTokens: tokens.gitTokens, gitTokenErrors: tokens.gitTokenErrors,
      unknownJobIds: [...new Set([...unknownJobIds, ...tokens.unknownJobIds])],
    };
  }

  /** Task 15 mints tokens here. */
  protected async grantTokens(_runnerId: string, _requests: ReadonlyArray<{ jobId: string; leaseEpoch: number }>, _now: Date) {
    return { gitTokens: [], gitTokenErrors: [], unknownJobIds: [] as string[] };
  }

  /** Task 15 evicts cached tokens, Task 19 posts the attribution comment. */
  protected async afterTerminal(_jobIds: readonly string[]): Promise<void> {
    return undefined;
  }

  private async deliver(runnerId: string, now: Date): Promise<FleetCommandOut[]> {
    const pending = await this.repo.findPendingCommands(runnerId);
    await this.repo.markDelivered(pending.filter((c) => c.deliveredAt === null).map((c) => c.id), now);
    return pending.map((c) => ({ commandId: c.id, type: c.type, jobId: c.jobId, leaseEpoch: c.leaseEpoch, payload: c.payload as FleetCommandOut['payload'] }));
  }
}
```

`sync/runner-sync.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { SyncService } from './sync.service';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner')
export class RunnerSyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('sync')
  @HttpCode(200)
  @SkipThrottle() // plan D20: runner-key authenticated; a 429 would delay acks and cancels
  @ApiOperation({ summary: 'Runner sync: events, command acks, token requests; long-polls when idle' })
  @ApiBody({ schema: { type: 'object', description: 'SyncRequest (packages/fleet-protocol)' } })
  @ApiResponse({ status: 200, description: 'SyncResponse (packages/fleet-protocol)' })
  @ApiResponse({ status: 400, description: 'Malformed sync request or capabilities' })
  @ApiResponse({ status: 426, description: 'Unsupported protocol version' })
  async sync(@Principal() runner: RunnerPrincipal, @Body() body: unknown) {
    return JsonResponse.Ok(await this.syncService.sync(runner.id, body));
  }
}
```

`sync/sync.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { CommandAckProcessor } from './command-ack.processor';
import { FenceService } from './fence.service';
import { JobReportProcessor } from './job-report.processor';
import { RunnerSyncController } from './runner-sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule, FleetActivityModule, FleetJobsModule],
  controllers: [RunnerSyncController],
  providers: [FenceService, JobReportProcessor, CommandAckProcessor, SyncService],
  exports: [FenceService],
})
export class SyncModule {}
```

Add `SyncModule` to `FleetModule.imports`. Confirm `FleetJobsModule` exports `PlacementService` and `RunnerNotifier` (Task 10).

- [ ] **Step 9: Run to verify pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/runner-sync-lifecycle.integration.spec.ts && bun run test:scoped src/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/fleet apps/api/test/helpers/fleet-fixtures.ts apps/api/test/integration/fleet/runner-sync*.integration.spec.ts
git commit -m "feat(fleet): runner sync with fenced events, command acks, reboot readopt and long-poll"
```

---

### Task 15: Per-job git tokens (broker fence)

**Files:**
- Modify: `apps/api/src/fleet/git-broker/github-app-client.ts` (`mintInstallationToken`), `github-app-client.spec.ts`
- Create: `apps/api/src/fleet/git-broker/gitlab-token.source.ts`, `apps/api/src/fleet/git-broker/git-token.broker.ts`, `git-token.broker.spec.ts`
- Modify: `apps/api/src/fleet/git-broker/git-broker.module.ts` (imports `VcsModule`), `apps/api/src/fleet/repos/fleet-repos.service.ts` (uses `GitLabTokenSource`), `fleet-repos.service.spec.ts`
- Modify: `apps/api/src/fleet/sync/sync.service.ts` (`grantTokens`, `afterTerminal`), `sync.module.ts`
- Modify: `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts:55` (the slice 1 mint stub gains `expires_at`)
- Test: `apps/api/test/integration/fleet/runner-git-tokens.integration.spec.ts` (new)

**Interfaces:**
- Produces:
  - `GitHubAppClient.mintInstallationToken(installationId: bigint, repoName: string): Promise<{ token: string; expiresAt: Date }>` — throws `RepoCheckException` (`app_not_installed` on 404, `app_permissions_insufficient` on 403/422, `provider_error` otherwise). `verifyRepo` uses it.
  - `GitLabTokenSource.resolve(projectId: string, owner: string, name: string): Promise<string>` — the slice 1 `verifyGitLab` checks (connection exists, matches, key configured, decrypts), throwing the same reasons.
  - `GitTokenBroker { mint(req: { jobId: string; leaseEpoch: number; repo: FleetRepoRef }, now?: Date): Promise<{ ok: true; token: GitToken } | { ok: false; error: GitTokenError }>; evict(jobId: string): void }` — cache per `(jobId, leaseEpoch)` until 5 min before expiry (spec §7.1).

- [ ] **Step 1: Write the failing unit test** — `git-token.broker.spec.ts`

```ts
import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException } from './repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const github: FleetRepoRef = { id: 'r', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(77) };
const gitlab: FleetRepoRef = { ...github, provider: 'gitlab', githubInstallationId: null };
const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('GitTokenBroker', () => {
  const app = { mintInstallationToken: jest.fn() };
  const lab = { resolve: jest.fn() };
  let broker: GitTokenBroker;
  beforeEach(() => {
    jest.resetAllMocks();
    broker = new GitTokenBroker(app as never, lab as never);
  });

  it('mints a GitHub installation token and reuses it until 5 minutes before expiry', async () => {
    app.mintInstallationToken.mockResolvedValue({ token: 'ghs_1', expiresAt: new Date(NOW.getTime() + 60 * 60_000) });
    const a = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    const b = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, new Date(NOW.getTime() + 54 * 60_000));
    expect(a).toEqual({ ok: true, token: { jobId: 'j', token: 'ghs_1', username: 'x-access-token', expiresAt: '2026-10-01T01:00:00.000Z' } });
    expect(b).toEqual(a);
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(1);
    await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, new Date(NOW.getTime() + 56 * 60_000));
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(2);
    expect(app.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
  });

  it('never serves one epoch a token cached for another, and evicts a job', async () => {
    app.mintInstallationToken.mockResolvedValue({ token: 'ghs_1', expiresAt: new Date(NOW.getTime() + 60 * 60_000) });
    await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    await broker.mint({ jobId: 'j', leaseEpoch: 2, repo: github }, NOW);
    broker.evict('j');
    await broker.mint({ jobId: 'j', leaseEpoch: 2, repo: github }, NOW);
    expect(app.mintInstallationToken).toHaveBeenCalledTimes(3);
  });

  it('serves the stored GitLab token as oauth2 with a nominal one-hour expiry', async () => {
    lab.resolve.mockResolvedValue('glpat-1');
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: gitlab }, NOW)).resolves.toEqual({
      ok: true, token: { jobId: 'j', token: 'glpat-1', username: 'oauth2', expiresAt: '2026-10-01T01:00:00.000Z' },
    });
    expect(lab.resolve).toHaveBeenCalledWith('p', 'acme', 'app');
  });

  it('turns failures into fixed reasons and never echoes a token', async () => {
    app.mintInstallationToken.mockRejectedValue(new RepoCheckException('app_not_installed'));
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW)).resolves.toEqual({ ok: false, error: { jobId: 'j', reason: 'app_not_installed' } });
    app.mintInstallationToken.mockRejectedValue(new Error('boom ghs_secret'));
    const res = await broker.mint({ jobId: 'j', leaseEpoch: 1, repo: github }, NOW);
    expect(res).toEqual({ ok: false, error: { jobId: 'j', reason: 'provider_error' } });
    await expect(broker.mint({ jobId: 'j', leaseEpoch: 1, repo: { ...github, githubInstallationId: null } }, NOW))
      .resolves.toEqual({ ok: false, error: { jobId: 'j', reason: 'app_not_installed' } });
  });
});
```

Append to `github-app-client.spec.ts` (reuse its fake forge and key setup):

```ts
  it('mints a repo-scoped installation token with its expiry', async () => {
    forge.routes.set('POST /app/installations/77/access_tokens', (req) => {
      expect(req.body).toEqual({ repositories: ['app'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
      return { status: 201, body: { token: 'ghs_x', expires_at: '2026-10-01T01:00:00Z' } };
    });
    await expect(client.mintInstallationToken(BigInt(77), 'app')).resolves.toEqual({ token: 'ghs_x', expiresAt: new Date('2026-10-01T01:00:00Z') });
    forge.routes.set('POST /app/installations/78/access_tokens', () => ({ status: 404, body: {} }));
    await expect(client.mintInstallationToken(BigInt(78), 'app')).rejects.toMatchObject({ reason: 'app_not_installed' });
  });
```

- [ ] **Step 2: Write the failing integration test** — `runner-git-tokens.integration.spec.ts`

Same header as `runner-sync.integration.spec.ts`, plus a fake forge and a GitHub App key exactly as `fleet-repos.integration.spec.ts:21-45` sets them (env `GITHUB_API_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_SLUG`, saved and restored), with route `POST /app/installations/77/access_tokens` returning `{ status: 201, body: { token: 'ghs_brokered', expires_at: <now + 1h ISO> } }`. `FLEET_SYNC_WAIT_MS=0`. Then:

```ts
  it('mints for the current lease only; a stale epoch gets nothing and one ABANDON', async () => {
    const j = await dispatch('tok');
    const res = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch }] });
    expect(res.gitTokens).toEqual([expect.objectContaining({ jobId: j.id, token: 'ghs_brokered', username: 'x-access-token' })]);

    const stale = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch + 5 }] });
    expect(stale.gitTokens).toEqual([]);
    await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch + 5 }] });
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);

    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'COMPLETED' } });
    const done = await sync({ tokenRequests: [{ jobId: j.id, leaseEpoch: j.leaseEpoch }] });
    expect(done.gitTokens).toEqual([]);
    expect(done.gitTokenErrors).toEqual([{ jobId: j.id, reason: 'job_not_active' }]);
    expect((await sync({ tokenRequests: [{ jobId: 'ghost', leaseEpoch: 1 }] })).unknownJobIds).toEqual(['ghost']);
  });

  it('never stores the token (spec §7.1)', async () => {
    const tables = await Promise.all([
      prisma.fleetCommand.findMany(), prisma.fleetActivity.findMany(), prisma.fleetJobEvent.findMany(), prisma.fleetJob.findMany(),
    ]);
    expect(JSON.stringify(tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('ghs_brokered');
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/git-broker test/integration/fleet/runner-git-tokens.integration.spec.ts`
Expected: FAIL.

- [ ] **Step 4: GitHub minting** — in `github-app-client.ts` add, and make `verifyRepo` call it (replacing its inline `POST …/access_tokens` block with `const { token } = await this.mintInstallationToken(BigInt(installationId), name);`):

```ts
  /** Repo-scoped installation token (spec §7.1): contents + pull_requests write, metadata read. */
  async mintInstallationToken(installationId: bigint, repoName: string): Promise<{ token: string; expiresAt: Date }> {
    const minted = await this.http.request('POST', `${this.api}/app/installations/${installationId.toString()}/access_tokens`, this.headers(this.createAppJwt()), {
      repositories: [repoName],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    if (minted.status === 404) throw new RepoCheckException('app_not_installed');
    if (minted.status === 422 || minted.status === 403) throw new RepoCheckException('app_permissions_insufficient');
    if (minted.status !== 201) throw new RepoCheckException('provider_error');
    const { token, expires_at: expiresAt } = obj(minted.body);
    if (typeof token !== 'string' || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw new RepoCheckException('provider_error');
    return { token, expiresAt: new Date(expiresAt) };
  }
```

(`verifyRepo` keeps its own 404 → `app_not_installed` on the installation lookup; the shared mint maps the token call.) The mint now requires `expires_at`, so update the slice 1 stub at `test/integration/fleet/fleet-repos.integration.spec.ts:55` to `{ status: 201, body: { token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' } }`; the unit fixture at `github-app-client.spec.ts:43` already carries one.

- [ ] **Step 5: GitLab token source** — `gitlab-token.source.ts` (moved verbatim from `FleetReposService.verifyGitLab`, minus the forge call)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { decryptToken } from '../../common/utils/encryption.util';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import type { IVcsRepository } from '../../vcs/domain/vcs.repository';
import { RepoCheckException } from './repo-check.exception';

/** The project's stored GitLab token, only for its connected repo (spec §7.1: one GitLab fleet repo per project). */
@Injectable()
export class GitLabTokenSource {
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'findVcsConnectionByProjectId'>,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'encryptionKey'>,
  ) {}

  async resolve(projectId: string, owner: string, name: string): Promise<string> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
    if (!connection) throw new RepoCheckException('vcs_connection_missing');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (connection.provider !== 'gitlab' || !same(connection.repoOwner, owner) || !same(connection.repoName, name)) {
      throw new RepoCheckException('vcs_connection_mismatch');
    }
    if (!this.vcsConfig.encryptionKey) throw new RepoCheckException('vcs_encryption_key_missing');
    try {
      return decryptToken(connection.encryptedToken, this.vcsConfig.encryptionKey);
    } catch {
      throw new RepoCheckException('gitlab_token_invalid');
    }
  }
}
```

In `FleetReposService`: replace the `verifyGitLab` body with `return this.gitlab.verifyRepo(owner, name, await this.gitlabTokens.resolve(projectId, owner, name));`, inject `GitLabTokenSource`, drop the now-unused `VCS_REPOSITORY`/`VCS_CFG` injections, and update `fleet-repos.service.spec.ts` to provide a `GitLabTokenSource` mock (the reason-code cases move to a small `gitlab-token.source.spec.ts` with the same table the service spec had). `GitBrokerModule`: `imports: [VcsModule]`, providers and exports gain `GitLabTokenSource` and `GitTokenBroker`.

- [ ] **Step 6: Broker** — `git-token.broker.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { GitToken, GitTokenError } from '../common/protocol';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { GitHubAppClient } from './github-app-client';
import { GitLabTokenSource } from './gitlab-token.source';
import { RepoCheckException } from './repo-check.exception';

export type MintResult = { ok: true; token: GitToken } | { ok: false; error: GitTokenError };

const REUSE_MARGIN_MS = 5 * 60_000;
const GITLAB_NOMINAL_TTL_MS = 60 * 60_000;

/**
 * Per-job git credentials (spec §7.1, §6.3). Callers fence first: only the job's current
 * (runnerId, leaseEpoch) in ASSIGNED | RUNNING | UPLOADING reaches mint(). Tokens live only
 * in this in-memory cache and the sync response; never logged, never stored.
 */
@Injectable()
export class GitTokenBroker {
  private readonly logger = new Logger(GitTokenBroker.name);
  private cache: ReadonlyMap<string, GitToken> = new Map();

  constructor(private readonly github: GitHubAppClient, private readonly gitlab: GitLabTokenSource) {}

  async mint(req: { jobId: string; leaseEpoch: number; repo: FleetRepoRef }, now = new Date()): Promise<MintResult> {
    const key = `${req.jobId}:${req.leaseEpoch}`;
    const cached = this.cache.get(key);
    if (cached && Date.parse(cached.expiresAt) - now.getTime() > REUSE_MARGIN_MS) return { ok: true, token: cached };
    try {
      const token = await this.fresh(req, now);
      this.cache = new Map([...[...this.cache].filter(([, t]) => Date.parse(t.expiresAt) > now.getTime()), [key, token]]);
      return { ok: true, token };
    } catch (error) {
      if (error instanceof RepoCheckException) return { ok: false, error: { jobId: req.jobId, reason: error.reason } };
      // Never log the error message: a provider body could echo a credential.
      this.logger.error(`Git token mint failed for job ${req.jobId} (${error instanceof Error ? error.name : 'unknown'})`);
      return { ok: false, error: { jobId: req.jobId, reason: 'provider_error' } };
    }
  }

  evict(jobId: string): void {
    this.cache = new Map([...this.cache].filter(([key]) => !key.startsWith(`${jobId}:`)));
  }

  private async fresh(req: { jobId: string; repo: FleetRepoRef }, now: Date): Promise<GitToken> {
    const { repo } = req;
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      const { token, expiresAt } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString() };
    }
    const token = await this.gitlab.resolve(repo.projectId, repo.owner, repo.name);
    return { jobId: req.jobId, token, username: 'oauth2', expiresAt: new Date(now.getTime() + GITLAB_NOMINAL_TTL_MS).toISOString() };
  }
}
```

- [ ] **Step 7: Wire into sync** — in `SyncService` inject `GitTokenBroker`, `FenceService` and `TRANSACTION_MANAGER`, and replace the two Task 14 stubs:

```ts
  /** Spec §6.3: fence each request (ABANDON on a stale epoch), then mint outside any transaction. */
  protected async grantTokens(runnerId: string, requests: ReadonlyArray<{ jobId: string; leaseEpoch: number }>, now: Date) {
    const gitTokens: GitToken[] = [];
    const gitTokenErrors: GitTokenError[] = [];
    const unknownJobIds: string[] = [];
    const toMint = await this.txManager.run(async () => {
      const granted: Array<{ jobId: string; leaseEpoch: number; repo: FleetRepoRef }> = [];
      for (const req of requests) {
        // Row lock: two overlapping syncs from one runner must not both queue an ABANDON.
        const job = await this.repo.lockById(req.jobId);
        if (!job) {
          unknownJobIds.push(req.jobId);
        } else if (!this.fence.holds(job, runnerId, req.leaseEpoch)) {
          await this.fence.abandon(runnerId, job, req.leaseEpoch);
        } else if (!(RUNNER_HELD_STATES as readonly string[]).includes(job.state)) {
          gitTokenErrors.push({ jobId: job.id, reason: 'job_not_active' });
        } else {
          const repo = await this.repo.findRepo(job.repoId);
          if (repo) granted.push({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo });
        }
      }
      return granted;
    });
    for (const req of toMint) {
      const result = await this.broker.mint(req, now);
      if (result.ok) gitTokens.push(result.token);
      else gitTokenErrors.push(result.error);
    }
    return { gitTokens, gitTokenErrors, unknownJobIds };
  }

  protected async afterTerminal(jobIds: readonly string[]): Promise<void> {
    for (const id of jobIds) this.broker.evict(id);
  }
```

Imports: `GitToken`, `GitTokenError` (type, from `../common/protocol`), `FleetRepoRef`, `RUNNER_HELD_STATES`, `GitTokenBroker`, `FenceService`, `ITransactionManager`/`TRANSACTION_MANAGER`. `SyncModule` imports `GitBrokerModule`.

- [ ] **Step 8: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet test/integration/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, including the slice 1 `fleet-repos.integration.spec.ts` with its updated stub.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/runner-git-tokens.integration.spec.ts
git commit -m "feat(fleet): fenced per-job git tokens from the GitHub App or the stored GitLab token"
```

---

### Task 16: Silence sweep

**Files:**
- Create: `apps/api/src/fleet/sync/fleet-sweeper.ts`, `fleet-sweeper.spec.ts`
- Modify: `apps/api/src/fleet/sync/sync.module.ts`
- Test: `apps/api/test/integration/fleet/fleet-sweep.integration.spec.ts` (new)

**Interfaces:**
- Produces: `FleetSweeper { sweep(now?: Date): Promise<number>; onModuleInit(); onModuleDestroy() }` — every 30s when `sweepEnabled`; held jobs (`ASSIGNED | RUNNING | UPLOADING`) of a runner silent for `jobCrashSec` become CRASHED (server, epoch bumped by plan D4).

- [ ] **Step 1: Write the failing tests**

`fleet-sweeper.spec.ts`:

```ts
import { FleetSweeper } from './fleet-sweeper';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

describe('FleetSweeper scheduling', () => {
  afterEach(() => jest.useRealTimers());

  it('starts a 30s interval only when enabled, and stops it on shutdown', () => {
    jest.useFakeTimers();
    const off = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: false }));
    off.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    const on = new FleetSweeper({} as never, {} as never, {} as never, {} as never, testFleetConfig({ sweepEnabled: true }));
    on.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    on.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
```

`test/integration/fleet/fleet-sweep.integration.spec.ts`:

```ts
/**
 * Fleet S1 slice 2 — silence sweep (spec §5.3, plan D11) on PG with an explicit clock.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-sweep.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { FleetSweeper } from '../../../src/fleet/sync/fleet-sweeper';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet silence sweep (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
  });
  afterAll(async () => {
    await app.close();
  });

  it('crashes held jobs of a silent runner only, bumping the epoch and withdrawing commands', async () => {
    const base = await seedFleetBase(prisma);
    const now = new Date('2026-10-01T12:00:00.000Z');
    const silent = await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 301_000), capacity: 3 });
    const alive = await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 10_000) });
    const job = (feature: string, state: string, runnerId: string | null) => prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId, state, runnerId, leaseEpoch: 1,
      },
    });
    const running = await job('a', 'RUNNING', silent.id);
    const uploading = await job('b', 'UPLOADING', silent.id);
    const queued = await job('c', 'QUEUED', null);
    const healthy = await job('d', 'RUNNING', alive.id);
    await prisma.fleetCommand.create({ data: { runnerId: silent.id, jobId: running.id, type: 'CANCEL', leaseEpoch: 1, payload: {} } });

    expect(await app.get(FleetSweeper).sweep(now)).toBe(2);
    const after = await prisma.fleetJob.findMany({ where: { id: { in: [running.id, uploading.id, queued.id, healthy.id] } }, orderBy: { feature: 'asc' } });
    expect(after.map((j) => [j.feature, j.state, j.leaseEpoch])).toEqual([['a', 'CRASHED', 2], ['b', 'CRASHED', 2], ['c', 'QUEUED', 1], ['d', 'RUNNING', 1]]);
    expect(after[0].stateReason).toBe('runner silent');
    expect((await prisma.fleetCommand.findFirstOrThrow({ where: { jobId: running.id } })).ackResult).toBe('withdrawn');
    expect(await app.get(FleetSweeper).sweep(now)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/sync/fleet-sweeper.spec.ts test/integration/fleet/fleet-sweep.integration.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `fleet-sweeper.ts`

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetJobState } from '../../common/enums';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { RUNNER_HELD_STATES } from '../jobs/job-state';
import { JobTransitionsService, SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Spec §5.3 "machine silent" (plus UPLOADING, plan D11). In process (single API instance).
 * Each job is re-checked under its row lock, so a runner that synced after the scan is spared.
 */
@Injectable()
export class FleetSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled' | 'jobCrashSec'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => this.logger.error(`Fleet sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.fleetConfig.jobCrashSec * 1000);
    let crashed = 0;
    for (const id of await this.repo.findSilentHeldIds(cutoff)) {
      const event = await this.txManager.run(async () => {
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || !(RUNNER_HELD_STATES as readonly string[]).includes(job.state) || !job.runnerId) return null;
        const [runner] = await this.repo.findPlacementRunners([job.runnerId]);
        if (runner && runner.lastSeenAt.getTime() >= cutoff.getTime()) return null;
        return (await this.transitions.apply({ job, to: FleetJobState.CRASHED, by: 'server', now, actor: SYSTEM_ACTOR, reason: 'runner silent' })).live;
      });
      if (event) {
        this.live.publish([event]);
        crashed += 1;
      }
    }
    if (crashed > 0) this.logger.warn(`Crashed ${crashed} job(s) of silent runners`);
    return crashed;
  }
}
```

Add `FleetSweeper` to `SyncModule.providers` and `exports`.

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2, then `bunx tsc --noEmit -p tsconfig.json`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/sync apps/api/test/integration/fleet/fleet-sweep.integration.spec.ts
git commit -m "feat(fleet): in-process silence sweep crashes jobs of silent runners"
```

---

### Task 17: Bundles — artifact store, upload, download

**Files:**
- Create: `apps/api/src/fleet/artifacts/artifact-store.ts`, `local-disk-artifact.store.ts`, `local-disk-artifact.store.spec.ts`
- Create: `apps/api/src/fleet/artifacts/bundle.exceptions.ts`, `bundle.service.ts`, `bundle-upload.controller.ts`, `job-bundle.controller.ts`, `artifacts.module.ts`
- Create: `apps/api/src/common/hooks/bundle-content-parser.ts`, `bundle-content-parser.spec.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/fleet/fleet.module.ts`, `apps/api/src/i18n/{en,zh}/fleet.json`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, `prisma-fleet-job.repository.ts` (`findArtifact`)
- Test: `apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts` (new)

**Interfaces:**
- Produces:
  - `ARTIFACT_STORE` symbol; `ArtifactStore { put(key, source: Readable, opts: { maxBytes: number; expectedSha256: string }): Promise<{ sizeBytes: number; sha256: string }>; get(key): Promise<Readable>; stat(key): Promise<{ sizeBytes: number } | null>; delete(key): Promise<void> }`; `ArtifactTooLargeError`, `ArtifactHashMismatchError`.
  - `LocalDiskArtifactStore` (root `FLEET_ARTIFACT_DIR`; temp file + rename, so a failed upload never replaces a good bundle).
  - `BundleService { upload(input): Promise<{ jobId; leaseEpoch; sizeBytes: string; sha256 }>; download(projectId, jobId): Promise<{ stream: Readable; leaseEpoch: number; sizeBytes: bigint }> }`
  - Routes: `PUT /fleet/runner/jobs/:jobId/bundle?leaseEpoch=` (runner), `GET /projects/:slug/fleet/jobs/:id/bundle` (project member).
  - `registerBundleContentParser(fastify)`.

- [ ] **Step 1: Write the failing unit tests**

`local-disk-artifact.store.spec.ts`:

```ts
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { ArtifactHashMismatchError, ArtifactTooLargeError } from './artifact-store';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('LocalDiskArtifactStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-artifacts-'));
  const store = new LocalDiskArtifactStore({ artifactDir: root });
  const good = Buffer.from('bundle-v1');

  it('stores, stats, reads and deletes', async () => {
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([good]), { maxBytes: 100, expectedSha256: sha(good) })).resolves.toEqual({ sizeBytes: good.length, sha256: sha(good) });
    expect(readFileSync(join(root, 'jobs/j1/1.tar.gz'))).toEqual(good);
    await expect(store.stat('jobs/j1/1.tar.gz')).resolves.toEqual({ sizeBytes: good.length });
    const chunks: Buffer[] = [];
    for await (const c of await store.get('jobs/j1/1.tar.gz')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(good);
  });

  it('keeps the previous file when a replacement is too large or has the wrong hash', async () => {
    const big = Buffer.alloc(200);
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([big]), { maxBytes: 100, expectedSha256: sha(big) })).rejects.toBeInstanceOf(ArtifactTooLargeError);
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([Buffer.from('x')]), { maxBytes: 100, expectedSha256: sha(good) })).rejects.toBeInstanceOf(ArtifactHashMismatchError);
    expect(readFileSync(join(root, 'jobs/j1/1.tar.gz'))).toEqual(good);
    await store.delete('jobs/j1/1.tar.gz');
    await expect(store.stat('jobs/j1/1.tar.gz')).resolves.toBeNull();
  });

  it.each(['../escape', '/abs/key', 'jobs/../x', 'jobs//x', 'jobs/x y'])('refuses key %s', async (key) => {
    await expect(store.stat(key)).rejects.toThrow(/artifact key/);
  });
});
```

`src/common/hooks/bundle-content-parser.spec.ts`:

```ts
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Readable } from 'stream';
import { registerBundleContentParser } from './bundle-content-parser';
import { registerRawBodyHook } from './raw-body.hook';

describe('registerBundleContentParser (production adapter, plan D12)', () => {
  it('hands a 2 MiB gzip body to the handler as a stream, past the 1 MiB JSON cap', async () => {
    const fastify = new FastifyAdapter().getInstance();
    registerRawBodyHook(fastify as never);
    registerBundleContentParser(fastify as never);
    fastify.put('/up', async (req) => {
      let bytes = 0;
      for await (const chunk of req.body as AsyncIterable<Buffer>) bytes += chunk.length;
      return { bytes, stream: req.body instanceof Readable };
    });
    const res = await fastify.inject({ method: 'PUT', url: '/up', headers: { 'content-type': 'application/gzip' }, payload: Buffer.alloc(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bytes: 2 * 1024 * 1024, stream: true });
    await fastify.close();
  });
});
```

- [ ] **Step 2: Write the failing integration test** — `fleet-bundles.integration.spec.ts`

```ts
/**
 * Fleet S1 slice 2 — bundle upload (runner, fenced) and download (member), spec §3.3, §8.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_BUNDLE_MAX_BYTES'] as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet bundles (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};

  const job = (feature: string, state: string, leaseEpoch = 1) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch,
    },
  });
  const upload = (jobId: string, body: Buffer, over: { epoch?: number; sha?: string; type?: string } = {}) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/bundle?leaseEpoch=${over.epoch ?? 1}`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': over.type ?? 'application/gzip', 'x-content-sha256': over.sha ?? sha(body) })
      .send(body);
  const download = (jobId: string, who: keyof FleetHttpWorld['tokens']) =>
    request(server).get(`/api/projects/web/fleet/jobs/${jobId}/bundle`).set({ Authorization: `Bearer ${world.tokens[who]}` })
      .buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-bundles-'));
    process.env.FLEET_BUNDLE_MAX_BYTES = '4096';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('accepts a bundle while RUNNING, replaces it on re-upload, and serves it to members', async () => {
    const j = await job('up', 'RUNNING');
    await upload(j.id, Buffer.from('first')).expect(201);
    const second = Buffer.from('second-bundle');
    await upload(j.id, second).expect(201);
    expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(1);
    const dir = join(process.env.FLEET_ARTIFACT_DIR as string, 'jobs', j.id, '1');
    expect(readdirSync(dir)).toHaveLength(1); // the replaced attempt was deleted after commit
    const res = await download(j.id, 'viewer').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/gzip/);
    expect(res.body).toEqual(second);
    await download(j.id, 'outsider').expect(403);
  });

  it('keeps the good bundle when a replacement has the wrong hash (422) or is too large (413)', async () => {
    const j = await job('bad', 'UPLOADING');
    const good = Buffer.from('good');
    await upload(j.id, good).expect(201);
    await upload(j.id, Buffer.from('evil'), { sha: sha(good) }).expect(422);
    await upload(j.id, Buffer.alloc(5_000)).expect(413);
    expect((await download(j.id, 'dev').expect(200)).body).toEqual(good);
  });

  it('fences: stale epoch 409 + ABANDON, wrong state 409, wrong type 415, bad hash header 400', async () => {
    const j = await job('fence', 'RUNNING', 2);
    await upload(j.id, Buffer.from('x'), { epoch: 1 }).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: j.id, type: 'ABANDON' } })).toBe(1);
    await upload((await job('queued', 'ASSIGNED')).id, Buffer.from('x')).expect(409);
    await upload(j.id, Buffer.from('x'), { epoch: 2, type: 'application/octet-stream' }).expect(415);
    await upload(j.id, Buffer.from('x'), { epoch: 2, sha: 'nope' }).expect(400);
    await download(j.id, 'dev').expect(404);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/artifacts src/common/hooks/bundle-content-parser.spec.ts test/integration/fleet/fleet-bundles.integration.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Store** — `artifact-store.ts`

```ts
import type { Readable } from 'stream';

export const ARTIFACT_STORE = Symbol('ARTIFACT_STORE');

export class ArtifactTooLargeError extends Error {
  constructor() {
    super('artifact exceeds the size limit');
  }
}

export class ArtifactHashMismatchError extends Error {
  constructor() {
    super('artifact sha256 does not match');
  }
}

/** Spec §8 C6 seam: local disk in S1, object storage later. Keys are server-generated. */
export interface ArtifactStore {
  /** Atomic replace; on ArtifactTooLargeError or ArtifactHashMismatchError nothing is kept and the old object survives. */
  put(key: string, source: Readable, opts: { maxBytes: number; expectedSha256: string }): Promise<{ sizeBytes: number; sha256: string }>;
  get(key: string): Promise<Readable>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}
```

`local-disk-artifact.store.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ArtifactHashMismatchError, ArtifactStore, ArtifactTooLargeError } from './artifact-store';

const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

@Injectable()
export class LocalDiskArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(@Inject(FLEET_CFG) config: Pick<IFleetConfig, 'artifactDir'>) {
    this.root = resolve(config.artifactDir);
  }

  private pathFor(key: string): string {
    if (key.length > 256 || !KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`invalid artifact key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid artifact key: ${key}`);
    return full;
  }

  async put(key: string, source: Readable, opts: { maxBytes: number; expectedSha256: string }): Promise<{ sizeBytes: number; sha256: string }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > opts.maxBytes) return done(new ArtifactTooLargeError());
        hash.update(chunk);
        return done(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(tmp, { mode: 0o600 }));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== opts.expectedSha256.toLowerCase()) {
      await rm(tmp, { force: true });
      throw new ArtifactHashMismatchError();
    }
    await rename(tmp, target);
    return { sizeBytes: size, sha256 };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path);
    return createReadStream(path);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      return { sizeBytes: (await stat(this.pathFor(key))).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
```

- [ ] **Step 5: Exceptions, service, controllers**

Repository first — add to `IFleetJobRepository` and implement:

```ts
  findArtifact(jobId: string, kind: string, leaseEpoch: number): Promise<FleetArtifactRecord | null>;
```

```ts
  findArtifact(jobId: string, kind: string, leaseEpoch: number): Promise<FleetArtifactRecord | null> {
    return this.db.fleetJobArtifact.findUnique({ where: { jobId_kind_leaseEpoch: { jobId, kind, leaseEpoch } } });
  }
```

`bundle.exceptions.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';

/** 413 too large, 415 not gzip, 422 hash mismatch (spec §3.3). */
export class FleetBundleException extends AppException {
  constructor(status: 413 | 415 | 422, args: Record<string, unknown> = {}) {
    super(status, args, 'fleet.bundle', status);
  }
}

/** 409: the caller does not hold the job's current lease (spec §6.2). */
export class FleetFenceException extends AppException {
  constructor() {
    super(409, {}, 'fleet.fence', 409);
  }
}
```

`bundle.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { Readable } from 'stream';
import { FleetJobState } from '../../common/enums';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from '../sync/fence.service';
import { ARTIFACT_STORE, ArtifactHashMismatchError, ArtifactStore, ArtifactTooLargeError } from './artifact-store';
import { FleetBundleException, FleetFenceException } from './bundle.exceptions';

const UPLOAD_STATES: readonly string[] = [FleetJobState.RUNNING, FleetJobState.UPLOADING];
const SHA256_RE = /^[0-9a-f]{64}$/i;

export interface BundleUpload {
  runnerId: string;
  jobId: string;
  leaseEpochRaw: string | undefined;
  sha256Header: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

@Injectable()
export class BundleService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'bundleMaxBytes'>,
  ) {}

  /** Spec §3.3: fenced, RUNNING (partial bundle on cancel) or UPLOADING only, streamed, hash-checked. */
  async upload(u: BundleUpload): Promise<{ jobId: string; leaseEpoch: number; sizeBytes: string; sha256: string }> {
    if (!/^application\/gzip\b/i.test(u.contentType ?? '')) throw new FleetBundleException(415);
    const leaseEpoch = Number(u.leaseEpochRaw);
    if (!Number.isInteger(leaseEpoch) || leaseEpoch < 0) throw new ValidationAppException({ reason: 'leaseEpoch' }, 'fleet.bundleInput');
    if (!SHA256_RE.test(u.sha256Header ?? '')) throw new ValidationAppException({ reason: 'X-Content-SHA256' }, 'fleet.bundleInput');
    const maxBytes = this.fleetConfig.bundleMaxBytes;
    if (u.contentLength !== undefined && Number(u.contentLength) > maxBytes) throw new FleetBundleException(413, { maxBytes });

    await this.assertHolder(u.runnerId, u.jobId, leaseEpoch);
    // Per-attempt key (plan D3): the previous bundle stays intact until the row points at this one.
    const key = `jobs/${u.jobId}/${leaseEpoch}/${randomUUID()}.tar.gz`;
    let stored: { sizeBytes: number; sha256: string };
    try {
      stored = await this.store.put(key, u.body, { maxBytes, expectedSha256: u.sha256Header as string });
    } catch (error) {
      if (error instanceof ArtifactTooLargeError) throw new FleetBundleException(413, { maxBytes });
      if (error instanceof ArtifactHashMismatchError) throw new FleetBundleException(422, { reason: 'sha256 mismatch' });
      throw error;
    }
    // The lease may have moved while the body streamed: re-check before recording.
    const recorded = await this.txManager.run(async () => {
      const job = await this.repo.lockById(u.jobId);
      if (!job || !this.fence.holds(job, u.runnerId, leaseEpoch) || !UPLOAD_STATES.includes(job.state)) return { ok: false as const };
      const previous = await this.repo.findArtifact(job.id, 'bundle', leaseEpoch);
      await this.repo.upsertArtifact({ jobId: job.id, leaseEpoch, kind: 'bundle', storageKey: key, sizeBytes: BigInt(stored.sizeBytes), sha256: stored.sha256 });
      await this.activity.record({
        actorType: 'RUNNER', actorId: u.runnerId, action: 'job.bundle_uploaded', entityType: 'job', entityId: job.id, jobId: job.id,
        projectId: job.projectId, responsibleUserId: job.requestedById, payload: { leaseEpoch, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
      });
      return { ok: true as const, replacedKey: previous?.storageKey ?? null };
    });
    if (!recorded.ok) {
      await this.store.delete(key); // only this attempt's file; the recorded bundle is untouched
      throw new FleetFenceException();
    }
    if (recorded.replacedKey) await this.store.delete(recorded.replacedKey);
    return { jobId: u.jobId, leaseEpoch, sizeBytes: String(stored.sizeBytes), sha256: stored.sha256 };
  }

  async download(projectId: string, jobId: string): Promise<{ stream: Readable; leaseEpoch: number; sizeBytes: bigint }> {
    const job = await this.repo.findById(jobId);
    if (!job || job.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.jobs');
    const artifact = await this.repo.findLatestArtifact(jobId, 'bundle');
    if (!artifact) throw new NotFoundAppException({}, 'fleet.bundle');
    return { stream: await this.store.get(artifact.storageKey), leaseEpoch: artifact.leaseEpoch, sizeBytes: artifact.sizeBytes };
  }

  private async assertHolder(runnerId: string, jobId: string, leaseEpoch: number): Promise<void> {
    const outcome = await this.txManager.run(async () => {
      const job = await this.repo.lockById(jobId);
      if (!job) return 'missing' as const;
      if (!this.fence.holds(job, runnerId, leaseEpoch)) {
        await this.fence.abandon(runnerId, job, leaseEpoch);
        return 'fenced' as const;
      }
      return UPLOAD_STATES.includes(job.state) ? ('ok' as const) : job.state;
    });
    if (outcome === 'missing') throw new NotFoundAppException({}, 'fleet.jobs');
    if (outcome === 'fenced') throw new FleetFenceException();
    if (outcome !== 'ok') throw new ConflictAppException({ state: outcome }, 'fleet.jobState');
  }
}
```

`bundle-upload.controller.ts`:

```ts
import { Controller, Headers, HttpCode, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Readable } from 'stream';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { BundleService } from './bundle.service';

/**
 * Plan D12: Fastify (production) hands the raw stream in `req.body` via the application/gzip
 * parser; Express (the HTTP test harness) leaves the body unread, so the request is the stream.
 */
export function requestStream(req: unknown): Readable {
  const body = (req as { body?: unknown }).body;
  return body instanceof Readable ? body : (req as Readable);
}

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@Controller('fleet/runner/jobs')
export class BundleUploadController {
  constructor(private readonly bundles: BundleService) {}

  @Put(':jobId/bundle')
  @HttpCode(201)
  @ApiConsumes('application/gzip')
  @ApiOperation({ summary: 'Upload the run bundle (tar.gz) for the held lease; replaces this epoch\'s previous bundle' })
  @ApiResponse({ status: 201, description: '{ jobId, leaseEpoch, sizeBytes, sha256 }' })
  @ApiResponse({ status: 409, description: 'Stale lease, or job not RUNNING/UPLOADING' })
  @ApiResponse({ status: 413, description: 'Larger than FLEET_BUNDLE_MAX_BYTES' })
  @ApiResponse({ status: 415, description: 'Not application/gzip' })
  @ApiResponse({ status: 422, description: 'X-Content-SHA256 mismatch' })
  async upload(
    @Principal() runner: RunnerPrincipal,
    @Param('jobId') jobId: string,
    @Query('leaseEpoch') leaseEpoch: string,
    @Headers('x-content-sha256') sha256: string,
    @Headers('content-type') contentType: string,
    @Headers('content-length') contentLength: string,
    @Req() req: unknown,
  ) {
    return JsonResponse.Ok(await this.bundles.upload({
      runnerId: runner.id, jobId, leaseEpochRaw: leaseEpoch, sha256Header: sha256, contentType, contentLength, body: requestStream(req),
    }));
  }
}
```

`job-bundle.controller.ts` (a separate controller on the jobs prefix, so `FleetJobsModule` does not depend on artifacts):

```ts
import { Controller, Get, Param, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { BundleService } from './bundle.service';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('projects/:slug/fleet/jobs')
@UseGuards(ProjectMembershipGuard)
export class JobBundleController {
  constructor(private readonly bundles: BundleService) {}

  @Get(':id/bundle')
  @ApiProduces('application/gzip')
  @ApiOperation({ summary: 'Download the latest run bundle (project member)' })
  @ApiResponse({ status: 200, description: 'tar.gz stream' })
  @ApiResponse({ status: 404, description: 'No such job or no bundle yet' })
  async download(@Param('id') id: string, @CurrentProject() ctx: ProjectContext): Promise<StreamableFile> {
    const { stream, leaseEpoch, sizeBytes } = await this.bundles.download(ctx.project.id, id);
    return new StreamableFile(stream, {
      type: 'application/gzip',
      disposition: `attachment; filename="koda-job-${id}-${leaseEpoch}.tar.gz"`,
      length: Number(sizeBytes),
    });
  }
}
```

`artifacts.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { ARTIFACT_STORE } from './artifact-store';
import { BundleService } from './bundle.service';
import { BundleUploadController } from './bundle-upload.controller';
import { JobBundleController } from './job-bundle.controller';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, FleetJobsModule, SyncModule],
  controllers: [BundleUploadController, JobBundleController],
  providers: [LocalDiskArtifactStore, { provide: ARTIFACT_STORE, useExisting: LocalDiskArtifactStore }, BundleService],
})
export class ArtifactsModule {}
```

Add `ArtifactsModule` to `FleetModule.imports`.

`src/common/hooks/bundle-content-parser.ts`:

```ts
type Done = (err: Error | null, body?: unknown) => void;
type FastifyLike = { addContentTypeParser: (type: string, parser: (req: unknown, payload: unknown, done: Done) => void) => void };

/**
 * Fleet bundle uploads (spec §3.3, plan D12): pass the raw application/gzip stream to the
 * handler unbuffered. The size cap is enforced by the ArtifactStore while streaming; the
 * JSON raw-body hook only buffers application/json, so it never touches these bodies.
 */
export function registerBundleContentParser(fastify: FastifyLike): void {
  fastify.addContentTypeParser('application/gzip', (_req, payload, done) => done(null, payload));
}
```

Known limit (documented, not fixed in S1): a body **without** `Content-Length` that crosses the cap mid-stream makes `pipeline` destroy the request, so the client sees a connection reset instead of 413. The slice 3 runner always sends `Content-Length` (it uploads a finished file); record that in the `packages/fleet-protocol` doc comment for the bundle upload.

In `main.ts`, right after `registerRawBodyHook(fastify);` add `registerBundleContentParser(fastify);` (import it). If the Fastify spec shows a 413 at 1 MiB, pass `{ bodyLimit: 2_147_483_647 }` as the parser's options argument (`addContentTypeParser(type, opts, fn)`) and widen `FastifyLike` accordingly; the store still caps at `FLEET_BUNDLE_MAX_BYTES`.

i18n (`en`, then the same keys in `zh`):

```json
  "bundle": { "404": "No bundle has been uploaded for this job", "413": "Bundle larger than {maxBytes} bytes", "415": "Bundles must be application/gzip", "422": "Bundle rejected: {reason}" },
  "bundleInput": { "-2": "Invalid bundle upload: {reason}" },
  "fence": { "409": "This runner does not hold the job's current lease" }
```

zh: `"404": "此任务尚未上传产物包"`, `"413": "产物包超过 {maxBytes} 字节"`, `"415": "产物包必须是 application/gzip"`, `"422": "产物包被拒绝：{reason}"`; `"bundleInput": {"-2": "无效的产物包上传：{reason}"}`; `"fence": {"409": "此执行器不持有该任务的当前租约"}`.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet/artifacts src/common/hooks test/integration/fleet/fleet-bundles.integration.spec.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet apps/api/src/common/hooks apps/api/src/main.ts apps/api/src/i18n apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts
git commit -m "feat(fleet): fenced bundle upload to a local artifact store and member download"
```

---

### Task 19: PR/MR attribution comment

**Files:**
- Modify: `apps/api/src/fleet/git-broker/github-app-client.ts` (`commentOnPullRequest`), `gitlab-access-checker.ts` (`commentOnMergeRequest`)
- Create: `apps/api/src/fleet/sync/pr-attribution.service.ts`, `pr-attribution.service.spec.ts`
- Modify: `apps/api/src/fleet/sync/sync.service.ts` (`afterTerminal`, terminal ids from every live event), `fleet-sweeper.ts`, `sync.module.ts`
- Test: `apps/api/test/integration/fleet/pr-attribution.integration.spec.ts` (new)

**Interfaces:**
- Produces:
  - `prNumberFor(repo: { provider: 'github' | 'gitlab'; owner: string; name: string }, url: string): number | null` — only when the URL's path names this repo.
  - `GitHubAppClient.commentOnPullRequest(installationId: bigint, owner: string, name: string, number: number, body: string): Promise<boolean>`
  - `GitLabAccessChecker.commentOnMergeRequest(owner: string, name: string, iid: number, body: string, token: string): Promise<boolean>`
  - `PrAttributionService.attribute(jobId: string, now?: Date): Promise<'posted' | 'skipped' | 'failed'>` — never throws.

- [ ] **Step 1: Write the failing unit test** — `pr-attribution.service.spec.ts`

```ts
import { prNumberFor } from './pr-attribution.service';

describe('prNumberFor (plan D19)', () => {
  const gh = { provider: 'github' as const, owner: 'acme', name: 'app' };
  const gl = { provider: 'gitlab' as const, owner: 'acme/platform', name: 'api' };

  it.each([
    [gh, 'https://github.com/acme/app/pull/12', 12],
    [gh, 'https://github.com/Acme/App/pull/12/', 12],
    [gh, 'https://ghe.acme.io/acme/app/pull/3', 3],
    [gl, 'https://gitlab.com/acme/platform/api/-/merge_requests/7', 7],
  ])('%o %s -> %s', (repo, url, n) => {
    expect(prNumberFor(repo, url)).toBe(n);
  });

  it.each([
    [gh, 'https://github.com/evil/app/pull/12'],
    [gh, 'https://github.com/acme/app/issues/12'],
    [gh, 'not a url'],
    [gl, 'https://gitlab.com/acme/other/api/-/merge_requests/7'],
    [gh, 'https://github.com/acme/app/pull/12x'],
  ])('refuses %o %s', (repo, url) => {
    expect(prNumberFor(repo, url)).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing integration test** — `pr-attribution.integration.spec.ts`

Same setup as `runner-git-tokens.integration.spec.ts` (fake forge + GitHub App env + `FLEET_SYNC_WAIT_MS=0` + `seedFleetHttpWorld` + `enrollRunner`), with forge routes `POST /app/installations/77/access_tokens` (201, token + expiry) and `POST /repos/acme/app/issues/12/comments` → `{ status: 201, body: { id: 1 } }`. Then:

```ts
  const waitFor = async (pred: () => boolean, ms = 2_000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return pred();
  };
  const runToCompletion = async (feature: string, prUrl: string) => {
    const j = await dispatch(feature);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
        { seq: 1, type: 'state', payload: { to: 'RUNNING' } },
        { seq: 2, type: 'snapshot', payload: { resultPrUrl: prUrl } },
        { seq: 3, type: 'state', payload: { to: 'UPLOADING' } },
        { seq: 4, type: 'state', payload: { to: 'COMPLETED' } },
      ] }],
    });
    return j;
  };

  it('comments once on the job\'s own PR, naming the requester by name', async () => {
    const j = await runToCompletion('attr', 'https://github.com/acme/app/pull/12');
    const comments = () => forge.requests.filter((r) => r.method === 'POST' && r.path === '/repos/acme/app/issues/12/comments');
    expect(await waitFor(() => comments().length === 1)).toBe(true);
    expect((comments()[0].body as { body: string }).body).toBe(`Dispatched by dev via koda job ${j.id}`);
    await expect(app.get(PrAttributionService).attribute(j.id)).resolves.toBe('skipped');
    expect(comments()).toHaveLength(1);
  });

  it('never comments on a PR of another repo (review focus 5)', async () => {
    await runToCompletion('attr-evil', 'https://github.com/evil/repo/pull/1');
    await new Promise((r) => setTimeout(r, 300));
    expect(forge.requests.some((r) => r.path.startsWith('/repos/evil'))).toBe(false);
  });
```

(`seedFleetHttpWorld` creates user `dev` with name `dev`. Each test needs the single-capacity runner free: the first job ends COMPLETED before the second dispatch.)

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && bun run test:scoped src/fleet/sync/pr-attribution.service.spec.ts test/integration/fleet/pr-attribution.integration.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Forge calls**

`GitHubAppClient`:

```ts
  /** Spec §7.1 attribution: one issue comment on the PR, with a fresh repo-scoped installation token. */
  async commentOnPullRequest(installationId: bigint, owner: string, name: string, number: number, body: string): Promise<boolean> {
    const { token } = await this.mintInstallationToken(installationId, name);
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`;
    const res = await this.http.request('POST', `${this.api}${path}`, this.headers(token), { body });
    return res.status === 201;
  }
```

`GitLabAccessChecker`:

```ts
  async commentOnMergeRequest(owner: string, name: string, iid: number, body: string, token: string): Promise<boolean> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const res = await this.http.request('POST', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests/${iid}/notes`, { 'private-token': token }, { body });
    return res.status === 201;
  }
```

- [ ] **Step 5: Service** — `sync/pr-attribution.service.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { isTerminal } from '../jobs/job-state';
import { FLEET_JOB_REPOSITORY, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';

const GITHUB_PR = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const GITLAB_MR = /^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)\/?$/;

/** The PR/MR number, only when the URL path names this job's own repo (plan D19). */
export function prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name'>, url: string): number | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = (repo.provider === 'github' ? GITHUB_PR : GITLAB_MR).exec(path);
  if (!match) return null;
  const same = (a: string, b: string) => decodeURIComponent(a).toLowerCase() === b.toLowerCase();
  return same(match[1], repo.owner) && same(match[2], repo.name) ? Number(match[3]) : null;
}

/** Spec §7.1: "Dispatched by <user> via koda job <id>", once per job; failures are logged, never thrown. */
@Injectable()
export class PrAttributionService {
  private readonly logger = new Logger(PrAttributionService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
  ) {}

  async attribute(jobId: string, now = new Date()): Promise<'posted' | 'skipped' | 'failed'> {
    try {
      const job = await this.repo.findById(jobId);
      if (!job || !isTerminal(job.state) || !job.resultPrUrl) return 'skipped';
      const repo = await this.repo.findRepo(job.repoId);
      if (!repo) return 'skipped';
      const number = prNumberFor(repo, job.resultPrUrl);
      if (number === null) {
        this.logger.warn(`Job ${job.id}: resultPrUrl does not name ${repo.owner}/${repo.name}; no attribution`);
        return 'skipped';
      }
      if (!(await this.repo.claimAttribution(job.id, now))) return 'skipped';
      const who = (await this.repo.findUserDisplayName(job.requestedById)) ?? 'a koda user';
      const body = `Dispatched by ${who} via koda job ${job.id}`;
      const posted = repo.provider === 'github'
        ? repo.githubInstallationId !== null && (await this.github.commentOnPullRequest(repo.githubInstallationId, repo.owner, repo.name, number, body))
        : await this.gitlab.commentOnMergeRequest(repo.owner, repo.name, number, body, await this.gitlabTokens.resolve(repo.projectId, repo.owner, repo.name));
      if (!posted) this.logger.warn(`Job ${job.id}: attribution comment was not accepted`);
      return posted ? 'posted' : 'failed';
    } catch (error) {
      this.logger.warn(`Job ${jobId}: attribution failed (${error instanceof Error ? error.name : 'unknown'})`);
      return 'failed';
    }
  }
}
```

- [ ] **Step 6: Hook it up**

In `SyncService.sync`, drop `terminalJobIds` and compute the terminal set from every live event (acks and reports both produce terminal transitions):

```ts
    await this.afterTerminal(live.filter((e) => isTerminal(e.state)).map((e) => e.jobId));
```

and extend `afterTerminal`:

```ts
  protected async afterTerminal(jobIds: readonly string[]): Promise<void> {
    for (const id of new Set(jobIds)) {
      this.broker.evict(id);
      void this.attribution.attribute(id); // fire-and-forget; never throws
    }
  }
```

Inject `PrAttributionService` into `SyncService` (and import `isTerminal` from `../jobs/job-state`). In `FleetSweeper`, append `PrAttributionService` as the **last** constructor parameter and, after publishing a crash event, call `void this.attribution.attribute(id);`; the sweeper unit spec's two constructor calls gain a trailing `{} as never`. Register `PrAttributionService` in `SyncModule.providers` (it already imports `GitBrokerModule`; `GitBrokerModule` must export `GitLabAccessChecker`, which it does since slice 1). `JobReportProcessor`'s `terminalJobId` stays for callers that want it; `SyncService` no longer reads it.

- [ ] **Step 7: Run to verify pass**

Run: `cd apps/api && bun run test:scoped src/fleet test/integration/fleet && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/pr-attribution.integration.spec.ts
git commit -m "feat(fleet): attribute runner-opened PRs and MRs to the requesting user"
```

---

### Task 20b: Contract, guidance, full gates, PR

**Files:**
- Modify: `openapi.json` (generated), `apps/cli/src/generated/**` (generated, untracked)
- Modify: `.nax/mono/apps/api/context.md`, then the generated agent files

- [ ] **Step 1: Regenerate the contract**

Run from the repo root: `bun run generate`
Expected: `openapi.json` gains `/api/fleet/runner/sync`, `/api/fleet/runner/jobs/{jobId}/bundle` and `/api/projects/{slug}/fleet/jobs/{id}/bundle`; `bun scripts/check-dist-requires.ts` reports no store paths.

- [ ] **Step 2: CLI still builds**

Run: `cd apps/cli && bunx tsc --noEmit && bunx jest`
Expected: clean and green.

- [ ] **Step 3: Guidance** — extend the `## Fleet (S1)` section of `.nax/mono/apps/api/context.md`:

```markdown
- Every runner write (events, acks, token requests, bundles) is fenced by `(runnerId, leaseEpoch)` through `FenceService`; a mismatch queues one `ABANDON` and stores nothing.
- Never hold a transaction across the sync long-poll or forge HTTP. One failing job or ack in a sync is logged and skipped, never allowed to fail the whole request.
- Runner strings are untrusted: parse through `parseSyncRequest` (NUL replaced) and `interpretEvent` (bounded fields dropped, never fatal).
- Git tokens exist only in `GitTokenBroker`'s memory cache and the sync response: never logged, stored, or put in a command or activity payload.
```

Run `nax generate` and `nax generate --all-packages` from the repo root (local, not billed).

- [ ] **Step 4: Full gates**

```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:integration && cd ../..
git add openapi.json
bun run generate && git diff --exit-code openapi.json
```
Expected: all green; counts recorded against the Task 0b baseline.

- [ ] **Step 5: Security self-check** (`<2a-sha>` = the sha recorded in Task 0b)

```bash
git diff --name-only <2a-sha> -- apps/api/src | grep -v '\.spec\.ts$' | xargs grep -n "console\.log" || true
git diff <2a-sha> -- apps/api/src | grep -nE "^\+.*logger\.(log|warn|error)\(.*token" || true
```
Expected: no `console.log`; no logger call interpolates a token value. Tokens appear only in `GitTokenBroker` and the sync response.

- [ ] **Step 6: Code review before push**

Dispatch a code reviewer over `git diff <2a-sha>...HEAD` with this plan's Review Focus list and decisions as the brief. Fix CRITICAL/HIGH findings, then re-run Step 4.

- [ ] **Step 7: Commit, push, PR (only after the user approves pushing and opening the PR)**

```bash
git add openapi.json .nax/mono/apps/api/context.md apps/api/AGENTS.md apps/api/CLAUDE.md AGENTS.md CLAUDE.md
git commit -m "docs(fleet): slice 2b api guidance and openapi"
git push -u origin feat/fleet-s1-slice2b-runner-sync
gh pr create --base main --title "feat(fleet): S1 slice 2b — runner sync, fencing, git tokens, bundles" --body-file <(cat <<'EOF'
## Summary
Fleet S1 slice 2b (spec `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`, plan `docs/superpowers/plans/2026-09-29-fleet-s1-slice-2b-runner-sync.md`).

- `POST /fleet/runner/sync`: per-(epoch, seq) dedup, cumulative acks, command acks, boot-id readopt on every sync, long-poll.
- Lease-epoch fence on every runner write; one ABANDON per stale lease.
- Per-job GitHub App / GitLab tokens minted only for the current lease; never stored or logged.
- Silence sweep; fenced, streamed, hash-checked bundle upload with per-attempt keys; member download; PR/MR attribution.

## Plan decisions beyond the spec
D2-D8, D11-D13, D19, D20 (register in the 2a plan).

## Tests
Baseline vs final counts.

## Out of scope
apps/runner (slice 3; needs SP-1, SP-4 and the nax `config --profile --json` / `auth list --json` PR first); web pages and `koda fleet` CLI (slice 4).
EOF
)
```
Expected: PR opened; all ten required checks green.

---

## Self-review (done while writing)

- **Spec coverage (2b share of §13 slice 2):** sync endpoint (Tasks 13, 14), fencing of runner writes (Tasks 14, 15, 17), command acks and boot-id reconcile (Task 14), token minting (Task 15), silence sweep (Task 16), bundle upload/download (Task 17), attribution (Task 19).
- **Spec §12 integration list:** stale-epoch event, ack, token request and bundle rejected with ABANDON (Tasks 14, 15, 17); duplicate seq same/different payload (Task 14); boot-id change ok and rejected (Task 14); silence sweep with an explicit clock (Task 16). Concurrent placement and the active-job 409 were covered in 2a.
- **Review fixes carried from the unified plan review:** per-job and per-ack isolation plus NUL replacement (Tasks 13, 14), reconcile on every sync (Task 14), locked token-request fence (Task 15), slice 1 mint stub gains `expires_at` (Task 15), per-attempt bundle keys (Task 17), shorter long-poll wait in tests (Task 14).
- **Review Focus:** 1 → Tasks 14, 15, 17; 2-3 → Task 14 lifecycle tests; 4 → Tasks 13, 14, 19; 5 → Task 17.
