# Fleet S2b (j) Slice 1 — Post-Run Stage Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry nax's post-run stage statuses (`postRun.acceptance|regression|finish.status` in `status.json`) from the runner through the sync protocol into a new `FleetJob.postRun` column and out on the job DTO, so slice 2 can draw the `Stories -> Acceptance -> Regression -> Finish` strip.

**Architecture:** The runner's structural `status.json` reader learns two more stage statuses and the snapshot mapper emits one optional `postRun` object. The API validates it as a bounded mirror field (bad keys dropped, never fatal), stores it in a nullable JSONB column with "present replaces, absent unchanged" semantics, clears it on requeue with the other per-attempt fields, and exposes it on `GET :id` (null on list pages). No web change in this slice.

**Tech Stack:** Bun runner (`bun:test`), `@nathapp/fleet-protocol` (type-only in the API), NestJS 11 + Prisma on PostgreSQL 16, Jest (unit + PG integration via `bun run test:scoped`), `@nestjs/swagger` OpenAPI export + generated CLI client.

**Spec:** `docs/superpowers/specs/2026-10-05-fleet-s2b-j-story-graph-design.md` (§1, §3 runner/API bullets, §4 slice 1, D427-D429, D433). Slice 2 (web + E2E) gets its own plan after this merges.

## Global Constraints

- Stage values: at most **32 printable ASCII** characters each (`^[\x20-\x7E]{1,32}$`), keys only `acceptance`, `regression`, `finish` (spec §1.2, D429).
- Snapshot semantics: `postRun` present **replaces** the stored object (D428); absent leaves it unchanged; invalid or empty after filtering is treated as absent.
- Requeue clears `postRun` to `null` with the other per-attempt fields (D427).
- `FleetJobDto.postRun` is `null` on list endpoints, like `stories` (D433, D149).
- No protocol version bump: the field is additive and optional (`FLEET_PROTOCOL_VERSION` stays 3; bump only on incompatible changes, `packages/fleet-protocol/src/index.ts:3`).
- No web change (`apps/web/**` untouched); the web `FleetJobDto` type gains `postRun` in slice 2.
- No new Prisma enums. Hand-written migration SQL, like `prisma/migrations/20261005090000_fleet_bundle_ingest/`.
- Never edit `apps/cli/src/generated/**` or generated `AGENTS.md`/`CLAUDE.md` by hand; regenerate (`bun run generate`).
- No emojis in code, comments or docs. Immutable style (build new objects; no in-place mutation of inputs).
- Never switch branches during execution; work on `feat/fleet-s2b-story-graph` (it already holds the spec commit `5382eba4`).
- Integration specs need the test Postgres: `cd apps/api && bun run test:db:up` once. Never run two DB-mode jest runs at the same time (each resets the test DB).

## Review Focus

- **A later snapshot without `postRun`** (every snapshot during the story phase, and every snapshot from an older runner) must leave a stored `postRun` untouched, not null it. Pinned in Task 3 (sync integration, step "absent leaves it").
- **One bad stage value** (33 chars, a control character, a number) must drop only that key, and a `postRun` whose every key is bad must not wipe the stored value nor fail the rest of the snapshot (cost, phase still applied). Pinned in Task 3 (unit table + integration).
- **`postRun: null`, an array, or a string** from a buggy runner: ignored, no 500, ack still advances. Pinned in Task 3 (unit table).
- **status.json with only `postRun.finish`** (what nax wrote before acceptance existed, and what the runner already maps): the existing `finishResult`/`resultPrUrl` mapping must not change, and `postRun: { finish: '<status>' }` is added only when `finish.status` is a string. Pinned in Task 1.
- **Requeue after a finished run** shows no stale stages on the new attempt. Pinned in Task 4 (requeue integration).

## Decisions (D434-D438)

