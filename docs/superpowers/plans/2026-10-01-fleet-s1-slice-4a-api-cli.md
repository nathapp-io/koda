# Fleet S1 Slice 4a — API Completions and the `koda fleet` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** Slice 4 is three plans (overview `docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md`,
> decision D114). This is **4a**. Decision numbers continue the fleet S1 register: D1-D113 are used by slices 2-3b-2,
> the overview holds D114-D129, this plan adds **D130-D134**.

**Prerequisite:** `main` at `0ba9ba94` (#175, slice 3 complete). This plan, the overview and the 4b/4c plans are
committed on branch `feat/fleet-s1-slice4a-api-cli`, cut from that `main`, in the main checkout (`repos/koda`).

**Goal:** Give the web and CLI everything slice 4 needs from the API (runner boot fields and online state, project
runner summaries, on-demand repo reachability, typed slug path params), then ship `koda fleet` so a terminal user
can manage runners and repos, dispatch a job and follow, cancel, requeue and download it.

**Architecture:** Four small API changes in the existing fleet modules: a nullable `Runner.bootedAt` column and
three `RunnerDto` fields computed through one shared `isRunnerOnline` rule; a `ProjectFleetRunnersController`
returning `RunnerSummaryDto`; `FleetReposService.check` re-running the registration forge check; class-level
`@ApiParam('slug')` on the project-scoped fleet controllers. `openapi.json` is re-exported and the CLI client
regenerated. The CLI adds one `fleet` command group split over five files (runner, repo, dispatch, job, shared
helpers), all through the generated SDK.

**Tech Stack:** NestJS 11 + Prisma 6 on PostgreSQL 16, `@nestjs/swagger`, Jest + supertest (API), Commander 12 +
`@hey-api/openapi-ts` generated client + Jest (CLI), Bun workspaces.

**Spec:** `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec": §2.2 permissions, §3.4
user-facing endpoints, §4 placement's online rule, §11 CLI line) and the slice 4 overview (binding API contract and
D114-D129). Issue #158 is closed by Task 1.

## Global Constraints

From the S1 spec, the overview and the repo rules (`.nax/context.md`, `.nax/rules/{common,cli,api-controllers,api-i18n}.md`,
`.nax/mono/apps/{api,cli}/context.md`); every task includes them.

- **Online rule:** a runner is online while `now - lastSeenAt <= FLEET_RUNNER_OFFLINE_SEC` seconds (default 90);
  `online` and placement's `offline` misfit use the same function (D117).
- **Permissions (S1 spec §2.2):** runners, enrollment tokens, repo registry and repo check = global ADMIN
  (`@RequiredPermission('ADMIN')`); project runner summaries and job reads = any project member
  (`ProjectMembershipGuard`); dispatch/cancel/requeue unchanged. A RUNNER key is 401 everywhere but
  `/fleet/runner/*` (global guard, unchanged).
- **Wire shapes:** every JSON route returns `JsonResponse.Ok(...)`; lists use `parseQuery` + `toPageResult`
  (`{ total, current, size, hasNext, hasPrev, records }`, `size` 1..100); dates are ISO strings; BigInt/Decimal are
  strings.
- **Errors on the wire are `{ ret, message }`** (nathapp `GlobalExceptionsFilter`), with no HTTP status; the
  generated CLI client throws that parsed body. Observed `ret` values (2026-10-01, real API): 401 → `40000`, 403 →
  `40003`, 404 → `404`, 400 validation → `-2`, `ConflictAppException` → `409`, fleet 422s → `422`. The shared
  `handleApiError` reads only `status`, so on its own every API error exits 1; fleet commands go through
  `handleFleetError` (Task 5), which maps those codes to the statuses `handleApiError` understands. Never match on
  message text (`.nax/rules/common.md`).
- **Exit codes:** commander option-parse failures (`parsePositiveInt`, `parseUsd`) exit 1 (commander's own
  behaviour, as for every existing command); validation the command does itself exits 3; 401/403 exit 2; 404 exits 4.
- **OpenAPI:** `openapi.json` at the repo root is committed and must match the API; `apps/cli/src/generated/` is
  gitignored and regenerated with `bun run generate:cli`; never hand-edit generated files.
- **CLI rules (`.nax/rules/cli.md`):** generated SDK only (no hand-written HTTP); every data command supports
  `--json` (`JSON.stringify(data, null, 2)` to stdout); errors to stderr; exit 0 success, 1 API/network error, 2
  config/auth, 3 validation; CLI strings are English; no sync FS in command paths.
- **Repo conventions.** Conventional commits, no attribution trailer, never push, no emojis, no `console.log` in
  API code, no `any`, no non-null assertions, no `eslint-disable`; immutable style; files under 400 lines typical
  (800 max), functions under 50 lines; API i18n keys in both `en` and `zh`.
- **Tests.** API unit specs beside the source (`src/**/*.spec.ts`), integration specs
  `apps/api/test/integration/**/*.integration.spec.ts` gated by `KODA_DB_TESTS=1`; CLI specs beside the command
  (`src/commands/*.spec.ts`) with the mock boilerplate of `src/commands/user.spec.ts`.
- **All ten required CI checks stay green; no new required check (D129).**

Plan-level rules:

- Work on `feat/fleet-s1-slice4a-api-cli` in the main checkout. Never run `git checkout`, `git switch`,
  `git stash`, `git reset` or `git rebase`; commit on the current branch only. Never push.
- API: one spec `cd apps/api && npx jest <path>`; all unit `bun run test:unit`; integration
  `bun run test:scoped <path>` (needs `bun run test:db:up` first, Postgres on 5433); types `bun run type-check`;
  lint `bun run lint`.
- CLI: `cd apps/cli && npx jest <path>`, `bun run test`, `bun run type-check`, `bun run lint`.
- After a Prisma schema change run `bun run db:generate` from the repo root.
- `bun run api:export-spec` boots the app and exits 1 with no output when `apps/api/.env` is missing (a fresh
  worktree): `cp apps/api/.env.example apps/api/.env` first. `bun scripts/export-spec.cjs` in `apps/api` shows the error.

## Review Focus

The five uncovered inputs most likely to bite a user, each pinned by a test in the named task:

1. **A runner exactly at the offline threshold, and a disabled runner that is syncing.** `online` must be true at
   `lastSeenAt = now - offlineSec` (placement treats it as online) and must not depend on `enabled`. Task 1
   (`runner.dto.spec.ts`, `runner-online.spec.ts`).
2. **A runner enrolled before this migration.** `bootedAt` is null until its next boot; the API returns `null`, the
   CLI prints `-`, nothing throws. Tasks 1 and 5.
3. **A GitLab repo in a subgroup** (`group/sub/app`). `koda fleet repo add group/sub/app` must send owner
   `group/sub` and name `app`; `--repo group/sub/app` must resolve for dispatch. Tasks 6 and 7.
4. **`--max-cost` input:** `5`, `0.0001` accepted; `0`, `-1`, `1e3`, `0.00001`, `10000.01`, `abc`, `` rejected
   before any request. Task 7.
5. **`koda fleet job bundle` when the output file exists, or when no bundle exists yet.** Existing file: refused
   without `--force`, never truncated; no bundle: exit 4, no file left behind. Task 8.

## Plan decisions beyond the spec and overview

| # | Decision | Why |
|:--|:--|:--|
| D130 | `isRunnerOnline(lastSeenAt, now, offlineSec)` lives in `apps/api/src/fleet/common/runner-online.ts`; `firstMisfit` calls it instead of its inline comparison. | One rule for placement and the DTOs (D117); the boundary (`<=` online) is placement's existing behaviour (`> offlineSec` is offline). |
| D131 | `Runner.bootedAt` is set at enrollment (`now`) and by `recordRunnerSync` when the reported `bootId` differs from the stored one; the migration adds it nullable with no backfill. | Overview D116. A backfill would invent a boot time; `null` is shown as unknown until the daemon's next restart. |
| D132 | `koda fleet repo check <id>` is added next to `add|list|rm`. | It is the CLI face of D119 (operators debug reachability from a terminal too); one SDK call. |
| D133 | `koda fleet dispatch` takes `--label` or `--pin`, not both (exit 3). `--repo` and `--pin` accept an id or a human name (`owner/name`, runner name), resolved through the project-scoped lists. A 409 is answered by finding the active job (overview D121) and printing it; the exit code stays 1. | The API ignores labels on a pinned job (`firstMisfit`), so accepting both would mislead. Names are what people type; ids still work for scripts. |
| D134 | `koda fleet job bundle <id>` writes `koda-job-<id>.tar.gz` in the current directory (or `--out <path>`), opening the file with flag `wx` unless `--force`; it downloads into memory first, so a failed download leaves no file. | `wx` refuses an existing file atomically (no check-then-write race); bundles are capped at 200 MiB server-side, so buffering is bounded. |

## File structure

API (`apps/api`):

| File | Change |
|:--|:--|
| `prisma/schema.prisma` | `Runner.bootedAt DateTime?` |
| `prisma/migrations/20261001090000_runner_booted_at/migration.sql` | new |
| `src/fleet/common/runner-online.ts` (+ `.spec.ts`) | new: `isRunnerOnline` |
| `src/fleet/jobs/placement-rules.ts` | use `isRunnerOnline` |
| `src/fleet/runners/domain/runner.domain.ts` | `bootedAt` on `RunnerRecord`, `NewRunner` |
| `src/fleet/runners/prisma-runner.repository.ts` | select `bootedAt` |
| `src/fleet/runners/enrollment.service.ts` (+ spec) | `bootedAt: now` |
| `src/fleet/jobs/prisma-fleet-job.repository.ts` | `recordRunnerSync` sets `bootedAt` on a new boot |
| `src/fleet/runners/dto/runner.dto.ts` (+ new `runner.dto.spec.ts`) | `bootId`, `bootedAt`, `online`; `from(r, view)` |
| `src/fleet/runners/dto/runner-summary.dto.ts` (+ spec) | new |
| `src/fleet/runners/runners.service.ts` (+ spec) | config injection, views, `listSummaries` |
| `src/fleet/runners/project-fleet-runners.controller.ts` | new |
| `src/fleet/runners/runners.module.ts` | import `ProjectAccessModule`, register the controller |
| `src/fleet/repos/dto/repo-check-result.dto.ts` | new |
| `src/fleet/repos/fleet-repos.service.ts` (+ spec) | `check(id)` |
| `src/fleet/repos/fleet-repos.controller.ts` | `POST :id/check` |
| `src/fleet/jobs/fleet-jobs.controller.ts`, `src/fleet/artifacts/job-bundle.controller.ts`, `src/fleet/repos/project-fleet-repos.controller.ts` | class-level `@ApiParam('slug')` |
| `src/fleet/fleet-openapi.contract.spec.ts` | new: asserts the exported contract |
| `test/integration/fleet/runner-views.integration.spec.ts` | new |
| `test/integration/fleet/fleet-repos.integration.spec.ts` | repo check cases |
| `/openapi.json` (repo root) | re-exported |

CLI (`apps/cli/src`):

| File | Change |
|:--|:--|
| `utils/parse-usd.ts` (+ spec) | new: `--max-cost` parser |
| `utils/api-error-code.ts` (+ spec) | new: read `ret` off a thrown API body |
| `commands/fleet-shared.ts` (+ spec) | new: `FleetPage<T>`, `ago`, `pageHint`, `splitRepoPath`, `resolveRepo`, `resolveRunner`, `runnerNames`, `printPlacement` |
| `commands/fleet-runner.ts` (+ spec) | new: `runner list|enable|disable|enroll-token` |
| `commands/fleet-repo.ts` (+ spec) | new: `repo add|list|rm|check` |
| `commands/fleet-dispatch.ts` (+ spec) | new: `dispatch` |
| `commands/fleet-job.ts` (+ spec) | new: `job list|show|cancel|requeue|bundle` |
| `commands/fleet.ts` (+ spec) | new: `fleetCommand(program)` registers the group |
| `index.ts` | register `fleetCommand` |

Docs: `docs/deployment/runner.md` gains an "Operate from the CLI" section (Task 9).

---

### Task 1: Runner boot fields and online state (#158)

**Files:**
- Create: `apps/api/prisma/migrations/20261001090000_runner_booted_at/migration.sql`
- Create: `apps/api/src/fleet/common/runner-online.ts`, `apps/api/src/fleet/common/runner-online.spec.ts`
- Create: `apps/api/src/fleet/runners/dto/runner.dto.spec.ts`
- Create: `apps/api/test/integration/fleet/runner-views.integration.spec.ts`
- Modify: `apps/api/prisma/schema.prisma` (model `Runner`, after `bootId`)
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts:63-66`
- Modify: `apps/api/src/fleet/runners/domain/runner.domain.ts` (`RunnerRecord`, `NewRunner`)
- Modify: `apps/api/src/fleet/runners/prisma-runner.repository.ts:10-14` (`RUNNER_SELECT`)
- Modify: `apps/api/src/fleet/runners/enrollment.service.ts:58-71` and its spec
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:137-148` (`recordRunnerSync`)
- Modify: `apps/api/src/fleet/runners/dto/runner.dto.ts`
- Modify: `apps/api/src/fleet/runners/runners.service.ts` and `runners.service.spec.ts`

**Interfaces:**
- Produces: `isRunnerOnline(lastSeenAt: Date, now: Date, offlineSec: number): boolean`;
  `interface RunnerView { now: Date; offlineSec: number }` and `RunnerDto.from(r: RunnerRecord, view: RunnerView)`
  (exported from `runner.dto.ts`); `RunnerRecord.bootedAt: Date | null`; `RunnersService` constructor
  `(repo, activity, txManager, fleetConfig: Pick<IFleetConfig, 'runnerOfflineSec'>)` and
  `list(page, now?)`, `get(id, now?)`; private `view(now: Date): RunnerView` (Task 2 uses it).
- Wire: `RunnerDto` gains `bootId: string`, `bootedAt: string | null`, `online: boolean`.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/fleet/common/runner-online.spec.ts`:

```ts
import { isRunnerOnline } from './runner-online';

describe('isRunnerOnline', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it('is online up to and including the threshold (the placement rule)', () => {
    expect(isRunnerOnline(ago(0), now, 90)).toBe(true);
    expect(isRunnerOnline(ago(90), now, 90)).toBe(true);
  });

  it('is offline one millisecond past the threshold', () => {
    expect(isRunnerOnline(new Date(ago(90).getTime() - 1), now, 90)).toBe(false);
  });

  it('treats a lastSeenAt in the future (clock skew) as online', () => {
    expect(isRunnerOnline(new Date(now.getTime() + 5_000), now, 90)).toBe(true);
  });
});
```

`apps/api/src/fleet/runners/dto/runner.dto.spec.ts`:

```ts
import { RunnerDto } from './runner.dto';
import type { RunnerRecord } from '../domain/runner.domain';

const now = new Date('2026-10-01T12:00:00.000Z');
const record = (over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, capabilities: { executors: ['host'] },
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-7', bootedAt: new Date('2026-10-01T11:00:00.000Z'),
  enabled: true, lastSeenAt: new Date(now.getTime() - 30_000), createdById: 'u1',
  createdAt: new Date('2026-09-30T00:00:00.000Z'), updatedAt: now, ...over,
});

describe('RunnerDto.from', () => {
  it('exposes bootId, bootedAt as ISO and online (#158)', () => {
    const dto = RunnerDto.from(record(), { now, offlineSec: 90 });
    expect(dto).toEqual(expect.objectContaining({ bootId: 'boot-7', bootedAt: '2026-10-01T11:00:00.000Z', online: true }));
  });

  it('keeps bootedAt null for a runner that has not booted since the migration', () => {
    expect(RunnerDto.from(record({ bootedAt: null }), { now, offlineSec: 90 }).bootedAt).toBeNull();
  });

  it('reports offline past the threshold, independent of enabled', () => {
    const stale = record({ lastSeenAt: new Date(now.getTime() - 91_000), enabled: true });
    const disabledButSyncing = record({ enabled: false });
    expect(RunnerDto.from(stale, { now, offlineSec: 90 }).online).toBe(false);
    expect(RunnerDto.from(disabledButSyncing, { now, offlineSec: 90 }).online).toBe(true);
  });

  it('never exposes createdById or the key hash', () => {
    const dto = RunnerDto.from(record(), { now, offlineSec: 90 }) as unknown as Record<string, unknown>;
    expect(dto).not.toHaveProperty('createdById');
    expect(dto).not.toHaveProperty('apiKeyHash');
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});
```

In `apps/api/src/fleet/runners/runners.service.spec.ts`, replace the `row` factory and the service construction,
and add one test:

```ts
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
// ...
const row = (over = {}) => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, capabilities: {},
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', bootedAt: null, enabled: true, lastSeenAt: new Date(0),
  createdById: 'u1', createdAt: new Date(0), updatedAt: new Date(0), ...over,
});
// ...
  const service = new RunnersService(repo as never, activity as never, tx as never, testFleetConfig({ runnerOfflineSec: 90 }));
// ...
  it('computes online against FLEET_RUNNER_OFFLINE_SEC at the given time', async () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    repo.findRunnerById.mockResolvedValue(row({ lastSeenAt: new Date(now.getTime() - 90_000) }));
    expect((await service.get('r1', now)).online).toBe(true);
    repo.findRunnerById.mockResolvedValue(row({ lastSeenAt: new Date(now.getTime() - 90_001) }));
    expect((await service.get('r1', now)).online).toBe(false);
  });
```

In `apps/api/src/fleet/runners/enrollment.service.spec.ts`, in the test `'creates the runner with merged labels and
returns a kr_ key once'`, after `const data = repo.createRunner.mock.calls[0][0];` add:

```ts
    expect(data.bootedAt).toBeInstanceOf(Date);
    expect(data.bootedAt).toEqual(data.lastSeenAt);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/fleet/common/runner-online.spec.ts src/fleet/runners`
Expected: FAIL: `Cannot find module './runner-online'`, `RunnerDto.from` lacking `bootId`/`online`, the service
spec's `online` undefined, and `data.bootedAt` undefined.

- [ ] **Step 3: Add the column and migration**

In `apps/api/prisma/schema.prisma`, model `Runner`, after the `bootId` line:

```prisma
  bootedAt        DateTime? // start of the current daemon boot: set at enroll and when sync reports a new bootId (D131)
```

`apps/api/prisma/migrations/20261001090000_runner_booted_at/migration.sql`:

```sql
-- Fleet S1 slice 4a (D131): when the runner's current daemon boot started. NULL until its next boot.
ALTER TABLE "Runner" ADD COLUMN "bootedAt" TIMESTAMP(3);
```

Run: `cd ../.. && bun run db:generate`
Expected: `Generated Prisma Client`.

- [ ] **Step 4: Implement the online rule and wire placement to it**

`apps/api/src/fleet/common/runner-online.ts`:

```ts
/**
 * A runner is online while its last sync is at most `offlineSec` old (S1 spec §4 step 1, D130).
 * Placement's `offline` misfit and every runner DTO use this one rule.
 */
export function isRunnerOnline(lastSeenAt: Date, now: Date, offlineSec: number): boolean {
  return now.getTime() - lastSeenAt.getTime() <= offlineSec * 1000;
}
```

In `apps/api/src/fleet/jobs/placement-rules.ts` add `import { isRunnerOnline } from '../common/runner-online';`
and replace the offline line in `firstMisfit`:

```ts
  if (!isRunnerOnline(runner.lastSeenAt, now, offlineSec)) return 'offline';
```

- [ ] **Step 5: Carry `bootedAt` through the domain, repository, enrollment and sync**

`apps/api/src/fleet/runners/domain/runner.domain.ts`: in `RunnerRecord` after `bootId: string;` add
`bootedAt: Date | null;`; in `NewRunner` after `bootId: string;` add `bootedAt: Date;`.

`apps/api/src/fleet/runners/prisma-runner.repository.ts`, `RUNNER_SELECT`:

```ts
const RUNNER_SELECT = {
  id: true, name: true, os: true, arch: true, labels: true, capacity: true, capabilities: true,
  daemonVersion: true, protocolVersion: true, bootId: true, bootedAt: true, enabled: true, lastSeenAt: true,
  createdById: true, createdAt: true, updatedAt: true,
} as const; // never selects apiKeyHash
```

`apps/api/src/fleet/runners/enrollment.service.ts`, in the `createRunner({...})` call, after `bootId: body.bootId,`:

```ts
        bootedAt: now,
```

`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`, `recordRunnerSync`:

```ts
  async recordRunnerSync(runnerId: string, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }) {
    const before = await this.db.runner.findUnique({ where: { id: runnerId }, select: { bootId: true } });
    if (!before) return null;
    await this.db.runner.update({
      where: { id: runnerId },
      data: {
        lastSeenAt: s.now, bootId: s.bootId, daemonVersion: s.daemonVersion, protocolVersion: s.protocolVersion,
        // D131: a new boot id is a daemon restart; the same boot id keeps the recorded start.
        ...(before.bootId !== s.bootId ? { bootedAt: s.now } : {}),
        ...(s.capabilities ? { capabilities: s.capabilities as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    return { previousBootId: before.bootId };
  }
```

- [ ] **Step 6: Extend `RunnerDto` and `RunnersService`**

`apps/api/src/fleet/runners/dto/runner.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import type { RunnerRecord } from '../domain/runner.domain';

/** The instant and threshold a DTO's `online` is computed against (D117). */
export interface RunnerView {
  now: Date;
  offlineSec: number;
}

export class RunnerDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare capacity: number;
  @ApiProperty({ type: Object }) declare capabilities: Record<string, unknown>;
  @ApiProperty() declare daemonVersion: string;
  @ApiProperty() declare protocolVersion: number;
  @ApiProperty({ description: 'Id of the daemon boot the runner last reported (#158)' }) declare bootId: string;
  @ApiProperty({ type: String, nullable: true, description: 'Start of the current daemon boot; null until the first boot after 2026-10-01' })
  declare bootedAt: string | null;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC (the placement rule)' }) declare online: boolean;
  @ApiProperty() declare enabled: boolean;
  @ApiProperty() declare lastSeenAt: string;
  @ApiProperty() declare createdAt: string;

  static from(r: RunnerRecord, view: RunnerView): RunnerDto {
    return Object.assign(new RunnerDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, capacity: r.capacity,
      capabilities: (r.capabilities ?? {}) as Record<string, unknown>, daemonVersion: r.daemonVersion,
      protocolVersion: r.protocolVersion, bootId: r.bootId, bootedAt: r.bootedAt ? r.bootedAt.toISOString() : null,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), enabled: r.enabled,
      lastSeenAt: r.lastSeenAt.toISOString(), createdAt: r.createdAt.toISOString(),
    });
  }
}
```

`apps/api/src/fleet/runners/runners.service.ts`: add the imports

```ts
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { RunnerDto, RunnerView } from './dto/runner.dto';
```

(replacing the old `RunnerDto` import), extend the constructor and change the three read paths:

```ts
  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: IRunnerRepository,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'runnerOfflineSec'>,
  ) {}

  private view(now: Date): RunnerView {
    return { now, offlineSec: this.fleetConfig.runnerOfflineSec };
  }

  async list(page: IPageOption, now = new Date()): Promise<IPageResult<RunnerDto>> {
    const view = this.view(now);
    return remapPage(await this.repo.findRunnerPage(page), (r) => RunnerDto.from(r, view));
  }

  async get(id: string, now = new Date()): Promise<RunnerDto> {
    const runner = await this.repo.findRunnerById(id);
    if (!runner) throw new NotFoundAppException({}, 'fleet.runners');
    return RunnerDto.from(runner, this.view(now));
  }
```

and in `update`, replace `return RunnerDto.from(updated);` with `return RunnerDto.from(updated, this.view(new Date()));`.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `cd apps/api && npx jest src/fleet/common src/fleet/runners src/fleet/jobs/placement-rules.spec.ts src/fleet/fleet.module.spec.ts`
Expected: PASS (placement-rules specs unchanged and green; `fleet.module.spec.ts` still compiles the module because
`FLEET_CFG` is already provided to the fleet modules).

- [ ] **Step 8: Write the integration spec**

`apps/api/test/integration/fleet/runner-views.integration.spec.ts` (Task 2 adds the summaries cases to this file):

```ts
/**
 * Fleet S1 slice 4a: the admin runner view (bootId, bootedAt, online; #158, D116, D117, D131).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/runner-views.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface AdminRunner { id: string; bootId: string; bootedAt: string | null; online: boolean; enabled: boolean }

describeIntegration('fleet runner views (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const adminGet = async (id: string) =>
    data<AdminRunner>(await request(server).get(`/api/fleet/runners/${id}`).set(auth(world.tokens.root)).expect(200));
  const sync = (bootId: string) =>
    request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ bootId })).expect(200);

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '200'; // an idle sync returns after 200 ms instead of 25 s
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });

  afterAll(async () => {
    await app.close();
    if (savedWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = savedWait;
  });

  it('shows bootId, bootedAt and online on the admin view (#158)', async () => {
    const r = await adminGet(runner.runnerId);
    expect(r.bootId).toBe('boot-1');
    expect(r.bootedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(r.online).toBe(true);
    const page = data<{ records: AdminRunner[] }>(await request(server).get('/api/fleet/runners').set(auth(world.tokens.root)).expect(200));
    expect(page.records[0]).toEqual(expect.objectContaining({ bootId: 'boot-1', online: true }));
  });

  it('moves bootedAt on a new boot id only', async () => {
    const before = (await adminGet(runner.runnerId)).bootedAt;
    await sync('boot-1');
    expect((await adminGet(runner.runnerId)).bootedAt).toBe(before);
    await sync('boot-2');
    const after = await adminGet(runner.runnerId);
    expect(after.bootId).toBe('boot-2');
    expect(Date.parse(after.bootedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''));
  });

  it('keeps bootedAt null for a runner row from before the migration', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { bootedAt: null } });
    expect((await adminGet(runner.runnerId)).bootedAt).toBeNull();
    await sync('boot-2');
    expect((await adminGet(runner.runnerId)).bootedAt).toBeNull();
  });

  it('reports offline once lastSeenAt is older than FLEET_RUNNER_OFFLINE_SEC, whatever enabled says', async () => {
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await adminGet(runner.runnerId);
    expect(r.online).toBe(false);
    expect(r.enabled).toBe(true);
  });
});
```

The third test proves D131's "no backfill" and that a same-boot sync never fills a null `bootedAt`.

- [ ] **Step 9: Run the integration spec**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/runner-views.integration.spec.ts`
Expected: PASS, 4 tests. Also run `bun run test:scoped test/integration/fleet/runner-admin.integration.spec.ts test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/placement.integration.spec.ts`
Expected: PASS (no behaviour change for them).

- [ ] **Step 10: Type-check, lint, commit**

Run: `cd apps/api && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261001090000_runner_booted_at \
  apps/api/src/fleet/common/runner-online.ts apps/api/src/fleet/common/runner-online.spec.ts \
  apps/api/src/fleet/jobs/placement-rules.ts apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts \
  apps/api/src/fleet/runners apps/api/test/integration/fleet/runner-views.integration.spec.ts
git commit -m "feat(fleet): runner bootId, bootedAt and online on the admin view (#158)"
```

---

### Task 2: Project runner summaries (`GET /api/projects/:slug/fleet/runners`)

**Files:**
- Create: `apps/api/src/fleet/runners/dto/runner-summary.dto.ts`, `apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts`
- Create: `apps/api/src/fleet/runners/project-fleet-runners.controller.ts`
- Modify: `apps/api/src/fleet/runners/runners.service.ts` (+ spec), `apps/api/src/fleet/runners/runners.module.ts`
- Modify: `apps/api/test/integration/fleet/runner-views.integration.spec.ts`

**Interfaces:**
- Consumes: `RunnerView`, `isRunnerOnline` (Task 1), `RunnersService.view` (Task 1).
- Produces: `RunnerSummaryDto { id, name, os, arch, labels, enabled, online, profiles }` with
  `static from(r: RunnerRecord, view: RunnerView): RunnerSummaryDto`;
  `RunnersService.listSummaries(page: IPageOption, now?: Date): Promise<IPageResult<RunnerSummaryDto>>`;
  route `GET /api/projects/:slug/fleet/runners` → generated SDK `projectFleetRunnersControllerList`.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/fleet/runners/dto/runner-summary.dto.spec.ts`:

```ts
import { RunnerSummaryDto } from './runner-summary.dto';
import type { RunnerRecord } from '../domain/runner.domain';

const now = new Date('2026-10-01T12:00:00.000Z');
const record = (capabilities: unknown, over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], capacity: 2, capabilities,
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', bootedAt: null, enabled: true,
  lastSeenAt: now, createdById: 'u1', createdAt: now, updatedAt: now, ...over,
});

describe('RunnerSummaryDto.from', () => {
  it('lists machine profile names sorted, and nothing else from the capability report', () => {
    const dto = RunnerSummaryDto.from(record({ profiles: { zeta: {}, alpha: {} }, credentials: [{ providerId: 'x' }] }), { now, offlineSec: 90 });
    expect(dto).toEqual({ id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, profiles: ['alpha', 'zeta'] });
  });

  it('answers no profiles for a malformed or empty report instead of throwing', () => {
    for (const caps of [null, {}, { profiles: null }, { profiles: ['a'] }, 'x']) {
      expect(RunnerSummaryDto.from(record(caps), { now, offlineSec: 90 }).profiles).toEqual([]);
    }
  });
});
```

In `runners.service.spec.ts` add:

```ts
  it('lists project summaries with online computed at the given time', async () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    repo.findRunnerPage.mockResolvedValue({
      total: 1, current: 1, size: 100, hasNext: false, hasPrev: false,
      records: [row({ lastSeenAt: now, capabilities: { profiles: { fast: {} } } })],
    });
    const page = await service.listSummaries({ current: 1, size: 100 }, now);
    expect(page.records).toEqual([expect.objectContaining({ id: 'r1', online: true, profiles: ['fast'] })]);
  });
```

(`remapPage` spreads `toPageResult(page)` and maps `records`, so a plain page object is enough; the same shape
as `fleet-activity.service.spec.ts` uses.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/fleet/runners`
Expected: FAIL: `Cannot find module './runner-summary.dto'` and `service.listSummaries is not a function`.

- [ ] **Step 3: Implement the DTO, the service method and the controller**

`apps/api/src/fleet/runners/dto/runner-summary.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { isRunnerOnline } from '../../common/runner-online';
import type { RunnerRecord } from '../domain/runner.domain';
import type { RunnerView } from './runner.dto';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Machine profile names from a stored capability report; [] when the report has none (D118). */
function profileNames(capabilities: unknown): string[] {
  if (!isRecord(capabilities) || !isRecord(capabilities['profiles'])) return [];
  return Object.keys(capabilities['profiles']).sort();
}

/**
 * What a project member needs to dispatch (labels, pin, profile chain) and to name runners in job
 * lists (overview D118). No versions, capacity, credentials or sandbox detail.
 */
export class RunnerSummaryDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) declare os: string;
  @ApiProperty({ enum: ['arm64', 'x64'] }) declare arch: string;
  @ApiProperty({ type: [String] }) declare labels: string[];
  @ApiProperty() declare enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC (the placement rule)' }) declare online: boolean;
  @ApiProperty({ type: [String], description: 'Machine profile names, sorted' }) declare profiles: string[];

  static from(r: RunnerRecord, view: RunnerView): RunnerSummaryDto {
    return Object.assign(new RunnerSummaryDto(), {
      id: r.id, name: r.name, os: r.os, arch: r.arch, labels: r.labels, enabled: r.enabled,
      online: isRunnerOnline(r.lastSeenAt, view.now, view.offlineSec), profiles: profileNames(r.capabilities),
    });
  }
}
```

In `runners.service.ts` import `RunnerSummaryDto` and add:

```ts
  /** Every runner, as a project member may see it (runners are global, overview D118). */
  async listSummaries(page: IPageOption, now = new Date()): Promise<IPageResult<RunnerSummaryDto>> {
    const view = this.view(now);
    return remapPage(await this.repo.findRunnerPage(page), (r) => RunnerSummaryDto.from(r, view));
  }
