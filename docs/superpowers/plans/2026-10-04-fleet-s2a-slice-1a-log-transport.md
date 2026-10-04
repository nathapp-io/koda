# Fleet S2a Slice 1a — Log Transport and Storage (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API accepts a runner's complete log streams (run JSONL, stdout, stderr) as exact-offset appends, stores
them on disk behind a `LogStore` with a `FleetJobLog` index row per (job, attempt, stream), publishes a coalesced
`fleet_log` live event, and fills any stream the runner did not finish from the job's bundle. API only; the runner
shipper is slice 1b, the read routes, CLI and retention are 1c, the web is 2.

**Architecture:** A new `src/fleet/logs/` module owns `LogStore` (+ `LocalDiskLogStore`), a per-key in-process
mutex, the `FleetJobLog` repository, the upload service and controller, the live publisher and the bundle fallback.
`ArtifactStore` moves into a small `ArtifactStoreModule` so both the artifacts module and the logs module can use it
without a cycle; `BundleService` hands each committed bundle to `LogFallbackService`. Every protocol outcome of an
upload (appended, duplicate, offset, complete, stream_cap, rate_limited) is an HTTP 200 with a typed body, so the
runner can read the server's size; real errors stay HTTP errors.

**Tech Stack:** NestJS 11 + Fastify + Prisma 6 (PostgreSQL) + Jest + supertest; `tar-stream` + `zlib` for bundle
extraction.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md` §1, §2.1 (API part), §2.2, §2.3, §2.5, §6
(API rows), §7 (the three upload keys), §8 (1a tests), §9 slice 1a. Rulings L1, L5, R1, R2, R7, R8, R14.

## Global Constraints

- Streams: exactly `run | stdout | stderr`. Storage key `logs/<jobId>/<leaseEpoch>/<stream>.log`.
- `FLEET_LOG_MAX_BYTES` default `268435456` (256 MiB), `FLEET_LOG_CHUNK_MAX_BYTES` default `1048576` (1 MiB),
  `FLEET_LOG_RUNNER_BYTES_PER_SEC` default `4194304` (4 MiB/s).
- Upload route: `PUT /fleet/runner/jobs/:jobId/logs/:stream?leaseEpoch=<int>&offset=<int>[&final=1]`,
  `@RunnerRoute()` + `@SkipThrottle()`, body `application/octet-stream`, header `X-Content-SHA256` (64 hex).
- Accepted job states for an upload: `ASSIGNED`, `RUNNING`, `UPLOADING` (R2).
- Protocol: the API's `SUPPORTED_FLEET_PROTOCOL_VERSIONS = [1, 2, 3]`. `packages/fleet-protocol`
  `FLEET_PROTOCOL_VERSION` **stays 2** in this slice (D308).
- `append`, `replace` and every `FleetJobLog` write for one key run inside `LogStore.withLock(key, ...)`.
- `fleet_log` events: `id = randomUUID()` per publish; at most one per `(jobId, leaseEpoch, stream)` per second,
  trailing edge; `final`, cap and fallback publish immediately.
- **`apps/api` compiles with `strictNullChecks: false`**: a boolean discriminant does not narrow a union. Discriminate
  with `'kind' in r` / a string literal field compared with `===` on a non-optional property, as the snippets do.
- API tests: `cd apps/api && bun run test:scoped <paths>` (integration specs need `bun run test:db:up` first). Never
  bare `bun test` at the repo root.
- Integration files log in over HTTP in `beforeAll` (login throttle 5/min). A whole file failing in under a millisecond
  with only a `loginToken` frame is the local throttle cascade: wait a minute and rerun that file alone.
- `bun run generate` (repo root) needs `apps/api/.env`; commit `openapi.json` only.
- No emojis in source; no `console.log` in `src`.
- Immutability: build new objects; the only mutable state is the mutex map, the rate buckets and the publisher's timer
  map, each private to one class and replaced, not mutated in place, where the snippets show it.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D307 (S1.5 slice 2b ended at D306).

| # | Decision | Why |
|:--|:--|:--|
| D307 | **Spec correction (§2.2, §2.4):** every protocol outcome of an upload is HTTP **200** `{ outcome, size, retryAfterMs? }` with `outcome ∈ appended \| duplicate \| offset \| complete \| stream_cap \| rate_limited`. HTTP errors are only: 400 input, 404 job, 409 fence (`fleet.fence`) or job state (`fleet.jobState`), 413 chunk too large, 422 SHA mismatch, 507 storage. The spec text is updated in this plan's commit. | The API's error envelope carries only a translated `message` (`AppException` args are interpolated, not returned), so a 409 could never give the runner the server size. The runner stops a job's streams on any 409 (stale lease or terminal state), so it does not need to tell them apart. |
| D308 | This slice bumps only the API's supported list to `[1, 2, 3]`. The shared package's `FLEET_PROTOCOL_VERSION` moves to 3 in slice 1b together with the shipper. | A runner that reports v3 must stream logs (R1); bumping the package now would build a v3 runner without a shipper. `protocol.spec.ts` asserts the supported list contains the package version, which stays true. |
| D309 | Module layout: `src/fleet/artifacts/artifact-store.module.ts` (provides and exports `LocalDiskArtifactStore` + `ARTIFACT_STORE`); `src/fleet/logs/logs.module.ts` imports it plus `FleetJobsModule`, `SyncModule`, `LiveModule`, and exports `LogFallbackService`; `ArtifactsModule` imports `ArtifactStoreModule` and `LogsModule`. | The fallback needs the artifact store and the bundle service needs the fallback; a store module breaks the cycle (same pattern as `BudgetStoreModule`, `ApprovalStoreModule`). |
| D310 | Fence on the upload route: `findById` (no lock) on the hot path; when `FenceService.holds(job, runnerId, leaseEpoch)` is false, re-check under `lockById` in a transaction and call `FenceService.abandon`, then throw `FleetFenceException` after commit (the `BundleService.assertHolder` pattern). The state check is not transactional with the append. | A row lock per 1 MiB chunk is needless; ABANDON must still be queued for a stale lease. A state change racing an append can at worst store bytes for a job that just ended, which the reader serves like any other bytes. |
| D311 | `KeyedMutex`: a map from key to the tail of a promise chain; the entry is deleted when its chain drains. `LogStore.withLock` delegates to it. `append` and `replace` do **not** lock themselves: the caller holds `withLock` (documented on the interface). | The upload service needs one critical section around row read, append and row write; nested locks would deadlock. |
| D312 | Rate: a per-runner token bucket, capacity = chunk max, refill = bytes/s. Charged **before** the body is read by `Content-Length` (or the chunk max when absent or invalid). On refusal the body is drained (`resume()`), and the answer is 200 `{ outcome: 'rate_limited', size: -1, retryAfterMs }`. No post-read correction. | Spec §2.2.1 minus the correction step: a runner that lies about the length is still capped by the chunk max; YAGNI. |
| D313 | `FleetJobLog.sizeBytes` is written from `LogStore.size()` inside the lock after every upload that reached the store, so it never goes backwards and heals after a crash between `fsync` and the row write. | Spec §1.2. |
| D314 | A `complete` row answers `{ outcome: 'complete', size }` to every later upload (including a repeated `final=1`); a `truncated` row answers `{ outcome: 'stream_cap', size }`. | R8; the runner treats both as "this stream is done". |
| D315 | The cap path appends `body[0, max(0, cap − offset))` through the normal exact-offset rule, sets `truncated = true`, answers `stream_cap`. A conflict on that cut append answers `offset` (no truncation recorded). | Spec §2.2 step 6. |
| D316 | Fallback runs on a private serial promise queue in `LogFallbackService` (`schedule()` returns at once; `idle()` resolves when the queue drains, for tests). Two passes over the stored bundle: pass 1 reads tar headers only, pass 2 extracts the chosen members. | A 200 MiB bundle must not delay the bundle response; choosing the `run` member may need every header (newest mtime). |
| D317 | Member names are normalised by stripping a leading `./`. Only `type === 'file'` entries count (the runner's tar keeps `latest.jsonl` as a symlink). `naxLogRunId` is used only when `job.leaseEpoch === leaseEpoch` (a requeue nulls or replaces it). | The runner builds the bundle with system `tar -T list` (`apps/runner/src/bundle/build-bundle.ts`); bsdtar and GNU tar may differ on `./`. |
| D318 | A bundle member larger than the cap is written up to the cap and the row becomes `truncated = true, complete = false, source = 'bundle'`. A member at most the cap becomes `complete = true, source = 'bundle'`. A member smaller than the stored size leaves the row untouched. | Spec §2.5 step 3 with the cap made explicit. |
| D319 | Error i18n keys (en + zh): `fleet.logInput` (400, `{reason}`), `fleet.logChunk` (413, `{maxBytes}`), `fleet.logHash` (422), `fleet.logStorage` (507). Fence and job state reuse `fleet.fence` and `fleet.jobState`. | Same pattern as `fleet.bundle` / `fleet.bundleInput`. |

## Review Focus

1. **A retried chunk after a lost response** (the runner re-sends `[offset, offset+n)` that the server already
   stored): expect `duplicate` with the current size, no second copy of the bytes. Pinned in Task 5.
2. **A chunk that straddles the cap, re-sent after a timeout**: the second attempt must answer `stream_cap` with the
   same size and leave the file byte-identical. Pinned in Task 5.
3. **The bundle fallback racing a late upload of the same stream** (drain timed out, the uploader is still sending
   when the bundle lands): the file must end up as exactly one of the two, never interleaved; a `complete` row refuses
   further appends. Pinned in Task 9 (integration) with the lock and the CAS.
4. **A bundle whose run member is missing, a symlink, or for another feature**: the stream stays incomplete and no
   other file is written. Pinned in Task 7 (selection) and Task 9 (no run member).
5. **A job requeued while its old attempt's bundle is processed**: the fallback must use the old attempt's key and must
   not use the new attempt's `naxLogRunId`. Pinned in Task 8.

## File Map

**apps/api**
- Modify `prisma/schema.prisma`; create `prisma/migrations/20261004120000_fleet_job_logs/migration.sql`.
- Modify `src/config/fleet.config.ts` (+ `src/config/fleet.config.spec.ts` if present, else create it).
- Modify `src/fleet/common/protocol.ts`, `src/fleet/common/protocol.spec.ts`.
- Modify `src/common/hooks/bundle-content-parser.ts`, `src/main.ts`.
- Modify `src/live/live-event.ts`.
- Modify `src/i18n/en/fleet.json`, `src/i18n/zh/fleet.json`.
- Create `src/fleet/artifacts/artifact-store.module.ts`; modify `src/fleet/artifacts/artifacts.module.ts`,
  `src/fleet/artifacts/bundle.service.ts`.
- Create in `src/fleet/logs/`: `log-store.ts`, `keyed-mutex.ts`, `local-disk-log.store.ts`,
  `domain/fleet-job-log.domain.ts`, `prisma-fleet-job-log.repository.ts`, `read-capped-body.ts`, `runner-byte-rate.ts`,
  `log-upload.exceptions.ts`, `log-upload.service.ts`, `log-upload.controller.ts`, `fleet-log-live.publisher.ts`,
  `bundle-log-extractor.ts`, `log-fallback.service.ts`, `logs.module.ts`, and a `*.spec.ts` beside each unit.
- Modify `src/fleet/fleet.module.ts`.
- Create `test/integration/fleet/fleet-job-logs-schema.integration.spec.ts`,
  `test/integration/fleet/fleet-log-upload.integration.spec.ts`,
  `test/integration/fleet/fleet-log-fallback.integration.spec.ts`, `test/helpers/tar-gz.ts`.
- `package.json`: add `tar-stream` and `@types/tar-stream`.

**repo root:** `openapi.json` (regenerated); spec text for D307.

---

### Task 1: Config keys, `FleetJobLog` table, migration and repository

**Files:**
- Modify: `apps/api/src/config/fleet.config.ts`
- Modify: `apps/api/prisma/schema.prisma` (model `FleetJob` relations + indexes near line 812; model `FleetJobArtifact`)
- Create: `apps/api/prisma/migrations/20261004120000_fleet_job_logs/migration.sql`
- Create: `apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts`
- Create: `apps/api/src/fleet/logs/prisma-fleet-job-log.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-job-logs-schema.integration.spec.ts`

**Interfaces:**
- Produces: `IFleetConfig.logMaxBytes: number`, `logChunkMaxBytes: number`, `logRunnerBytesPerSec: number`;
  `LOG_STREAMS`, `LogStreamName`, `FleetJobLogRecord`, `IFleetJobLogRepository`, `FLEET_JOB_LOG_REPOSITORY`,
  `PrismaFleetJobLogRepository`.

- [ ] **Step 1: Write the failing schema test**

`apps/api/test/integration/fleet/fleet-job-logs-schema.integration.spec.ts`:

```ts
/**
 * Fleet S2a slice 1a — FleetJobLog table and repository (PG), spec §1.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-logs-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetJobLogRepository } from '../../../src/fleet/logs/prisma-fleet-job-log.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet job logs schema (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaFleetJobLogRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  let jobId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repoRow = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: project.id, repoId: repoRow.id, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: user.id, state: 'RUNNING',
      },
    });
    jobId = job.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('upserts one row per (job, epoch, stream) and returns sizes as numbers', async () => {
    const created = await repo.upsertStream(jobId, 1, 'run', { sizeBytes: 10 });
    expect(created).toMatchObject({ jobId, leaseEpoch: 1, stream: 'run', sizeBytes: 10, complete: false, truncated: false, source: 'stream', expiredAt: null });
    const grown = await repo.upsertStream(jobId, 1, 'run', { sizeBytes: 20, complete: true });
    expect(grown).toMatchObject({ id: created.id, sizeBytes: 20, complete: true });
    await repo.upsertStream(jobId, 1, 'stdout', { sizeBytes: 5 });
    expect((await repo.listForAttempt(jobId, 1)).map((r) => r.stream).sort()).toEqual(['run', 'stdout']);
    expect(await repo.findStream(jobId, 2, 'run')).toBeNull();
  });

  it('completeFromBundle is a compare-and-set on complete = false and truncated = false', async () => {
    await repo.upsertStream(jobId, 3, 'stderr', { sizeBytes: 4 });
    expect(await repo.completeFromBundle(jobId, 3, 'stderr', { sizeBytes: 9, truncated: false })).toBe(true);
    expect(await repo.findStream(jobId, 3, 'stderr')).toMatchObject({ sizeBytes: 9, complete: true, source: 'bundle' });
    expect(await repo.completeFromBundle(jobId, 3, 'stderr', { sizeBytes: 12, truncated: false })).toBe(false);
    expect(await repo.completeFromBundle(jobId, 3, 'run', { sizeBytes: 7, truncated: true })).toBe(true); // no row yet: created
    expect(await repo.findStream(jobId, 3, 'run')).toMatchObject({ sizeBytes: 7, complete: false, truncated: true, source: 'bundle' });
  });

  it('rejects a duplicate (job, epoch, stream) row and cascades on job delete', async () => {
    await expect(prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: 1, stream: 'run' } })).rejects.toMatchObject({ code: 'P2002' });
    const artifact = await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: 1, kind: 'bundle', storageKey: 'k', sizeBytes: 1n, sha256: 'x' } });
    expect(artifact.expiredAt).toBeNull();
    await prisma.fleetJob.delete({ where: { id: jobId } });
    expect(await prisma.fleetJobLog.count({ where: { jobId } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-job-logs-schema.integration.spec.ts`
Expected: FAIL — cannot find module `prisma-fleet-job-log.repository`.

- [ ] **Step 3: Schema, migration, config**

`schema.prisma` — in `model FleetJob`, after `artifacts    FleetJobArtifact[]`:

```prisma
  logs         FleetJobLog[]
```

and after `@@index([runnerId, state])`:

```prisma
  @@index([state, finishedAt]) // S2a retention (spec §5)
```

In `model FleetJobArtifact`, after `createdAt`:

```prisma
  expiredAt  DateTime? // S2a retention: the file is gone (spec §5)
```

New model after `FleetJobArtifact`:

```prisma
/// Fleet S2a §1.2: index row of one log stream of one attempt; the bytes live in LogStore.
model FleetJobLog {
  id         String    @id @default(cuid())
  jobId      String
  leaseEpoch Int
  stream     String // run | stdout | stderr
  sizeBytes  BigInt    @default(0)
  complete   Boolean   @default(false) // final=1 accepted, or filled from the bundle
  truncated  Boolean   @default(false) // hit FLEET_LOG_MAX_BYTES; terminal, never complete
  source     String    @default("stream") // stream | bundle
  expiredAt  DateTime?
  updatedAt  DateTime  @updatedAt
  createdAt  DateTime  @default(now())

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, stream])
  @@index([jobId])
}
```

`apps/api/prisma/migrations/20261004120000_fleet_job_logs/migration.sql`:

```sql
-- Fleet S2a slice 1a: complete run logs (spec §1.2) and retention markers (spec §5).
CREATE TABLE "FleetJobLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'stream',
    "expiredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetJobLog_jobId_leaseEpoch_stream_key" ON "FleetJobLog"("jobId", "leaseEpoch", "stream");
CREATE INDEX "FleetJobLog_jobId_idx" ON "FleetJobLog"("jobId");
ALTER TABLE "FleetJobLog" ADD CONSTRAINT "FleetJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FleetJobArtifact" ADD COLUMN "expiredAt" TIMESTAMP(3);

CREATE INDEX "FleetJob_state_finishedAt_idx" ON "FleetJob"("state", "finishedAt");
```

Run `cd apps/api && bunx prisma generate`. Then check the migration matches the schema:
`bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$TEST_SHADOW_URL" --exit-code`
where `TEST_SHADOW_URL` is the test database URL with database `koda_shadow_test` (create it once with
`docker compose -f ../../docker-compose.test.yml exec -T postgres createdb -U postgres koda_shadow_test`; read the
user and port from `docker-compose.test.yml`). Expected: exit 0 (no difference). If the diff prints SQL, copy its
statement text into the migration and rerun.

`fleet.config.ts` — add to `IFleetConfig` after `bundleMaxBytes`:

```ts
  /** S2a §7: per stream per attempt cap. */
  logMaxBytes: number;
  /** S2a §7: max body per log upload. */
  logChunkMaxBytes: number;
  /** S2a §2.2.1: per-runner upload rate. */
  logRunnerBytesPerSec: number;