| # | Decision |
|---|---|
| D434 | The runner sends a stage only when nax wrote a string `status` for it; a stage object without `status` is skipped; `postRun` is omitted when no stage survives. The runner clips each value to 32 UTF-16 units with the existing `clip()`; printable-ASCII filtering is the server's job (one validator, like `wipPush`). |
| D435 | Domain type `FleetJobPostRun = { acceptance?: string; regression?: string; finish?: string }`; DTO class `FleetJobPostRunDto` with three optional string properties. |
| D436 | `FleetJobRecord.postRun` is required-nullable (`FleetJobPostRun \| null`), like `stories`; every hand-built record fixture gains `postRun: null`. |
| D437 | The API validator lives next to the other mirror bounds in `event-payloads.ts` as `postRunStages()`, exported for its unit table. |
| D438 | Migration `20261005120000_fleet_job_post_run`: `ALTER TABLE "FleetJob" ADD COLUMN "postRun" JSONB;` no default, no backfill (null = unknown, spec §2.4). |

## File Structure

| File | Responsibility |
|---|---|
| `packages/fleet-protocol/src/index.ts` (modify) | `SnapshotEventPayload.postRun?` |
| `apps/runner/src/verdict/status-view.ts` (modify) | `StageView`, `StatusView.postRun` widened, `parseStatusView` reads acceptance/regression status |
| `apps/runner/src/watcher/status-snapshot.ts` (modify) | `mapStatusToSnapshot` emits `postRun` |
| `apps/runner/src/verdict/verdict.spec.ts`, `apps/runner/src/watcher/status-snapshot.spec.ts` (modify) | runner tests |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261005120000_fleet_job_post_run/migration.sql` | column |
| `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (modify) | `FleetJobPostRun`, record field, `Mutable` |
| `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` (modify) | `toJob` cast, `update` JSON null handling |
| `apps/api/src/fleet/sync/event-payloads.ts` (+ spec) | `postRunStages()`, mirror entry |
| `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` (+ spec) | `FleetJobPostRunDto`, `from`/`summary` |
| `apps/api/src/fleet/jobs/fleet-jobs.service.ts` | requeue clears `postRun` |
| record fixtures: `apps/api/src/fleet/sync/job-report.processor.spec.ts:24`, `sync/command-ack.processor.spec.ts:18`, `jobs/job-transitions.service.spec.ts:14`, `jobs/assign-payload.spec.ts:14`, `jobs/fleet-jobs.service.spec.ts:16`, `jobs/dto/fleet-job.dto.spec.ts:~34` | add `postRun: null` |
| `apps/api/test/integration/fleet/runner-sync.integration.spec.ts`, `fleet-job-cancel-requeue.integration.spec.ts` (modify) | integration |
| `apps/api/src/fleet/fleet-openapi.contract.spec.ts` (modify), `openapi.json`, `apps/cli/src/generated/**` (regenerated) | contract |

---

### Task 1: Protocol field and runner mapping

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts` (inside `SnapshotEventPayload`, after `storiesTruncated?: boolean;`)
- Modify: `apps/runner/src/verdict/status-view.ts`
- Modify: `apps/runner/src/watcher/status-snapshot.ts`
- Test: `apps/runner/src/verdict/verdict.spec.ts` (`describe('parseStatusView')`), `apps/runner/src/watcher/status-snapshot.spec.ts` (`describe('mapStatusToSnapshot ...')`)

**Interfaces:**
- Produces: `SnapshotEventPayload.postRun?: { acceptance?: string; regression?: string; finish?: string }` (wire field the API reads in Task 3); `StageView { readonly status?: string }`; `StatusView.postRun?: { acceptance?: StageView; regression?: StageView; finish?: FinishView }`.

- [ ] **Step 1: Write the failing runner tests**

In `apps/runner/src/verdict/verdict.spec.ts`, inside `describe('parseStatusView', ...)`, add:

```ts
  test('reads acceptance and regression status and drops everything else in those stages (S2b (j) §1.1)', () => {
    const view = parseStatusView({
      run: { id: 'r', status: 'running' },
      postRun: {
        acceptance: { status: 'running', lastRunAt: 'x', failedACs: ['AC-1'] },
        regression: { status: 7 },
        finish: { status: 'not-run' },
        gates: { acceptance: 'passed' },
      },
    });
    expect(view?.postRun).toEqual({ acceptance: { status: 'running' }, regression: {}, finish: { status: 'not-run' } });
  });
  test('a postRun that is not an object, or has no stage objects, leaves postRun undefined', () => {
    expect(parseStatusView({ run: { id: 'r', status: 'running' }, postRun: 'x' })?.postRun).toBeUndefined();
    expect(parseStatusView({ run: { id: 'r', status: 'running' }, postRun: { acceptance: 'passed' } })?.postRun).toBeUndefined();
  });