```

`apps/api/src/fleet/runners/project-fleet-runners.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { RunnersService } from './runners.service';
import { ListRunnersQuery } from './dto/list-runners.query';
import { RunnerSummaryDto } from './dto/runner-summary.dto';

// Nothing else references RunnerSummaryDto (the page response has only a description), so without
// ApiExtraModels it is missing from openapi.json and the CLI has no type for it (verified 2026-10-01).
@ApiExtraModels(RunnerSummaryDto)
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/runners')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetRunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Get()
  @ApiOperation({ summary: 'Runner summaries for dispatch and job lists (project member)' })
  @ApiResponse({ status: 200, description: 'Page of RunnerSummaryDto, ordered by name' })
  async list(@Query() rawQuery: ListRunnersQuery) {
    const { current, size } = parseQuery(ListRunnersQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.runners.listSummaries({ current, size })));
  }
}
```

`apps/api/src/fleet/runners/runners.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { EnrollmentsController } from './enrollments.controller';
import { RunnerApiController } from './runner-api.controller';
import { RunnersController } from './runners.controller';
import { ProjectFleetRunnersController } from './project-fleet-runners.controller';
import { EnrollmentService } from './enrollment.service';
import { RunnersService } from './runners.service';
import { PrismaRunnerRepository } from './prisma-runner.repository';
import { EnrollmentRetentionProcessor } from './enrollment-retention.processor';
import { RUNNER_REPOSITORY } from './domain/runner.domain';