```

to `FleetConfigSchema` after `FLEET_BUNDLE_MAX_BYTES`:

```ts
  @IsOptional() @IsString() FLEET_LOG_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_LOG_CHUNK_MAX_BYTES: string;
  @IsOptional() @IsString() FLEET_LOG_RUNNER_BYTES_PER_SEC: string;
```

and to the `fleetConfig` object after `bundleMaxBytes`:

```ts
    logMaxBytes: int('FLEET_LOG_MAX_BYTES', 256 * 1024 * 1024),
    logChunkMaxBytes: int('FLEET_LOG_CHUNK_MAX_BYTES', 1024 * 1024),
    logRunnerBytesPerSec: int('FLEET_LOG_RUNNER_BYTES_PER_SEC', 4 * 1024 * 1024),
```

Add the three keys with their defaults and one-line meanings to `apps/api/.env.example` (or the repo-root
`.env.example` if `apps/api` has none), next to `FLEET_BUNDLE_MAX_BYTES`.

- [ ] **Step 4: Domain and repository**

`apps/api/src/fleet/logs/domain/fleet-job-log.domain.ts`:

```ts
export const LOG_STREAMS = ['run', 'stdout', 'stderr'] as const;
export type LogStreamName = (typeof LOG_STREAMS)[number];
export type LogSource = 'stream' | 'bundle';

export const isLogStream = (value: unknown): value is LogStreamName =>
  typeof value === 'string' && (LOG_STREAMS as readonly string[]).includes(value);

/** Spec §1.2. `sizeBytes` is a number (at most 256 MiB, safe). */
export interface FleetJobLogRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  sizeBytes: number;
  complete: boolean;
  truncated: boolean;
  source: LogSource;
  expiredAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface LogStreamPatch {
  sizeBytes: number;
  complete?: boolean;
  truncated?: boolean;
}

export const FLEET_JOB_LOG_REPOSITORY = Symbol('FLEET_JOB_LOG_REPOSITORY');

export interface IFleetJobLogRepository {
  findStream(jobId: string, leaseEpoch: number, stream: LogStreamName): Promise<FleetJobLogRecord | null>;
  listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]>;
  /** Caller holds LogStore.withLock for the stream's key. */
  upsertStream(jobId: string, leaseEpoch: number, stream: LogStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord>;
  /**
   * Caller holds the key lock. Sets source = bundle and the size; complete = !truncated. Only when the row is absent
   * or has complete = false and truncated = false. Returns whether it wrote.
   */
  completeFromBundle(jobId: string, leaseEpoch: number, stream: LogStreamName, r: { sizeBytes: number; truncated: boolean }): Promise<boolean>;
}
```

`apps/api/src/fleet/logs/prisma-fleet-job-log.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { FleetJobLog as LogRow, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { FleetJobLogRecord, IFleetJobLogRepository, LogSource, LogStreamName, LogStreamPatch } from './domain/fleet-job-log.domain';

const toRecord = (r: LogRow): FleetJobLogRecord => ({
  ...r,
  stream: r.stream as LogStreamName,
  source: r.source as LogSource,
  sizeBytes: Number(r.sizeBytes),
});

@Injectable()
export class PrismaFleetJobLogRepository implements IFleetJobLogRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findStream(jobId: string, leaseEpoch: number, stream: LogStreamName): Promise<FleetJobLogRecord | null> {
    const r = await this.db.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } } });
    return r ? toRecord(r) : null;
  }

  async listForAttempt(jobId: string, leaseEpoch: number): Promise<FleetJobLogRecord[]> {
    return (await this.db.fleetJobLog.findMany({ where: { jobId, leaseEpoch }, orderBy: { stream: 'asc' } })).map(toRecord);
  }

  async upsertStream(jobId: string, leaseEpoch: number, stream: LogStreamName, patch: LogStreamPatch): Promise<FleetJobLogRecord> {
    const data = {
      sizeBytes: BigInt(patch.sizeBytes),
      ...(patch.complete === undefined ? {} : { complete: patch.complete }),
      ...(patch.truncated === undefined ? {} : { truncated: patch.truncated }),
    };
    return toRecord(await this.db.fleetJobLog.upsert({
      where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } },
      create: { jobId, leaseEpoch, stream, ...data },
      update: data,
    }));
  }

  async completeFromBundle(jobId: string, leaseEpoch: number, stream: LogStreamName, r: { sizeBytes: number; truncated: boolean }): Promise<boolean> {
    const data = { sizeBytes: BigInt(r.sizeBytes), source: 'bundle', complete: !r.truncated, truncated: r.truncated };
    const existing = await this.db.fleetJobLog.findUnique({ where: { jobId_leaseEpoch_stream: { jobId, leaseEpoch, stream } } });
    if (!existing) {
      await this.db.fleetJobLog.create({ data: { jobId, leaseEpoch, stream, ...data } });
      return true;
    }
    const { count } = await this.db.fleetJobLog.updateMany({ where: { id: existing.id, complete: false, truncated: false }, data });
    return count === 1;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-logs-schema.integration.spec.ts`
Expected: PASS (3 tests). Also run `cd apps/api && bun run type-check`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src/config/fleet.config.ts apps/api/src/fleet/logs/domain apps/api/src/fleet/logs/prisma-fleet-job-log.repository.ts apps/api/test/integration/fleet/fleet-job-logs-schema.integration.spec.ts apps/api/.env.example .env.example
git commit -m "feat(fleet): FleetJobLog table, retention markers and log config (S2a 1a)"
```

(`git add` of a path that does not exist fails; drop the `.env.example` you did not edit.)

---

### Task 2: `LogStore`, `KeyedMutex` and `LocalDiskLogStore`

**Files:**
- Create: `apps/api/src/fleet/logs/log-store.ts`
- Create: `apps/api/src/fleet/logs/keyed-mutex.ts`, `apps/api/src/fleet/logs/keyed-mutex.spec.ts`
- Create: `apps/api/src/fleet/logs/local-disk-log.store.ts`, `apps/api/src/fleet/logs/local-disk-log.store.spec.ts`

**Interfaces:**
- Consumes: `LogStreamName` (Task 1), `IFleetConfig.artifactDir`.
- Produces: `LOG_STORE`, `LogStore`, `AppendResult`, `logKey(jobId, leaseEpoch, stream): string`, `KeyedMutex`,
  `LocalDiskLogStore`.

- [ ] **Step 1: Write the failing tests**

`keyed-mutex.spec.ts`:

```ts
import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise((r) => setImmediate(r));

describe('KeyedMutex', () => {
  it('runs sections for one key one at a time, in order, and other keys in parallel', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = m.run('k', async () => { order.push('a-start'); await new Promise<void>((r) => { releaseA = r; }); order.push('a-end'); });
    const b = m.run('k', async () => { order.push('b'); });
    const other = m.run('other', async () => { order.push('other'); });
    await tick();
    expect(order).toEqual(['a-start', 'other']);
    releaseA();
    await Promise.all([a, b, other]);
    expect(order).toEqual(['a-start', 'other', 'a-end', 'b']);
    await tick(); // the idle entry is dropped one microtask turn after the last section settles
    expect(m.size).toBe(0);
  });

  it('a failing section rejects its caller and does not block the next one', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(m.run('k', async () => 7)).resolves.toBe(7);
    await tick();
    expect(m.size).toBe(0);
  });
});
```

`local-disk-log.store.spec.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';

describe('LocalDiskLogStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-logs-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const key = logKey('j1', 1, 'run');
  const b = (s: string) => Buffer.from(s);

  it('builds keys from validated parts', () => {
    expect(key).toBe('logs/j1/1/run.log');
    expect(() => logKey('../x', 1, 'run')).toThrow(/log key/);
    expect(() => logKey('j1', -1, 'run')).toThrow(/log key/);
  });

  it('appends only at the current size; answers duplicate and conflict with the size', async () => {
    await expect(store.size(key)).resolves.toBe(0);
    await expect(store.append(key, 0, b('abc\n'))).resolves.toEqual({ kind: 'appended', size: 4 });
    await expect(store.append(key, 0, b('abc\n'))).resolves.toEqual({ kind: 'duplicate', size: 4 });
    await expect(store.append(key, 2, b('c\n'))).resolves.toEqual({ kind: 'duplicate', size: 4 });
    await expect(store.append(key, 2, b('c\nde'))).resolves.toEqual({ kind: 'conflict', size: 4 });
    await expect(store.append(key, 9, b('x'))).resolves.toEqual({ kind: 'conflict', size: 4 });
    await expect(store.append(key, 4, b('de\n'))).resolves.toEqual({ kind: 'appended', size: 7 });
    expect(readFileSync(join(root, key), 'utf8')).toBe('abc\nde\n');
    await expect(store.read(key, 4, 100)).resolves.toEqual(b('de\n'));
  });

  it('serialises concurrent appends under withLock so the file is never interleaved', async () => {
    const k = logKey('j2', 1, 'stdout');
    const chunk = (i: number) => b(`line-${i}\n`);
    let offset = 0;
    const offsets = Array.from({ length: 20 }, (_, i) => { const o = offset; offset += chunk(i).length; return o; });
    const results = await Promise.all(offsets.map((o, i) => store.withLock(k, () => store.append(k, o, chunk(i)))));
    // Appends land in submission order because withLock is FIFO per key.
    expect(results.every((r) => r.kind === 'appended')).toBe(true);
    expect(readFileSync(join(root, k), 'utf8')).toBe(Array.from({ length: 20 }, (_, i) => `line-${i}\n`).join(''));
  });

  it('replace writes at most maxBytes, drains the rest of the source, and reports the bytes written', async () => {
    const k = logKey('j3', 1, 'stderr');
    await store.append(k, 0, b('old'));
    const written = await store.replace(k, Readable.from([b('0123456789'), b('abcdef')]), 12);
    expect(written).toBe(12);
    expect(readFileSync(join(root, k), 'utf8')).toBe('0123456789ab');
  });

  it('streams a whole object and deletes a prefix (absent prefix is a no-op)', async () => {
    const chunks: Buffer[] = [];
    for await (const c of await store.stream(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc\nde\n');
    await store.deletePrefix('logs/j1/1/');
    expect(existsSync(join(root, 'logs/j1/1'))).toBe(false);
    await expect(store.deletePrefix('logs/nope/1/')).resolves.toBeUndefined();
    await expect(store.size(key)).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/keyed-mutex.spec.ts src/fleet/logs/local-disk-log.store.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`log-store.ts`:

```ts
import type { Readable } from 'stream';
import { isLogStream, LogStreamName } from './domain/fleet-job-log.domain';

export const LOG_STORE = Symbol('LOG_STORE');

export type AppendResult =
  | { kind: 'appended'; size: number }
  | { kind: 'duplicate'; size: number } // offset + length <= size: these bytes are already stored
  | { kind: 'conflict'; size: number }; // a gap or a partial overlap

/**
 * Spec §1.1 (C6 split): append-only log bytes on disk; Postgres keeps only the FleetJobLog index row.
 * `append` and `replace` assume the caller holds `withLock(key)` (plan D311); they do not lock.
 */
export interface LogStore {
  append(key: string, offset: number, bytes: Buffer): Promise<AppendResult>;
  size(key: string): Promise<number>;
  read(key: string, from: number, to: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  replace(key: string, source: Readable, maxBytes: number): Promise<number>;
  deletePrefix(prefix: string): Promise<void>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Server-built key from validated parts only (spec §1.1). */
export function logKey(jobId: string, leaseEpoch: number, stream: LogStreamName): string {
  if (!ID_RE.test(jobId) || !Number.isInteger(leaseEpoch) || leaseEpoch < 0 || !isLogStream(stream)) {
    throw new Error(`invalid log key part: ${jobId}/${leaseEpoch}/${String(stream)}`);
  }
  return `logs/${jobId}/${leaseEpoch}/${stream}.log`;
}
```

`keyed-mutex.ts`:

```ts
/** Plan D311: FIFO critical sections per key, in-process (single API instance). */
export class KeyedMutex {
  private tails: ReadonlyMap<string, Promise<unknown>> = new Map();

  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn(), () => fn());
    const tail = result.then(() => undefined, () => undefined);
    this.tails = new Map([...this.tails, [key, tail]]);
    void tail.then(() => {
      if (this.tails.get(key) !== tail) return;
      const next = new Map(this.tails);
      next.delete(key);
      this.tails = next;
    });
    return result;
  }
}
```

`local-disk-log.store.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, open, rename, rm, stat } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { KeyedMutex } from './keyed-mutex';
import type { AppendResult, LogStore } from './log-store';