```

In `apps/runner/src/watcher/status-snapshot.spec.ts`, inside `describe('mapStatusToSnapshot (slice 3 design §1.3)', ...)`, add:

```ts
  test('maps post-run stage statuses, skipping stages without a status (S2b (j) D434)', () => {
    const snap = mapStatusToSnapshot({
      run: { id: 'r', status: 'running' },
      postRun: { acceptance: { status: 'passed' }, regression: {}, finish: { status: 'running' } },
    });
    expect(snap.postRun).toEqual({ acceptance: 'passed', finish: 'running' });
  });
  test('omits postRun when no stage has a status, and keeps the finish mapping unchanged', () => {
    expect(mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, postRun: { regression: {} } })).not.toHaveProperty('postRun');
    expect(mapStatusToSnapshot({ run: { id: 'r', status: 'running' } })).not.toHaveProperty('postRun');
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'opened', url: 'https://github.com/a/b/pull/1' } } });
    expect(snap).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://github.com/a/b/pull/1' });
    expect(snap).not.toHaveProperty('postRun');
  });
  test('clips each stage status to 32 characters', () => {
    const snap = mapStatusToSnapshot({ run: { id: 'r', status: 'running' }, postRun: { acceptance: { status: 'x'.repeat(50) } } });
    expect(snap.postRun?.acceptance).toBe('x'.repeat(32));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/verdict/verdict.spec.ts src/watcher/status-snapshot.spec.ts`
Expected: FAIL (the new `parseStatusView` test sees `postRun: { finish: ... }` only; the snapshot tests see no `postRun`; type errors on `postRun.acceptance` are reported by `tsc`, not by `bun test`).

- [ ] **Step 3: Add the protocol field**

In `packages/fleet-protocol/src/index.ts`, inside `SnapshotEventPayload`, directly after the `storiesTruncated?: boolean;` member, add:

```ts
  /** S2b (j): nax post-run stage statuses (`status.json` `postRun.<stage>.status`), passed through.
   *  Each at most 32 printable ASCII chars; only stages nax wrote a status for. Absent = unchanged. */
  postRun?: { acceptance?: string; regression?: string; finish?: string };
```

- [ ] **Step 4: Widen the status view**

In `apps/runner/src/verdict/status-view.ts`:

Add after the `FinishView` interface:

```ts
/** S2b (j): one nax post-run stage (acceptance, regression); only `status` is read. */
export interface StageView {
  readonly status?: string;
}
```

Change the `postRun` member of `StatusView` to:

```ts
  readonly postRun?: { readonly acceptance?: StageView; readonly regression?: StageView; readonly finish?: FinishView };
```

In `parseStatusView`, replace the two lines that compute `finishRaw` and `finish` and the `postRun: finish ? { finish } : undefined` entry with:

```ts
  const postRunRaw = isObj(raw['postRun']) ? raw['postRun'] : undefined;
  const stage = (key: 'acceptance' | 'regression'): StageView | undefined =>
    postRunRaw && isObj(postRunRaw[key]) ? defined({ status: str(postRunRaw[key]['status']) }) : undefined;
  const finishRaw = postRunRaw && isObj(postRunRaw['finish']) ? postRunRaw['finish'] : undefined;
  const finish = finishRaw ? defined({ status: str(finishRaw['status']), result: str(finishRaw['result']), url: str(finishRaw['url']), escalationReason: str(finishRaw['escalationReason']) }) : undefined;
  const postRunView = defined({ acceptance: stage('acceptance'), regression: stage('regression'), finish });
```

and in the returned `defined({...})` use:

```ts
    postRun: Object.keys(postRunView).length > 0 ? postRunView : undefined,
```

(The existing first `parseStatusView` test still passes: `postRun: { finish: {...} }` maps to `{ finish: {...} }`.)

- [ ] **Step 5: Emit `postRun` from the snapshot mapper**

In `apps/runner/src/watcher/status-snapshot.ts`, add above `mapStatusToSnapshot`:

```ts
/** S2b (j) spec §1.2: the server's per-stage bound. */
const STAGE_STATUS_MAX = 32;

/** D434: only stages nax wrote a status for; undefined when none. */
function postRunStages(status: StatusView): SnapshotEventPayload['postRun'] {
  const post = status.postRun;
  const entries: Array<[string, string | undefined]> = [
    ['acceptance', clip(post?.acceptance?.status, STAGE_STATUS_MAX)],
    ['regression', clip(post?.regression?.status, STAGE_STATUS_MAX)],
    ['finish', clip(post?.finish?.status, STAGE_STATUS_MAX)],
  ];
  const stages = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
  return Object.keys(stages).length > 0 ? stages : undefined;
}
```

and add to the `entries` array in `mapStatusToSnapshot`, after `['resultSha', extras.resultSha],`:

```ts
    ['postRun', postRunStages(status)],
```

- [ ] **Step 6: Run the runner checks**

Run: `cd apps/runner && bun test src/verdict/verdict.spec.ts src/watcher/status-snapshot.spec.ts && bun run type-check && bun run lint`
Expected: PASS, no type or lint errors.

Then the whole runner suite: `cd apps/runner && bun run test`
Expected: PASS (watcher and host-executor specs compare whole snapshots; none of their fixtures carry acceptance/regression, and a fixture with `postRun.finish.status` now also yields `postRun: { finish }` — if a `toEqual` on a whole snapshot fails for that reason, add the expected `postRun` to that assertion, never loosen it to `toMatchObject`).

- [ ] **Step 7: Commit**

```bash
git add packages/fleet-protocol/src/index.ts apps/runner/src/verdict/status-view.ts apps/runner/src/verdict/verdict.spec.ts apps/runner/src/watcher/status-snapshot.ts apps/runner/src/watcher/status-snapshot.spec.ts
git commit -m "feat(runner): mirror nax post-run stage statuses in snapshots (S2b (j) D434)"
```

(Add any runner spec you had to update in Step 6.)

---

### Task 2: `FleetJob.postRun` column, domain type and repository

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `FleetJob`, after `storiesTruncated   Boolean   @default(false)`)
- Create: `apps/api/prisma/migrations/20261005120000_fleet_job_post_run/migration.sql`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:15-24` (`toJob`), `:106-114` (`update`)
- Modify (fixtures, add `postRun: null` next to `storiesTruncated`): `apps/api/src/fleet/sync/job-report.processor.spec.ts:24`, `apps/api/src/fleet/sync/command-ack.processor.spec.ts:18`, `apps/api/src/fleet/jobs/job-transitions.service.spec.ts:14`, `apps/api/src/fleet/jobs/assign-payload.spec.ts:14`, `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts:16`
- Test: `apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts`

**Interfaces:**
- Produces: `export interface FleetJobPostRun { acceptance?: string; regression?: string; finish?: string }` in `fleet-job.domain.ts`; `FleetJobRecord.postRun: FleetJobPostRun | null`; `'postRun'` in `Mutable`, so `FleetJobPatch.postRun?: FleetJobPostRun | null`; `PrismaFleetJobRepository.update` writes `null` as `Prisma.DbNull`.

- [ ] **Step 1: Write the failing repository integration test**

In `apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts`, add after the `'creates a job with decimal strings and refuses an active duplicate'` test:

```ts
  it('stores, replaces and clears postRun (S2b (j) D428, D436)', async () => {
    const job = await repo.createJob({ ...base, feature: 'post-run' });
    expect(job.postRun).toBeNull();
    const first = await repo.update(job.id, { postRun: { acceptance: 'running' } });
    expect(first.postRun).toEqual({ acceptance: 'running' });
    const second = await repo.update(job.id, { postRun: { acceptance: 'passed', regression: 'running' } });
    expect(second.postRun).toEqual({ acceptance: 'passed', regression: 'running' });
    const untouched = await repo.update(job.id, { currentPhase: 'x' });
    expect(untouched.postRun).toEqual({ acceptance: 'passed', regression: 'running' });
    const cleared = await repo.update(job.id, { postRun: null });
    expect(cleared.postRun).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts`
Expected: FAIL (TypeScript: `postRun` does not exist on the record / patch type).

- [ ] **Step 3: Schema and migration**

In `apps/api/prisma/schema.prisma`, in `model FleetJob`, directly after `storiesTruncated   Boolean   @default(false)`, add:

```prisma
  postRun            Json? // S2b (j) §1.3: nax post-run stage statuses {acceptance?, regression?, finish?}; null = unknown
```

Create `apps/api/prisma/migrations/20261005120000_fleet_job_post_run/migration.sql`:

```sql
-- Fleet S2b (j) slice 1: nax post-run stage statuses mirrored from the runner (spec §1.3, D438).
ALTER TABLE "FleetJob" ADD COLUMN "postRun" JSONB;
```

Run: `cd apps/api && bun run db:generate`
Expected: Prisma client regenerated; `FleetJob` row type has `postRun: Prisma.JsonValue | null`.

- [ ] **Step 4: Domain type**

In `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, after the `FleetJobStory` interface, add:

```ts
/** S2b (j) §1.3: nax post-run stage statuses, as nax wrote them (at most 32 printable ASCII each). */
export interface FleetJobPostRun {
  acceptance?: string;
  regression?: string;
  finish?: string;
}
```

In `FleetJobRecord`, after `storiesTruncated: boolean;`, add:

```ts
  /** S2b (j): replaced by each snapshot that carries it; cleared on requeue (D427). */
  postRun: FleetJobPostRun | null;
```

In the `Mutable` union, change the last line to:

```ts
  | 'resultBranch' | 'resultSha' | 'resultPrUrl' | 'wipPush' | 'stories' | 'storiesTruncated' | 'postRun' | 'ackedRunnerSeq';
```

- [ ] **Step 5: Repository mapping**

In `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`, add `FleetJobPostRun` to the import from `./domain/fleet-job.domain`, then in `toJob` add after the `stories:` line:

```ts
  postRun: r.postRun as unknown as FleetJobPostRun | null,
```

In `update`, change the destructuring to `const { bumpEpoch, costSpentUsd, costCarriedUsd, progress, stories, postRun, ...rest } = patch;` and add after the `stories` spread:

```ts
      ...(postRun !== undefined ? { postRun: postRun === null ? Prisma.DbNull : (postRun as unknown as Prisma.InputJsonValue) } : {}),
```

- [ ] **Step 6: Record fixtures**

In each fixture listed under **Files** (the hand-built `FleetJobRecord` objects), insert `postRun: null,` directly after `storiesTruncated: false,`. In `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` the record literal ends `stories: [...], storiesTruncated: true,` — insert `postRun: null,` after it (Task 4 changes that test further).

Find any other hand-built records the compiler reports: `cd apps/api && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -i postRun`. Expected after the edits: no output.

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts && bun run test:unit -- src/fleet`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261005120000_fleet_job_post_run apps/api/src/fleet/jobs/domain/fleet-job.domain.ts apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts apps/api/src/fleet apps/api/test/integration/fleet/fleet-job-repository.integration.spec.ts
git commit -m "feat(api): FleetJob.postRun column and repository mapping (S2b (j) D436, D438)"
```

---

### Task 3: Validate and mirror `postRun` from runner snapshots

**Files:**
- Modify: `apps/api/src/fleet/sync/event-payloads.ts`
- Test: `apps/api/src/fleet/sync/event-payloads.spec.ts`, `apps/api/test/integration/fleet/runner-sync.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetJobPostRun`, `FleetJobPatch.postRun` (Task 2); wire field `postRun` (Task 1).
- Produces: `export function postRunStages(v: unknown): FleetJobPostRun | undefined` in `event-payloads.ts`; the snapshot mirror patch carries `postRun` when valid.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/fleet/sync/event-payloads.spec.ts`, change the import to `import { interpretEvent, postRunStages } from './event-payloads';` and add at the end of the file:

```ts
describe('postRunStages (S2b (j) §1.3, D429)', () => {
  it.each([
    ['all three stages', { acceptance: 'passed', regression: 'running', finish: 'not-run' }, { acceptance: 'passed', regression: 'running', finish: 'not-run' }],
    ['unknown keys dropped', { acceptance: 'passed', gates: 'x', __proto__x: 'y' }, { acceptance: 'passed' }],
    ['a 33-char value drops only that key', { acceptance: 'x'.repeat(33), regression: 'passed' }, { regression: 'passed' }],
    ['32 chars kept', { finish: 'y'.repeat(32) }, { finish: 'y'.repeat(32) }],
    ['control character dropped', { acceptance: 'pass\ned', finish: 'passed' }, { finish: 'passed' }],
    ['non-ASCII dropped', { acceptance: 'passé' }, undefined],
    ['empty string dropped', { acceptance: '' }, undefined],
    ['non-string dropped', { acceptance: 7, regression: null, finish: { status: 'x' } }, undefined],
    ['empty object', {}, undefined],
  ])('%s', (_name, input, expected) => {
    expect(postRunStages(input)).toEqual(expected);
  });
  it.each([[null], [undefined], ['passed'], [['passed']], [42]])('%p is not a stage object', (input) => {
    expect(postRunStages(input)).toBeUndefined();
  });
});

describe('snapshot postRun mirror', () => {
  it('mirrors valid stages next to the other fields', () => {
    expect(interpretEvent('snapshot', { currentPhase: 'review', postRun: { acceptance: 'running' } }))
      .toEqual({ kind: 'mirror', patch: { currentPhase: 'review', postRun: { acceptance: 'running' } } });
  });
  it('an all-invalid postRun is absent, and the rest of the snapshot still applies', () => {
    expect(interpretEvent('snapshot', { costSpentUsd: '0.5', postRun: { acceptance: 'x'.repeat(40) } }))
      .toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.5' } });
    expect(interpretEvent('snapshot', { costSpentUsd: '0.5', postRun: null }))
      .toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.5' } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:unit -- src/fleet/sync/event-payloads.spec.ts`
Expected: FAIL (`postRunStages` is not exported).

- [ ] **Step 3: Implement the validator and mirror entry**

In `apps/api/src/fleet/sync/event-payloads.ts`:

Change the domain import to `import type { FleetJobPatch, FleetJobPostRun, FleetJobStory } from '../jobs/domain/fleet-job.domain';`.

Add after the `STORY_STATUS_RE` constant:

```ts
/** S2b (j) §1.3 bounds: nax stage status strings, passed through (D429). */
const POST_RUN_STAGES = ['acceptance', 'regression', 'finish'] as const;
const STAGE_STATUS_RE = /^[\x20-\x7e]{1,32}$/;
```

Add after `storyList`:

```ts
/** Known stages with a valid status; undefined (field absent, stored value kept) when none survive (D428). */
export function postRunStages(v: unknown): FleetJobPostRun | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Obj;
  const kept = POST_RUN_STAGES.flatMap((key): Array<[string, string]> => {
    const value = o[key];
    return typeof value === 'string' && STAGE_STATUS_RE.test(value) ? [[key, value]] : [];
  });
  return kept.length > 0 ? (Object.fromEntries(kept) as FleetJobPostRun) : undefined;
}
```

In `mirror`, add to `entries` after the `storiesTruncated` entry:

```ts
    ['postRun', postRunStages(p.postRun)],
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && bun run test:unit -- src/fleet/sync`
Expected: PASS.

- [ ] **Step 5: Write the sync integration test**

In `apps/api/test/integration/fleet/runner-sync.integration.spec.ts`, add as the **last** test of the `describe` (after `'fills free slots on sync, but never for a disabled runner'`). The shared runner has capacity 1 (`insertRunner` default) and earlier tests leave a job holding it, so the test first fails every job the runner holds, exactly like the `'fills free slots'` test does:

```ts
  it('mirrors postRun from snapshots: present replaces, absent and all-invalid leave it (S2b (j) D428)', async () => {
    await prisma.fleetJob.updateMany({ where: { runnerId: runner.runnerId, state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'FAILED' } });
    const j = await dispatch('post-run');
    expect(j.state).toBe('ASSIGNED');
    const first = await sync();
    const assign = first.commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    expect(assign).toBeDefined();
    const e = { jobId: j.id, leaseEpoch: j.leaseEpoch };
    await sync({
      commandAcks: [{ commandId: assign!.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ ...e, events: [ev(1, 'state', { to: 'RUNNING' }), ev(2, 'snapshot', { postRun: { acceptance: 'running', regression: 'not-run' } })] }],
    });
    expect((await job(j.id)).postRun).toEqual({ acceptance: 'running', regression: 'not-run' });

    // absent: unchanged
    await sync({ jobs: [{ ...e, events: [ev(3, 'snapshot', { currentPhase: 'review' })] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ currentPhase: 'review', postRun: { acceptance: 'running', regression: 'not-run' } }));

    // all-invalid: unchanged, the rest of the snapshot still applies
    const res = await sync({ jobs: [{ ...e, events: [ev(4, 'snapshot', { costSpentUsd: '0.25', postRun: { acceptance: 'x'.repeat(40) } })] }] });
    expect(res.jobAcks).toEqual([{ jobId: j.id, ackedSeq: 4 }]);
    const after = await job(j.id);
    expect(after.postRun).toEqual({ acceptance: 'running', regression: 'not-run' });
    expect(after.costSpentUsd.toString()).toBe('0.25');

    // present: replaces (no merge)
    await sync({ jobs: [{ ...e, events: [ev(5, 'snapshot', { postRun: { finish: 'passed' } })] }] });
    expect((await job(j.id)).postRun).toEqual({ finish: 'passed' });
  });
```

- [ ] **Step 6: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/sync/event-payloads.ts apps/api/src/fleet/sync/event-payloads.spec.ts apps/api/test/integration/fleet/runner-sync.integration.spec.ts
git commit -m "feat(api): validate and mirror snapshot postRun stages (S2b (j) D428, D429, D437)"
```

---

### Task 4: Job DTO, requeue clearing and OpenAPI

**Files:**
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:215` (requeue `extra` block)
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Test: `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`, `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`

**Interfaces:**
- Consumes: `FleetJobRecord.postRun` (Task 2).
- Produces: `export class FleetJobPostRunDto { acceptance?: string; regression?: string; finish?: string }`; `FleetJobDto.postRun: FleetJobPostRunDto | null` (slice 2's web type mirrors this).

- [ ] **Step 1: Write the failing DTO and contract tests**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`, in the record literal of the stories test, replace the `postRun: null,` added in Task 2 with `postRun: { acceptance: 'passed', finish: 'running' },`, and add after the existing two `expect` lines of that test:

```ts
    expect(full.postRun).toEqual({ acceptance: 'passed', finish: 'running' });
    expect(summary.postRun).toBeNull();
```

In `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, add inside `describe('fleet OpenAPI contract', ...)`:

```ts
  it('exposes the job post-run stages (S2b (j) D433, D435)', () => {
    expect(Object.keys(spec.components.schemas['FleetJobDto']?.properties ?? {})).toContain('postRun');
    expect(Object.keys(spec.components.schemas['FleetJobPostRunDto']?.properties ?? {}).sort()).toEqual(['acceptance', 'finish', 'regression']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:unit -- src/fleet/jobs/dto/fleet-job.dto.spec.ts src/fleet/fleet-openapi.contract.spec.ts`
Expected: FAIL (`full.postRun` undefined; `FleetJobPostRunDto` missing from `openapi.json`).

- [ ] **Step 3: DTO**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, add after `FleetJobStoryDto`:

```ts
/** S2b (j) §1.3: nax post-run stage statuses, passed through (pending/running/passed/failed/skipped/not-run, ...). */
export class FleetJobPostRunDto {
  @ApiPropertyOptional({ maxLength: 32 }) declare acceptance?: string;
  @ApiPropertyOptional({ maxLength: 32 }) declare regression?: string;
  @ApiPropertyOptional({ maxLength: 32 }) declare finish?: string;
}
```

In `FleetJobDto`, after the `storiesTruncated` property, add:

```ts
  @ApiPropertyOptional({ type: FleetJobPostRunDto, nullable: true, description: 'nax post-run stage statuses (S2b (j)). Null when unknown and on list pages (D433).' })
  declare postRun: FleetJobPostRunDto | null;
```

In `from`, change `stories: r.stories, storiesTruncated: r.storiesTruncated,` to:

```ts
      stories: r.stories, storiesTruncated: r.storiesTruncated, postRun: r.postRun,
```

In `summary`, change the override object to `{ stories: null, storiesTruncated: false, postRun: null }` and update its doc comment to: `/** D149, D433: a list page leaves the story list and post-run stages out; \`GET :id\` carries them. */`.

- [ ] **Step 4: Requeue clears `postRun` (D427)**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`, in the requeue `extra` block, change the line

```ts
            resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
```

to

```ts
            resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false, postRun: null,
```

In `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`, in the test `'requeues a CRASHED job: clears the run, bumps the epoch and places it again'`, add `postRun: { acceptance: 'failed', finish: 'skipped' },` to the `insertJob('rq', {...})` overrides (after `storiesTruncated: true,`), and extend the `expect(after).toEqual(expect.objectContaining({...}))` object with `postRun: null`.

- [ ] **Step 5: Regenerate the contract and client**

Run from the repo root: `bun run generate`
Expected: `openapi.json` gains `FleetJobPostRunDto` and `FleetJobDto.postRun`; `apps/cli/src/generated/**` updates. Do not hand-edit either.

- [ ] **Step 6: Run the tests**

Run:

```bash
cd apps/api && bun run test:unit -- src/fleet
bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts test/integration/openapi-spec/spec-integrity.integration.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/jobs/dto/fleet-job.dto.ts apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts apps/api/src/fleet/jobs/fleet-jobs.service.ts apps/api/src/fleet/fleet-openapi.contract.spec.ts apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts openapi.json apps/cli/src/generated
git commit -m "feat(api): expose job postRun stages and clear them on requeue (S2b (j) D427, D433, D435)"
```

---

### Task 5: Full verification and handoff

**Files:** none new.

- [ ] **Step 1: Full verification**

Run from the repo root:

```bash
bun run lint
bun run type-check
bun run test
cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts test/integration/openapi-spec/spec-integrity.integration.spec.ts test/integration/openapi-client/openapi-client.integration.spec.ts
```

Expected: everything PASS (`bun run test` covers API unit, runner and CLI). Record counts for the PR body. Do not mark done on a red run.

Confirm the web is untouched: `git diff --stat main...HEAD -- apps/web` prints nothing.

- [ ] **Step 2: Migration matches the schema**

The test database is built with `prisma db push` (`apps/api/test/global-setup.ts:34`) and never runs migrations, so check the hand-written SQL separately. With the test Postgres up, run from `apps/api`:

```bash
docker compose -f ../../docker-compose.test.yml exec -T postgres-test createdb -U koda koda_shadow_postrun || true
bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow_postrun --script | grep -i postRun
docker compose -f ../../docker-compose.test.yml exec -T postgres-test dropdb -U koda koda_shadow_postrun
```

Expected: no output from the `grep` (migration and schema agree on `postRun`; pre-existing differences such as partial indexes are not this slice's concern). Never point `--shadow-database-url` at `koda_test` (Prisma resets the shadow database). The live apply happens on deploy (`~/koda-wk/deploy.sh` runs the one-shot `migrate` service).

- [ ] **Step 3: Whole-branch review, then hand off (no push without approval)**

Request a whole-branch code review of `main..feat/fleet-s2b-story-graph` against the spec (superpowers:requesting-code-review). Fix Critical and Important findings, at most 2 fix rounds. Then report to the user: test counts, deferred minors, and the proposed PR title `feat(fleet): S2b (j) slice 1 — mirror nax post-run stages on jobs (D427-D438)`. **Do not push or open the PR until the user approves.** Deploy note for the PR body: koda-wk needs the migration (`deploy.sh` runs it); runner builds that send `postRun` should go out after the API. After merge, slice 2 (web + E2E) gets its own plan from main.