@Module({
  imports: [PrismaModule, ProjectAccessModule, FleetActivityModule],
  controllers: [EnrollmentsController, RunnerApiController, RunnersController, ProjectFleetRunnersController],
  providers: [PrismaRunnerRepository, { provide: RUNNER_REPOSITORY, useExisting: PrismaRunnerRepository }, EnrollmentService, RunnersService, EnrollmentRetentionProcessor],
  exports: [RUNNER_REPOSITORY],
})
export class RunnersModule {}
```

(`ProjectAccessModule` exports `ProjectMembershipGuard` and `KodaCaslAbilityFactory`; the second must resolve or the
guard gets `undefined` for its optional CASL factory, see the comment in `project-access.module.ts`.)

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd apps/api && npx jest src/fleet/runners src/fleet/fleet.module.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the integration cases**

Append to the `describeIntegration` block of `runner-views.integration.spec.ts`, **before** the
`'reports offline ...'` test (that test leaves the runner offline):

```ts
  interface Summary { id: string; name: string; online: boolean; profiles: string[] }

  it('shows project members runner summaries with machine profile names only (D118)', async () => {
    const page = data<{ records: Array<Record<string, unknown>> }>(
      await request(server).get('/api/projects/web/fleet/runners').set(auth(world.tokens.viewer)).expect(200),
    );
    expect(page.records).toHaveLength(1);
    expect(Object.keys(page.records[0]).sort()).toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']);
    const summary = page.records[0] as unknown as Summary;
    expect(summary).toEqual(expect.objectContaining({ id: runner.runnerId, name: 'box-1', online: true, profiles: ['fast'] }));
  });

  it('refuses project runner summaries to outsiders and to runner keys', async () => {
    await request(server).get('/api/projects/web/fleet/runners').set(auth(world.tokens.outsider)).expect(403);
    await request(server).get('/api/projects/web/fleet/runners').set(auth(runner.apiKey)).expect(401);
    await request(server).get('/api/projects/nope/fleet/runners').set(auth(world.tokens.root)).expect(404);
  });
```

(`FLEET_CAPS`, which `enrollRunner` sends, has the single machine profile `fast`.) Update the file's header
comment to name D118 as well.

- [ ] **Step 6: Run the integration spec**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-views.integration.spec.ts`
Expected: PASS, 6 tests. If the unknown-slug case answers 403 instead of 404, read
`ProjectMembershipGuard.canActivate` and assert what it does for an unknown slug for a global admin (the
`project-fleet-repos` route behaves the same; keep the two consistent rather than changing the guard).

- [ ] **Step 7: Type-check, lint, commit**

Run: `cd apps/api && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/api/src/fleet/runners apps/api/test/integration/fleet/runner-views.integration.spec.ts
git commit -m "feat(fleet): project runner summaries for dispatch and job lists"
```

---

### Task 3: On-demand repo reachability (`POST /api/fleet/repos/:id/check`)

**Files:**
- Create: `apps/api/src/fleet/repos/dto/repo-check-result.dto.ts`
- Modify: `apps/api/src/fleet/repos/fleet-repos.service.ts` (+ spec), `apps/api/src/fleet/repos/fleet-repos.controller.ts`
- Modify: `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts`

**Interfaces:**
- Consumes: `GitHubAppClient.verifyRepo(owner, name)`, `GitLabAccessChecker.verifyRepo(owner, name, token)`,
  `GitLabTokenSource.resolve(projectId, owner, name)`, `RepoCheckException` (`.reason: RepoCheckReason`).
- Produces: `RepoCheckResultDto { repoId: string; reachable: boolean; reason: RepoCheckReason | null; checkedAt: string }`;
  `FleetReposService.check(id: string, now?: Date): Promise<RepoCheckResultDto>`; route
  `POST /api/fleet/repos/:id/check` → SDK `fleetReposControllerCheck`.

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` (add
`import { RepoCheckException } from '../git-broker/repo-check.exception';` at the top):

```ts
  describe('check', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');

    it('answers reachable for a GitHub repo the App can still reach', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
      expect(await make().check('fr1', now)).toEqual({ repoId: 'fr1', reachable: true, reason: null, checkedAt: now.toISOString() });
      expect(github.verifyRepo).toHaveBeenCalledWith('acme', 'app');
    });

    it('answers unreachable with the forge reason instead of throwing', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockRejectedValue(new RepoCheckException('app_not_installed'));
      expect(await make().check('fr1', now)).toEqual({ repoId: 'fr1', reachable: false, reason: 'app_not_installed', checkedAt: now.toISOString() });
    });

    it('checks a GitLab repo with the project token, and reports a lost connection as a reason', async () => {
      repo.findById.mockResolvedValue(created({ provider: 'gitlab', owner: 'group/sub', githubInstallationId: null }));
      gitlabTokens.resolve.mockRejectedValue(new RepoCheckException('vcs_connection_missing'));
      const result = await make().check('fr1', now);
      expect(gitlabTokens.resolve).toHaveBeenCalledWith('p1', 'group/sub', 'app');
      expect(result.reason).toBe('vcs_connection_missing');
      expect(gitlab.verifyRepo).not.toHaveBeenCalled();
    });

    it('rethrows anything that is not a forge verdict', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockRejectedValue(new Error('boom'));
      await expect(make().check('fr1', now)).rejects.toThrow('boom');
    });

    it('404s an unknown repo before calling the forge', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(make().check('nope', now)).rejects.toBeInstanceOf(NotFoundAppException);
      expect(github.verifyRepo).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/fleet/repos/fleet-repos.service.spec.ts`
Expected: FAIL: `make(...).check is not a function`.

- [ ] **Step 3: Implement**

`apps/api/src/fleet/repos/dto/repo-check-result.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import type { RepoCheckReason } from '../../git-broker/repo-check.exception';

const REASONS: RepoCheckReason[] = [
  'github_app_not_configured', 'github_app_key_unreadable', 'app_not_installed', 'app_permissions_insufficient',
  'repo_not_found', 'provider_unreachable', 'provider_error', 'vcs_connection_missing', 'vcs_connection_mismatch',
  'vcs_encryption_key_missing', 'gitlab_token_invalid', 'gitlab_access_insufficient', 'gitlab_scope_missing',
];

/** Result of re-running the registration forge check (overview D119); a failure is data, not an error. */
export class RepoCheckResultDto {
  @ApiProperty() declare repoId: string;
  @ApiProperty() declare reachable: boolean;
  @ApiProperty({ enum: REASONS, nullable: true }) declare reason: RepoCheckReason | null;
  @ApiProperty() declare checkedAt: string;
}
```

In `fleet-repos.service.ts` add the imports

```ts
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
```

and the method:

```ts
  /**
   * Re-runs the registration forge check (overview D119): can koda still broker git for this repo?
   * A forge verdict is returned as data; anything else is a real error and propagates.
   */
  async check(id: string, now = new Date()): Promise<RepoCheckResultDto> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    const result = (reachable: boolean, reason: RepoCheckResultDto['reason']) =>
      Object.assign(new RepoCheckResultDto(), { repoId: id, reachable, reason, checkedAt: now.toISOString() });
    try {
      if (row.provider === 'github') await this.github.verifyRepo(row.owner, row.name);
      else await this.verifyGitLab(row.projectId, row.owner, row.name);
      return result(true, null);
    } catch (error) {
      if (error instanceof RepoCheckException) return result(false, error.reason);
      throw error;
    }
  }
