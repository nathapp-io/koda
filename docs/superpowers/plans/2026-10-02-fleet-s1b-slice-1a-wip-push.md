# Fleet S1b Slice 1a — Work-in-Progress Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every RUN job that ends without finishing, the runner pushes the feature branch (story commits plus a
dirty `prd.json`, nothing else) so any runner can continue the feature, and koda shows the push outcome on the job.

**Architecture:** A new pure-git module `apps/runner/src/executor/progress-push.ts` commits only the PRD and does a
fast-forward push with the PLAN push's retry schedule. `HostExecutor.pushProgress` wraps it with the job's brokered
credentials, and `JobRun.finish()` calls it for unfinished RUN verdicts before `UPLOADING`, reporting a new snapshot
field `wipPush`. The API mirrors `wipPush` into a new `FleetJob.wipPush` column, the DTO exposes it, requeue clears
it, and the web job page shows it next to the result branch.

**Tech Stack:** Bun + TypeScript (runner, `bun test`), NestJS + Prisma + Jest (API), Nuxt 3 + Jest (web), git.

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §1.1, §1.3 (`wipPush` only),
§1.4 (the `wipPush` line), §1.5 (1a items). Background: runner design
`docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` (R-3.3 branch rules, §2 step 4).

## Global Constraints

- The push is never forced, never opens a PR, and never commits any path but `.nax/features/<feature>/prd.json`.
- Commit message: `chore(nax): progress of <feature> via koda job <jobId>`, authored as `job.assign.gitIdentity`.
- Retries reuse `PLAN_PUSH_BACKOFF_MS` (`[2_000, 8_000]`); a non-fast-forward or auth failure is not retried.
- `wipPush` values: `pushed`, `none`, `failed:<reason>`; reason printable ASCII, 1-200 chars.
- `FLEET_PROTOCOL_VERSION` stays `1`; `wipPush` is an optional snapshot field.
- Server mirror drops an invalid `wipPush`; it never rejects the event.
- The push never changes the job's verdict.
- A halt (`ABANDON`) stops the push; a cancel does not (a CANCELLED run pushes).
- Runner tests: `cd apps/runner && bun run test` (unit), `KODA_DB_TESTS=1 bun run test:integration` (needs
  `cd apps/api && bun run test:db:up`). API: `cd apps/api && bun run test:unit`, `bun run test:scoped <paths>`
  for integration. Web: `cd apps/web && bun run test`. Never run bare `bun test` at the repo root.
- No emojis; no `console.log` in source.

## Decisions

| # | Decision | Why |
|:--|:--|:--|
| D141 | Resume idempotence uses the journal's existing `resultBranch`/`resultSha` columns: a RUN row with `resultSha` set has already pushed, so `finish()` reports `pushed` and does not push again. | RUN never wrote those columns before; no journal schema change is needed. Same rule PLAN uses (job-run.spec "a resume after the push was recorded"). |
| D142 | Push with `git push --porcelain origin refs/heads/<b>:refs/heads/<b>`; a `=` flag line means `none`. | Porcelain output is stable and machine-readable; the explicit refspec avoids pushing anything else. |
| D143 | The push refuses (`failed:not on branch`) unless `HEAD` is the job's `branch`. | nax works on the checked-out branch; a detached or switched HEAD means the commit would land elsewhere. |
| D144 | The halted-no-push case is unit-tested only. The integration harness cannot land an `ABANDON` exactly between nax exit and the push. | Deterministic coverage at the unit level, where `halt()` is callable. |
| D145 | `ESCALATED` also attempts the push. nax's finish phase may already have pushed, in which case the result is `none`. | One rule ("not COMPLETED") is simpler than per-verdict cases, and the push is idempotent. |

## Review Focus

1. A RUN that nax left with uncommitted story code beside a dirty `prd.json`: only `prd.json` is committed; the
   stray files stay out of origin. (Task 2 test "commits only prd.json".)
2. A daemon restart between a successful push and the terminal report: the resumed `finish()` must not push a
   second time and must still report `pushed` with the same sha. (Task 3 test "resume after the push".)
3. A cancelled RUN: the push still runs even though `cancelRequestedAt` is set. (Task 3 test "a CANCELLED run
   still pushes".)
4. Someone pushed to the feature branch by hand: the runner reports `failed:diverged` once, without retry loops,
   and the job keeps its nax verdict. (Task 2 test "non-fast-forward"; Task 3 test "failed push keeps verdict".)
5. Branch name with a slash (`feat/x`): the refspec and the commit work with nested branch names. (Every Task 2
   test uses `feat/f`.)

---

### Task 1: Protocol field, API column, mirror, DTO, requeue

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts` (`SnapshotEventPayload`, ~line 84-101)
- Modify: `apps/api/prisma/schema.prisma` (`model FleetJob`, after `resultPrUrl`)
- Create: `apps/api/prisma/migrations/20261002090000_fleet_job_wip_push/migration.sql`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobRecord`, `Mutable`)
- Modify: `apps/api/src/fleet/sync/event-payloads.ts` (`mirror`)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:145-149` (requeue `extra`)
- Test: `apps/api/src/fleet/sync/event-payloads.spec.ts`, `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`,
  `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
- Regenerate: `openapi.json`, `apps/cli/src/generated/`

**Interfaces:**
- Produces: `SnapshotEventPayload.wipPush?: string`; `FleetJobRecord.wipPush: string | null`;
  `FleetJobDto.wipPush: string | null`; DB column `FleetJob.wipPush TEXT NULL`.

- [ ] **Step 1: Write the failing mirror tests**

Append to `apps/api/src/fleet/sync/event-payloads.spec.ts` inside `describe('interpretEvent', ...)`:

```ts
  it('mirrors a valid wipPush and drops an invalid one without rejecting the snapshot', () => {
    for (const value of ['pushed', 'none', 'failed:diverged', 'failed:git auth failed']) {
      expect(interpretEvent('snapshot', { wipPush: value })).toEqual({ kind: 'mirror', patch: { wipPush: value } });
    }
    for (const value of ['', 'yes', 'failed:', `failed:${'x'.repeat(201)}`, 'failed:line\nbreak', 42]) {
      expect(interpretEvent('snapshot', { wipPush: value, currentPhase: 'review' })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:unit -- src/fleet/sync/event-payloads.spec.ts`
Expected: FAIL. The valid values produce `patch: {}`.

- [ ] **Step 3: Add the protocol field**

In `packages/fleet-protocol/src/index.ts`, inside `SnapshotEventPayload`, after `resultPrUrl?: string;`:

```ts
  /** S1b §1.1: outcome of the runner's work-in-progress push after an unfinished RUN.
   *  `pushed` | `none` | `failed:<reason>` (printable ASCII, at most 200 chars of reason). */
  wipPush?: string;
```

- [ ] **Step 4: Add the column, migration and domain field**

`apps/api/prisma/schema.prisma`, in `model FleetJob`, directly after the `resultPrUrl` line:

```prisma
  wipPush           String? // S1b §1.1: pushed | none | failed:<reason>
```

Create `apps/api/prisma/migrations/20261002090000_fleet_job_wip_push/migration.sql`:

```sql
-- S1b slice 1a: outcome of the runner's work-in-progress push after an unfinished RUN.
ALTER TABLE "FleetJob" ADD COLUMN "wipPush" TEXT;
```

Run: `cd apps/api && bun run db:generate`

`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`: in `FleetJobRecord` after `resultPrUrl: string | null;` add
`wipPush: string | null;`, and extend `Mutable`:

```ts
  | 'resultBranch' | 'resultSha' | 'resultPrUrl' | 'wipPush' | 'ackedRunnerSeq';
```

- [ ] **Step 5: Mirror the field**

In `apps/api/src/fleet/sync/event-payloads.ts`, next to `SHA_RE`:

```ts
/** S1b §1.1: `pushed`, `none` or `failed:` plus 1-200 printable ASCII characters. */
const WIP_PUSH_RE = /^(pushed|none|failed:[\x20-\x7e]{1,200})$/;
```

and in `mirror()`'s `entries`, after the `resultPrUrl` entry:

```ts
    ['wipPush', typeof p.wipPush === 'string' && WIP_PUSH_RE.test(p.wipPush) ? p.wipPush : undefined],
```

- [ ] **Step 6: Run the mirror test**

Run: `cd apps/api && bun run test:unit -- src/fleet/sync/event-payloads.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing DTO test**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`, add `wipPush: 'failed:diverged',` to the record passed to
`FleetJobDto.from` (after `resultPrUrl: null,`) and add:

```ts
    expect(json).toEqual(expect.objectContaining({ wipPush: 'failed:diverged' }));
```

Run: `cd apps/api && bun run test:unit -- src/fleet/jobs/dto/fleet-job.dto.spec.ts`
Expected: FAIL (`wipPush` missing from the DTO).

- [ ] **Step 8: Expose it in the DTO**

`apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, after the `resultPrUrl` property:

```ts
  @ApiPropertyOptional({ type: String, nullable: true, description: 'pushed | none | failed:<reason> (S1b §1.1)' }) declare wipPush: string | null;
```

and in `from()` change the last line of the object to:

```ts
      resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl, wipPush: r.wipPush,
```

Run: `cd apps/api && bun run test:unit -- src/fleet/jobs/dto/fleet-job.dto.spec.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing requeue assertion**

In `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`, test "requeues a CRASHED job",
add `wipPush: 'pushed',` to the `insertJob('rq', {...})` fields and extend the `after` assertion:

```ts
    expect(after).toEqual(expect.objectContaining({ naxRunId: null, finishedAt: null, ackedRunnerSeq: 0, wipPush: null }));
```

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: FAIL (`wipPush` still `'pushed'`). If `insertJob` rejects the unknown field at type level, that is the
failure to fix in Step 10 (it takes Prisma's `FleetJobUncheckedCreateInput`).

- [ ] **Step 10: Clear it on requeue**

`apps/api/src/fleet/jobs/fleet-jobs.service.ts`, requeue `extra`, change the last line to:

```ts
            resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, ackedRunnerSeq: 0, bumpEpoch: true,
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: PASS.

- [ ] **Step 11: Regenerate the contract and run the API checks**

Run from the repo root: `bun run generate`
Then: `cd apps/api && bun run type-check && bun run lint && bun run test:unit`
Expected: all pass; `git diff --stat openapi.json apps/cli/src/generated` shows `wipPush` added.
Also: `cd packages/fleet-protocol && bun run type-check` → PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/fleet-protocol/src/index.ts apps/api/prisma apps/api/src/fleet apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts openapi.json apps/cli/src/generated
git commit -m "feat(fleet): wipPush snapshot field, FleetJob column and DTO"
```

---

### Task 2: `progress-push` module (commit the PRD, fast-forward push)

**Files:**
- Create: `apps/runner/src/executor/progress-push.ts`
- Test: `apps/runner/test/unit/progress-push.spec.ts`

**Interfaces:**
- Consumes: `Git`, `isAuthFailure`, `NO_CREDENTIALS_REASON` (`apps/runner/src/executor/git.ts`);
  `PLAN_PUSH_BACKOFF_MS` (`apps/runner/src/executor/plan-commit.ts`); `systemSleep` (`apps/runner/src/time.ts`);
  `GitIdentity` (`@nathapp/fleet-protocol`).
- Produces:

```ts
export type ProgressPushOutcome =
  | { readonly kind: 'pushed'; readonly branch: string; readonly sha: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'halted' };
export interface ProgressPushInput {
  readonly git: Git; readonly repoDir: string; readonly feature: string; readonly jobId: string;
  readonly branchName: string; readonly identity: GitIdentity; readonly credentialHelper?: string | null;
  readonly isHalted?: () => boolean; readonly sleep?: (ms: number) => Promise<void>;
}
export function pushProgress(input: ProgressPushInput): Promise<ProgressPushOutcome>;
export function wipPushValue(outcome: Exclude<ProgressPushOutcome, { kind: 'halted' }>): string;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/test/unit/progress-push.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit, NO_CREDENTIALS_REASON, type Git, type GitResult } from '../../src/executor/git';
import { PLAN_PUSH_BACKOFF_MS } from '../../src/executor/plan-commit';
import { pushProgress, wipPushValue, type ProgressPushInput } from '../../src/executor/progress-push';
import { git as sh, isolateGit, makeOrigin, pushCommit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const g = createGit();
const identity = { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' };
const PRD = '.nax/features/f/prd.json';
const prdText = (status: string) => `${JSON.stringify({ feature: 'f', branchName: 'feat/f', userStories: [{ id: 'US-001', status }] })}\n`;
const noSleep = async (): Promise<void> => undefined;

/** A clone on `feat/f` (tracking origin) with one local story commit, like a RUN nax just left behind. */
async function setup() {
  const base = await tmp.make('wip');
  const origin = await makeOrigin(base, 'origin', { files: { 'README.md': 'x', [PRD]: prdText('pending') }, branches: [{ name: 'feat/f', files: { 'branch.txt': 'b\n' } }] });
  const repoDir = join(base, 'clone');
  await sh(base, 'clone', '-q', origin.url, repoDir);
  await sh(repoDir, 'checkout', '-q', '-B', 'feat/f', 'origin/feat/f');
  await writeFile(join(repoDir, 'story.txt'), 'work\n');
  await sh(repoDir, 'add', 'story.txt');
  await sh(repoDir, '-c', 'user.name=n', '-c', 'user.email=e@x', 'commit', '-q', '-m', 'feat(f): story work');
  const input: ProgressPushInput = { git: g, repoDir, feature: 'f', jobId: 'job-1', branchName: 'feat/f', identity, sleep: noSleep };
  return { base, origin, repoDir, input };
}
function scriptedPush(results: GitResult[]): { git: Git; pushes: () => number } {
  let count = 0;
  const run: Git['run'] = async (args, options) => {
    if (args[0] !== 'push') return g.run(args, options);
    count += 1;
    return results.shift() ?? { code: 1, stdout: '', stderr: 'fatal: unable to access' };
  };
  return { git: { run, ok: g.ok }, pushes: () => count };
}

describe('pushProgress', () => {
  test('pushes the local story commits; no PRD change means no extra commit', async () => {
    const s = await setup();
    const out = await pushProgress(s.input);
    const tip = await sh(s.origin.dir, 'rev-parse', 'feat/f');
    expect(out).toEqual({ kind: 'pushed', branch: 'feat/f', sha: tip });
    expect(await sh(s.origin.dir, 'log', '-1', '--format=%s', 'feat/f')).toBe('feat(f): story work');
  });

  test('commits only prd.json, as the job identity, with the progress message', async () => {
    const s = await setup();
    await writeFile(join(s.repoDir, PRD), prdText('passed'));
    await writeFile(join(s.repoDir, 'half-done.ts'), 'export const x = 1;\n');      // uncommitted story code
    await writeFile(join(s.repoDir, 'README.md'), 'edited\n');                         // tracked, dirty, not ours
    await mkdir(join(s.repoDir, 'staged'), { recursive: true });
    await writeFile(join(s.repoDir, 'staged', 'a.txt'), 'a\n');
    await sh(s.repoDir, 'add', 'staged/a.txt');                                         // staged by someone else
    const out = await pushProgress(s.input);
    expect(out.kind).toBe('pushed');
    expect(await sh(s.origin.dir, 'log', '-1', '--format=%s|%an|%ae', 'feat/f')).toBe(`chore(nax): progress of f via koda job job-1|${identity.name}|${identity.email}`);
    expect(await sh(s.origin.dir, 'show', '--name-only', '--format=', 'feat/f')).toBe(PRD);
    expect(await sh(s.origin.dir, 'show', `feat/f:${PRD}`)).toBe(prdText('passed').trim());
  });

  test('nothing new to push is none', async () => {
    const s = await setup();
    await sh(s.repoDir, 'push', '-q', 'origin', 'feat/f');
    expect(await pushProgress(s.input)).toEqual({ kind: 'none' });
  });

  test('non-fast-forward is failed:diverged and is not retried', async () => {
    const s = await setup();
    await pushCommit(s.base, s.origin.url, 'feat/f', 'other.txt', 'someone else\n');
    let pushes = 0;
    const counted: Git = { run: async (args, o) => { if (args[0] === 'push') pushes += 1; return g.run(args, o); }, ok: g.ok };
    const out = await pushProgress({ ...s.input, git: counted });   // a real push: the rejection text is git's own
    expect(out).toEqual({ kind: 'failed', reason: 'diverged' });
    expect(pushes).toBe(1);
  });

  test('an auth failure is not retried', async () => {
    const s = await setup();
    const scripted = scriptedPush([{ code: 128, stdout: '', stderr: 'fatal: Authentication failed for https://x' }]);
    expect(await pushProgress({ ...s.input, git: scripted.git })).toEqual({ kind: 'failed', reason: NO_CREDENTIALS_REASON });
    expect(scripted.pushes()).toBe(1);
  });

  test('a transient failure is retried on the PLAN back-off schedule, then fails', async () => {
    const s = await setup();
    const waits: number[] = [];
    const scripted = scriptedPush([]);
    const out = await pushProgress({ ...s.input, git: scripted.git, sleep: async (ms) => { waits.push(ms); } });
    expect(out).toEqual({ kind: 'failed', reason: 'push failed' });
    expect(scripted.pushes()).toBe(PLAN_PUSH_BACKOFF_MS.length + 1);
    expect(waits).toEqual([...PLAN_PUSH_BACKOFF_MS]);
  });

  test('a transient failure then success is pushed', async () => {
    const s = await setup();
    let first = true;
    const run: Git['run'] = async (args, o) => {
      if (args[0] === 'push' && first) { first = false; return { code: 1, stdout: '', stderr: 'fatal: unable to access' }; }
      return g.run(args, o);
    };
    expect((await pushProgress({ ...s.input, git: { run, ok: g.ok } })).kind).toBe('pushed');
  });

  test('a halt before or between attempts stops the push', async () => {
    const s = await setup();
    let halted = false;
    const scripted = scriptedPush([]);
    const out = await pushProgress({ ...s.input, git: scripted.git, isHalted: () => halted, sleep: async () => { halted = true; } });
    expect(out).toEqual({ kind: 'halted' });
    expect(scripted.pushes()).toBe(1);
  });

  test('refuses when HEAD is not the job branch', async () => {
    const s = await setup();
    await sh(s.repoDir, 'checkout', '-q', '--detach');
    expect(await pushProgress(s.input)).toEqual({ kind: 'failed', reason: 'not on branch' });
  });
});

describe('wipPushValue', () => {
  test('maps each outcome to its snapshot value', () => {
    expect(wipPushValue({ kind: 'pushed', branch: 'b', sha: 'a'.repeat(40) })).toBe('pushed');
    expect(wipPushValue({ kind: 'none' })).toBe('none');
    expect(wipPushValue({ kind: 'failed', reason: 'diverged' })).toBe('failed:diverged');
    expect(wipPushValue({ kind: 'failed', reason: `x${'y'.repeat(300)}` })).toHaveLength('failed:'.length + 200);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test test/unit/progress-push.spec.ts`
Expected: FAIL with "Cannot find module '../../src/executor/progress-push'".

- [ ] **Step 3: Implement the module**

Create `apps/runner/src/executor/progress-push.ts`:

```ts
import type { GitIdentity } from '@nathapp/fleet-protocol';
import { systemSleep } from '../time';
import { NO_CREDENTIALS_REASON, isAuthFailure, type Git } from './git';
import { PLAN_PUSH_BACKOFF_MS } from './plan-commit';

export type ProgressPushOutcome =
  | { readonly kind: 'pushed'; readonly branch: string; readonly sha: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'halted' };

export interface ProgressPushInput {
  readonly git: Git;
  readonly repoDir: string;
  readonly feature: string;
  readonly jobId: string;
  readonly branchName: string;
  readonly identity: GitIdentity;
  readonly credentialHelper?: string | null;
  /** True after an ABANDON: stop before the next push attempt. A cancel never stops it (S1b §1.1). */
  readonly isHalted?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const REASON_MAX = 200;
const REJECTED = /\[rejected\]|non-fast-forward|fetch first/i;

type Attempt = 'pushed' | 'none' | { readonly reason: string; readonly retry: boolean };

/** S1b §1.1 step 1: only the PRD is committed; nax's uncommitted story code and anything staged stay out. */
async function commitPrd(input: ProgressPushInput): Promise<void> {
  const { git, repoDir, feature } = input;
  const path = `.nax/features/${feature}/prd.json`;
  const dirty = await git.ok(['status', '--porcelain', '--', path], { cwd: repoDir });
  if (dirty.trim() === '') return;
  await git.ok(['add', '--', path], { cwd: repoDir });
  const message = `chore(nax): progress of ${feature} via koda job ${input.jobId}`;
  await git.ok([
    '-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-q', '-m', message, '--', path,
  ], { cwd: repoDir });
}

/** D142: porcelain push of exactly this branch; `=` means origin already has it. */
async function pushOnce(input: ProgressPushInput): Promise<Attempt> {
  const ref = `refs/heads/${input.branchName}`;
  const res = await input.git.run(['push', '--porcelain', 'origin', `${ref}:${ref}`], { cwd: input.repoDir, credentialHelper: input.credentialHelper ?? null });
  if (res.code === 0) return /^=\t/m.test(res.stdout) ? 'none' : 'pushed';
  if (REJECTED.test(`${res.stdout}\n${res.stderr}`)) return { reason: 'diverged', retry: false };
  if (isAuthFailure(res.stderr)) return { reason: NO_CREDENTIALS_REASON, retry: false };
  return { reason: 'push failed', retry: true };
}

/** S1b §1.1 (B5): after an unfinished RUN, put the branch on origin so any runner can continue it. Never forced. */
export async function pushProgress(input: ProgressPushInput): Promise<ProgressPushOutcome> {
  const { git, repoDir, branchName } = input;
  const head = (await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repoDir })).stdout.trim();
  if (head !== branchName) return { kind: 'failed', reason: 'not on branch' };   // D143
  try {
    await commitPrd(input);
  } catch {
    return { kind: 'failed', reason: 'commit failed' };
  }
  const sleep = input.sleep ?? systemSleep;
  for (let attempt = 0; ; attempt += 1) {
    if (input.isHalted?.() === true) return { kind: 'halted' };
    const result = await pushOnce(input);
    if (result === 'none') return { kind: 'none' };
    if (result === 'pushed') return { kind: 'pushed', branch: branchName, sha: (await git.ok(['rev-parse', 'HEAD'], { cwd: repoDir })).trim() };
    const backoff = PLAN_PUSH_BACKOFF_MS[attempt];
    if (!result.retry || backoff === undefined) return { kind: 'failed', reason: result.reason };
    await sleep(backoff);
  }
}

/** The snapshot's `wipPush` value (S1b §1.1 "Result"). */
export function wipPushValue(outcome: Exclude<ProgressPushOutcome, { kind: 'halted' }>): string {
  if (outcome.kind === 'failed') return `failed:${outcome.reason.slice(0, REASON_MAX)}`;
  return outcome.kind;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/runner && bun test test/unit/progress-push.spec.ts`
Expected: PASS (10 tests). If the diverged test reports `push failed`, print `res.stdout`/`res.stderr` from a
scratch run and widen `REJECTED` to git's actual wording; do not loosen the test.

- [ ] **Step 5: Lint, type-check, commit**

Run: `cd apps/runner && bun run type-check && bun run lint`
Expected: PASS.

```bash
git add apps/runner/src/executor/progress-push.ts apps/runner/test/unit/progress-push.spec.ts
git commit -m "feat(runner): progress push commits only the PRD and fast-forwards the feature branch"
```

---

### Task 3: Executor seam and `JobRun.finish()` wiring

**Files:**
- Modify: `apps/runner/src/executor/job-executor.ts` (interface + options type)
- Modify: `apps/runner/src/executor/host-executor.ts` (new `pushProgress` method, after `finishPlan`)
- Modify: `apps/runner/src/supervisor/job-run.ts` (`finish()`, new private `pushRunProgress`)
- Modify: `apps/runner/test/helpers/fake-executor.ts`
- Test: `apps/runner/src/supervisor/job-run.spec.ts` (new `describe('RUN progress push (S1b 1a)')`)

**Interfaces:**
- Consumes: `pushProgress`, `wipPushValue`, `ProgressPushOutcome` (Task 2); `SnapshotEventPayload.wipPush` (Task 1).
- Produces:

```ts
// job-executor.ts
export interface PushProgressOptions { readonly isHalted?: () => boolean }
// JobExecutor:
pushProgress(job: JobRow, options?: PushProgressOptions): Promise<ProgressPushOutcome>;
```

- [ ] **Step 1: Extend the fake executor**

In `apps/runner/test/helpers/fake-executor.ts`: import `PushProgressOptions` from the job-executor import and
`ProgressPushOutcome` from `'../../src/executor/progress-push'`; add fields and the method:

```ts
  readonly pushProgressOptions: PushProgressOptions[] = [];
  progressPush: ProgressPushOutcome = { kind: 'pushed', branch: 'feat/x', sha: 'e'.repeat(40) };
```

```ts
  async pushProgress(job: JobRow, options: PushProgressOptions = {}): Promise<ProgressPushOutcome> {
    this.note('pushProgress', job);
    this.pushProgressOptions.push(options);
    return this.progressPush;
  }
```

- [ ] **Step 2: Write the failing JobRun tests**

Append to `apps/runner/src/supervisor/job-run.spec.ts`:

```ts
describe('RUN progress push (S1b 1a)', () => {
  const failedStatus = { run: { id: 'r', status: 'failed' } };
  test('a FAILED run pushes before UPLOADING; the pushed branch and sha override the ledger', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls.indexOf('pushProgress:j1')).toBeGreaterThan(-1);
    expect(b.ex.calls.indexOf('pushProgress:j1')).toBeLessThan(b.ex.calls.indexOf('collectBundle:j1'));
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
    expect(b.journal.getJob('j1', 1)).toMatchObject({ resultBranch: 'feat/x', resultSha: 'e'.repeat(40) });
  });
  test('a COMPLETED run does not push and reports no wipPush', async () => {
    const b = build();
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(lastSnapshot(b)?.wipPush).toBeUndefined();
  });
  test('ESCALATED with nothing new reports none and keeps the ledger result (D145)', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'completed' }, postRun: { finish: { result: 'escalated', escalationReason: 'review' } } };
    b.ex.progressPush = { kind: 'none' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'none', resultBranch: 'feat/x', resultSha: 'b'.repeat(40) });
    expect(states(b).at(-1)).toEqual({ to: 'ESCALATED', reason: 'review' });
  });
  test('a failed push keeps the nax verdict and reason', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.progressPush = { kind: 'failed', reason: 'diverged' };
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(states(b).at(-1)).toEqual({ to: 'FAILED', reason: 'run status: failed' });
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'failed:diverged', resultSha: 'b'.repeat(40) });
  });
  test('a CANCELLED run still pushes, and the probe is halt-only', async () => {
    const b = build();
    b.ex.status = { run: { id: 'r', status: 'crashed' } };
    b.ex.onTick = (n) => { if (n === 2) b.run.requestCancel(); };
    await b.run.start('prepare');
    expect(stateNames(b)).toEqual(['RUNNING', 'UPLOADING', 'CANCELLED']);
    expect(b.ex.calls).toContain('pushProgress:j1');
    expect(b.ex.pushProgressOptions[0].isHalted?.()).toBe(false);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed' });
  });
  test('a halt during the push records nothing (D144)', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.ex.dieAfterTicks(1);
    const seen: { probe: (() => boolean) | null } = { probe: null };
    b.ex.pushProgress = async (_job, options) => {
      seen.probe = options?.isHalted ?? null;
      b.run.halt();
      return { kind: 'halted' };
    };
    await b.run.start('prepare');
    expect(seen.probe?.()).toBe(true);
    expect(everyStateName(b)).toEqual(['RUNNING']);
    expect(b.uploads).toEqual([]);
  });
  test('resume after the push was recorded does not push again and reports pushed (D141)', async () => {
    const b = build();
    b.ex.status = failedStatus;
    b.journal.updateJob('j1', 1, { state: 'UPLOADING', branch: 'feat/x', resultBranch: 'feat/x', resultSha: 'd'.repeat(40), pid: 1, pgid: 1 });
    await b.run.start('finish');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
    expect(stateNames(b)).toEqual(['FAILED']);
    expect(lastSnapshot(b)).toMatchObject({ wipPush: 'pushed', resultSha: 'd'.repeat(40) });
  });
  test('PLAN never calls pushProgress', async () => {
    const b = build('PLAN');
    b.ex.dieAfterTicks(1);
    await b.run.start('prepare');
    expect(b.ex.calls).not.toContain('pushProgress:j1');
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/runner && bun test src/supervisor/job-run.spec.ts`
Expected: FAIL. The new tests fail because nothing calls `pushProgress` and no `wipPush` is reported.

- [ ] **Step 4: Add the seam**

`apps/runner/src/executor/job-executor.ts`: add the import and the option type, and the method to `JobExecutor`
after `finishPlan`:

```ts
import type { ProgressPushOutcome } from './progress-push';
```

```ts
/** S1b §1.1: polled while the progress push waits for a token or a retry; true (an ABANDON) stops it. Never a cancel. */
export interface PushProgressOptions {
  readonly isHalted?: () => boolean;
}
```

```ts
  /** S1b §1.1 (B5): after an unfinished RUN, commit the PRD and fast-forward the feature branch on origin. */
  pushProgress(job: JobRow, options?: PushProgressOptions): Promise<ProgressPushOutcome>;
```

`apps/runner/src/executor/host-executor.ts`: import `pushProgress` from `'./progress-push'`, the
`PushProgressOptions` and `ProgressPushOutcome` types, and add after `finishPlan`:

```ts
  async pushProgress(job: JobRow, options: PushProgressOptions = {}): Promise<ProgressPushOutcome> {
    const { repoDir } = this.dirs(job);
    if (job.branch === null) return { kind: 'failed', reason: 'no branch' };
    const halted = (): boolean => options.isHalted?.() === true;
    const acquired = await this.deps.credentials.acquire(job, { wait: true, isCancelled: halted });
    if (!acquired.ok) return acquired.cancelled ? { kind: 'halted' } : { kind: 'failed', reason: acquired.reason };
    return pushProgress({
      git: this.deps.git, repoDir, feature: job.assign.feature, jobId: job.jobId, branchName: job.branch,
      identity: job.assign.gitIdentity, credentialHelper: acquired.credentials.helper, isHalted: halted,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
  }
```

- [ ] **Step 5: Wire `finish()`**

`apps/runner/src/supervisor/job-run.ts`: import `wipPushValue` from `'../executor/progress-push'`. Add the private
method next to `judge`:

```ts
  /**
   * S1b §1.1 (B5): an unfinished RUN's branch goes to origin so any runner can continue it. D141: a row that already
   * recorded a pushed sha (a resumed finish) is not pushed again. `null` means halted: report nothing.
   */
  private async pushRunProgress(row: JobRow): Promise<{ value: string; result: { branch: string; sha: string } | null } | null> {
    if (row.resultBranch !== null && row.resultSha !== null) return { value: 'pushed', result: { branch: row.resultBranch, sha: row.resultSha } };
    const outcome = await this.deps.executor.pushProgress(row, { isHalted: () => this.halted });
    if (outcome.kind === 'halted' || this.halted) return null;
    if (outcome.kind !== 'pushed') return { value: wipPushValue(outcome), result: null };
    this.deps.journal.updateJob(this.jobId, this.leaseEpoch, { resultBranch: outcome.branch, resultSha: outcome.sha });
    return { value: 'pushed', result: { branch: outcome.branch, sha: outcome.sha } };
  }
```

In `finish()`, declare `let wipPush: string | undefined;` next to `let result = ...`, and replace the RUN branch:

```ts
    } else if (row.command === 'RUN') {
      const ledger = await this.deps.executor.readFinishLedger(row);
      if (ledger) result = { branch: ledger.branch, sha: ledger.headSha };
      if (verdict.state !== 'COMPLETED') {
        const progress = await this.pushRunProgress(row);
        if (progress === null) return;   // halted: ABANDON owns the job now
        wipPush = progress.value;
        if (progress.result) result = progress.result;
      }
    }
```

and the final snapshot:

```ts
    const snapshot: SnapshotEventPayload = {
      ...judged.snapshot, ...(result.branch ? { resultBranch: result.branch } : {}), ...(result.sha ? { resultSha: result.sha } : {}),
      ...(wipPush ? { wipPush } : {}),
    };
```

- [ ] **Step 6: Run the runner unit suite**

Run: `cd apps/runner && bun run test`
Expected: PASS, including every existing `job-run.spec.ts` test (the COMPLETED happy path must not change).

- [ ] **Step 7: Lint, type-check, commit**

Run: `cd apps/runner && bun run type-check && bun run lint`

```bash
git add apps/runner/src/executor/job-executor.ts apps/runner/src/executor/host-executor.ts apps/runner/src/supervisor/job-run.ts apps/runner/src/supervisor/job-run.spec.ts apps/runner/test/helpers/fake-executor.ts
git commit -m "feat(runner): push an unfinished RUN's progress before uploading and report wipPush"
```

---

### Task 4: Fake nax scenarios and runner integration test

**Files:**
- Modify: `apps/runner/test/fixtures/fake-nax.ts` (scenario `cost-limit`, env `FAKE_NAX_DIRTY_PRD`)
- Modify: `apps/runner/test/integration/harness/world.ts` (`dispatch` gains `pinnedRunnerId`; `JobView.wipPush`)
- Create: `apps/runner/test/integration/wip-push.integration.spec.ts`

**Interfaces:**
- Consumes: everything above; the real API with the Task 1 migration.
- Produces: `World.dispatch({ ..., pinnedRunnerId?: string })`; `JobView.wipPush: string | null`.

- [ ] **Step 1: Extend the fake nax**

In `apps/runner/test/fixtures/fake-nax.ts`, replace

```ts
  runStatus = scenario === 'failed' ? 'failed' : 'completed';
```

with

```ts
  runStatus = scenario === 'failed' ? 'failed' : scenario === 'cost-limit' ? 'cost-limit' : 'completed';
  // S1b 1a: what nax leaves after an unfinished run: an updated PRD and story code it never committed.
  if (process.env['FAKE_NAX_DIRTY_PRD'] === '1') {
    const prdPath = join(process.cwd(), '.nax', 'features', feature, 'prd.json');
    const current = JSON.parse(readFileSync(prdPath, 'utf8')) as { userStories?: Array<Record<string, unknown>> };
    const stories = (current.userStories ?? []).map((s) => ({ ...s, status: 'passed', attempts: 1 }));
    writeFileSync(prdPath, `${JSON.stringify({ ...current, userStories: stories }, null, 2)}\n`);
    writeFileSync(join(process.cwd(), 'koda-fake-uncommitted.txt'), 'half-done\n');
  }
```

(`readFileSync`, `writeFileSync` and `join` are already imported by the fixture; `git` from `git-fixture` throws
on a non-zero exit, which the `merge-base --is-ancestor` check in Step 3 relies on.)

- [ ] **Step 2: Extend the harness**

`apps/runner/test/integration/harness/world.ts`:
- `JobView`: add `wipPush: string | null;` and in `job()` add `wipPush: r.wipPush,`.
- `World.dispatch` input type: add `pinnedRunnerId?: string`.
- In `dispatch`'s body object add `...(input.pinnedRunnerId ? { pinnedRunnerId: input.pinnedRunnerId } : {}),`.

- [ ] **Step 3: Write the integration test**

Create `apps/runner/test/integration/wip-push.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { git as sh } from '../helpers/git-fixture';
import { createWorld, type TestRunner, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';

describe.skipIf(!enabled)('S1b 1a: an unfinished RUN pushes its progress and another runner continues it', () => {
  let world: World;
  let a: TestRunner;
  let b: TestRunner;
  let aId: string;
  let bId: string;
  beforeAll(async () => {
    world = await createWorld();
    a = await world.addRunner('wip-a');
    b = await world.addRunner('wip-b');
    await a.start();
    await b.start();
    aId = (await a.identity()).runnerId;
    bId = (await b.identity()).runnerId;
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('FAILED on runner A pushes story commits plus only prd.json; COMPLETED on runner B continues that branch', async () => {
    const first = await world.withFake({ FAKE_NAX_SCENARIO: 'failed', FAKE_NAX_DIRTY_PRD: '1' }, async () => {
      const id = await world.dispatch({ feature: 'fd', pinnedRunnerId: aId });
      return world.waitForJob(id, (j) => j.state === 'FAILED');
    });
    expect(first).toMatchObject({ stateReason: 'run status: failed', wipPush: 'pushed', resultBranch: 'feat/fd' });
    const tip = await sh(world.origin.dir, 'rev-parse', 'feat/fd');
    expect(first.resultSha).toBe(tip);
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fd')).toBe(`chore(nax): progress of fd via koda job ${first.id}`);
    expect(await sh(world.origin.dir, 'show', '--name-only', '--format=', 'feat/fd')).toBe('.nax/features/fd/prd.json');
    expect(await sh(world.origin.dir, 'log', '-1', '--format=%s', 'feat/fd~1')).toContain('fake story work');
    expect(await sh(world.origin.dir, 'ls-tree', '-r', '--name-only', 'feat/fd')).not.toContain('koda-fake-uncommitted.txt');

    const secondId = await world.dispatch({ feature: 'fd', pinnedRunnerId: bId });
    const second = await world.waitForJob(secondId, (j) => j.state === 'COMPLETED');
    expect(second.runnerId).toBe(bId);
    expect(second.wipPush).toBeNull();
    await sh(world.origin.dir, 'merge-base', '--is-ancestor', tip, 'feat/fd');   // throws if B did not build on A's push
    const subjects = (await sh(world.origin.dir, 'log', '--format=%s', 'main..feat/fd')).split('\n');
    expect(subjects.filter((s) => s.includes('fake story work'))).toHaveLength(2);
  });

  test('a cost-limit stop pushes too', async () => {
    const job = await world.withFake({ FAKE_NAX_SCENARIO: 'cost-limit' }, async () => {
      const id = await world.dispatch({ feature: 'fe', pinnedRunnerId: aId });
      return world.waitForJob(id, (j) => j.state === 'FAILED');
    });
    expect(job).toMatchObject({ stateReason: 'run status: cost-limit', wipPush: 'pushed', resultBranch: 'feat/fe' });
    expect(await sh(world.origin.dir, 'rev-parse', 'feat/fe')).toBe(job.resultSha);
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd apps/api && bun run test:db:up` then `cd apps/runner && KODA_DB_TESTS=1 bun test test/integration/wip-push.integration.spec.ts`
Expected: PASS (2 tests). Then the whole integration suite:
`cd apps/runner && KODA_DB_TESTS=1 bun run test:integration` → PASS (the fake-nax change must not alter existing
scenarios: `cost-limit` and `FAKE_NAX_DIRTY_PRD` are opt-in).

- [ ] **Step 5: Commit**

```bash
git add apps/runner/test/fixtures/fake-nax.ts apps/runner/test/integration/harness/world.ts apps/runner/test/integration/wip-push.integration.spec.ts
git commit -m "test(runner): integration for progress push and cross-runner continuation"
```

---

### Task 5: Web — show `wipPush` on the job page

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (`FleetJobDto`)
- Modify: `apps/web/lib/fleet-jobs.ts` (new `wipPushStatus`)
- Modify: `apps/web/pages/[project]/fleet/jobs/[id].vue:196` (branch row)
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json` (`fleet.jobs.detail.wipPush.*`)
- Test: `apps/web/tests/lib/fleet-jobs.spec.ts`

**Interfaces:**
- Consumes: `FleetJobDto.wipPush` (Task 1).
- Produces:

```ts
export interface WipPushStatus { readonly key: 'pushed' | 'none' | 'failed'; readonly reason: string | null }
export function wipPushStatus(value: string | null | undefined): WipPushStatus | null;
```

- [ ] **Step 1: Write the failing test**

In `apps/web/tests/lib/fleet-jobs.spec.ts` add `wipPushStatus` to the import list and:

```ts
describe('wipPushStatus', () => {
  test('parses the three outcomes and ignores anything else', () => {
    expect(wipPushStatus('pushed')).toEqual({ key: 'pushed', reason: null })
    expect(wipPushStatus('none')).toEqual({ key: 'none', reason: null })
    expect(wipPushStatus('failed:diverged')).toEqual({ key: 'failed', reason: 'diverged' })
    expect(wipPushStatus(null)).toBeNull()
    expect(wipPushStatus(undefined)).toBeNull()
    expect(wipPushStatus('weird')).toBeNull()
  })
})
```

Run: `cd apps/web && bun run test -- tests/lib/fleet-jobs.spec.ts`
Expected: FAIL ("wipPushStatus is not a function" / import error).

- [ ] **Step 2: Implement the helper and type**

`apps/web/lib/fleet-types.ts`, in `FleetJobDto` after `resultPrUrl: string | null`:

```ts
  wipPush: string | null
```

`apps/web/lib/fleet-jobs.ts`, after `safePrUrl`:

```ts
export interface WipPushStatus {
  readonly key: 'pushed' | 'none' | 'failed'
  readonly reason: string | null
}

/** S1b §1.1: the runner's progress-push outcome after an unfinished RUN. */
export function wipPushStatus(value: string | null | undefined): WipPushStatus | null {
  if (value === 'pushed' || value === 'none') return { key: value, reason: null }
  if (typeof value === 'string' && value.startsWith('failed:')) return { key: 'failed', reason: value.slice('failed:'.length) }
  return null
}
```

Run: `cd apps/web && bun run test -- tests/lib/fleet-jobs.spec.ts`
Expected: PASS.

- [ ] **Step 3: Render it and add strings**

`apps/web/pages/[project]/fleet/jobs/[id].vue`: import `wipPushStatus` with the other `~/lib/fleet-jobs` imports
and add near `prUrl`:

```ts
const wipPush = computed(() => wipPushStatus(job.value?.wipPush))
```

Replace the branch `<dd>` on line 196 with:

```vue
<dd class="break-all">{{ job.resultBranch ?? '-' }}<template v-if="job.resultSha"> ({{ job.resultSha.slice(0, 12) }})</template><span v-if="wipPush" class="block text-xs text-muted-foreground">{{ wipPush.key === 'failed' ? t('fleet.jobs.detail.wipPush.failed', { reason: wipPush.reason }) : t(`fleet.jobs.detail.wipPush.${wipPush.key}`) }}</span></dd>
```

`apps/web/i18n/locales/en.json`, in `fleet.jobs.detail` after `"escalation": ...`:

```json
        "wipPush": {
          "pushed": "Progress pushed to the branch",
          "none": "No new progress to push",
          "failed": "Progress push failed: {reason}"
        },
```

`apps/web/i18n/locales/zh.json`, same place:

```json
        "wipPush": {
          "pushed": "进度已推送到分支",
          "none": "没有新的进度需要推送",
          "failed": "进度推送失败：{reason}"
        },
```

Keep valid JSON (commas) in both files.

- [ ] **Step 4: Run the web checks**

Run: `cd apps/web && bun run test && bun run lint && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-types.ts apps/web/lib/fleet-jobs.ts "apps/web/pages/[project]/fleet/jobs/[id].vue" apps/web/i18n/locales/en.json apps/web/i18n/locales/zh.json apps/web/tests/lib/fleet-jobs.spec.ts
git commit -m "feat(web): show the progress push outcome on the fleet job page"
```

---

### Task 6: Whole-slice verification

- [ ] **Step 1: Repo-wide gates**

Run from the repo root: `bun run type-check && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 2: Integration suites touched by this slice**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet`
Run: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`
Expected: PASS.

- [ ] **Step 3: Contract drift check**

Run: `bun run generate && git status --short openapi.json apps/cli/src/generated`
Expected: no changes (Task 1 already committed the regenerated files).