const KEY_RE = /^logs\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\/?$/;

@Injectable()
export class LocalDiskLogStore implements LogStore {
  private readonly root: string;
  private readonly mutex = new KeyedMutex();

  constructor(@Inject(FLEET_CFG) config: Pick<IFleetConfig, 'artifactDir'>) {
    this.root = resolve(config.artifactDir);
  }

  private pathFor(key: string): string {
    if (key.length > 256 || !KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`invalid log key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid log key: ${key}`);
    return full;
  }

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(key, fn);
  }

  async size(key: string): Promise<number> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async append(key: string, offset: number, bytes: Buffer): Promise<AppendResult> {
    const size = await this.size(key);
    if (offset === size) {
      const path = this.pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { kind: 'appended', size: size + bytes.length };
    }
    if (offset + bytes.length <= size) return { kind: 'duplicate', size };
    return { kind: 'conflict', size };
  }

  async read(key: string, from: number, to: number): Promise<Buffer> {
    const size = await this.size(key);
    const end = Math.min(to, size);
    if (end <= from) return Buffer.alloc(0);
    const handle = await open(this.pathFor(key), 'r');
    try {
      const buffer = Buffer.alloc(end - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async stream(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path);
    return createReadStream(path);
  }

  async replace(key: string, source: Readable, maxBytes: number): Promise<number> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    const out = createWriteStream(tmp, { mode: 0o600 });
    let written = 0;
    let failure: Error | null = null;
    out.on('error', (error) => { failure = error; });
    // Writes up to maxBytes and keeps reading (and dropping) the rest, so a tar entry stream always drains.
    const capped = new Writable({
      write(chunk: Buffer, _enc, done) {
        const room = maxBytes - written;
        if (room <= 0) return done();
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        written += part.length;
        if (out.write(part)) return done();
        out.once('drain', () => done());
        return undefined;
      },
      final(done) {
        out.end(() => done(failure));
      },
    });
    try {
      await pipeline(source, capped);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return written;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/keyed-mutex.spec.ts src/fleet/logs/local-disk-log.store.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-store.ts apps/api/src/fleet/logs/keyed-mutex.ts apps/api/src/fleet/logs/keyed-mutex.spec.ts apps/api/src/fleet/logs/local-disk-log.store.ts apps/api/src/fleet/logs/local-disk-log.store.spec.ts
git commit -m "feat(fleet): LogStore with exact-offset appends and a keyed mutex (S2a 1a)"
```

---

### Task 3: Protocol v3 accepted, octet-stream parser, capped body reader, runner byte rate

**Files:**
- Modify: `apps/api/src/fleet/common/protocol.ts:45-46`, `apps/api/src/fleet/common/protocol.spec.ts:23`
- Modify: `apps/api/src/common/hooks/bundle-content-parser.ts`, `apps/api/src/main.ts:20`
- Create: `apps/api/src/fleet/logs/read-capped-body.ts`, `apps/api/src/fleet/logs/read-capped-body.spec.ts`
- Create: `apps/api/src/fleet/logs/runner-byte-rate.ts`, `apps/api/src/fleet/logs/runner-byte-rate.spec.ts`
- Create: `apps/api/src/common/hooks/bundle-content-parser.spec.ts`

**Interfaces:**
- Produces: `readCappedBody(stream: Readable, maxBytes: number): Promise<{ ok: 'yes'; bytes: Buffer } | { ok: 'too_large' }>`;
  `RunnerByteRate` with `take(runnerId: string, bytes: number, nowMs: number): { ok: 'yes' } | { ok: 'no'; retryAfterMs: number }`;
  `registerLogContentParser(fastify)`.

- [ ] **Step 1: Write the failing tests**

`protocol.spec.ts` — replace the `it.each` row list on line 23 so 3 is accepted:

```ts
  it.each([[1, true], [2, true], [3, true], [0, false], [4, false], ['2', false], [1.5, false], [undefined, false]])(
```

`read-capped-body.spec.ts`:

```ts
import { Readable } from 'stream';
import { readCappedBody } from './read-capped-body';

describe('readCappedBody', () => {
  it('reads a body up to the cap', async () => {
    await expect(readCappedBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4)).resolves.toEqual({ ok: 'yes', bytes: Buffer.from('abcd') });
  });

  it('stops at the first byte past the cap, whatever Content-Length said', async () => {
    let pulled = 0;
    const source = Readable.from((function* () { for (let i = 0; i < 100; i += 1) { pulled += 1; yield Buffer.alloc(10); } })());
    await expect(readCappedBody(source, 25)).resolves.toEqual({ ok: 'too_large' });
    expect(pulled).toBeLessThan(100);
  });

  it('an empty body is an empty buffer', async () => {
    await expect(readCappedBody(Readable.from([]), 4)).resolves.toEqual({ ok: 'yes', bytes: Buffer.alloc(0) });
  });
});
```

`runner-byte-rate.spec.ts`:

```ts
import { RunnerByteRate } from './runner-byte-rate';

describe('RunnerByteRate', () => {
  const rate = () => new RunnerByteRate({ bytesPerSec: 1000, burstBytes: 1000 });

  it('lets a full burst through, then refuses with the wait for the deficit', () => {
    const r = rate();
    expect(r.take('a', 1000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('a', 500, 0)).toEqual({ ok: 'no', retryAfterMs: 500 });
    expect(r.take('a', 500, 500)).toEqual({ ok: 'yes' });
  });

  it('keeps one bucket per runner', () => {
    const r = rate();
    expect(r.take('a', 1000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('b', 1000, 0)).toEqual({ ok: 'yes' });
  });

  it('charges at most the burst for one request (a larger declared length waits for a full bucket)', () => {
    const r = rate();
    expect(r.take('a', 5000, 0)).toEqual({ ok: 'yes' });
    expect(r.take('a', 1000, 100)).toEqual({ ok: 'no', retryAfterMs: 900 });
  });
});
```

`bundle-content-parser.spec.ts`:

```ts
import { registerBundleContentParser, registerLogContentParser } from './bundle-content-parser';

describe('raw content parsers', () => {
  it('pass application/gzip and application/octet-stream through unbuffered', () => {
    const parsers = new Map<string, (req: unknown, payload: unknown, done: (e: Error | null, b?: unknown) => void) => void>();
    const fastify = { addContentTypeParser: (type: string, p: never) => { parsers.set(type, p); } };
    registerBundleContentParser(fastify);
    registerLogContentParser(fastify);
    const payload = { stream: true };
    for (const type of ['application/gzip', 'application/octet-stream']) {
      const done = jest.fn();
      parsers.get(type)?.({}, payload, done);
      expect(done).toHaveBeenCalledWith(null, payload);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/common/protocol.spec.ts src/fleet/logs/read-capped-body.spec.ts src/fleet/logs/runner-byte-rate.spec.ts src/common/hooks/bundle-content-parser.spec.ts`
Expected: FAIL (3 rejected as unsupported; modules and export not found).

- [ ] **Step 3: Implement**

`protocol.ts` line 46:

```ts
export const SUPPORTED_FLEET_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1, 2, 3]);
```

and extend the comment above it: `v3 (S2a): the runner streams logs over PUT .../logs/:stream instead of log events.`

`bundle-content-parser.ts` — append:

```ts
/** Fleet log uploads (S2a §2.2): raw stream; LogUploadService counts the bytes itself (plan D312). */
export function registerLogContentParser(fastify: FastifyLike): void {
  fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
}
```

`main.ts`: import `registerLogContentParser` beside `registerBundleContentParser` and call
`registerLogContentParser(fastify);` on the line after `registerBundleContentParser(fastify);`.

`read-capped-body.ts`:

```ts
import type { Readable } from 'stream';

/** Spec §2.2 step 5: Fastify does not meter a raw stream, so count here and stop at the first byte past the cap. */
export async function readCappedBody(stream: Readable, maxBytes: number): Promise<{ ok: 'yes'; bytes: Buffer } | { ok: 'too_large' }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      return { ok: 'too_large' };
    }
    chunks.push(buffer);
  }
  return { ok: 'yes', bytes: Buffer.concat(chunks, total) };
}
```

`runner-byte-rate.ts`:

```ts
interface Bucket {
  readonly tokens: number;
  readonly atMs: number;
}

/** Spec §2.2.1, plan D312: per-runner token bucket, in-process. */
export class RunnerByteRate {
  private buckets: ReadonlyMap<string, Bucket> = new Map();

  constructor(private readonly opts: { bytesPerSec: number; burstBytes: number }) {}

  take(runnerId: string, bytes: number, nowMs: number): { ok: 'yes' } | { ok: 'no'; retryAfterMs: number } {
    const { bytesPerSec, burstBytes } = this.opts;
    const charge = Math.min(Math.max(bytes, 0), burstBytes);
    const previous = this.buckets.get(runnerId) ?? { tokens: burstBytes, atMs: nowMs };
    const tokens = Math.min(burstBytes, previous.tokens + ((nowMs - previous.atMs) * bytesPerSec) / 1000);
    if (tokens < charge) {
      this.buckets = new Map([...this.buckets, [runnerId, { tokens, atMs: nowMs }]]);
      return { ok: 'no', retryAfterMs: Math.ceil(((charge - tokens) * 1000) / bytesPerSec) };
    }
    this.buckets = new Map([...this.buckets, [runnerId, { tokens: tokens - charge, atMs: nowMs }]]);
    return { ok: 'yes' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/common/protocol.ts apps/api/src/fleet/common/protocol.spec.ts apps/api/src/common/hooks apps/api/src/main.ts apps/api/src/fleet/logs/read-capped-body.ts apps/api/src/fleet/logs/read-capped-body.spec.ts apps/api/src/fleet/logs/runner-byte-rate.ts apps/api/src/fleet/logs/runner-byte-rate.spec.ts
git commit -m "feat(fleet): accept protocol v3, octet-stream parser, capped body and runner byte rate (S2a 1a)"
```

---

### Task 4: `fleet_log` live event and the coalescing publisher

**Files:**
- Modify: `apps/api/src/live/live-event.ts`
- Create: `apps/api/src/fleet/logs/fleet-log-live.publisher.ts`, `apps/api/src/fleet/logs/fleet-log-live.publisher.spec.ts`

**Interfaces:**
- Consumes: `ProjectEventBus.publish(event: LiveEvent)`; `LogStreamName`.
- Produces: `LiveFleetLogEvent`; `FleetLogLivePublisher.touch(input: LogTouch, immediate: boolean): void` with
  `LogTouch = { projectId: string; jobId: string; leaseEpoch: number; stream: LogStreamName; size: number; complete: boolean }`.

- [ ] **Step 1: Write the failing test**

`fleet-log-live.publisher.spec.ts`:

```ts
import { FleetLogLivePublisher, LogTouch } from './fleet-log-live.publisher';

describe('FleetLogLivePublisher', () => {
  const bus = { publish: jest.fn() };
  const touch = (size: number, over: Partial<LogTouch> = {}): LogTouch => ({ projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size, complete: false, ...over });
  let pub: FleetLogLivePublisher;

  beforeEach(() => {
    jest.useFakeTimers();
    pub = new FleetLogLivePublisher(bus as never);
  });
  afterEach(() => {
    pub.onModuleDestroy();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  const sizes = () => bus.publish.mock.calls.map(([e]) => e.size);

  it('publishes the first touch at once, then at most one per second with the latest size (trailing edge)', () => {
    pub.touch(touch(10), false);
    pub.touch(touch(20), false);
    pub.touch(touch(30), false);
    expect(sizes()).toEqual([10]);
    jest.advanceTimersByTime(1000);
    expect(sizes()).toEqual([10, 30]);
    jest.advanceTimersByTime(1000);
    expect(sizes()).toEqual([10, 30]); // nothing pending: no repeat
    expect(pub.pendingKeys).toBe(0);
  });

  it('an immediate touch publishes now and cancels the pending trailing one', () => {
    pub.touch(touch(10), false);
    pub.touch(touch(20), false);
    pub.touch(touch(25, { complete: true }), true);
    jest.advanceTimersByTime(5000);
    expect(sizes()).toEqual([10, 25]);
    expect(bus.publish.mock.calls[1][0]).toMatchObject({ type: 'fleet_log', complete: true });
  });

  it('keys by job, epoch and stream; every event has a fresh id', () => {
    pub.touch(touch(1), false);
    pub.touch(touch(1, { stream: 'stdout' }), false);
    pub.touch(touch(1, { leaseEpoch: 2 }), false);
    expect(bus.publish).toHaveBeenCalledTimes(3);
    const ids = bus.publish.mock.calls.map(([e]) => e.id);
    expect(new Set(ids).size).toBe(3);
    expect(bus.publish.mock.calls[0][0]).toEqual({ id: ids[0], type: 'fleet_log', projectId: 'p1', jobId: 'j1', leaseEpoch: 1, stream: 'run', size: 1, complete: false, at: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-log-live.publisher.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`live-event.ts` — add after `LiveFleetApprovalEvent` and extend the union (update the header comment: `fleet_log` since
fleet S2a):

```ts
/**
 * Fleet S2a (spec §2.3): content-free log growth; the viewer fetches from its cursor.
 * `id` is fresh per publish (clients dedupe by id).
 */
export interface LiveFleetLogEvent {
  id: string;
  type: 'fleet_log';
  projectId: string;
  jobId: string;
  leaseEpoch: number;
  stream: 'run' | 'stdout' | 'stderr';
  size: number;
  complete: boolean;
  at: string;
}

export type LiveEvent = LiveTicketEvent | LiveFleetJobEvent | LiveFleetApprovalEvent | LiveFleetLogEvent;
```

(Replace the existing `LiveEvent` line.)

`fleet-log-live.publisher.ts`:

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetLogEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { LogStreamName } from './domain/fleet-job-log.domain';

export interface LogTouch {
  projectId: string;
  jobId: string;
  leaseEpoch: number;
  stream: LogStreamName;
  size: number;
  complete: boolean;
}

interface Slot {
  readonly timer: NodeJS.Timeout;
  readonly pending: LogTouch | null;
}

const WINDOW_MS = 1000;

/** Spec §2.3: at most one fleet_log per (job, epoch, stream) per second, trailing edge; immediate on final/cap/fallback. */
@Injectable()
export class FleetLogLivePublisher implements OnModuleDestroy {
  private slots: ReadonlyMap<string, Slot> = new Map();

  constructor(private readonly bus: ProjectEventBus) {}

  get pendingKeys(): number {
    return this.slots.size;
  }

  touch(input: LogTouch, immediate: boolean): void {
    const key = `${input.jobId}:${input.leaseEpoch}:${input.stream}`;
    const slot = this.slots.get(key);
    if (immediate) {
      if (slot) clearTimeout(slot.timer);
      this.setSlot(key, null);
      this.emit(input);
      return;
    }
    if (slot) {
      this.setSlot(key, { ...slot, pending: input });
      return;
    }
    this.emit(input);
    this.setSlot(key, { timer: this.arm(key), pending: null });
  }

  onModuleDestroy(): void {
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots = new Map();
  }

  private arm(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.flush(key), WINDOW_MS);
    timer.unref?.();
    return timer;
  }

  private flush(key: string): void {
    const slot = this.slots.get(key);
    if (!slot?.pending) {
      this.setSlot(key, null);
      return;
    }
    this.emit(slot.pending);
    this.setSlot(key, { timer: this.arm(key), pending: null });
  }

  private setSlot(key: string, slot: Slot | null): void {
    const next = new Map(this.slots);
    if (slot) next.set(key, slot);
    else next.delete(key);
    this.slots = next;
  }

  private emit(t: LogTouch): void {
    const event: LiveFleetLogEvent = {
      id: randomUUID(), type: 'fleet_log', projectId: t.projectId, jobId: t.jobId, leaseEpoch: t.leaseEpoch,
      stream: t.stream, size: t.size, complete: t.complete, at: new Date().toISOString(),
    };
    this.bus.publish(event);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/fleet-log-live.publisher.spec.ts src/live`
Expected: PASS (the existing live specs still pass with the widened union).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/live/live-event.ts apps/api/src/fleet/logs/fleet-log-live.publisher.ts apps/api/src/fleet/logs/fleet-log-live.publisher.spec.ts
git commit -m "feat(fleet): fleet_log live event with a one-second coalescing publisher (S2a 1a)"
```

---

### Task 5: `LogUploadService` — fence, state, rate, body, exact-offset append, cap, final

**Files:**
- Create: `apps/api/src/fleet/logs/log-upload.exceptions.ts`
- Create: `apps/api/src/fleet/logs/log-upload.service.ts`, `apps/api/src/fleet/logs/log-upload.service.spec.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`

**Interfaces:**
- Consumes: `IFleetJobRepository.findById/lockById` (`FLEET_JOB_REPOSITORY`), `FenceService.holds/abandon`,
  `TRANSACTION_MANAGER`, `LOG_STORE`/`LogStore`, `logKey`, `FLEET_JOB_LOG_REPOSITORY`, `readCappedBody`,
  `RunnerByteRate`, `FleetLogLivePublisher.touch`, `FleetFenceException` (`../artifacts/bundle.exceptions`),
  `ConflictAppException`, `FLEET_CFG` (`logMaxBytes`, `logChunkMaxBytes`, `logRunnerBytesPerSec`).
- Produces: `LogUploadService.upload(u: LogUpload): Promise<LogUploadResult>` with

```ts
export interface LogUpload {
  runnerId: string;
  jobId: string;
  streamRaw: string;
  leaseEpochRaw: string | undefined;
  offsetRaw: string | undefined;
  finalRaw: string | undefined;
  sha256Header: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}
export type LogUploadOutcome = 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';
export interface LogUploadResult { outcome: LogUploadOutcome; size: number; retryAfterMs?: number }
```

- [ ] **Step 1: Write the failing test**

`log-upload.service.spec.ts` (real `LocalDiskLogStore` on a temp dir, in-memory fakes for the rest):

```ts
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import type { FleetJobLogRecord, LogStreamName, LogStreamPatch } from './domain/fleet-job-log.domain';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { FleetLogException } from './log-upload.exceptions';
import { LogUpload, LogUploadService } from './log-upload.service';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

class MemoryLogRepo {
  rows: ReadonlyMap<string, FleetJobLogRecord> = new Map();
  private k = (j: string, e: number, s: string) => `${j}:${e}:${s}`;
  async findStream(j: string, e: number, s: LogStreamName) { return this.rows.get(this.k(j, e, s)) ?? null; }
  async upsertStream(j: string, e: number, s: LogStreamName, p: LogStreamPatch) {
    const prev = this.rows.get(this.k(j, e, s));
    const row: FleetJobLogRecord = {
      id: prev?.id ?? `${j}-${e}-${s}`, jobId: j, leaseEpoch: e, stream: s, source: prev?.source ?? 'stream', expiredAt: null,
      createdAt: new Date(0), updatedAt: new Date(0), complete: p.complete ?? prev?.complete ?? false,
      truncated: p.truncated ?? prev?.truncated ?? false, sizeBytes: p.sizeBytes,
    };
    this.rows = new Map([...this.rows, [this.k(j, e, s), row]]);
    return row;
  }
}

describe('LogUploadService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-log-upload-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const cfg = { logMaxBytes: 32, logChunkMaxBytes: 16, logRunnerBytesPerSec: 1_000_000 };
  let job: { id: string; projectId: string; runnerId: string | null; leaseEpoch: number; state: string };
  const jobs = { findById: jest.fn(async () => job), lockById: jest.fn(async () => job) };
  const fence = { holds: jest.fn((j: typeof job, r: string, e: number) => j.runnerId === r && j.leaseEpoch === e), abandon: jest.fn() };
  const tx = { run: jest.fn((fn: () => unknown) => fn()) };
  const live = { touch: jest.fn() };
  let logs: MemoryLogRepo;
  let svc: LogUploadService;
  let n = 0;

  beforeEach(() => {
    n += 1;
    job = { id: `job${n}`, projectId: 'p1', runnerId: 'r1', leaseEpoch: 1, state: 'RUNNING' };
    logs = new MemoryLogRepo();
    svc = new LogUploadService(jobs as never, fence as never, tx as never, store, logs as never, live as never, cfg as never);
  });
  afterEach(() => jest.clearAllMocks());

  const up = (body: string, over: Partial<LogUpload> = {}) => {
    const bytes = Buffer.from(body);
    return svc.upload({
      runnerId: 'r1', jobId: job.id, streamRaw: 'run', leaseEpochRaw: '1', offsetRaw: '0', finalRaw: undefined,
      sha256Header: sha(bytes), contentLength: String(bytes.length), body: Readable.from([bytes]), ...over,
    });
  };
  const file = () => readFileSync(join(root, logKey(job.id, 1, 'run')), 'utf8');

  it('appends at the current size, then answers duplicate and offset with the server size', async () => {
    await expect(up('abc\n')).resolves.toEqual({ outcome: 'appended', size: 4 });
    await expect(up('abc\n')).resolves.toEqual({ outcome: 'duplicate', size: 4 }); // Review Focus 1
    await expect(up('x', { offsetRaw: '9' })).resolves.toEqual({ outcome: 'offset', size: 4 });
    await expect(up('de\n', { offsetRaw: '4' })).resolves.toEqual({ outcome: 'appended', size: 7 });
    expect(file()).toBe('abc\nde\n');
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ sizeBytes: 7, complete: false });
    expect(live.touch).toHaveBeenLastCalledWith({ projectId: 'p1', jobId: job.id, leaseEpoch: 1, stream: 'run', size: 7, complete: false }, false);
  });

  it('accepts ASSIGNED and UPLOADING; refuses a terminal job with 409 jobState (R2)', async () => {
    job = { ...job, state: 'ASSIGNED' };
    await expect(up('a')).resolves.toMatchObject({ outcome: 'appended' });
    job = { ...job, state: 'UPLOADING' };
    await expect(up('b', { offsetRaw: '1' })).resolves.toMatchObject({ outcome: 'appended' });
    job = { ...job, state: 'COMPLETED' };
    await expect(up('c', { offsetRaw: '2' })).rejects.toBeInstanceOf(ConflictAppException);
  });

  it('a stale lease queues ABANDON under the row lock and throws the fence 409 (D310)', async () => {
    await expect(up('a', { leaseEpochRaw: '0' })).rejects.toBeInstanceOf(FleetFenceException);
    expect(jobs.lockById).toHaveBeenCalledWith(job.id);
    expect(fence.abandon).toHaveBeenCalledWith('r1', job, 0);
  });

  it('final=1 at the end marks the stream complete; later uploads answer complete (D314)', async () => {
    await up('abc\n');
    await expect(up('', { offsetRaw: '4', finalRaw: '1' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ complete: true });
    expect(live.touch).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true }), true);
    await expect(up('', { offsetRaw: '4', finalRaw: '1' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    await expect(up('z', { offsetRaw: '4' })).resolves.toEqual({ outcome: 'complete', size: 4 });
    expect(file()).toBe('abc\n');
  });

  it('final=1 at the wrong offset answers offset and does not complete', async () => {
    await up('abc\n');
    await expect(up('', { offsetRaw: '2', finalRaw: '1' })).resolves.toEqual({ outcome: 'offset', size: 4 });
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ complete: false });
  });

  it('cuts a chunk at the cap, marks truncated, and answers stream_cap again on retry (D315, Review Focus 2)', async () => {
    await up('0123456789abcdef'); // 16
    const tail = '0123456789ABCDEFGHIJ'.slice(0, 16);
    await expect(up(tail, { offsetRaw: '16' })).resolves.toEqual({ outcome: 'appended', size: 32 });
    await expect(up('more', { offsetRaw: '32' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    const before = file();
    await expect(up('more', { offsetRaw: '32' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    expect(file()).toBe(before);
    expect(await logs.findStream(job.id, 1, 'run')).toMatchObject({ truncated: true, complete: false, sizeBytes: 32 });
  });

  it('a chunk straddling the cap keeps only the bytes that fit', async () => {
    await up('0123456789abcdef');
    await up('0123456789', { offsetRaw: '16' }); // 26
    await expect(up('ABCDEFGHIJ', { offsetRaw: '26' })).resolves.toEqual({ outcome: 'stream_cap', size: 32 });
    expect(file().slice(26)).toBe('ABCDEF');
  });

  it('refuses a body past the chunk max by counting, not by Content-Length (413)', async () => {
    const big = 'x'.repeat(17);
    expect(await statusOf(up(big, { contentLength: '3' }))).toBe(413);
  });

  it('refuses a SHA mismatch (422) and bad input (400) before touching the store', async () => {
    await expect(up('abc', { sha256Header: sha(Buffer.from('zzz')) })).rejects.toBeInstanceOf(FleetLogException);
    expect(await statusOf(up('abc', { streamRaw: 'prompt' }))).toBe(400);
    expect(await statusOf(up('abc', { offsetRaw: '-1' }))).toBe(400);
    expect(await statusOf(up('abc', { finalRaw: 'yes' }))).toBe(400);
    expect(await statusOf(up('', {}))).toBe(400); // empty and not final
    expect(await statusOf(up('abc', { sha256Header: 'nope' }))).toBe(400);
    expect(await logs.findStream(job.id, 1, 'run')).toBeNull();
  });

  it('answers rate_limited with a wait before reading the body (D312)', async () => {
    svc = new LogUploadService(jobs as never, fence as never, tx as never, store, logs as never, live as never, { ...cfg, logRunnerBytesPerSec: 1 } as never);
    await expect(up('0123456789abcdef')).resolves.toMatchObject({ outcome: 'appended' });
    const res = await up('a', { offsetRaw: '16' });
    expect(res.outcome).toBe('rate_limited');
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-upload.service.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`log-upload.exceptions.ts`:

```ts
import { AppException } from '@nathapp/nestjs-common';

/** Plan D319: 413 chunk too large, 422 SHA mismatch, 507 storage failure. */
export class FleetLogException extends AppException {
  constructor(status: 413 | 422 | 507, args: Record<string, unknown> = {}) {
    const key = status === 413 ? 'fleet.logChunk' : status === 422 ? 'fleet.logHash' : 'fleet.logStorage';
    super(status, args, key, status);
  }
}
```

i18n `en/fleet.json` — add keys (keep the file's existing shape and ordering style):

```json
  "logInput": { "-2": "Invalid log upload: {reason}" },
  "logChunk": { "413": "Log chunk larger than {maxBytes} bytes" },
  "logHash": { "422": "Log chunk rejected: sha256 mismatch" },
  "logStorage": { "507": "The server could not store the log chunk" },
```

`zh/fleet.json` — the same keys:

```json
  "logInput": { "-2": "无效的日志上传：{reason}" },
  "logChunk": { "413": "日志块超过 {maxBytes} 字节" },
  "logHash": { "422": "日志块被拒绝：sha256 不匹配" },
  "logStorage": { "507": "服务器无法保存日志块" },
```

If an i18n parity spec exists for the API (`grep -rl "fleet.json" apps/api/src apps/api/test`), run it in Step 4.

`log-upload.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { Readable } from 'stream';
import { FleetJobState } from '../../common/enums';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FenceService } from '../sync/fence.service';
import { FLEET_JOB_LOG_REPOSITORY, IFleetJobLogRepository, isLogStream, LogStreamName } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LOG_STORE, LogStore, logKey } from './log-store';
import { FleetLogException } from './log-upload.exceptions';
import { readCappedBody } from './read-capped-body';
import { RunnerByteRate } from './runner-byte-rate';

export interface LogUpload {
  runnerId: string;
  jobId: string;
  streamRaw: string;
  leaseEpochRaw: string | undefined;
  offsetRaw: string | undefined;
  finalRaw: string | undefined;
  sha256Header: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

export type LogUploadOutcome = 'appended' | 'duplicate' | 'offset' | 'complete' | 'stream_cap' | 'rate_limited';

export interface LogUploadResult {
  outcome: LogUploadOutcome;
  size: number;
  retryAfterMs?: number;
}

const UPLOAD_STATES: readonly string[] = [FleetJobState.ASSIGNED, FleetJobState.RUNNING, FleetJobState.UPLOADING];
const SHA256_RE = /^[0-9a-f]{64}$/i;
const NON_NEG_INT = /^(0|[1-9][0-9]{0,15})$/;

type Cfg = Pick<IFleetConfig, 'logMaxBytes' | 'logChunkMaxBytes' | 'logRunnerBytesPerSec'>;

interface Parsed {
  stream: LogStreamName;
  leaseEpoch: number;
  offset: number;
  final: boolean;
  sha256: string;
}

@Injectable()
export class LogUploadService {
  private readonly rate: RunnerByteRate;

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById' | 'lockById'>,
    private readonly fence: FenceService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: IFleetJobLogRepository,
    private readonly live: FleetLogLivePublisher,
    @Inject(FLEET_CFG) private readonly cfg: Cfg,
  ) {
    this.rate = new RunnerByteRate({ bytesPerSec: cfg.logRunnerBytesPerSec, burstBytes: cfg.logChunkMaxBytes });
  }

  /** Spec §2.2, plan D307: protocol outcomes are 200 results; errors are thrown. */
  async upload(u: LogUpload): Promise<LogUploadResult> {
    const p = this.parse(u);
    const declared = Number(u.contentLength);
    const charge = Number.isInteger(declared) && declared >= 0 ? declared : this.cfg.logChunkMaxBytes;
    const allowed = this.rate.take(u.runnerId, charge, Date.now());
    if (allowed.ok === 'no') {
      u.body.resume();
      return { outcome: 'rate_limited', size: -1, retryAfterMs: allowed.retryAfterMs };
    }
    const job = await this.assertHolder(u.runnerId, u.jobId, p.leaseEpoch);
    const read = await readCappedBody(u.body, this.cfg.logChunkMaxBytes);
    if (read.ok === 'too_large') throw new FleetLogException(413, { maxBytes: this.cfg.logChunkMaxBytes });
    const bytes = read.bytes;
    if (bytes.length === 0 && !p.final) throw new ValidationAppException({ reason: 'empty body' }, 'fleet.logInput');
    if (createHash('sha256').update(bytes).digest('hex') !== p.sha256.toLowerCase()) throw new FleetLogException(422);

    const key = logKey(job.id, p.leaseEpoch, p.stream);
    const result = await this.store.withLock(key, () => this.write(job.id, key, p, bytes));
    if (result.outcome === 'appended' || result.outcome === 'complete' || result.outcome === 'stream_cap') {
      const immediate = result.outcome !== 'appended';
      this.live.touch({ projectId: job.projectId, jobId: job.id, leaseEpoch: p.leaseEpoch, stream: p.stream, size: result.size, complete: result.outcome === 'complete' }, immediate);
    }
    return result;
  }

  private async write(jobId: string, key: string, p: Parsed, bytes: Buffer): Promise<LogUploadResult> {
    const row = await this.logs.findStream(jobId, p.leaseEpoch, p.stream);
    const size = await this.store.size(key);
    if (row?.complete) return { outcome: 'complete', size };
    if (row?.truncated) return { outcome: 'stream_cap', size };
    try {
      if (p.offset + bytes.length > this.cfg.logMaxBytes) {
        const fit = bytes.subarray(0, Math.max(0, this.cfg.logMaxBytes - p.offset));
        const r = fit.length > 0 ? await this.store.append(key, p.offset, fit) : { kind: p.offset <= size ? ('duplicate' as const) : ('conflict' as const), size };
        if (r.kind === 'conflict') return { outcome: 'offset', size: r.size };
        await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size, truncated: true });
        return { outcome: 'stream_cap', size: r.size };
      }
      const r = bytes.length > 0 ? await this.store.append(key, p.offset, bytes) : { kind: p.offset === size ? ('duplicate' as const) : ('conflict' as const), size };
      if (r.kind === 'conflict') return { outcome: 'offset', size: r.size };
      if (p.final) {
        if (r.size !== p.offset + bytes.length) return { outcome: 'offset', size: r.size };
        await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size, complete: true });
        return { outcome: 'complete', size: r.size };
      }
      await this.logs.upsertStream(jobId, p.leaseEpoch, p.stream, { sizeBytes: r.size });
      return { outcome: r.kind, size: r.size };
    } catch (error) {
      if (error instanceof FleetLogException) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EIO' || code === 'EROFS') throw new FleetLogException(507);
      throw error;
    }
  }

  private parse(u: LogUpload): Parsed {
    const bad = (reason: string) => new ValidationAppException({ reason }, 'fleet.logInput');
    if (!isLogStream(u.streamRaw)) throw bad('stream');
    if (!NON_NEG_INT.test(u.leaseEpochRaw ?? '')) throw bad('leaseEpoch');
    if (!NON_NEG_INT.test(u.offsetRaw ?? '')) throw bad('offset');
    if (u.finalRaw !== undefined && u.finalRaw !== '1') throw bad('final');
    if (!SHA256_RE.test(u.sha256Header ?? '')) throw bad('X-Content-SHA256');
    return { stream: u.streamRaw, leaseEpoch: Number(u.leaseEpochRaw), offset: Number(u.offsetRaw), final: u.finalRaw === '1', sha256: u.sha256Header as string };
  }

  /** Plan D310: unlocked read on the hot path; lock + ABANDON only when the fence fails. */
  private async assertHolder(runnerId: string, jobId: string, leaseEpoch: number) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    if (!this.fence.holds(job, runnerId, leaseEpoch)) {
      const fenced = await this.txManager.run(async () => {
        const locked = await this.jobs.lockById(jobId);
        if (locked && !this.fence.holds(locked, runnerId, leaseEpoch)) {
          await this.fence.abandon(runnerId, locked, leaseEpoch);
          return true;
        }
        return locked === null;
      });
      if (fenced) throw new FleetFenceException();
    }
    if (!UPLOAD_STATES.includes(job.state)) throw new ConflictAppException({ state: job.state }, 'fleet.jobState');
    return job;
  }
}
```

Notes for the implementer: if the fence passes on the re-check (the lease moved back is impossible, but a missing
row is), the code above treats a vanished job as fenced; that is intended. `FleetJobState.ASSIGNED` exists in
`src/common/enums.ts`; if the enum spells it differently, stop and report (plan defect).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-upload.service.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-upload.exceptions.ts apps/api/src/fleet/logs/log-upload.service.ts apps/api/src/fleet/logs/log-upload.service.spec.ts apps/api/src/i18n
git commit -m "feat(fleet): log upload service with exact offsets, cap, final and rate (S2a 1a)"
```

---

### Task 6: Upload controller, `LogsModule`, `ArtifactStoreModule`, HTTP integration

**Files:**
- Create: `apps/api/src/fleet/artifacts/artifact-store.module.ts`
- Modify: `apps/api/src/fleet/artifacts/artifacts.module.ts`
- Create: `apps/api/src/fleet/logs/log-upload.controller.ts`, `apps/api/src/fleet/logs/logs.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts`
- Test: `apps/api/test/integration/fleet/fleet-log-upload.integration.spec.ts`

**Interfaces:**
- Consumes: `LogUploadService.upload`, `requestStream(req)` from `../artifacts/bundle-upload.controller`.
- Produces: `PUT /api/fleet/runner/jobs/:jobId/logs/:stream` answering `{ ret?, data: LogUploadResult }` via
  `JsonResponse.Ok`; `LogsModule` exporting `LOG_STORE`, `FLEET_JOB_LOG_REPOSITORY`, `FleetLogLivePublisher` (Task 9
  adds `LogFallbackService` to its exports).

- [ ] **Step 1: Write the failing integration test**

`fleet-log-upload.integration.spec.ts`:

```ts
/**
 * Fleet S2a slice 1a — log upload route over HTTP (PG), spec §2.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-upload.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_LOG_MAX_BYTES', 'FLEET_LOG_CHUNK_MAX_BYTES'] as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet log upload (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved: Record<string, string | undefined> = {};
  const events: LiveEvent[] = [];

  const job = (feature: string, state: string, leaseEpoch = 1) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state, runnerId: runner.runnerId, leaseEpoch,
    },
  });
  const put = (jobId: string, body: Buffer, q: { stream?: string; epoch?: number; offset?: number; final?: boolean } = {}) =>
    request(server)
      .put(`/api/fleet/runner/jobs/${jobId}/logs/${q.stream ?? 'run'}?leaseEpoch=${q.epoch ?? 1}&offset=${q.offset ?? 0}${q.final ? '&final=1' : ''}`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(body) })
      .send(body);

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-log-upload-'));
    process.env.FLEET_LOG_MAX_BYTES = '64';
    process.env.FLEET_LOG_CHUNK_MAX_BYTES = '32';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-logs');
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => { events.push(e); });
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('appends, dedupes, completes and indexes a stream; publishes fleet_log', async () => {
    const j = await job('ok', 'RUNNING');
    expect((await put(j.id, Buffer.from('a\nb\n')).expect(200)).body.data).toEqual({ outcome: 'appended', size: 4 });
    expect((await put(j.id, Buffer.from('a\nb\n')).expect(200)).body.data).toEqual({ outcome: 'duplicate', size: 4 });
    expect((await put(j.id, Buffer.from('zz'), { offset: 9 }).expect(200)).body.data).toEqual({ outcome: 'offset', size: 4 });
    expect((await put(j.id, Buffer.alloc(0), { offset: 4, final: true }).expect(200)).body.data).toEqual({ outcome: 'complete', size: 4 });
    const file = join(process.env.FLEET_ARTIFACT_DIR as string, 'logs', j.id, '1', 'run.log');
    expect(readFileSync(file, 'utf8')).toBe('a\nb\n');
    expect(await prisma.fleetJobLog.findUniqueOrThrow({ where: { jobId_leaseEpoch_stream: { jobId: j.id, leaseEpoch: 1, stream: 'run' } } }))
      .toMatchObject({ sizeBytes: 4n, complete: true, source: 'stream' });
    expect(events.filter((e) => e.type === 'fleet_log' && e.jobId === j.id).at(-1)).toMatchObject({ size: 4, complete: true });
  });

  it('fences a stale epoch (409 + ABANDON) and refuses a terminal job (409); accepts ASSIGNED', async () => {
    const stale = await job('fence', 'RUNNING', 2);
    await put(stale.id, Buffer.from('x'), { epoch: 1 }).expect(409);
    expect(await prisma.fleetCommand.count({ where: { jobId: stale.id, type: 'ABANDON' } })).toBe(1);
    await put((await job('done', 'COMPLETED')).id, Buffer.from('x')).expect(409);
    await put((await job('assigned', 'ASSIGNED')).id, Buffer.from('x')).expect(200);
  });

  it('413 past the chunk max, 422 on a bad hash, 400 on input, never throttled', async () => {
    const j = await job('errs', 'RUNNING');
    await put(j.id, Buffer.alloc(33)).expect(413);
    const body = Buffer.from('abc');
    await request(server).put(`/api/fleet/runner/jobs/${j.id}/logs/run?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(Buffer.from('nope')) })
      .send(body).expect(422);
    await put(j.id, body, { stream: 'prompt' }).expect(400);
    for (let i = 0; i < 120; i += 1) await put(j.id, Buffer.from('k')).expect(200); // > 100 req/min global limit
  });

  it('cuts at the stream cap and answers stream_cap', async () => {
    const j = await job('cap', 'RUNNING');
    await put(j.id, Buffer.alloc(32, 'a')).expect(200);
    await put(j.id, Buffer.alloc(30, 'b'), { offset: 32 }).expect(200);
    expect((await put(j.id, Buffer.alloc(10, 'c'), { offset: 62 }).expect(200)).body.data).toEqual({ outcome: 'stream_cap', size: 64 });
    expect((await prisma.fleetJobLog.findFirstOrThrow({ where: { jobId: j.id } })).truncated).toBe(true);
  });

  it('refuses a user token and an agent token on the runner route', async () => {
    const j = await job('auth', 'RUNNING');
    await request(server).put(`/api/fleet/runner/jobs/${j.id}/logs/run?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${world.tokens.dev}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(Buffer.from('x')) })
      .send(Buffer.from('x')).expect((res) => expect([401, 403]).toContain(res.status));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-upload.integration.spec.ts`
Expected: FAIL — 404 on the route.

- [ ] **Step 3: Implement**

`artifact-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ARTIFACT_STORE } from './artifact-store';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

/** Plan D309: the artifact store on its own so the logs module can read bundles without importing ArtifactsModule. */
@Module({
  providers: [LocalDiskArtifactStore, { provide: ARTIFACT_STORE, useExisting: LocalDiskArtifactStore }],
  exports: [ARTIFACT_STORE],
})
export class ArtifactStoreModule {}
```

`artifacts.module.ts` — import `ArtifactStoreModule` (and, in Task 9, `LogsModule`); remove `LocalDiskArtifactStore`
and the `ARTIFACT_STORE` provider from `providers`:

```ts
@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule, FleetJobsModule, SyncModule, ArtifactStoreModule],
  controllers: [BundleUploadController, JobBundleController],
  providers: [BundleService],
})
export class ArtifactsModule {}
```

Check that `FLEET_CFG` is resolvable inside `ArtifactStoreModule` the same way it was inside `ArtifactsModule` (the
config is registered globally in `app.module.ts`; if it is not global, add the same import `ArtifactsModule` used).

`log-upload.controller.ts`:

```ts
import { Controller, Headers, HttpCode, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { SkipThrottle } from '@nathapp/nestjs-throttler';
import { RunnerRoute } from '../../auth/guards/runner-route.decorator';
import type { RunnerPrincipal } from '../../auth/principal/koda-principal.types';
import { requestStream } from '../artifacts/bundle-upload.controller';
import { LogUploadService } from './log-upload.service';

@ApiTags('fleet-runner')
@ApiBearerAuth()
@RunnerRoute()
@SkipThrottle() // S2a §2.2: runner-key authenticated; its own byte rate applies (plan D312)
@Controller('fleet/runner/jobs')
export class LogUploadController {
  constructor(private readonly uploads: LogUploadService) {}

  @Put(':jobId/logs/:stream')
  @HttpCode(200)
  @ApiConsumes('application/octet-stream')
  @ApiOperation({ summary: 'Append bytes to a log stream of the held attempt at an exact offset (S2a §2.2)' })
  @ApiResponse({ status: 200, description: '{ outcome: appended|duplicate|offset|complete|stream_cap|rate_limited, size, retryAfterMs? }' })
  @ApiResponse({ status: 400, description: 'Invalid stream, leaseEpoch, offset, final, X-Content-SHA256, or an empty non-final body' })
  @ApiResponse({ status: 409, description: 'Stale lease (ABANDON queued) or the job is in a terminal state' })
  @ApiResponse({ status: 413, description: 'Body larger than FLEET_LOG_CHUNK_MAX_BYTES' })
  @ApiResponse({ status: 422, description: 'X-Content-SHA256 mismatch' })
  @ApiResponse({ status: 507, description: 'The server could not store the bytes' })
  async append(
    @Principal() runner: RunnerPrincipal,
    @Param('jobId') jobId: string,
    @Param('stream') stream: string,
    @Query('leaseEpoch') leaseEpoch: string,
    @Query('offset') offset: string,
    @Query('final') final: string | undefined,
    @Headers('x-content-sha256') sha256: string,
    @Headers('content-length') contentLength: string,
    @Req() req: unknown,
  ) {
    return JsonResponse.Ok(await this.uploads.upload({
      runnerId: runner.id, jobId, streamRaw: stream, leaseEpochRaw: leaseEpoch, offsetRaw: offset, finalRaw: final,
      sha256Header: sha256, contentLength, body: requestStream(req),
    }));
  }
}
```

`logs.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { SyncModule } from '../sync/sync.module';
import { FLEET_JOB_LOG_REPOSITORY } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LocalDiskLogStore } from './local-disk-log.store';
import { LOG_STORE } from './log-store';
import { LogUploadController } from './log-upload.controller';
import { LogUploadService } from './log-upload.service';
import { PrismaFleetJobLogRepository } from './prisma-fleet-job-log.repository';

/** Fleet S2a (spec docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md). */
@Module({
  imports: [PrismaModule, LiveModule, FleetJobsModule, SyncModule],
  controllers: [LogUploadController],
  providers: [
    LocalDiskLogStore, { provide: LOG_STORE, useExisting: LocalDiskLogStore },
    PrismaFleetJobLogRepository, { provide: FLEET_JOB_LOG_REPOSITORY, useExisting: PrismaFleetJobLogRepository },
    FleetLogLivePublisher, LogUploadService,
  ],
  exports: [LOG_STORE, FLEET_JOB_LOG_REPOSITORY, FleetLogLivePublisher],
})
export class LogsModule {}
```

`FleetJobsModule` must export `FLEET_JOB_REPOSITORY` and `SyncModule` must export `FenceService` (both are used by
`ArtifactsModule` today, so they already are; if not, stop and report). `fleet.module.ts`: add `LogsModule` to
`imports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-upload.integration.spec.ts test/integration/fleet/fleet-bundles.integration.spec.ts`
Expected: PASS (the bundles suite proves the module refactor kept the bundle routes working).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/artifacts/artifact-store.module.ts apps/api/src/fleet/artifacts/artifacts.module.ts apps/api/src/fleet/logs/log-upload.controller.ts apps/api/src/fleet/logs/logs.module.ts apps/api/src/fleet/fleet.module.ts apps/api/test/integration/fleet/fleet-log-upload.integration.spec.ts
git commit -m "feat(fleet): runner log upload route and logs module (S2a 1a)"
```

---

### Task 7: Bundle member extraction (`tar-stream`)

**Files:**
- Modify: `apps/api/package.json` (dependencies)
- Create: `apps/api/src/fleet/logs/bundle-log-extractor.ts`, `apps/api/src/fleet/logs/bundle-log-extractor.spec.ts`
- Create: `apps/api/test/helpers/tar-gz.ts`

**Interfaces:**
- Produces:

```ts
export interface BundleMember { name: string; size: number; mtimeMs: number }
export function listBundleMembers(bundle: Readable): Promise<BundleMember[]>;               // files only, names normalised
export function pickLogMembers(members: readonly BundleMember[], job: { command: string; feature: string; naxLogRunId: string | null }):
  Partial<Record<LogStreamName, BundleMember>>;
export function extractBundleMembers(bundle: Readable, wanted: ReadonlyMap<string, LogStreamName>,
  sink: (stream: LogStreamName, entry: Readable, member: BundleMember) => Promise<void>): Promise<void>;
// test helper:
export function tarGz(files: Array<{ name: string; body?: string | Buffer; type?: 'file' | 'symlink'; linkname?: string; mtime?: Date }>): Promise<Buffer>;
```

- [ ] **Step 1: Add the dependency**

Run: `cd apps/api && bun add tar-stream && bun add -d @types/tar-stream`
Expected: both appear in `apps/api/package.json`; `bun.lock` updated.

- [ ] **Step 2: Write the test helper and the failing test**

`test/helpers/tar-gz.ts`:

```ts
import { pack } from 'tar-stream';
import { createGzip } from 'zlib';

export interface TarFile {
  name: string;
  body?: string | Buffer;
  type?: 'file' | 'symlink';
  linkname?: string;
  mtime?: Date;
}

/** Builds a tar.gz in memory, shaped like the runner's bundle (apps/runner/src/bundle/build-bundle.ts). */
export function tarGz(files: TarFile[]): Promise<Buffer> {
  const p = pack();
  for (const f of files) {
    if (f.type === 'symlink') p.entry({ name: f.name, type: 'symlink', linkname: f.linkname ?? '', mtime: f.mtime });
    else p.entry({ name: f.name, mtime: f.mtime }, typeof f.body === 'string' ? Buffer.from(f.body) : (f.body ?? Buffer.alloc(0)));
  }
  p.finalize();
  const gz = p.pipe(createGzip());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    gz.on('data', (c: Buffer) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
  });
}
```

`bundle-log-extractor.spec.ts`:

```ts
import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { extractBundleMembers, listBundleMembers, pickLogMembers } from './bundle-log-extractor';

const job = { command: 'RUN', feature: 'feat-a', naxLogRunId: null as string | null };
const runs = 'nax-out/features/feat-a/runs';

describe('bundle log extraction', () => {
  it('lists file members only, with ./ stripped', async () => {
    const gz = await tarGz([
      { name: './nax.stdout', body: 'out' },
      { name: `${runs}/r1.jsonl`, body: '{}\n' },
      { name: `${runs}/latest.jsonl`, type: 'symlink', linkname: 'r1.jsonl' },
    ]);
    const members = await listBundleMembers(Readable.from([gz]));
    expect(members.map((m) => m.name).sort()).toEqual(['nax-out/features/feat-a/runs/r1.jsonl', 'nax.stdout']);
  });

  it('picks the run log by naxLogRunId, else the single file, else the newest; never latest or another feature', async () => {
    const m = (name: string, mtimeMs = 0) => ({ name, size: 1, mtimeMs });
    const base = [m('nax.stdout'), m('nax.stderr'), m(`${runs}/a.jsonl`, 1000), m(`${runs}/b.jsonl`, 2000), m('nax-out/features/other/runs/z.jsonl', 9000)];
    expect(pickLogMembers(base, { ...job, naxLogRunId: 'a' }).run?.name).toBe(`${runs}/a.jsonl`);
    expect(pickLogMembers(base, job).run?.name).toBe(`${runs}/b.jsonl`);
    expect(pickLogMembers([m(`${runs}/only.jsonl`)], job).run?.name).toBe(`${runs}/only.jsonl`);
    expect(pickLogMembers([m(`${runs}/latest.jsonl`)], job).run).toBeUndefined();
    expect(pickLogMembers([m('nax-out/features/other/runs/z.jsonl')], job).run).toBeUndefined(); // Review Focus 4
    expect(pickLogMembers([m(`${runs}/nested/x.jsonl`)], job).run).toBeUndefined();
    expect(pickLogMembers(base, { ...job, command: 'PLAN' }).run).toBeUndefined();
    expect(pickLogMembers(base, job).stdout?.name).toBe('nax.stdout');
    expect(pickLogMembers(base, job).stderr?.name).toBe('nax.stderr');
  });

  it('streams only the wanted members to the sink and drains the rest', async () => {
    const gz = await tarGz([{ name: 'nax.stdout', body: 'OUT' }, { name: 'skip.bin', body: 'xxxx' }, { name: 'nax.stderr', body: 'ERR' }]);
    const got: Record<string, string> = {};
    await extractBundleMembers(Readable.from([gz]), new Map([['nax.stdout', 'stdout'], ['nax.stderr', 'stderr']]), async (stream, entry) => {
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      got[stream] = Buffer.concat(chunks).toString();
    });
    expect(got).toEqual({ stdout: 'OUT', stderr: 'ERR' });
  });

  it('rejects a corrupt gzip', async () => {
    await expect(listBundleMembers(Readable.from([Buffer.from('not gzip')]))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/bundle-log-extractor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`bundle-log-extractor.ts`:

```ts
import { posix } from 'path';
import type { Readable } from 'stream';
import { extract, Headers } from 'tar-stream';
import { createGunzip } from 'zlib';
import type { LogStreamName } from './domain/fleet-job-log.domain';

export interface BundleMember {
  name: string;
  size: number;
  mtimeMs: number;
}

const normalise = (name: string): string => name.replace(/^\.\//, '');

/** Plan D316: walks the archive; `onFile` gets each regular file; every entry is drained. */
function walk(bundle: Readable, onFile: (h: Headers, member: BundleMember, entry: Readable) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = extract();
    x.on('entry', (header, entry, next) => {
      const member = { name: normalise(header.name), size: header.size ?? 0, mtimeMs: header.mtime?.getTime() ?? 0 };
      const done = () => next();
      if (header.type !== 'file') {
        entry.on('end', done);
        entry.resume();
        return;
      }
      onFile(header, member, entry).then(() => {
        if (entry.readableEnded) done();
        else {
          entry.on('end', done);
          entry.resume();
        }
      }, (error: unknown) => x.destroy(error as Error));
    });
    x.on('finish', resolve);
    x.on('error', reject);
    const gunzip = createGunzip();
    gunzip.on('error', reject);
    bundle.on('error', reject);
    bundle.pipe(gunzip).pipe(x);
  });
}

export async function listBundleMembers(bundle: Readable): Promise<BundleMember[]> {
  const found: BundleMember[] = [];
  await walk(bundle, async (_h, member, entry) => {
    found.push(member);
    entry.resume();
  });
  return found;
}

/** Spec §2.5 step 1, plan D317. */
export function pickLogMembers(
  members: readonly BundleMember[],
  job: { command: string; feature: string; naxLogRunId: string | null },
): Partial<Record<LogStreamName, BundleMember>> {
  const byName = new Map(members.map((m) => [m.name, m]));
  const stdout = byName.get('nax.stdout');
  const stderr = byName.get('nax.stderr');
  const base = { ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) };
  if (job.command !== 'RUN') return base;
  const dir = `nax-out/features/${job.feature}/runs`;
  const candidates = members.filter((m) => posix.dirname(m.name) === dir && m.name.endsWith('.jsonl') && posix.basename(m.name) !== 'latest.jsonl');
  const byId = job.naxLogRunId ? byName.get(`${dir}/${job.naxLogRunId}.jsonl`) : undefined;
  const newest = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0];
  const run = byId ?? (candidates.length === 1 ? candidates[0] : newest);
  return run ? { ...base, run } : base;
}

export async function extractBundleMembers(
  bundle: Readable,
  wanted: ReadonlyMap<string, LogStreamName>,
  sink: (stream: LogStreamName, entry: Readable, member: BundleMember) => Promise<void>,
): Promise<void> {
  await walk(bundle, async (_h, member, entry) => {
    const stream = wanted.get(member.name);
    if (stream) await sink(stream, entry, member);
    else entry.resume();
  });
}
```

If `tar-stream`'s installed major exports `extract` differently (v3 is `require('tar-stream').extract()`), adjust the
import to match the installed version's typings and note it in the commit message.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/bundle-log-extractor.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json ../../bun.lock apps/api/src/fleet/logs/bundle-log-extractor.ts apps/api/src/fleet/logs/bundle-log-extractor.spec.ts apps/api/test/helpers/tar-gz.ts
git commit -m "feat(fleet): pick and stream log members out of a job bundle (S2a 1a)"
```

(Run `git add` from the repo root with the root-relative paths: `apps/api/...` and `bun.lock`.)

---

### Task 8: `LogFallbackService` (unit)

**Files:**
- Create: `apps/api/src/fleet/logs/log-fallback.service.ts`, `apps/api/src/fleet/logs/log-fallback.service.spec.ts`

**Interfaces:**
- Consumes: `ARTIFACT_STORE` (`get(key)`), `LOG_STORE` (`withLock`, `size`, `replace`), `FLEET_JOB_LOG_REPOSITORY`
  (`listForAttempt`, `completeFromBundle`), `FLEET_JOB_REPOSITORY` (`findById`), `FleetLogLivePublisher.touch`,
  `listBundleMembers`, `pickLogMembers`, `extractBundleMembers`, `FLEET_CFG.logMaxBytes`.
- Produces: `LogFallbackService.schedule(input: { jobId: string; leaseEpoch: number; storageKey: string }): void`,
  `LogFallbackService.idle(): Promise<void>`, and (for tests) `LogFallbackService.fill(input): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`log-fallback.service.spec.ts` (real `LocalDiskLogStore` + the in-memory repo pattern from Task 5, a fake artifact store
serving a `tarGz` buffer):

```ts
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import type { FleetJobLogRecord, LogStreamName } from './domain/fleet-job-log.domain';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';
import { LogFallbackService } from './log-fallback.service';

class Repo {
  rows: ReadonlyMap<string, FleetJobLogRecord> = new Map();
  private k = (j: string, e: number, s: string) => `${j}:${e}:${s}`;
  set(r: Partial<FleetJobLogRecord> & { jobId: string; leaseEpoch: number; stream: LogStreamName }) {
    const row = { id: 'x', sizeBytes: 0, complete: false, truncated: false, source: 'stream', expiredAt: null, createdAt: new Date(0), updatedAt: new Date(0), ...r } as FleetJobLogRecord;
    this.rows = new Map([...this.rows, [this.k(r.jobId, r.leaseEpoch, r.stream), row]]);
  }
  get(j: string, e: number, s: string) { return this.rows.get(this.k(j, e, s)) ?? null; }
  async listForAttempt(j: string, e: number) { return [...this.rows.values()].filter((r) => r.jobId === j && r.leaseEpoch === e); }
  async completeFromBundle(j: string, e: number, s: LogStreamName, r: { sizeBytes: number; truncated: boolean }) {
    const prev = this.get(j, e, s);
    if (prev && (prev.complete || prev.truncated)) return false;
    this.set({ jobId: j, leaseEpoch: e, stream: s, sizeBytes: r.sizeBytes, complete: !r.truncated, truncated: r.truncated, source: 'bundle' });
    return true;
  }
}

describe('LogFallbackService', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-fallback-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const live = { touch: jest.fn() };
  let repo: Repo;
  let bundle: Buffer;
  let job: { id: string; projectId: string; command: string; feature: string; naxLogRunId: string | null; leaseEpoch: number };
  const artifacts = { get: jest.fn(async () => Readable.from([bundle])) };
  const jobs = { findById: jest.fn(async () => job) };
  let n = 0;
  const svc = () => new LogFallbackService(artifacts as never, store, repo as never, jobs as never, live as never, { logMaxBytes: 16 } as never);
  const file = (s: LogStreamName) => readFileSync(join(root, logKey(job.id, 1, s)), 'utf8');
  const runLog = 'nax-out/features/f/runs/r1.jsonl';

  beforeEach(() => {
    n += 1;
    repo = new Repo();
    job = { id: `jf${n}`, projectId: 'p1', command: 'RUN', feature: 'f', naxLogRunId: 'r1', leaseEpoch: 1 };
  });
  afterEach(() => jest.clearAllMocks());

  it('fills missing and incomplete streams; leaves complete and truncated ones alone', async () => {
    bundle = await tarGz([{ name: runLog, body: 'R1\nR2\n' }, { name: 'nax.stdout', body: 'OUT' }, { name: 'nax.stderr', body: 'ERR' }]);
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: 3 });
    await store.append(logKey(job.id, 1, 'run'), 0, Buffer.from('R1\n'));
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'stdout', sizeBytes: 3, complete: true });
    await store.append(logKey(job.id, 1, 'stdout'), 0, Buffer.from('out'));
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'stderr', sizeBytes: 16, truncated: true });
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('R1\nR2\n');
    expect(repo.get(job.id, 1, 'run')).toMatchObject({ complete: true, source: 'bundle', sizeBytes: 6 });
    expect(file('stdout')).toBe('out');
    expect(repo.get(job.id, 1, 'stderr')).toMatchObject({ truncated: true, source: 'stream' });
    expect(live.touch).toHaveBeenCalledWith(expect.objectContaining({ stream: 'run', complete: true, size: 6 }), true);
  });

  it('never replaces with a shorter member, and leaves a stream with no member incomplete', async () => {
    bundle = await tarGz([{ name: runLog, body: 'R1\n' }]);
    repo.set({ jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: 5 });
    await store.append(logKey(job.id, 1, 'run'), 0, Buffer.from('R1\nR2'));
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('R1\nR2');
    expect(repo.get(job.id, 1, 'run')).toMatchObject({ complete: false });
    expect(repo.get(job.id, 1, 'stdout')).toBeNull();
  });

  it('caps a member larger than FLEET_LOG_MAX_BYTES and marks it truncated (D318)', async () => {
    bundle = await tarGz([{ name: 'nax.stdout', body: 'x'.repeat(40) }]);
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('stdout')).toBe('x'.repeat(16));
    expect(repo.get(job.id, 1, 'stdout')).toMatchObject({ truncated: true, complete: false, sizeBytes: 16, source: 'bundle' });
  });

  it('ignores naxLogRunId of a newer attempt (Review Focus 5)', async () => {
    job = { ...job, leaseEpoch: 2, naxLogRunId: 'r2' };
    bundle = await tarGz([{ name: runLog, body: 'old\n', mtime: new Date(1000) }, { name: 'nax-out/features/f/runs/r2.jsonl', body: 'new\n', mtime: new Date(500) }]);
    await svc().fill({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' });
    expect(file('run')).toBe('old\n'); // newest by mtime, not the new attempt's id
  });

  it('schedule() never throws and idle() waits for the queue; a corrupt bundle leaves streams incomplete', async () => {
    bundle = Buffer.from('corrupt');
    const s = svc();
    expect(() => s.schedule({ jobId: job.id, leaseEpoch: 1, storageKey: 'k' })).not.toThrow();
    await s.idle();
    expect(repo.get(job.id, 1, 'run')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-fallback.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`log-fallback.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { extractBundleMembers, listBundleMembers, pickLogMembers } from './bundle-log-extractor';
import { FLEET_JOB_LOG_REPOSITORY, IFleetJobLogRepository, LOG_STREAMS, LogStreamName } from './domain/fleet-job-log.domain';
import { FleetLogLivePublisher } from './fleet-log-live.publisher';
import { LOG_STORE, LogStore, logKey } from './log-store';

export interface FallbackInput {
  jobId: string;
  leaseEpoch: number;
  storageKey: string;
}

/** Spec §2.5, plan D316-D318: fill streams the runner did not finish from the attempt's bundle, off the request path. */
@Injectable()
export class LogFallbackService {
  private readonly logger = new Logger(LogFallbackService.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ARTIFACT_STORE) private readonly artifacts: Pick<ArtifactStore, 'get'>,
    @Inject(LOG_STORE) private readonly store: LogStore,
    @Inject(FLEET_JOB_LOG_REPOSITORY) private readonly logs: Pick<IFleetJobLogRepository, 'listForAttempt' | 'completeFromBundle'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly live: FleetLogLivePublisher,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'logMaxBytes'>,
  ) {}

  schedule(input: FallbackInput): void {
    this.queue = this.queue.then(() => this.fill(input)).catch((error: unknown) => {
      this.logger.warn(`log fallback failed for job ${input.jobId} epoch ${input.leaseEpoch}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  idle(): Promise<void> {
    return this.queue;
  }

  async fill(input: FallbackInput): Promise<void> {
    const job = await this.jobs.findById(input.jobId);
    if (!job) return;
    const rows = await this.logs.listForAttempt(input.jobId, input.leaseEpoch);
    const done = new Set(rows.filter((r) => r.complete || r.truncated).map((r) => r.stream));
    const open = LOG_STREAMS.filter((s) => !done.has(s));
    if (open.length === 0) return;
    const members = await listBundleMembers(await this.artifacts.get(input.storageKey));
    const picked = pickLogMembers(members, {
      command: job.command, feature: job.feature, naxLogRunId: job.leaseEpoch === input.leaseEpoch ? job.naxLogRunId : null,
    });
    const wanted = new Map<string, LogStreamName>(open.flatMap((s) => (picked[s] ? [[picked[s].name, s] as [string, LogStreamName]] : [])));
    if (wanted.size === 0) return;
    await extractBundleMembers(await this.artifacts.get(input.storageKey), wanted, async (stream, entry, member) => {
      const key = logKey(input.jobId, input.leaseEpoch, stream);
      const filled = await this.store.withLock(key, async () => {
        const current = (await this.logs.listForAttempt(input.jobId, input.leaseEpoch)).find((r) => r.stream === stream);
        if (current && (current.complete || current.truncated)) return null;
        if (member.size < (await this.store.size(key))) return null;
        const written = await this.store.replace(key, entry, this.cfg.logMaxBytes);
        const truncated = member.size > this.cfg.logMaxBytes;
        return (await this.logs.completeFromBundle(input.jobId, input.leaseEpoch, stream, { sizeBytes: written, truncated })) ? { written, truncated } : null;
      });
      if (filled) {
        this.live.touch({ projectId: job.projectId, jobId: input.jobId, leaseEpoch: input.leaseEpoch, stream, size: filled.written, complete: !filled.truncated }, true);
      }
    });
  }
}
```

The `extractBundleMembers` walker drains `entry` after the sink returns, so a sink that returns early (`null` paths)
still lets the archive advance.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/logs/log-fallback.service.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/log-fallback.service.ts apps/api/src/fleet/logs/log-fallback.service.spec.ts
git commit -m "feat(fleet): fill unfinished log streams from the job bundle (S2a 1a)"
```

---

### Task 9: Wire the fallback into bundle uploads; fallback integration

**Files:**
- Modify: `apps/api/src/fleet/logs/logs.module.ts` (provide + export `LogFallbackService`, import `ArtifactStoreModule`)
- Modify: `apps/api/src/fleet/artifacts/artifacts.module.ts` (import `LogsModule`)
- Modify: `apps/api/src/fleet/artifacts/bundle.service.ts`
- Test: `apps/api/test/integration/fleet/fleet-log-fallback.integration.spec.ts`

**Interfaces:**
- Consumes: `LogFallbackService.schedule/idle` (Task 8).
- Produces: every committed bundle upload schedules a fallback for its `(jobId, leaseEpoch, storageKey)`.

- [ ] **Step 1: Write the failing integration test**

`fleet-log-fallback.integration.spec.ts`:

```ts
/**
 * Fleet S2a slice 1a — bundle fallback after a bundle upload (PG), spec §2.5.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-fallback.integration.spec.ts
 */
import request from 'supertest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { LogFallbackService } from '../../../src/fleet/logs/log-fallback.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describeIntegration('fleet log fallback (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let dir: string;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;

  const job = (feature: string) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'UPLOADING', runnerId: runner.runnerId, leaseEpoch: 1, naxLogRunId: 'r1',
    },
  });
  const auth = () => ({ Authorization: `Bearer ${runner.apiKey}` });
  const putLog = (jobId: string, body: Buffer, offset: number, final = false) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/logs/run?leaseEpoch=1&offset=${offset}${final ? '&final=1' : ''}`)
      .set({ ...auth(), 'content-type': 'application/octet-stream', 'x-content-sha256': sha(body) }).send(body);
  const putBundle = (jobId: string, gz: Buffer) =>
    request(server).put(`/api/fleet/runner/jobs/${jobId}/bundle?leaseEpoch=1`)
      .set({ ...auth(), 'content-type': 'application/gzip', 'x-content-sha256': sha(gz) }).send(gz);
  const runFile = (jobId: string) => readFileSync(join(dir, 'logs', jobId, '1', 'run.log'), 'utf8');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-log-fallback-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-fallback');
  });
  afterAll(async () => {
    await app.close();
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });

  it('fills a stream whose upload stopped before final from the uploaded bundle', async () => {
    const j = await job('cut');
    await putLog(j.id, Buffer.from('L1\n'), 0).expect(200);
    const gz = await tarGz([{ name: 'nax-out/features/cut/runs/r1.jsonl', body: 'L1\nL2\nL3\n' }, { name: 'nax.stdout', body: 'O' }]);
    await putBundle(j.id, gz).expect(201);
    await app.get(LogFallbackService).idle();
    expect(runFile(j.id)).toBe('L1\nL2\nL3\n');
    const rows = await prisma.fleetJobLog.findMany({ where: { jobId: j.id }, orderBy: { stream: 'asc' } });
    expect(rows.map((r) => [r.stream, r.complete, r.source])).toEqual([['run', true, 'bundle'], ['stdout', true, 'bundle']]);
  });

  it('a stream completed by the runner is not replaced, and a late append after the fill answers complete (Review Focus 3)', async () => {
    const j = await job('done');
    await putLog(j.id, Buffer.from('A\n'), 0).expect(200);
    await putLog(j.id, Buffer.alloc(0), 2, true).expect(200);
    await putBundle(j.id, await tarGz([{ name: 'nax-out/features/done/runs/r1.jsonl', body: 'DIFFERENT\n' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect(runFile(j.id)).toBe('A\n');

    const k = await job('late');
    await putBundle(k.id, await tarGz([{ name: 'nax-out/features/late/runs/r1.jsonl', body: 'X\nY\n' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect((await putLog(k.id, Buffer.from('X\n'), 0).expect(200)).body.data).toEqual({ outcome: 'complete', size: 4 });
    expect(runFile(k.id)).toBe('X\nY\n');
  });

  it('a bundle with no run member leaves the stream incomplete and the bundle upload succeeds', async () => {
    const j = await job('none');
    await putLog(j.id, Buffer.from('only\n'), 0).expect(200);
    await putBundle(j.id, await tarGz([{ name: 'unrelated.txt', body: 'x' }])).expect(201);
    await app.get(LogFallbackService).idle();
    expect((await prisma.fleetJobLog.findFirstOrThrow({ where: { jobId: j.id, stream: 'run' } })).complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-fallback.integration.spec.ts`
Expected: FAIL — `LogFallbackService` not in the container / streams not filled.

- [ ] **Step 3: Implement**

`logs.module.ts`: add `ArtifactStoreModule` to `imports`, `LogFallbackService` to `providers`, and
`LogFallbackService` to `exports`.

`artifacts.module.ts`: add `LogsModule` to `imports`.

`bundle.service.ts`: inject the fallback and schedule it after a successful record. Constructor gains (last
parameter):

```ts
    private readonly fallback: LogFallbackService,
```

with `import { LogFallbackService } from '../logs/log-fallback.service';`. In `upload`, after the `if (!recorded.ok)`
block and **before** the `if (recorded.replacedKey)` block:

```ts
    // S2a §2.5: fill unfinished log streams from this bundle, off the request path.
    this.fallback.schedule({ jobId: u.jobId, leaseEpoch, storageKey: key });
```

Update every `new BundleService(...)` in existing specs (`grep -rn "new BundleService" apps/api`) to pass a
`{ schedule: jest.fn() }` fake as the new last argument.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-fallback.integration.spec.ts test/integration/fleet/fleet-bundles.integration.spec.ts src/fleet/artifacts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/logs/logs.module.ts apps/api/src/fleet/artifacts apps/api/test/integration/fleet/fleet-log-fallback.integration.spec.ts
git commit -m "feat(fleet): schedule the log fallback after each bundle upload (S2a 1a)"
```

---

### Task 10: OpenAPI, docs, spec correction and whole-slice verification

**Files:**
- Modify: `openapi.json` (regenerated)
- Modify: `docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md` (§2.2, §2.4 table, §6 — only if the D307 text
  was not already applied in the commit that added this plan; check with `grep -n "rate_limited" <spec>`)
- Modify: `.nax/mono/apps/api/context.md` (one line: fleet logs live in `src/fleet/logs/`, `LogStore` appends require
  `withLock`)

- [ ] **Step 1: Regenerate the contract**

Run: `bun run generate` (repo root). Expected: `openapi.json` gains `PUT /fleet/runner/jobs/{jobId}/logs/{stream}`.
Commit `openapi.json` only.

- [ ] **Step 2: API context note**

Add under the fleet section of `.nax/mono/apps/api/context.md`:

```markdown
- Fleet logs (S2a): `src/fleet/logs/`. `LogStore.append`/`replace` assume the caller holds `withLock(key)`; every
  `FleetJobLog` write for that key happens inside the same lock. Upload outcomes are HTTP 200 bodies, not errors.
```

Then run `nax generate` only if the repo's `CLAUDE.md`/`AGENTS.md` are generated from it and the team does that per
change (check `git log -3 -- AGENTS.md`); otherwise leave generation to the next sync.

- [ ] **Step 3: Whole-slice verification**

Run, from `apps/api`:
- `bun run lint` — Expected: 0 errors.
- `bun run type-check` — Expected: 0 errors.
- `bun run test` — Expected: all unit suites pass.
- `bun run test:scoped test/integration/fleet` — Expected: all fleet integration suites pass (including the three new
  ones and `fleet-bundles`, `runner-sync*`).

Then from the repo root: `git diff --stat main -- packages/fleet-protocol apps/runner apps/web apps/cli` —
Expected: **empty** (D308: this slice is API-only).

- [ ] **Step 4: Commit**

```bash
git add openapi.json .nax/mono/apps/api/context.md docs/superpowers/specs/2026-10-04-fleet-s2a-logs-design.md
git commit -m "docs(fleet): S2a 1a contract, API context and spec correction D307"
```