```

In `fleet-repos.controller.ts` import `RepoCheckResultDto` and add after `create`:

```ts
  @Post(':id/check')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Re-run the forge check for a registered repo (global admin)' })
  @ApiResponse({ status: 200, type: RepoCheckResultDto })
  @ApiResponse({ status: 404, description: 'No such repo' })
  async check(@Param('id') id: string) {
    return JsonResponse.Ok(await this.repos.check(id));
  }
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd apps/api && npx jest src/fleet/repos`
Expected: PASS.

- [ ] **Step 5: Add integration cases**

In `test/integration/fleet/fleet-repos.integration.spec.ts`, insert before the `'deletes a repo and records the
activity'` test (that test deletes `acme/app`):

```ts
  it('re-checks a registered repo on demand and reports a forge refusal as data (D119)', async () => {
    const all = data<{ records: Array<{ id: string; name: string }> }>(await request(server).get('/api/fleet/repos').set(auth(admin)).expect(200));
    const app1 = all.records.find((r) => r.name === 'app');
    const ok = data<{ repoId: string; reachable: boolean; reason: string | null }>(
      await request(server).post(`/api/fleet/repos/${app1?.id}/check`).set(auth(admin)).expect(200),
    );
    expect(ok).toEqual(expect.objectContaining({ repoId: app1?.id, reachable: true, reason: null }));

    forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 404, body: { message: 'provider-internal-detail' } }));
    const res = await request(server).post(`/api/fleet/repos/${app1?.id}/check`).set(auth(admin)).expect(200);
    expect(data<{ reachable: boolean; reason: string }>(res)).toEqual(expect.objectContaining({ reachable: false, reason: 'app_not_installed' }));
    expect(JSON.stringify(res.body)).not.toContain('provider-internal-detail');
    forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 200, body: { id: 77 } }));
  });

  it('keeps the repo check to admins and 404s an unknown repo', async () => {
    await request(server).post('/api/fleet/repos/nope/check').set(auth(admin)).expect(404);
    await request(server).post('/api/fleet/repos/nope/check').set(auth(member)).expect(403);
  });
```

Before running, confirm the forge route the GitHub check hits first for a registered repo is
`GET /repos/acme/app/installation` by reading `GitHubAppClient.verifyRepo`
(`apps/api/src/fleet/git-broker/github-app-client.ts:100`); if it calls another route first, refuse that one
instead and keep the assertion on the reason.

- [ ] **Step 6: Run the integration spec**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-repos.integration.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Type-check, lint, commit**

Run: `cd apps/api && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/api/src/fleet/repos apps/api/test/integration/fleet/fleet-repos.integration.spec.ts
git commit -m "feat(fleet): on-demand repo reachability check"
```

---

### Task 4: Typed slug params, `openapi.json` and the CLI client

**Files:**
- Create: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`, `apps/api/src/fleet/artifacts/job-bundle.controller.ts`, `apps/api/src/fleet/repos/project-fleet-repos.controller.ts`
- Modify: `openapi.json` (repo root, regenerated)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `openapi.json` with `RunnerDto.{bootId,bootedAt,online}`, `RunnerSummaryDto`, `RepoCheckResultDto`,
  `/api/projects/{slug}/fleet/runners`, `/api/fleet/repos/{id}/check`, and a `slug` path parameter on every
  `/api/projects/{slug}/fleet/**` operation; regenerated `apps/cli/src/generated` with
  `projectFleetRunnersControllerList`, `fleetReposControllerCheck` and `path: { slug, ... }` on project fleet calls.

- [ ] **Step 1: Write the failing contract spec**

`apps/api/src/fleet/fleet-openapi.contract.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Fleet slice 4a contract (overview D116-D120): the committed openapi.json must carry what the CLI
 * and web build on. Regenerate with `bun run api:export-spec` from the repo root.
 */
interface Operation { parameters?: Array<{ name: string; in: string; required?: boolean }> }
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('fleet OpenAPI contract', () => {
  it('declares the slug path param on every project-scoped fleet operation (D120)', () => {
    const scoped = Object.entries(spec.paths).filter(([path]) => path.startsWith('/api/projects/{slug}/fleet'));
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    for (const [path, methods] of scoped) {
      for (const [method, op] of Object.entries(methods)) {
        const slug = (op.parameters ?? []).find((p) => p.name === 'slug' && p.in === 'path');
        expect({ path, method, slug: Boolean(slug?.required) }).toEqual({ path, method, slug: true });
      }
    }
  });

  it('exposes the runner boot fields and online state (#158, D116, D117)', () => {
    expect(Object.keys(spec.components.schemas['RunnerDto']?.properties ?? {})).toEqual(expect.arrayContaining(['bootId', 'bootedAt', 'online']));
  });

  it('exposes project runner summaries and the repo check (D118, D119)', () => {
    expect(spec.paths['/api/projects/{slug}/fleet/runners']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/repos/{id}/check']?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['RunnerSummaryDto']?.properties ?? {}).sort())
      .toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']);
    expect(Object.keys(spec.components.schemas['RepoCheckResultDto']?.properties ?? {}).sort())
      .toEqual(['checkedAt', 'reachable', 'reason', 'repoId']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/fleet/fleet-openapi.contract.spec.ts`
Expected: FAIL on all three tests (no slug params on the existing project fleet routes; no new schemas yet).

- [ ] **Step 3: Add the class-level slug params**

In each of `fleet-jobs.controller.ts`, `job-bundle.controller.ts` and `project-fleet-repos.controller.ts`, add
`ApiParam` to the `@nestjs/swagger` import and this decorator directly above `@Controller(...)`:

```ts
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
```

- [ ] **Step 4: Export the spec and regenerate the CLI client**

Run (repo root): `bun run api:export-spec`
Expected: `OpenAPI spec exported to .../openapi.json`.

Run: `cd apps/api && npx jest src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS.

Run (repo root): `bun run generate:cli && grep -c "projectFleetRunnersControllerList\|fleetReposControllerCheck" apps/cli/src/generated/sdk.gen.ts`
Expected: a count of at least 2. Then
`grep -n "export type FleetJobsControllerCancelData" -A6 apps/cli/src/generated/types.gen.ts` shows a `path`
object containing `slug: string` (next to `id: string`; order does not matter).

- [ ] **Step 5: Check the whole API and CLI still build against the new contract**

Run: `cd apps/api && bun run test:unit && bun run type-check && bun run lint`
Expected: PASS / no errors.
Run: `cd apps/cli && bun run type-check && bun run test`
Expected: PASS (no CLI command uses the changed types yet).
Run: `cd apps/api && bun run test:scoped test/integration/openapi-spec test/integration/openapi-client`
Expected: PASS (these read the committed `openapi.json`).

- [ ] **Step 6: Commit**

```bash
git add openapi.json apps/api/src/fleet/fleet-openapi.contract.spec.ts \
  apps/api/src/fleet/jobs/fleet-jobs.controller.ts apps/api/src/fleet/artifacts/job-bundle.controller.ts \
  apps/api/src/fleet/repos/project-fleet-repos.controller.ts
git commit -m "feat(fleet): typed slug params and openapi export for slice 4"
```

---

### Task 5: CLI fleet foundation and `koda fleet runner`

**Files:**
- Create: `apps/cli/src/utils/api-error-code.ts`, `apps/cli/src/utils/api-error-code.spec.ts`
- Create: `apps/cli/src/commands/fleet-shared.ts`, `apps/cli/src/commands/fleet-shared.spec.ts`
- Create: `apps/cli/src/commands/fleet-runner.ts`, `apps/cli/src/commands/fleet-runner.spec.ts`
- Create: `apps/cli/src/commands/fleet.ts`, `apps/cli/src/commands/fleet.spec.ts`
- Modify: `apps/cli/src/index.ts` (import + registration after `ciWebhookCommand(program);`)

**Interfaces:**
- Consumes: generated `runnersControllerList`, `runnersControllerUpdate`, `enrollmentsControllerCreate`,
  `projectFleetReposControllerList`, `projectFleetRunnersControllerList`; types `RunnerDto`, `RunnerSummaryDto`,
  `FleetRepoDto`, `EnrollmentCreatedDto`, `DispatchResultDto`.
- Produces (Tasks 6-8 rely on these exact names):
  - `apiErrorCode(err: unknown): number | undefined` (`utils/api-error-code.ts`)
  - in `commands/fleet-shared.ts`: `interface FleetPage<T> { total: number; current: number; size: number; hasNext: boolean; records: T[] }`;
    `ADMIN_TOKEN_HINT: string`; `ago(iso: string | null | undefined, now?: Date): string`;
    `pageHint(page: FleetPage<unknown>): string | null`; `splitRepoPath(path: string): { owner: string; name: string } | null`;
    `resolveRepo(slug: string, ref: string): Promise<FleetRepoDto | null>`;
    `resolveRunner(slug: string, ref: string): Promise<RunnerSummaryDto | null>`;
    `runnerNames(slug: string): Promise<ReadonlyMap<string, string>>`;
    `printPlacement(result: DispatchResultDto, names: ReadonlyMap<string, string>): void`;
    `handleFleetError(err: unknown, opts?: { notFoundMessage?: string; adminHint?: boolean }): never`
  - `registerFleetRunner(fleet: Command): void` (`commands/fleet-runner.ts`)
  - `fleetCommand(program: Command): Command` (`commands/fleet.ts`) returns the `fleet` group; Tasks 6-8 add one
    `registerFleetX(fleet)` line each.

- [ ] **Step 1: Write the failing tests for the helpers**

`apps/cli/src/utils/api-error-code.spec.ts`:

```ts
import { apiErrorCode } from './api-error-code';

describe('apiErrorCode', () => {
  it('reads ret from the parsed error body the generated client throws', () => {
    expect(apiErrorCode({ ret: 409, message: 'An active job already runs this feature: j1' })).toBe(409);
  });

  it('answers undefined for anything without a numeric ret', () => {
    for (const err of [new Error('x'), 'text', null, undefined, { ret: '409' }, { status: 409 }]) {
      expect(apiErrorCode(err)).toBeUndefined();
    }
  });
});
```

`apps/cli/src/commands/fleet-shared.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
jest.mock('../generated', () => ({
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));

import { projectFleetReposControllerList, projectFleetRunnersControllerList } from '../generated';
import { ago, pageHint, printPlacement, resolveRepo, resolveRunner, runnerNames, splitRepoPath } from './fleet-shared';

const ok = <T>(data: T) => ({ ret: 0, data });
const page = <T>(records: T[]) => ok({ total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records });
const repoA = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const repoB = { id: 'fr2', projectId: 'p', provider: 'gitlab', owner: 'group/sub', name: 'svc', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true, profiles: [] };

describe('fleet-shared', () => {
  afterEach(() => jest.clearAllMocks());

  it('ago prints a compact age and - for no value', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    expect(ago(null, now)).toBe('-');
    expect(ago(undefined, now)).toBe('-');
    expect(ago('2026-10-01T11:59:18.000Z', now)).toBe('42s');
    expect(ago('2026-10-01T11:55:00.000Z', now)).toBe('5m');
    expect(ago('2026-10-01T09:00:00.000Z', now)).toBe('3h');
    expect(ago('2026-09-29T12:00:00.000Z', now)).toBe('2d');
    expect(ago('2026-10-01T12:00:05.000Z', now)).toBe('0s');
    expect(ago('not a date', now)).toBe('-');
  });

  it('pageHint names the next page only when there is one', () => {
    expect(pageHint({ total: 3, current: 1, size: 2, hasNext: true, records: [] })).toBe('Next: --page 2');
    expect(pageHint({ total: 1, current: 1, size: 2, hasNext: false, records: [] })).toBeNull();
  });

  it('splitRepoPath keeps GitLab subgroups in the owner', () => {
    expect(splitRepoPath('acme/app')).toEqual({ owner: 'acme', name: 'app' });
    expect(splitRepoPath('group/sub/app')).toEqual({ owner: 'group/sub', name: 'app' });
    for (const bad of ['app', '/app', 'acme/', '', 'a//b']) expect(splitRepoPath(bad)).toBeNull();
  });

  it('resolveRepo matches an id or owner/name case-insensitively, including subgroups', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repoA, repoB]));
    expect(await resolveRepo('web', 'fr2')).toEqual(repoB);
    expect(await resolveRepo('web', 'ACME/App')).toEqual(repoA);
    expect(await resolveRepo('web', 'group/sub/svc')).toEqual(repoB);
    expect(await resolveRepo('web', 'acme/other')).toBeNull();
    expect(projectFleetReposControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { size: 100 } });
  });

  it('resolveRunner matches an id or a name; runnerNames maps id to name', async () => {
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
    expect(await resolveRunner('web', 'box-1')).toEqual(box);
    expect(await resolveRunner('web', 'r1')).toEqual(box);
    expect(await resolveRunner('web', 'nope')).toBeNull();
    expect((await runnerNames('web')).get('r1')).toBe('box-1');
  });

  describe('handleFleetError', () => {
    let exit: jest.SpyInstance;
    let err: jest.SpyInstance;
    beforeEach(() => {
      exit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { exit.mockRestore(); err.mockRestore(); });
    const stderr = () => err.mock.calls.flat().join('\n');

    it.each([
      [{ ret: 40000, message: 'Unauthorized' }, 2],
      [{ ret: 40003, message: 'Forbidden' }, 2],
      [{ ret: -2, message: 'size must not be greater than 100' }, 3],
      [{ ret: 409, message: 'An active job already runs this feature: j1' }, 1],
      [{ ret: 422, message: 'The pinned runner can never run this job: tools' }, 1],
      [new Error('socket hang up'), 1],
    ])('maps %j to exit %i', (body, code) => {
      handleFleetError(body);
      expect(exit).toHaveBeenCalledWith(code);
    });

    it('maps 404 to exit 4 with the not-found message', () => {
      handleFleetError({ ret: 404, message: 'Runner not found' }, { notFoundMessage: 'Runner not found: r9' });
      expect(exit).toHaveBeenCalledWith(4);
      expect(stderr()).toContain('Runner not found: r9');
    });

    it('adds the admin-token hint to a 403 only when asked', () => {
      handleFleetError({ ret: 40003, message: 'Forbidden' }, { adminHint: true });
      expect(stderr()).toContain('global-admin user access token');
      err.mockClear();
      handleFleetError({ ret: 40003, message: 'Forbidden' });
      expect(stderr()).not.toContain('global-admin user access token');
    });
  });

  it('printPlacement shows the assigned runner by name, or each misfit', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const job = { id: 'j1', state: 'ASSIGNED' };
    printPlacement({ job, placement: { assigned: true, runnerId: 'r1', misfits: [] } } as never, new Map([['r1', 'box-1']]));
    expect(log.mock.calls.flat().join('\n')).toContain('Assigned to box-1');
    log.mockClear();
    printPlacement(
      { job: { id: 'j2', state: 'QUEUED' }, placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'box-1', reason: 'offline' }] } } as never,
      new Map(),
    );
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('Queued: no runner fits now');
    expect(out).toContain('offline');
    log.mockRestore();
  });
});
```

(`chalk` is ESM and `table()` uses it, hence the same mock `user.spec.ts` has.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && npx jest src/utils/api-error-code.spec.ts src/commands/fleet-shared.spec.ts`
Expected: FAIL: modules not found.

- [ ] **Step 3: Implement the helpers**

`apps/cli/src/utils/api-error-code.ts`:

```ts
/**
 * The generated client throws the parsed error body `{ ret, message }` for an HTTP failure; `ret` is the
 * API's AppException code (409 for a conflict). Read it as a structured code; never match the message.
 */
export function apiErrorCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('ret' in err)) return undefined;
  const ret = (err as { ret: unknown }).ret;
  return typeof ret === 'number' ? ret : undefined;
}
```

`apps/cli/src/commands/fleet-shared.ts`:

```ts
import {
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
  type DispatchResultDto,
  type FleetRepoDto,
  type RunnerSummaryDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { apiErrorCode } from '../utils/api-error-code';
import { handleApiError } from '../utils/error';
import { error, table } from '../utils/output';

export interface FleetPage<T> {
  total: number;
  current: number;
  size: number;
  hasNext: boolean;
  records: T[];
}

// Agent API keys never hold the global ADMIN authority; runner and repo-registry routes need a
// global-admin user's access token passed through KODA_API_KEY (same as `koda user`).
export const ADMIN_TOKEN_HINT = 'Requires a global-admin user access token: KODA_API_KEY=<token> koda fleet …';

/** Compact age of an ISO instant: 42s, 5m, 3h, 2d; '-' when absent or unparseable. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '-';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '-';
  const sec = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

export function pageHint(page: FleetPage<unknown>): string | null {
  return page.hasNext ? `Next: --page ${page.current + 1}` : null;
}

/** `owner/name`, where a GitLab owner may contain `/` (group/subgroup): the name is the last segment. */
export function splitRepoPath(path: string): { owner: string; name: string } | null {
  const cut = path.lastIndexOf('/');
  if (cut <= 0 || cut === path.length - 1) return null;
  const owner = path.slice(0, cut);
  if (owner.split('/').some((part) => part === '')) return null;
  return { owner, name: path.slice(cut + 1) };
}

// Fleets are a handful of repos and machines (overview D125): one page of 100 is the whole list.
async function projectRepos(slug: string): Promise<FleetRepoDto[]> {
  return unwrap<FleetPage<FleetRepoDto>>(await projectFleetReposControllerList({ path: { slug }, query: { size: 100 } })).records;
}

async function projectRunners(slug: string): Promise<RunnerSummaryDto[]> {
  return unwrap<FleetPage<RunnerSummaryDto>>(await projectFleetRunnersControllerList({ path: { slug }, query: { size: 100 } })).records;
}

/** A project repo by id, or by `owner/name` (case-insensitive, D133). */
export async function resolveRepo(slug: string, ref: string): Promise<FleetRepoDto | null> {
  const wanted = ref.toLowerCase();
  return (await projectRepos(slug)).find((r) => r.id === ref || `${r.owner}/${r.name}`.toLowerCase() === wanted) ?? null;
}

/** A runner by id or by name (D133). */
export async function resolveRunner(slug: string, ref: string): Promise<RunnerSummaryDto | null> {
  return (await projectRunners(slug)).find((r) => r.id === ref || r.name === ref) ?? null;
}

export async function runnerNames(slug: string): Promise<ReadonlyMap<string, string>> {
  return new Map((await projectRunners(slug)).map((r) => [r.id, r.name]));
}

// The API's error envelope carries an AppException code, not the HTTP status (Global Constraints).
// Repo-wide fix tracked in #176; fold this back into handleApiError when it lands.
const RET_STATUS: ReadonlyMap<number, number> = new Map([[40000, 401], [40003, 403], [404, 404], [-2, 400]]);

/**
 * handleApiError for fleet commands: maps the envelope code to the status handleApiError reads, so 401/403
 * exit 2, 404 exits 4 (with `notFoundMessage`) and validation exits 3. `adminHint` adds the admin-token hint to a 403.
 */
export function handleFleetError(err: unknown, opts: { notFoundMessage?: string; adminHint?: boolean } = {}): never {
  const code = apiErrorCode(err);
  const status = code === undefined ? undefined : RET_STATUS.get(code);
  if (status === 403 && opts.adminHint) error(ADMIN_TOKEN_HINT);
  const mapped = status === undefined ? err : { ...(err as Record<string, unknown>), status };
  return handleApiError(mapped, opts.notFoundMessage ? { notFoundMessage: opts.notFoundMessage } : undefined);
}

/** Dispatch and requeue answer: the job, and either its runner or why no runner fits now. */
export function printPlacement(result: DispatchResultDto, names: ReadonlyMap<string, string>): void {
  console.log(`Job ${result.job.id} ${result.job.state}`);
  const { placement } = result;
  if (placement.assigned && placement.runnerId) {
    console.log(`Assigned to ${names.get(placement.runnerId) ?? placement.runnerId}`);
    return;
  }
  console.log('Queued: no runner fits now');
  if (placement.misfits.length > 0) {
    table(['Runner', 'Reason'], placement.misfits.map((m) => [m.name, m.reason]));
  }
}
```

If `bun run type-check` reports that `projectFleetReposControllerList`'s generated query type has no `size`, read
`ProjectFleetReposControllerListData` in `types.gen.ts`; the page query (`current`, `size`) is inherited by
`ListFleetReposQuery`, so it should be there after Task 4. Do not cast around a missing field: fix the API query
DTO's swagger metadata instead.

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `cd apps/cli && npx jest src/utils/api-error-code.spec.ts src/commands/fleet-shared.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing runner command tests**

`apps/cli/src/commands/fleet-runner.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  runnersControllerList: jest.fn(),
  runnersControllerUpdate: jest.fn(),
  enrollmentsControllerCreate: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { enrollmentsControllerCreate, runnersControllerList, runnersControllerUpdate } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const runner = {
  id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: ['linux', 'gpu'], capacity: 2,
  capabilities: { nax: { version: '0.83.1' } }, daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b1',
  bootedAt: null, online: true, enabled: true, lastSeenAt: new Date().toISOString(), createdAt: '2026-10-01T00:00:00.000Z',
};
const page = { total: 1, current: 1, size: 100, hasNext: false, hasPrev: false, records: [runner] };

describe('koda fleet runner', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'runner', ...args]);
  const out = () => logSpy.mock.calls.flat().join('\n');

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('list prints name, online, enabled, labels, capacity, nax version and boot age', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    expect(runnersControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 100 } });
    expect(out()).toContain('box-1');
    expect(out()).toContain('linux,gpu');
    expect(out()).toContain('0.83.1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('list prints - for a runner with no recorded boot', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    const row = out().split('\n').find((l) => l.includes('box-1')) ?? '';
    expect(row).toMatch(/\s-(\s|$)/);
  });

  it('list --json prints the page', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list', '--json');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
  });

  it('a non-admin gets exit 2 and the admin-token hint', async () => {
    (runnersControllerList as jest.Mock).mockRejectedValue({ ret: 40003, message: 'Forbidden' });
    await run('list');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect((console.error as jest.Mock).mock.calls.flat().join('\n')).toContain('global-admin user access token');
  });

  it('enable and disable patch only enabled', async () => {
    (runnersControllerUpdate as jest.Mock).mockResolvedValue({ ret: 0, data: runner });
    await run('disable', 'r1');
    expect(runnersControllerUpdate).toHaveBeenCalledWith({ path: { id: 'r1' }, body: { enabled: false } });
    await run('enable', 'r1');
    expect(runnersControllerUpdate).toHaveBeenLastCalledWith({ path: { id: 'r1' }, body: { enabled: true } });
  });

  it('enroll-token sends labels and prints the token once with the enroll command line', async () => {
    (enrollmentsControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0, data: { id: 'e1', labels: ['gpu', 'linux'], expiresAt: '2026-10-02T00:00:00.000Z', createdById: 'u', createdAt: '', token: 'ke_secret' },
    });
    await run('enroll-token', '--label', 'gpu', '--label', 'linux');
    expect(enrollmentsControllerCreate).toHaveBeenCalledWith({ body: { labels: ['gpu', 'linux'] } });
    expect(out()).toContain('ke_secret');
    expect(out()).toContain('koda-runner enroll --server https://koda.example.com --token ke_secret');
    expect(out()).toContain('2026-10-02T00:00:00.000Z');
  });

  it('enroll-token rejects a bad label before any request (exit 3)', async () => {
    await run('enroll-token', '--label', 'Bad Label');
    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(enrollmentsControllerCreate).not.toHaveBeenCalled();
  });
});
```

`apps/cli/src/commands/fleet.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
jest.mock('conf', () => jest.fn(() => ({ get: jest.fn(() => ''), set: jest.fn() })));
jest.mock('../generated', () => ({}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';

describe('fleetCommand', () => {
  it('registers the fleet group with runner, repo, dispatch and job', () => {
    const program = new Command();
    fleetCommand(program);
    const fleet = program.commands.find((c) => c.name() === 'fleet');
    expect(fleet?.commands.map((c) => c.name()).sort()).toEqual(['runner']);
  });
});
```

(Tasks 6-8 extend the expected list to `['dispatch', 'job', 'repo', 'runner']` as they register their groups.)

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/cli && npx jest src/commands/fleet-runner.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL: `Cannot find module './fleet'`.

- [ ] **Step 7: Implement `fleet.ts`, `fleet-runner.ts` and the registration**

`apps/cli/src/commands/fleet.ts`:

```ts
import { Command } from 'commander';
import { registerFleetRunner } from './fleet-runner';

/** `koda fleet …`: runners, repos, dispatch and jobs (fleet S1 spec §11). */
export function fleetCommand(program: Command): Command {
  const fleet = program.command('fleet');
  fleet.description('Dispatch nax runs to fleet runners and follow the jobs');
  registerFleetRunner(fleet);
  return fleet;
}
```

`apps/cli/src/commands/fleet-runner.ts`:

```ts
import { Command } from 'commander';
import {
  enrollmentsControllerCreate,
  runnersControllerList,
  runnersControllerUpdate,
  type EnrollmentCreatedDto,
  type RunnerDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { error, table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, ago, type FleetPage, handleFleetError, pageHint } from './fleet-shared';

const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/; // UpdateRunnerDto / CreateEnrollmentDto LABEL_PATTERN

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function naxVersion(r: RunnerDto): string {
  const nax = (r.capabilities as { nax?: { version?: unknown } }).nax;
  return typeof nax?.version === 'string' ? nax.version : '-';
}

function runnerRow(r: RunnerDto): string[] {
  return [
    r.name, r.id, r.online ? 'yes' : 'no', r.enabled ? 'yes' : 'no', r.labels.join(','), String(r.capacity),
    naxVersion(r), ago(r.lastSeenAt), ago(r.bootedAt),
  ];
}

function registerList(runner: Command): void {
  runner
    .command('list')
    .description('List runners with online state, labels, capacity and boot age')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 100)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const page = unwrap<FleetPage<RunnerDto>>(await runnersControllerList({ query: { current: options.page, size: options.size } }));
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['Name', 'ID', 'Online', 'Enabled', 'Labels', 'Cap', 'nax', 'Last seen', 'Boot age'], page.records.map(runnerRow));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true });
      }
    });
}

function registerToggle(runner: Command, name: 'enable' | 'disable'): void {
  const enabled = name === 'enable';
  runner
    .command(`${name} <runnerId>`)
    .description(enabled ? 'Let placement use the runner again' : 'Drain the runner: running jobs finish, no new jobs')
    .option('--json', 'Output as JSON')
    .action(async (runnerId: string, options) => {
      try {
        await withContext({}, { requireProject: false });
        const updated = unwrap<RunnerDto>(await runnersControllerUpdate({ path: { id: runnerId }, body: { enabled } }));
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`Runner ${updated.name} ${enabled ? 'enabled' : 'disabled'}`);
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true, notFoundMessage: `Runner not found: ${runnerId}` });
      }
    });
}

function registerEnrollToken(runner: Command): void {
  runner
    .command('enroll-token')
    .description('Issue a single-use enrollment token (shown once, valid 24h by default)')
    .option('--label <label>', 'Label preset on the enrolling runner (repeatable)', collect, [] as string[])
    .option('--json', 'Output as JSON')
    .action(async (options: { label: string[]; json?: boolean }) => {
      const bad = options.label.find((l) => !LABEL.test(l));
      if (bad !== undefined) {
        error(`Invalid label "${bad}": lowercase letters, digits, . _ -; at most 32 characters`);
        process.exit(3);
        return;
      }
      try {
        const ctx = await withContext({}, { requireProject: false });
        const created = unwrap<EnrollmentCreatedDto>(await enrollmentsControllerCreate({ body: { labels: options.label } }));
        if (options.json) {
          console.log(JSON.stringify(created, null, 2));
        } else {
          const server = ctx.apiUrl.replace(/\/api\/?$/, '');
          console.log(`Token (shown once): ${created.token}`);
          console.log(`Expires: ${created.expiresAt}`);
          console.log(`On the runner machine: koda-runner enroll --server ${server} --token ${created.token}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true });
      }
    });
}

export function registerFleetRunner(fleet: Command): void {
  const runner = fleet.command('runner');
  runner.description(`Fleet runners (global admin). ${ADMIN_TOKEN_HINT}`);
  registerList(runner);
  registerToggle(runner, 'enable');
  registerToggle(runner, 'disable');
  registerEnrollToken(runner);
}
```

In `apps/cli/src/index.ts` add `import { fleetCommand } from './commands/fleet';` after the
`ciWebhookCommand` import and, after `ciWebhookCommand(program);`:

```ts
// Fleet command (runners, repos, dispatch, jobs)
fleetCommand(program);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/cli && npx jest src/commands/fleet src/utils/api-error-code.spec.ts`
Expected: PASS.

- [ ] **Step 9: Type-check, lint, commit**

Run: `cd apps/cli && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/cli/src/utils/api-error-code.ts apps/cli/src/utils/api-error-code.spec.ts \
  apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts \
  apps/cli/src/commands/fleet-shared.ts apps/cli/src/commands/fleet-shared.spec.ts \
  apps/cli/src/commands/fleet-runner.ts apps/cli/src/commands/fleet-runner.spec.ts apps/cli/src/index.ts
git commit -m "feat(cli): koda fleet runner list, enable, disable, enroll-token"
```

---

### Task 6: `koda fleet repo add|list|rm|check`

**Files:**
- Create: `apps/cli/src/commands/fleet-repo.ts`, `apps/cli/src/commands/fleet-repo.spec.ts`
- Modify: `apps/cli/src/commands/fleet.ts` (+ `fleet.spec.ts` expected list)

**Interfaces:**
- Consumes: `splitRepoPath`, `pageHint`, `FleetPage`, `ADMIN_TOKEN_HINT` (Task 5); generated
  `fleetReposControllerCreate`, `fleetReposControllerList`, `fleetReposControllerRemove`, `fleetReposControllerCheck`,
  `projectFleetReposControllerList`; `requireForce` (`utils/force.ts`).
- Produces: `registerFleetRepo(fleet: Command): void`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/commands/fleet-repo.spec.ts` (same mock boilerplate as `fleet-runner.spec.ts`, with this
`../generated` mock):

```ts
jest.mock('../generated', () => ({
  fleetReposControllerCreate: jest.fn(),
  fleetReposControllerList: jest.fn(),
  fleetReposControllerRemove: jest.fn(),
  fleetReposControllerCheck: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
}));
```

and these tests. The Task 6-8 specs reuse the Task 5 runner spec's `describe`/`beforeEach`/`afterEach` shell
verbatim (program built with `fleetCommand(program)`, `afterEach(() => jest.clearAllMocks())`); fixtures go at
module level, while `run` and any spy go inside the `describe` (they close over `program`). Here
`const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'repo', ...a]);`:

```ts
const repo = { id: 'fr1', projectId: 'p', provider: 'gitlab', owner: 'group/sub', name: 'svc', defaultBranch: 'main', githubInstallationId: null, createdAt: '' };
const page = { total: 1, current: 1, size: 100, hasNext: false, hasPrev: false, records: [repo] };

  it('add splits a GitLab subgroup path and sends the project slug in the body', async () => {
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
    await run('add', 'group/sub/svc', '--provider', 'gitlab');
    expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: { projectSlug: 'web', provider: 'gitlab', owner: 'group/sub', name: 'svc' } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('add refuses a path without owner/name and an unknown provider (exit 3, no request)', async () => {
    await run('add', 'svc', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(3);
    await run('add', 'acme/app', '--provider', 'bitbucket');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetReposControllerCreate).not.toHaveBeenCalled();
  });

  it('add surfaces a forge refusal (422) as an API error, exit 1', async () => {
    (fleetReposControllerCreate as jest.Mock).mockRejectedValue({ ret: 422, message: 'Forge check failed: app_not_installed' });
    await run('add', 'acme/app', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('list shows the project repos by default and the whole registry with --all', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    (fleetReposControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    expect(projectFleetReposControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { current: 1, size: 100 } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('group/sub/svc');
    await run('list', '--all');
    expect(fleetReposControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 100 } });
  });

  it('rm needs --force and never calls the API without it', async () => {
    await run('rm', 'fr1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fleetReposControllerRemove).not.toHaveBeenCalled();
    (fleetReposControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 'fr1', '--force');
    expect(fleetReposControllerRemove).toHaveBeenCalledWith({ path: { id: 'fr1' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('check prints reachable, or the reason and exits 1 when unreachable', async () => {
    (fleetReposControllerCheck as jest.Mock).mockResolvedValue({ ret: 0, data: { repoId: 'fr1', reachable: true, reason: null, checkedAt: '' } });
    await run('check', 'fr1');
    expect(fleetReposControllerCheck).toHaveBeenCalledWith({ path: { id: 'fr1' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
    (fleetReposControllerCheck as jest.Mock).mockResolvedValue({ ret: 0, data: { repoId: 'fr1', reachable: false, reason: 'app_not_installed', checkedAt: '' } });
    await run('check', 'fr1');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('app_not_installed');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
```

In `fleet.spec.ts`, change the expected list to `['repo', 'runner']`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && npx jest src/commands/fleet-repo.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL (`repo` is not a command).

- [ ] **Step 3: Implement**

`apps/cli/src/commands/fleet-repo.ts`:

```ts
import { Command } from 'commander';
import {
  fleetReposControllerCheck,
  fleetReposControllerCreate,
  fleetReposControllerList,
  fleetReposControllerRemove,
  projectFleetReposControllerList,
  type FleetRepoDto,
  type RepoCheckResultDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { requireForce } from '../utils/force';
import { error, table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, type FleetPage, handleFleetError, pageHint, splitRepoPath } from './fleet-shared';

const PROVIDERS = ['github', 'gitlab'] as const;
type Provider = (typeof PROVIDERS)[number];

function registerAdd(repo: Command): void {
  repo
    .command('add <ownerAndName>')
    .description(`Register a repo for dispatch after koda proves it can broker git access (global admin). ${ADMIN_TOKEN_HINT}`)
    .requiredOption('--provider <provider>', 'github or gitlab')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (ownerAndName: string, options: { provider: string; project?: string; json?: boolean }) => {
      const parts = splitRepoPath(ownerAndName);
      if (!parts || !(PROVIDERS as readonly string[]).includes(options.provider)) {
        error(!parts ? `Expected owner/name, got "${ownerAndName}"` : `Unknown provider "${options.provider}": github or gitlab`);
        process.exit(3);
        return;
      }
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const created = unwrap<FleetRepoDto>(await fleetReposControllerCreate({
          body: { projectSlug: ctx.projectSlug, provider: options.provider as Provider, owner: parts.owner, name: parts.name },
        }));
        if (options.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`Registered ${created.owner}/${created.name} (${created.id}), default branch ${created.defaultBranch}`);
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true });
      }
    });
}

function registerList(repo: Command): void {
  repo
    .command('list')
    .description("List the project's fleet repos (--all: the whole registry, global admin)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--all', 'Every registered repo (global admin)')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 100)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const query = { current: options.page, size: options.size };
        let response: unknown;
        if (options.all) {
          await withContext({}, { requireProject: false });
          response = await fleetReposControllerList({ query });
        } else {
          const ctx = await withContext({ projectSlug: options.project });
          response = await projectFleetReposControllerList({ path: { slug: ctx.projectSlug }, query });
        }
        const page = unwrap<FleetPage<FleetRepoDto>>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['ID', 'Provider', 'Repo', 'Default branch'], page.records.map((r) => [r.id, r.provider, `${r.owner}/${r.name}`, r.defaultBranch]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: Boolean(options.all) });
      }
    });
}

function registerRemove(repo: Command): void {
  repo
    .command('rm <repoId>')
    .description('Unregister a repo; refused while it has unfinished jobs (global admin)')
    .option('--force', 'Confirm the removal')
    .action(async (repoId: string, options: { force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        await withContext({}, { requireProject: false });
        await fleetReposControllerRemove({ path: { id: repoId } });
        console.log(`Removed repo ${repoId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true, notFoundMessage: `Repo not found: ${repoId}` });
      }
    });
}

function registerCheck(repo: Command): void {
  repo
    .command('check <repoId>')
    .description('Re-run the forge check: can koda still broker git for this repo? Exit 1 when not (global admin)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { json?: boolean }) => {
      try {
        await withContext({}, { requireProject: false });
        const result = unwrap<RepoCheckResultDto>(await fleetReposControllerCheck({ path: { id: repoId } }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(result.reachable ? `Reachable (${result.checkedAt})` : `Unreachable: ${result.reason ?? 'unknown'} (${result.checkedAt})`);
        process.exit(result.reachable ? 0 : 1);
      } catch (err: unknown) {
        handleFleetError(err, { adminHint: true, notFoundMessage: `Repo not found: ${repoId}` });
      }
    });
}

export function registerFleetRepo(fleet: Command): void {
  const repo = fleet.command('repo');
  repo.description('Fleet repo registry');
  registerAdd(repo);
  registerList(repo);
  registerRemove(repo);
  registerCheck(repo);
}
```

In `fleet.ts` import `registerFleetRepo` and call it after `registerFleetRunner(fleet);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && npx jest src/commands/fleet`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

Run: `cd apps/cli && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/cli/src/commands/fleet-repo.ts apps/cli/src/commands/fleet-repo.spec.ts apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts
git commit -m "feat(cli): koda fleet repo add, list, rm, check"
```

---

### Task 7: `koda fleet dispatch`

**Files:**
- Create: `apps/cli/src/utils/parse-usd.ts`, `apps/cli/src/utils/parse-usd.spec.ts`
- Create: `apps/cli/src/commands/fleet-dispatch.ts`, `apps/cli/src/commands/fleet-dispatch.spec.ts`
- Modify: `apps/cli/src/commands/fleet.ts` (+ `fleet.spec.ts`)

**Interfaces:**
- Consumes: `resolveRepo`, `resolveRunner`, `runnerNames`, `printPlacement` (Task 5); `apiErrorCode` (Task 5);
  generated `fleetJobsControllerDispatch`, `fleetJobsControllerList`.
- Produces: `parseUsd(value: string): number`; `findActiveJob(slug: string, repoId: string, feature: string): Promise<FleetJobDto | null>`
  (exported from `fleet-dispatch.ts`); `registerFleetDispatch(fleet: Command): void`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/utils/parse-usd.spec.ts`:

```ts
import { InvalidArgumentError } from 'commander';
import { parseUsd } from './parse-usd';

describe('parseUsd', () => {
  it.each([['5', 5], ['0.0001', 0.0001], ['10000', 10000], [' 2.5 ', 2.5]])('accepts %s', (raw, value) => {
    expect(parseUsd(raw)).toBe(value);
  });

  it.each(['0', '-1', '1e3', '0.00001', '10000.01', 'abc', '', '1.', '.5', '0x10'])('rejects %p', (raw) => {
    expect(() => parseUsd(raw)).toThrow(InvalidArgumentError);
  });
});
```

`apps/cli/src/commands/fleet-dispatch.spec.ts` (same boilerplate as `fleet-runner.spec.ts`; `../generated` mock with
`fleetJobsControllerDispatch`, `fleetJobsControllerList`, `projectFleetReposControllerList`,
`projectFleetRunnersControllerList`). Reuse the Task 5 shell as described in Task 6; the `run` and `beforeEach`
lines below go inside the `describe`:

```ts
const repo = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: ['gpu'], enabled: true, online: true, profiles: ['fast'] };
const job = (over = {}) => ({ id: 'j1', state: 'ASSIGNED', repoId: 'fr1', feature: 'login', ...over });
const page = <T>(records: T[]) => ({ ret: 0, data: { total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records } });
const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'dispatch', ...a]);

  beforeEach(() => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repo]));
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
  });

  it('dispatches a RUN by repo name with profiles and labels, and prints the assigned runner', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--profile', 'fast', '--profile', 'cheap', '--label', 'gpu');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 5, profiles: ['fast', 'cheap'], selectorLabels: ['gpu'] },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Assigned to box-1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches a PLAN when --plan is given, pinned by runner name, with a ref', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job({ state: 'QUEUED' }), placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'box-1', reason: 'offline' }] } } });
    await run('--repo', 'fr1', '--feature', 'login', '--max-cost', '1', '--plan', 'docs/spec.md', '--pin', 'box-1', '--ref', 'dev');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'PLAN', feature: 'login', maxCostUsd: 1, planFrom: 'docs/spec.md', pinnedRunnerId: 'r1', ref: 'dev' },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('offline');
  });

  it('refuses --label with --pin, an unknown repo and an unknown runner before dispatching (exit 3)', async () => {
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--label', 'gpu', '--pin', 'box-1');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/nope', '--feature', 'f', '--max-cost', '1');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--pin', 'ghost');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('rejects a bad --max-cost before any request', async () => {
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '0')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('on a duplicate (409) names the active job and exits 1', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job({ id: 'j9', state: 'COMPLETED' }), job({ id: 'j0', state: 'RUNNING' })]));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(fleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { repoId: 'fr1', feature: 'login', size: 20 } });
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('j0');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('on a 409 whose job already finished, falls back to the API message', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job({ id: 'j0', state: 'COMPLETED' })]));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('An active job already runs this feature');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
```

Declare `let errorSpy: jest.SpyInstance;` and assign it in `beforeEach`
(`errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});`); `output.error()` and `handleApiError`
write through `console.error`.

In `fleet.spec.ts`, change the expected list to `['dispatch', 'repo', 'runner']`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && npx jest src/utils/parse-usd.spec.ts src/commands/fleet-dispatch.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL: modules not found.

- [ ] **Step 3: Implement**

`apps/cli/src/utils/parse-usd.ts`:

```ts
import { InvalidArgumentError } from 'commander';

/**
 * Commander parser for a USD budget: > 0, at most 10000, at most 4 decimals (DispatchFleetJobDto.maxCostUsd).
 * Plain decimal notation only: no exponent, sign or hex, so what the user typed is what is sent.
 */
export function parseUsd(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    throw new InvalidArgumentError('must be a USD amount with at most 4 decimals, for example 5 or 0.25');
  }
  const parsed = Number(trimmed);
  if (parsed <= 0 || parsed > 10_000) throw new InvalidArgumentError('must be more than 0 and at most 10000');
  return parsed;
}
```

`apps/cli/src/commands/fleet-dispatch.ts`:

```ts
import { Command } from 'commander';
import {
  fleetJobsControllerDispatch,
  fleetJobsControllerList,
  type DispatchFleetJobDto,
  type DispatchResultDto,
  type FleetJobDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { apiErrorCode } from '../utils/api-error-code';
import { withContext } from '../utils/context';
import { error } from '../utils/output';
import { parseUsd } from '../utils/parse-usd';
import { type FleetPage, handleFleetError, printPlacement, resolveRepo, resolveRunner, runnerNames } from './fleet-shared';

const ACTIVE = new Set(['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING']);
const collect = (value: string, previous: string[]): string[] => [...previous, value];

interface DispatchOptions {
  repo: string; feature: string; maxCost: number; plan?: string; ref?: string;
  profile: string[]; label: string[]; pin?: string; project?: string; json?: boolean;
}

/**
 * The active job behind a dispatch 409 (overview D121): the partial unique index allows at most one active
 * job per (repo, feature), and the list is newest first.
 */
export async function findActiveJob(slug: string, repoId: string, feature: string): Promise<FleetJobDto | null> {
  const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query: { repoId, feature, size: 20 } }));
  return page.records.find((j) => ACTIVE.has(j.state)) ?? null;
}

/** Validation failure: message to stderr, exit 3 (`.nax/rules/cli.md`). Returns null so callers can `return invalid(...)`. */
function invalid(message: string): null {
  error(message);
  process.exit(3);
  return null;
}

async function buildBody(slug: string, o: DispatchOptions): Promise<DispatchFleetJobDto | null> {
  if (o.pin && o.label.length > 0) return invalid('Use --label or --pin, not both: a pinned job ignores labels');
  const repo = await resolveRepo(slug, o.repo);
  if (!repo) return invalid(`Unknown repo "${o.repo}" in project ${slug}: koda fleet repo list`);
  const pinned = o.pin ? await resolveRunner(slug, o.pin) : null;
  if (o.pin && !pinned) return invalid(`Unknown runner "${o.pin}"`);
  return {
    repoId: repo.id, command: o.plan ? 'PLAN' : 'RUN', feature: o.feature, maxCostUsd: o.maxCost,
    ...(o.plan ? { planFrom: o.plan } : {}),
    ...(o.profile.length > 0 ? { profiles: o.profile } : {}),
    ...(o.label.length > 0 ? { selectorLabels: o.label } : {}),
    ...(pinned ? { pinnedRunnerId: pinned.id } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
  };
}

/** A 409 on dispatch names the active job (D133, overview D121); any other error, or a failed lookup, reports as-is. */
async function explainConflict(err: unknown, slug: string, body: DispatchFleetJobDto): Promise<void> {
  if (apiErrorCode(err) !== 409) return handleFleetError(err);
  let active: FleetJobDto | null = null;
  try {
    active = await findActiveJob(slug, body.repoId, body.feature);
  } catch {
    // The lookup is a courtesy; the original 409 is the answer.
  }
  if (!active) return handleFleetError(err);
  error(`An active job already runs ${body.feature} on this repo: ${active.id} (${active.state}). koda fleet job show ${active.id}`);
  process.exit(1);
}

export function registerFleetDispatch(fleet: Command): void {
  fleet
    .command('dispatch')
    .description('Dispatch a nax run (or, with --plan, a nax plan) for a project repo to a fleet runner')
    .requiredOption('--repo <repo>', 'Repo id or owner/name (koda fleet repo list)')
    .requiredOption('--feature <name>', 'nax feature name')
    .requiredOption('--max-cost <usd>', 'Budget in USD, at most 4 decimals', parseUsd)
    .option('--plan <specPath>', 'Run nax plan from this repo-relative spec instead of nax run')
    .option('--ref <ref>', 'Git ref to check out (default: the repo default branch)')
    .option('--profile <name>', 'nax profile, repeatable; later wins', collect, [] as string[])
    .option('--label <label>', 'Only runners with this label, repeatable', collect, [] as string[])
    .option('--pin <runner>', 'Run on this runner (id or name); excludes --label')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: DispatchOptions) => {
      let body: DispatchFleetJobDto | null = null;
      let slug = '';
      try {
        const ctx = await withContext({ projectSlug: options.project });
        slug = ctx.projectSlug;
        body = await buildBody(slug, options);
        if (!body) return;
        const result = unwrap<DispatchResultDto>(await fleetJobsControllerDispatch({ path: { slug }, body }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printPlacement(result, result.placement.assigned ? await runnerNames(slug) : new Map());
        process.exit(0);
      } catch (err: unknown) {
        if (body) await explainConflict(err, slug, body);
        else handleFleetError(err);
      }
    });
}
```

Add one more test to `fleet-dispatch.spec.ts`:

```ts
  it('on a 409 whose lookup fails, still reports the original conflict', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockRejectedValue(new Error('network down'));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('An active job already runs this feature');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
```

In `fleet.ts` import `registerFleetDispatch` and call it after `registerFleetRepo(fleet);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && npx jest src/utils/parse-usd.spec.ts src/commands/fleet`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

Run: `cd apps/cli && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/cli/src/utils/parse-usd.ts apps/cli/src/utils/parse-usd.spec.ts \
  apps/cli/src/commands/fleet-dispatch.ts apps/cli/src/commands/fleet-dispatch.spec.ts \
  apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts
git commit -m "feat(cli): koda fleet dispatch"
```

---

### Task 8: `koda fleet job list|show|cancel|requeue|bundle`

**Files:**
- Create: `apps/cli/src/commands/fleet-job.ts`, `apps/cli/src/commands/fleet-job.spec.ts`
- Modify: `apps/cli/src/commands/fleet.ts` (+ `fleet.spec.ts`)

**Interfaces:**
- Consumes: `resolveRepo`, `resolveRunner`, `runnerNames`, `printPlacement`, `pageHint`, `ago`, `FleetPage`
  (Task 5); generated `fleetJobsControllerList`,
  `fleetJobsControllerGet`, `fleetJobsControllerCancel`, `fleetJobsControllerRequeue`, `jobBundleControllerDownload`.
- Produces: `registerFleetJob(fleet: Command): void`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/commands/fleet-job.spec.ts` (same boilerplate as `fleet-runner.spec.ts`, plus the `errorSpy` of
Task 7; `../generated` mock with the five job functions plus `projectFleetReposControllerList` and
`projectFleetRunnersControllerList`; also mock `fs/promises`). The `run`, `beforeEach` and `it` blocks go inside
the `describe`:

```ts
const mockWriteFile = jest.fn();
jest.mock('fs/promises', () => ({ writeFile: (...a: unknown[]) => mockWriteFile(...a) }));

const repo = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true, profiles: [] };
const job = (over = {}) => ({
  id: 'j1', projectId: 'p', repoId: 'fr1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: ['fast'],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: 'r1', leaseEpoch: 1,
  state: 'RUNNING', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T10:00:00.000Z',
  currentStoryId: 'US-002', currentPhase: 'implement', costSpentUsd: '1.2500', finishResult: null,
  escalationReason: null, resultBranch: null, resultPrUrl: null, ...over,
});
const page = <T>(records: T[], hasNext = false) => ({ ret: 0, data: { total: records.length, current: 1, size: 20, hasNext, hasPrev: false, records } });
const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'job', ...a]);

  beforeEach(() => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repo]));
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
    mockWriteFile.mockReset();
  });

  it('list filters by state, repo name and runner name, and shows runner names', async () => {
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job()], true));
    await run('list', '--state', 'RUNNING', '--repo', 'acme/app', '--runner', 'box-1', '--requested-by', 'u1');
    expect(fleetJobsControllerList).toHaveBeenCalledWith({
      path: { slug: 'web' },
      query: { current: 1, size: 20, state: 'RUNNING', repoId: 'fr1', runnerId: 'r1', requestedById: 'u1' },
    });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('box-1');
    expect(out).toContain('Next: --page 2');
  });

  it('list rejects an unknown --state before any request (exit 3)', async () => {
    await run('list', '--state', 'DONE');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetJobsControllerList).not.toHaveBeenCalled();
  });

  it('show prints the job fields with runner name, story, phase and cost', async () => {
    (fleetJobsControllerGet as jest.Mock).mockResolvedValue({ ret: 0, data: job() });
    await run('show', 'j1');
    expect(fleetJobsControllerGet).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    const out = logSpy.mock.calls.flat().join('\n');
    for (const want of ['RUNNING', 'box-1', 'US-002', 'implement', '1.2500', '5']) expect(out).toContain(want);
  });

  it('cancel posts and prints the new state', async () => {
    (fleetJobsControllerCancel as jest.Mock).mockResolvedValue({ ret: 0, data: job({ state: 'RUNNING', cancelRequestedAt: '2026-10-01T10:05:00.000Z' }) });
    await run('cancel', 'j1');
    expect(fleetJobsControllerCancel).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Cancel requested');
  });

  it('requeue prints the placement', async () => {
    (fleetJobsControllerRequeue as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job({ id: 'j1', state: 'QUEUED' }), placement: { assigned: false, runnerId: null, misfits: [] } } });
    await run('requeue', 'j1');
    expect(fleetJobsControllerRequeue).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Queued: no runner fits now');
  });

  it('bundle writes the bytes to koda-job-<id>.tar.gz without overwriting', async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer;
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(bytes);
    mockWriteFile.mockResolvedValue(undefined);
    await run('bundle', 'j1');
    expect(jobBundleControllerDownload).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' }, parseAs: 'arrayBuffer' });
    const [path, data, opts] = mockWriteFile.mock.calls[0];
    expect(path).toBe('koda-job-j1.tar.gz');
    expect(Buffer.from(data as Uint8Array)).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(opts).toEqual({ flag: 'wx' });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('bundle --out --force overwrites the named file', async () => {
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(new ArrayBuffer(1));
    mockWriteFile.mockResolvedValue(undefined);
    await run('bundle', 'j1', '--out', 'b.tgz', '--force');
    expect(mockWriteFile.mock.calls[0][0]).toBe('b.tgz');
    expect(mockWriteFile.mock.calls[0][2]).toEqual({ flag: 'w' });
  });

  it('bundle refuses an existing file and leaves it alone (exit 1)', async () => {
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(new ArrayBuffer(1));
    mockWriteFile.mockRejectedValue(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
    await run('bundle', 'j1');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('--force');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('bundle with no bundle yet writes nothing and exits 4', async () => {
    (jobBundleControllerDownload as jest.Mock).mockRejectedValue({ ret: 404, message: 'No bundle for this job' });
    await run('bundle', 'j1');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenLastCalledWith(4);
  });
```

In `fleet.spec.ts`, change the expected list to `['dispatch', 'job', 'repo', 'runner']`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/cli && npx jest src/commands/fleet-job.spec.ts src/commands/fleet.spec.ts`
Expected: FAIL (`job` is not a command).

- [ ] **Step 3: Implement**

`apps/cli/src/commands/fleet-job.ts`:

```ts
import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import {
  fleetJobsControllerCancel,
  fleetJobsControllerGet,
  fleetJobsControllerList,
  fleetJobsControllerRequeue,
  jobBundleControllerDownload,
  type DispatchResultDto,
  type FleetJobDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { error, table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ago, type FleetPage, handleFleetError, pageHint, printPlacement, resolveRepo, resolveRunner, runnerNames } from './fleet-shared';

const STATES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] as const;
type JobState = (typeof STATES)[number];

function invalid(message: string): null {
  error(message);
  process.exit(3);
  return null;
}

interface ListOptions { state?: string; repo?: string; runner?: string; requestedBy?: string; feature?: string; page: number; size: number; project?: string; json?: boolean }

async function listQuery(slug: string, o: ListOptions): Promise<Record<string, unknown> | null> {
  if (o.state && !(STATES as readonly string[]).includes(o.state)) return invalid(`Unknown state "${o.state}": ${STATES.join(', ')}`);
  const repo = o.repo ? await resolveRepo(slug, o.repo) : null;
  if (o.repo && !repo) return invalid(`Unknown repo "${o.repo}"`);
  const runner = o.runner ? await resolveRunner(slug, o.runner) : null;
  if (o.runner && !runner) return invalid(`Unknown runner "${o.runner}"`);
  return {
    current: o.page, size: o.size,
    ...(o.state ? { state: o.state as JobState } : {}),
    ...(repo ? { repoId: repo.id } : {}),
    ...(runner ? { runnerId: runner.id } : {}),
    ...(o.requestedBy ? { requestedById: o.requestedBy } : {}),
    ...(o.feature ? { feature: o.feature } : {}),
  };
}

function registerList(job: Command): void {
  job
    .command('list')
    .description('List fleet jobs, newest first')
    .option('--state <state>', `One of ${STATES.join(', ')}`)
    .option('--repo <repo>', 'Repo id or owner/name')
    .option('--runner <runner>', 'Runner id or name')
    .option('--requested-by <userId>', 'Requester user id')
    .option('--feature <name>', 'nax feature name')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: ListOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const query = await listQuery(slug, options);
        if (!query) return;
        const page = unwrap<FleetPage<FleetJobDto>>(await fleetJobsControllerList({ path: { slug }, query }));
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          const names = await runnerNames(slug);
          table(['ID', 'State', 'Cmd', 'Feature', 'Runner', 'Cost', 'Queued'], page.records.map((j) => [
            j.id, j.state, j.command, j.feature, j.runnerId ? names.get(j.runnerId) ?? j.runnerId : '-',
            `${j.costSpentUsd}/${j.maxCostUsd}`, ago(j.queuedAt),
          ]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err);
      }
    });
}

function showRows(j: FleetJobDto, runner: string): string[][] {
  const opt = (v: string | null | undefined) => v ?? '-';
  return [
    ['ID', j.id], ['State', j.state], ['Reason', opt(j.stateReason)], ['Command', j.command], ['Feature', j.feature],
    ['Plan from', opt(j.planFrom)], ['Ref', j.ref], ['Profiles', j.profiles.join(',') || '-'], ['Runner', runner],
    ['Story', opt(j.currentStoryId)], ['Phase', opt(j.currentPhase)], ['Cost (USD)', `${j.costSpentUsd} of ${j.maxCostUsd}`],
    ['Finish', opt(j.finishResult)], ['Escalation', opt(j.escalationReason)], ['Branch', opt(j.resultBranch)],
    ['PR', opt(j.resultPrUrl)], ['Queued', j.queuedAt], ['Finished', opt(j.finishedAt)],
  ];
}

function registerShow(job: Command): void {
  job
    .command('show <jobId>')
    .description('Show one job: state, progress, cost and result')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const j = unwrap<FleetJobDto>(await fleetJobsControllerGet({ path: { slug, id: jobId } }));
        if (options.json) {
          console.log(JSON.stringify(j, null, 2));
        } else {
          const runner = j.runnerId ? (await runnerNames(slug)).get(j.runnerId) ?? j.runnerId : '-';
          table(['Field', 'Value'], showRows(j, runner));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerCancel(job: Command): void {
  job
    .command('cancel <jobId>')
    .description('Cancel a job: the runner stops nax and the job ends CANCELLED')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const j = unwrap<FleetJobDto>(await fleetJobsControllerCancel({ path: { slug, id: jobId } }));
        if (options.json) console.log(JSON.stringify(j, null, 2));
        else console.log(`Cancel requested: job ${j.id} is ${j.state}`);
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerRequeue(job: Command): void {
  job
    .command('requeue <jobId>')
    .description('Queue a CRASHED, FAILED or CANCELLED job again')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: { project?: string; json?: boolean }) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const result = unwrap<DispatchResultDto>(await fleetJobsControllerRequeue({ path: { slug, id: jobId } }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printPlacement(result, result.placement.assigned ? await runnerNames(slug) : new Map());
        process.exit(0);
      } catch (err: unknown) {
        handleFleetError(err, { notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

function registerBundle(job: Command): void {
  job
    .command('bundle <jobId>')
    .description("Download the job's artifact bundle (tar.gz)")
    .option('--out <path>', 'Output file (default: koda-job-<id>.tar.gz)')
    .option('--force', 'Overwrite the output file if it exists')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (jobId: string, options: { out?: string; force?: boolean; project?: string }) => {
      const out = options.out ?? `koda-job-${jobId}.tar.gz`;
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        // Fully downloaded before the file is opened (D134): a failed download leaves no file behind.
        const bytes = await jobBundleControllerDownload({ path: { slug, id: jobId }, parseAs: 'arrayBuffer' });
        const data = new Uint8Array(bytes as unknown as ArrayBuffer);
        await writeFile(out, data, { flag: options.force ? 'w' : 'wx' });
        console.log(`Wrote ${out} (${data.byteLength} bytes)`);
        process.exit(0);
      } catch (err: unknown) {
        if ((err as { code?: unknown } | null)?.code === 'EEXIST') {
          error(`${out} exists; pass --force to overwrite or --out <path>`);
          process.exit(1);
          return;
        }
        handleFleetError(err, { notFoundMessage: `No bundle for job ${jobId}` });
      }
    });
}

export function registerFleetJob(fleet: Command): void {
  const job = fleet.command('job');
  job.description('Fleet jobs: list, show, cancel, requeue, bundle');
  registerList(job);
  registerShow(job);
  registerCancel(job);
  registerRequeue(job);
  registerBundle(job);
}
```

Read `JobBundleControllerDownloadResponses` in `types.gen.ts` before writing the `bytes` line: if the generated
response type for 200 is already `Blob | ArrayBuffer | unknown`, drop the `as unknown as` cast and narrow with
`bytes instanceof ArrayBuffer` (throwing a plain `Error('unexpected bundle response')` otherwise). Keep the
`parseAs: 'arrayBuffer'` option: without it the client parses gzip by content type, which is not what we want.

If `fleet-job.ts` passes 400 lines, move `showRows` and `listQuery` into `fleet-job-helpers.ts`.

In `fleet.ts` import `registerFleetJob` and call it after `registerFleetDispatch(fleet);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && npx jest src/commands/fleet`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

Run: `cd apps/cli && bun run type-check && bun run lint`
Expected: no errors.

```bash
git add apps/cli/src/commands/fleet-job.ts apps/cli/src/commands/fleet-job.spec.ts apps/cli/src/commands/fleet.ts apps/cli/src/commands/fleet.spec.ts
git commit -m "feat(cli): koda fleet job list, show, cancel, requeue, bundle"
```

---

### Task 9: Operator docs, end-to-end smoke and full verification

**Files:**
- Modify: `docs/deployment/runner.md` (new "Operate from the CLI" section before "## Live check (release gate)")

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Document the CLI**

Insert before `## Live check (release gate)` in `docs/deployment/runner.md`:

````markdown
## Operate from the CLI

Runner and repo-registry commands need a global-admin user's access token (`KODA_API_KEY=<token>`); dispatch and
job commands need project membership (dispatch, cancel others' jobs and requeue need DEVELOPER or higher).

```bash
koda fleet runner enroll-token --label linux       # prints the token once and the koda-runner enroll line
koda fleet runner list                             # online, enabled, labels, capacity, nax version, boot age
koda fleet runner disable <runnerId>               # drain: running jobs finish, nothing new is placed
koda fleet repo add acme/app --provider github     # GitLab subgroups: group/sub/app
koda fleet repo check <repoId>                     # exit 1 and a reason when koda can no longer broker git
koda fleet dispatch --repo acme/app --feature login --max-cost 5 --profile fast
koda fleet dispatch --repo acme/app --feature login --max-cost 2 --plan docs/specs/login.md --pin box-1
koda fleet job list --state RUNNING
koda fleet job show <jobId>
koda fleet job cancel <jobId>
koda fleet job bundle <jobId> --out login.tar.gz
```

`--label` and `--pin` are exclusive. A dispatch for a feature that already has an active job on the repo prints
that job's id instead of starting a second one.
````

- [ ] **Step 2: Smoke-test against a local API (manual, no billed calls)**

With the dev Postgres and API up (`cd apps/api && bun run start:dev`, a global-admin access token in
`KODA_API_KEY`, `KODA_API_URL=http://localhost:3100`):

```bash
cd apps/cli && bun run build
node dist/index.js fleet runner list
node dist/index.js fleet runner enroll-token --label smoke --json
node dist/index.js fleet repo list --all
```

Expected: the runner table (possibly empty), a JSON body with `token` starting `ke_`, the repo table. No
dispatch here: without a running runner a job stays QUEUED, which is fine but leaves an active row; if you do
dispatch, cancel the job afterwards (`node dist/index.js fleet job cancel <id>`). Record what you ran in the PR body.

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
bun run db:generate
cd apps/api && bun run test:unit && bun run type-check && bun run lint && cd ../..
cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet test/integration/openapi-spec test/integration/openapi-client && cd ../..
cd apps/cli && bun run test && bun run type-check && bun run lint && bun run build && cd ../..
bunx turbo run build --filter=@nathapp/koda-api
git status --short openapi.json
```

Expected: every suite passes; `git status --short openapi.json` prints nothing (the committed export is current;
if it prints ` M openapi.json`, re-run `bun run api:export-spec`, re-run the contract spec and amend Task 4's
content in a new commit `chore: refresh openapi.json`).

- [ ] **Step 4: Commit**

```bash
git add docs/deployment/runner.md
git commit -m "docs(fleet): operate runners, repos and jobs from the koda CLI"
```

The branch is ready for review and a PR (a human pushes). The PR body names: #158 closed; the overview's
deviation D128 (for review with 4c); the D133/D134 CLI choices; that #167 is not included (D122).
