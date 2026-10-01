# Fleet S1b Slice 1b — Story List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each RUN job's page shows nax's PRD story checklist live (status, attempts, the current story with its
phase), fed from the runner's snapshots. The plan also adds an integration test for the 1a halted-push gap (D144).

**Architecture:** A new pure module `apps/runner/src/watcher/prd-stories.ts` reads
`<repo>/.nax/features/<feature>/prd.json` (at most 1 MiB) and maps it to a capped story list (8 KiB, 100 stories).
The `Watcher` adds that list to a snapshot only when it changed, and only for RUN jobs. The API mirrors `stories`
and `storiesTruncated` into two new `FleetJob` columns, the single-job DTO exposes them, and the web job page renders
them in a new `FleetJobStories` component. A last task holds the progress push in the runner integration harness
to prove a halted job pushes nothing.

**Tech Stack:** Bun + TypeScript (runner, `bun test`), NestJS + Prisma + Jest (API), Nuxt 3 + Jest (web), git.

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §1.2, §1.3 (`stories`,
`storiesTruncated`), §1.4 (checklist), §1.5 (1b items). The D144 task closes the gap noted in PR #183 against the
1a item "a halted job pushes nothing". Issue #185 (wipPush over HTTP) is folded into Task 3.

## Global Constraints

- PRD read skipped when the file exceeds **1 MiB**; a missing, oversize or unparsable PRD omits the field and never
  fails the job.
- Story: `{ id, title, status, attempts, dependsOn }`; `title` clipped to **80** UTF-16 units, never splitting a
  surrogate pair; `dependsOn` at most **10** ids; `attempts` an integer `>= 0`; `status` is nax's string, passed
  through (`pending`, `in-progress`, `passed`, `failed`, `skipped`, `blocked`, `paused`, `regression-failed`,
  `decomposed`).
- The serialized `stories` array is at most **8 KiB** (UTF-8 bytes), PRD order, cut before the story that would
  exceed it, `storiesTruncated: true`. At most **100** stories in any case.
- Sent only when the list differs from the last one sent for this job and epoch.
- `FLEET_PROTOCOL_VERSION` stays `1`; `stories` and `storiesTruncated` are optional snapshot fields.
- The server mirror drops an invalid or over-cap list and keeps the rest of the snapshot; it never rejects the
  event.
- `requeue` clears `stories` and `storiesTruncated` with the other live fields.
- The `fleet_job` live event is unchanged; the job page already refetches on it.
- Runner tests: `cd apps/runner && bun run test` (unit), `KODA_DB_TESTS=1 bun run test:integration` (needs
  `cd apps/api && bun run test:db:up`). API: `cd apps/api && bun run test:scoped <paths>` for one unit or integration spec (paths relative to
  `apps/api`; unit specs need no DB). Never `bun run test:unit -- <path>`: the script's
  `--testPathIgnorePatterns` swallows the path and runs the whole suite green. Web: `cd apps/web && bun run test -- <path>`. Never run bare
  `bun test` at the repo root.
- No emojis in source; no `console.log` in source.

## Decisions

| # | Decision | Why |
|:--|:--|:--|
| D146 | Stories are read for **RUN** jobs only: `HostExecutor.createWatcher` passes `repoDir` only when `job.command === 'RUN'`. | During a PLAN the checkout's `prd.json` is an older plan's, or absent; showing it would be wrong. |
| D147 | Mapping defaults copy nax's `loadPRD` normalisation (`packages/nax/src/prd/index.ts:121-131`): missing `status` is `pending`, missing `attempts` is `0`, missing `dependencies` is `[]`. `dependsOn` is koda's name for nax's `dependencies`. A story without a usable id (not a string, blank, over 128 chars) is skipped. A status that is not `^[a-z][a-z-]{0,31}$` becomes `unknown`. `attempts` is capped at 1,000,000. | The checklist shows what nax itself would read. The id and status bounds are what the server accepts, so a stray story cannot make the server drop the whole list. |
| D148 | The change gate compares the serialized list string, not a hash, and the watcher's snapshot dedup key includes it, so a PRD-only change still emits a snapshot. An unreadable PRD keeps the previous key. | The list is at most 8 KiB, so the string is as cheap as a hash and cannot collide. Keeping the key on a failed read avoids two redundant snapshots each time nax is caught mid-write. |
| D149 | `GET /fleet/jobs` (the list) returns `stories: null`, `storiesTruncated: false` via `FleetJobDto.summary`; only single-job responses carry the list. | A 100-row page would carry up to 800 KiB of stories no list view renders. The spec says "exposed in `FleetJobDto`"; the PR notes this narrowing. |
| D150 | The server mirrors `storiesTruncated` only together with an accepted `stories` list, as `p.storiesTruncated === true`. | The two are one fact; a flag without its list would describe a list the server does not have. |
| D151 | The runner's oversize-snapshot fallback (`JobEvents.snapshot`) tries the full payload, then without `progress` (as today), then without the story list, then without both. A dropped list is resent only on the next PRD change (the watcher already recorded it as sent). | Stories plus a 2,000-character escalation reason plus 4 KiB progress can pass 16 KiB; the event must never be refused by the sync parser. Reaching the second fallback needs about 8 KiB of other fields, so the stale-list case is practically unreachable. |
| D152 | The web highlights the current story only while the job is active (`QUEUED` to `UPLOADING`). | A finished job's `currentStoryId` is history, not "now". |
| D153 | D144 gets an integration test: the harness git front holds the progress push's first request; the test writes the `CRASHED` + epoch bump and the `ABANDON` row itself (what `FenceService.abandon` writes), waits for `deliveredAt`, then fails the held request. The push's 2 s retry back-off is where the halt is seen. | The fence only fires when a sync mentions the job, which an exited nax no longer guarantees. `abandon()` waits on the repo mutex the push holds, so the test cannot wait for the ack before releasing. |

## Review Focus

1. A PRD with 150 stories and long titles: the list keeps PRD order, stops before the story that would pass 8 KiB,
   sets `storiesTruncated`, and the server accepts it. (Task 1 "byte cap"; Task 3 "accepts a full 8 KiB list".)
2. nax caught mid-write (`{"userSto`): that poll's snapshot has no `stories`, the job is unaffected, and the next
   good read sends the list. (Task 2 "an unreadable PRD".)
3. An emoji at the 80-character title boundary: no lone surrogate reaches the server, whose 80-unit check passes.
   (Task 1 "clips titles".)
4. A status-only change after the list was sent: the snapshot carries no `stories`, and the server keeps the stored
   list, because an absent field is unchanged. (Task 2 "not again while unchanged"; Task 3 "absent list".)
5. A requeue: the old epoch's list is cleared, and the new epoch's watcher sends it again. (Task 3 requeue test; the
   watcher is per epoch, so its gate starts empty.)

---

### Task 1: Protocol fields and the `prd-stories` module

**Files:**
- Modify: `packages/fleet-protocol/src/index.ts` (`SnapshotEventPayload`, ~line 84-104)
- Modify: `apps/runner/src/watcher/status-snapshot.ts` (export `clip`)
- Create: `apps/runner/src/watcher/prd-stories.ts`
- Test: `apps/runner/src/watcher/prd-stories.spec.ts`

**Interfaces:**
- Produces: `SnapshotStory { id: string; title: string; status: string; attempts: number; dependsOn: string[] }`
  (protocol); `SnapshotEventPayload.stories?: SnapshotStory[]`, `.storiesTruncated?: boolean`;
  `STORY_LIMITS`; `StoryList { stories: SnapshotStory[]; truncated: boolean }`;
  `mapPrdStories(prd: unknown): StoryList | null`; `readPrdStories(path: string): Promise<StoryList | null>`
  (never throws); `clip(text: string | undefined, max: number): string | undefined` exported from
  `status-snapshot.ts`.

- [ ] **Step 1: Add the protocol types**

In `packages/fleet-protocol/src/index.ts`, directly above `export interface SnapshotEventPayload`:

```ts
/** S1b §1.2: one PRD user story, as the runner read it from nax's prd.json. */
export interface SnapshotStory {
  id: string;
  /** At most 80 UTF-16 units. */
  title: string;
  /** nax's story status, passed through (`pending`, `in-progress`, `passed`, ...). */
  status: string;
  attempts: number;
  /** nax's `dependencies`, at most 10 ids. */
  dependsOn: string[];
}
```

Inside `SnapshotEventPayload`, after the `wipPush?: string;` field:

```ts
  /** S1b §1.2: the PRD's stories in PRD order, sent only when changed. At most 100 stories and 8 KiB serialized. */
  stories?: SnapshotStory[];
  /** S1b §1.2: true when the runner cut `stories` to fit; sent with `stories`. */
  storiesTruncated?: boolean;
```

Run: `cd packages/fleet-protocol && bun run type-check`
Expected: PASS.

- [ ] **Step 2: Export `clip`**

In `apps/runner/src/watcher/status-snapshot.ts` change `function clip(` to `export function clip(`.

- [ ] **Step 3: Write the failing tests**

Create `apps/runner/src/watcher/prd-stories.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { STORY_LIMITS, mapPrdStories, readPrdStories } from './prd-stories';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('mapPrdStories (S1b §1.2)', () => {
  test('maps each story to id/title/status/attempts/dependsOn and drops every other key', () => {
    const list = mapPrdStories({
      feature: 'f',
      userStories: [
        { id: 'US-001', title: 'Login', status: 'passed', attempts: 2, dependencies: [], acceptanceCriteria: ['x'], routing: {} },
        { id: 'US-002', title: 'Logout', status: 'in-progress', attempts: 0, dependencies: ['US-001'] },
      ],
    });
    expect(list).toEqual({
      truncated: false,
      stories: [
        { id: 'US-001', title: 'Login', status: 'passed', attempts: 2, dependsOn: [] },
        { id: 'US-002', title: 'Logout', status: 'in-progress', attempts: 0, dependsOn: ['US-001'] },
      ],
    });
  });

  test('fills what nax would default (D147): status pending, attempts 0, dependsOn [], title empty', () => {
    expect(mapPrdStories({ userStories: [{ id: 'US-001' }] })?.stories).toEqual([
      { id: 'US-001', title: '', status: 'pending', attempts: 0, dependsOn: [] },
    ]);
  });

  test('skips a story without a usable id; odd fields fall back without dropping the story', () => {
    const list = mapPrdStories({
      userStories: [
        { title: 'no id' }, { id: '' }, { id: '   ' }, { id: 7 }, { id: 'x'.repeat(129) }, 'not an object', null,
        { id: 'US-009', title: 42, status: 'Weird Status', attempts: -1, dependencies: ['US-001', 3, '', ...Array.from({ length: 12 }, (_, i) => `D-${i}`)] },
        { id: 'US-010', attempts: 2.5, dependencies: 'US-001' },
        { id: 'US-011', attempts: 5_000_000 },
      ],
    });
    expect(list?.stories).toEqual([
      { id: 'US-009', title: '', status: 'unknown', attempts: 0, dependsOn: ['US-001', 'D-0', 'D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6', 'D-7', 'D-8'] },
      { id: 'US-010', title: '', status: 'pending', attempts: 0, dependsOn: [] },
      { id: 'US-011', title: '', status: 'pending', attempts: STORY_LIMITS.attempts, dependsOn: [] },
    ]);
    expect(list?.truncated).toBe(false);
  });

  test('clips titles to 80 units and never leaves half a surrogate pair (Review focus 3)', () => {
    const emoji = '\u{1F600}';   // two UTF-16 units
    const [plain, split] = mapPrdStories({
      userStories: [{ id: 'A', title: 'x'.repeat(100) }, { id: 'B', title: `${'y'.repeat(79)}${emoji}` }],
    })?.stories ?? [];
    expect(plain?.title).toBe('x'.repeat(80));
    expect(split?.title).toBe('y'.repeat(79));
  });

  test('byte cap: keeps PRD order and stops before the story that would pass 8 KiB (Review focus 1)', () => {
    const userStories = Array.from({ length: 150 }, (_, i) => ({ id: `US-${String(i).padStart(3, '0')}`, title: 't'.repeat(200), status: 'pending' }));
    const list = mapPrdStories({ userStories });
    expect(list?.truncated).toBe(true);
    const stories = list?.stories ?? [];
    expect(stories.length).toBeGreaterThan(0);
    expect(stories.length).toBeLessThan(100);
    expect(stories.map((s) => s.id)).toEqual(userStories.slice(0, stories.length).map((s) => s.id));
    expect(bytes(stories)).toBeLessThanOrEqual(STORY_LIMITS.bytes);
    const next = { id: userStories[stories.length]?.id ?? '', title: 't'.repeat(80), status: 'pending', attempts: 0, dependsOn: [] };
    expect(bytes([...stories, next])).toBeGreaterThan(STORY_LIMITS.bytes);
  });

  test('count cap: at most 100 stories even when they would fit', () => {
    const list = mapPrdStories({ userStories: Array.from({ length: 101 }, (_, i) => ({ id: `S${i}` })) });
    expect(list?.stories).toHaveLength(100);
    expect(list?.truncated).toBe(true);
    expect(mapPrdStories({ userStories: Array.from({ length: 100 }, (_, i) => ({ id: `S${i}` })) })?.truncated).toBe(false);
  });

  test('anything that is not a PRD object with a userStories array is null', () => {
    for (const value of [null, 'prd', [], { userStories: 'nope' }, { feature: 'f' }]) expect(mapPrdStories(value)).toBeNull();
    expect(mapPrdStories({ userStories: [] })).toEqual({ stories: [], truncated: false });
  });
});

describe('readPrdStories', () => {
  test('missing, oversize and unparsable files are null; a valid file is mapped', async () => {
    const dir = await tmp.make('prd');
    const path = join(dir, 'prd.json');
    expect(await readPrdStories(path)).toBeNull();
    await writeFile(path, '{"userSto');
    expect(await readPrdStories(path)).toBeNull();
    await writeFile(path, JSON.stringify({ userStories: [{ id: 'US-001', title: 'a'.repeat(STORY_LIMITS.prdBytes) }] }));
    expect(await readPrdStories(path)).toBeNull();
    await writeFile(path, JSON.stringify({ userStories: [{ id: 'US-001', title: 'a' }] }));
    expect(await readPrdStories(path)).toEqual({ stories: [{ id: 'US-001', title: 'a', status: 'pending', attempts: 0, dependsOn: [] }], truncated: false });
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd apps/runner && bun test src/watcher/prd-stories.spec.ts`
Expected: FAIL, `Cannot find module './prd-stories'`.

- [ ] **Step 5: Write the module**

Create `apps/runner/src/watcher/prd-stories.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import type { SnapshotStory } from '@nathapp/fleet-protocol';
import { clip } from './status-snapshot';

/** S1b §1.2 bounds. The server re-checks each one (`apps/api/src/fleet/sync/event-payloads.ts`). */
export const STORY_LIMITS = Object.freeze({
  count: 100, bytes: 8_192, prdBytes: 1_048_576, title: 80, id: 128, dependsOn: 10, attempts: 1_000_000,
} as const);

const STATUS_RE = /^[a-z][a-z-]{0,31}$/;

export interface StoryList {
  readonly stories: SnapshotStory[];
  readonly truncated: boolean;
}

const storyId = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= STORY_LIMITS.id ? value : null;

/** D147: the defaults are nax's own `loadPRD` normalisation; a story without a usable id is skipped. */
function mapStory(raw: unknown): SnapshotStory | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const story = raw as Record<string, unknown>;
  const id = storyId(story['id']);
  if (id === null) return null;
  const rawStatus = story['status'];
  const status = rawStatus === undefined ? 'pending' : typeof rawStatus === 'string' && STATUS_RE.test(rawStatus) ? rawStatus : 'unknown';
  const rawAttempts = story['attempts'];
  const attempts = typeof rawAttempts === 'number' && Number.isInteger(rawAttempts) && rawAttempts >= 0 ? Math.min(rawAttempts, STORY_LIMITS.attempts) : 0;
  const rawDeps = story['dependencies'];
  const dependsOn = Array.isArray(rawDeps)
    ? rawDeps.map(storyId).filter((dep): dep is string => dep !== null).slice(0, STORY_LIMITS.dependsOn)
    : [];
  const rawTitle = story['title'];
  const title = typeof rawTitle === 'string' ? clip(rawTitle, STORY_LIMITS.title) ?? '' : '';
  return { id, title, status, attempts, dependsOn };
}

/** S1b §1.2: PRD order, cut before the story that would pass 8 KiB serialized, and at most 100 stories. */
export function mapPrdStories(prd: unknown): StoryList | null {
  if (typeof prd !== 'object' || prd === null || Array.isArray(prd)) return null;
  const raw = (prd as Record<string, unknown>)['userStories'];
  if (!Array.isArray(raw)) return null;
  const stories: SnapshotStory[] = [];
  let size = 2;   // "[]"
  for (const item of raw) {
    const story = mapStory(item);
    if (story === null) continue;
    const add = Buffer.byteLength(JSON.stringify(story), 'utf8') + (stories.length > 0 ? 1 : 0);
    if (stories.length === STORY_LIMITS.count || size + add > STORY_LIMITS.bytes) return { stories, truncated: true };
    stories.push(story);
    size += add;
  }
  return { stories, truncated: false };
}

/** Null for a missing, oversize, unreadable or half-written PRD: the snapshot omits the field this poll. */
export async function readPrdStories(path: string): Promise<StoryList | null> {
  try {
    if ((await stat(path)).size > STORY_LIMITS.prdBytes) return null;
    const bytes = await readFile(path);
    if (bytes.length > STORY_LIMITS.prdBytes) return null;   // grew between stat and read
    return mapPrdStories(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/runner && bun test src/watcher/prd-stories.spec.ts src/watcher/status-snapshot.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fleet-protocol/src/index.ts apps/runner/src/watcher/status-snapshot.ts apps/runner/src/watcher/prd-stories.ts apps/runner/src/watcher/prd-stories.spec.ts
git commit -m "feat(runner): map nax's prd.json to a capped story list"
```

---

### Task 2: Watcher sends the list; RUN only; oversize fallback

**Files:**
- Modify: `apps/runner/src/watcher/watcher.ts`
- Modify: `apps/runner/src/executor/host-executor.ts:139-145` (`createWatcher`)
- Modify: `apps/runner/src/supervisor/job-events.ts:34-38` (`snapshot`)
- Test: `apps/runner/src/watcher/watcher.spec.ts`, `apps/runner/test/unit/host-executor.spec.ts`,
  `apps/runner/src/supervisor/job-events.spec.ts`

**Interfaces:**
- Consumes: `readPrdStories`, `StoryList` (Task 1); `featureDirFor(repoDir, feature)` from
  `apps/runner/src/paths/safe-segment.ts`.
- Produces: `WatcherOptions.repoDir?: string` (RUN only, D146).

- [ ] **Step 1: Write the failing watcher tests**

In `apps/runner/src/watcher/watcher.spec.ts`, add `import type { SnapshotStory } from '@nathapp/fleet-protocol';`
to the imports, add this helper after `runsDir`:

```ts
const prdPath = () => join(base, 'repo', '.nax', 'features', 'feat', 'prd.json');
const writePrd = async (stories: Array<Record<string, unknown>> | string) => {
  await mkdir(join(base, 'repo', '.nax', 'features', 'feat'), { recursive: true });
  await writeFile(prdPath(), typeof stories === 'string' ? stories : JSON.stringify({ feature: 'feat', userStories: stories }));
};
const story = (over: Partial<SnapshotStory> = {}): SnapshotStory => ({ id: 'US-001', title: 'first', status: 'pending', attempts: 0, dependsOn: [], ...over });
```

and a new `describe` block at the end of the file:

```ts
describe('story list (S1b §1.2)', () => {
  test('sends the list with the first snapshot, not again while unchanged, and again on a PRD-only change (Review focus 4)', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writeStatus();
    await writePrd([{ id: 'US-001', title: 'first', status: 'pending' }]);
    await w.tick();
    expect(snaps[0]).toMatchObject({ naxRunId: 'run-1', stories: [story()], storiesTruncated: false });

    await writeStatus({ progress: { total: 3, passed: 2, failed: 0, paused: 0, blocked: 0, pending: 1 } });
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).not.toHaveProperty('stories');
    expect(snaps[1]).not.toHaveProperty('storiesTruncated');

    await w.tick();
    expect(snaps).toHaveLength(2);

    await writePrd([{ id: 'US-001', title: 'first', status: 'passed', attempts: 1 }]);
    await w.tick();
    expect(snaps).toHaveLength(3);
    expect(snaps[2]).toMatchObject({ stories: [story({ status: 'passed', attempts: 1 })], storiesTruncated: false });
  });

  test('an unreadable PRD omits the list without an extra snapshot; the next good read sends it (Review focus 2)', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writeStatus();
    await writePrd('{"userSto');
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
    await w.tick();
    expect(snaps).toHaveLength(1);
    await writePrd([{ id: 'US-001', title: 'first' }]);
    await w.tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).toMatchObject({ stories: [story()] });
    await writePrd('{"userSto');
    await w.tick();
    expect(snaps).toHaveLength(2);
  });

  test('without repoDir (a PLAN job, D146) no list is ever read', async () => {
    const w = new Watcher(sink, options());
    await writeStatus();
    await writePrd([{ id: 'US-001' }]);
    await w.tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
  });

  test('no status.json yet: no snapshot, even with a PRD', async () => {
    const w = new Watcher(sink, options({ repoDir: join(base, 'repo') }));
    await writePrd([{ id: 'US-001' }]);
    await w.tick();
    expect(snaps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/runner && bun test src/watcher/watcher.spec.ts`
Expected: FAIL. The first test's snapshot has no `stories`, and `repoDir` is not a known option (type error).

- [ ] **Step 3: Implement in the watcher**

In `apps/runner/src/watcher/watcher.ts`:

Imports, add:

```ts
import { featureDirFor } from '../paths/safe-segment';
import { readPrdStories, type StoryList } from './prd-stories';
```

In `WatcherOptions`, after `readonly feature: string;`:

```ts
  /** D146: RUN jobs only. Stories come from `<repoDir>/.nax/features/<feature>/prd.json` (S1b §1.2). */
  readonly repoDir?: string;
```

In the class, after `private runLogPath: string | null = null;`:

```ts
  /** D148: the serialized list last sent for this job and epoch (one Watcher per JobRun). */
  private lastStories = '';
```

Replace the block in `pumpStatus` from `const { droppedLogs: _dropped, ...stable } = payload;` through
`this.sink.snapshot(payload);` with:

```ts
    const list = await this.readStories();
    // D148: a failed read keeps the last list's key, so nax caught mid-write emits nothing extra.
    const storiesKey = list ? JSON.stringify(list) : this.lastStories;
    const { droppedLogs: _dropped, ...stable } = payload;
    const key = `${JSON.stringify(stable)}\n${storiesKey}`;
    if (key === this.lastKey) return;      // lost logs ride the next snapshot that is emitted anyway (D45)
    this.lastKey = key;
    this.budget.takeDropped();
    if (list !== null && storiesKey !== this.lastStories) {
      this.lastStories = storiesKey;
      this.sink.snapshot({ ...payload, stories: list.stories, storiesTruncated: list.truncated });
    } else {
      this.sink.snapshot(payload);
    }
```

Add the private method after `pumpStatus`:

```ts
  private async readStories(): Promise<StoryList | null> {
    if (this.options.repoDir === undefined) return null;
    try {
      return await readPrdStories(join(featureDirFor(this.options.repoDir, this.options.feature), 'prd.json'));
    } catch {
      return null;   // featureDirFor refuses only a feature name the assign validator already refused
    }
  }
```

- [ ] **Step 4: Run the watcher tests**

Run: `cd apps/runner && bun test src/watcher/watcher.spec.ts`
Expected: PASS, including the existing tests.

- [ ] **Step 5: Write the failing HostExecutor tests**

In `apps/runner/test/unit/host-executor.spec.ts`, add `import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';`
to the imports. In the test `'the watcher sees snapshots and log lines from the real process'`, after
`expect(logs.join('')).toContain('story US-003 done');` add:

```ts
    // D146: a RUN job's watcher reads the checkout's prd.json (PRD = OLD-1, nothing else set).
    expect((snaps as SnapshotEventPayload[]).find((s) => s.stories !== undefined)).toMatchObject({
      stories: [{ id: 'OLD-1', title: '', status: 'pending', attempts: 0, dependsOn: [] }], storiesTruncated: false,
    });
```

Add a new `describe` at the end of the file:

```ts
describe('HostExecutor PLAN watcher', () => {
  test('a PLAN job never reads the checkout prd.json (D146)', async () => {
    const w = await world('PLAN');
    expect((await w.ex.prepare(w.row)).ok).toBe(true);
    await mkdir(join(w.row.jobDir, 'nax-out'), { recursive: true });
    await writeFile(join(w.row.jobDir, 'nax-out', 'status.json'), JSON.stringify({ version: 1, run: { id: 'plan-run', status: 'running' } }));
    const snaps: SnapshotEventPayload[] = [];
    const watcher = w.ex.createWatcher(w.row, { snapshot: (p) => { snaps.push(p); }, lifecycle: () => undefined, logLine: () => undefined }, { startAtEnd: false });
    await watcher.tick(true);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).not.toHaveProperty('stories');
  });
});
```

Run: `cd apps/runner && bun test test/unit/host-executor.spec.ts`
Expected: FAIL on the RUN assertion (no snapshot carries `stories`). The PLAN test passes already; it pins D146
against a later change.

- [ ] **Step 6: Pass `repoDir` for RUN jobs**

In `apps/runner/src/executor/host-executor.ts`, replace `createWatcher` with:

```ts
  createWatcher(job: JobRow, sink: WatcherSink, options: WatchOptions): JobWatcher {
    const { jobDir, outDir, repoDir } = this.dirs(job);
    return new Watcher(sink, {
      outDir, feature: job.assign.feature, stdoutPath: join(jobDir, 'nax.stdout'), stderrPath: join(jobDir, 'nax.stderr'),
      startAtEnd: options.startAtEnd, nowMs: this.deps.nowMs, onRunIds: options.onRunIds,
      ...(job.command === 'RUN' ? { repoDir } : {}),   // D146: a PLAN checkout's prd.json is an older plan's
    });
  }
```

Run: `cd apps/runner && bun test test/unit/host-executor.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing oversize-fallback test**

In `apps/runner/src/supervisor/job-events.spec.ts`, directly after the test
`'an oversize snapshot drops progress so it fits the 16 KiB payload limit'`, add:

```ts
  test('D151: a snapshot still too big without progress drops the story list next, and keeps progress when that fits', () => {
    const stories = [{ id: 'US-001', title: 'x'.repeat(20_000), status: 'pending', attempts: 0, dependsOn: [] }];
    events.snapshot({ naxRunId: 'r', progress: { total: 3 }, stories, storiesTruncated: false });
    events.snapshot({ naxRunId: 'r2', progress: { blob: 'x'.repeat(20_000) } as never, stories, storiesTruncated: true });
    const [first, second] = all().map((e) => e.payload);
    expect(first).toEqual({ naxRunId: 'r', progress: { total: 3 } });
    expect(second).toEqual({ naxRunId: 'r2' });
  });
```

Run: `cd apps/runner && bun test src/supervisor/job-events.spec.ts`
Expected: FAIL. Both events keep `stories` (only `progress` is dropped today).

- [ ] **Step 8: Extend the fallback**

In `apps/runner/src/supervisor/job-events.ts`, replace `snapshot` with:

```ts
  snapshot(payload: SnapshotEventPayload): void {
    // `_`-prefixed: ignored by the root eslint varsIgnorePattern '^_'
    const { progress: _progress, ...noProgress } = payload;
    const { stories: _stories, storiesTruncated: _truncated, ...noStories } = payload;
    const { stories: _s, storiesTruncated: _t, ...bare } = noProgress;
    // D151: progress goes first (as before), then the story list; the rest always fits.
    const fitting = [payload, noProgress, noStories].find((candidate) => byteLength(candidate) <= SYNC_LIMITS.payloadBytes) ?? bare;
    this.journal.appendEvent(this.jobId, this.leaseEpoch, 'snapshot', fitting);
  }
```

Run: `cd apps/runner && bun test src/supervisor/job-events.spec.ts`
Expected: PASS, including the existing progress test.

- [ ] **Step 9: Runner checks**

The runner's `tsc` also checks `test/integration`, which needs the generated Prisma client: run
`cd apps/api && bun run db:generate` once first if it has not been run in this checkout.

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add apps/runner/src/watcher apps/runner/src/executor/host-executor.ts apps/runner/src/supervisor/job-events.ts apps/runner/src/supervisor/job-events.spec.ts apps/runner/test/unit/host-executor.spec.ts
git commit -m "feat(runner): send the PRD story list in RUN snapshots when it changes"
```

---

### Task 3: API columns, mirror, DTO, requeue (and #185)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`model FleetJob`, after `wipPush`)
- Create: `apps/api/prisma/migrations/20261001150000_fleet_job_stories/migration.sql`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobStory`, `FleetJobRecord`, `Mutable`)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` (`toJob`, `update`)
- Modify: `apps/api/src/fleet/sync/event-payloads.ts` (`mirror`)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` (`FleetJobStoryDto`, fields, `from`, `summary`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (`list`, requeue `extra`)
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts` (`job()` literal)
- Test: `apps/api/src/fleet/sync/event-payloads.spec.ts`, `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`,
  `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
- Regenerate: `openapi.json` (`apps/cli/src/generated` is gitignored)

**Interfaces:**
- Consumes: `SnapshotEventPayload.stories`, `.storiesTruncated` (Task 1). The API imports the protocol package
  type-only, so the bounds are repeated here.
- Produces: `FleetJobStory` (domain); `FleetJobRecord.stories: FleetJobStory[] | null`,
  `.storiesTruncated: boolean`; `FleetJobDto.stories: FleetJobStoryDto[] | null`, `.storiesTruncated: boolean`;
  `FleetJobDto.summary(r)`; DB columns `FleetJob.stories JSONB NULL`, `FleetJob.storiesTruncated BOOLEAN NOT NULL
  DEFAULT false`.

- [ ] **Step 1: Write the failing mirror tests**

Append inside `describe('interpretEvent', ...)` in `apps/api/src/fleet/sync/event-payloads.spec.ts`:

```ts
  const st = (over: Record<string, unknown> = {}) => ({ id: 'US-001', title: 'first', status: 'passed', attempts: 1, dependsOn: [], ...over });

  it('mirrors a valid story list with its truncation flag and strips unknown story keys', () => {
    expect(interpretEvent('snapshot', { stories: [st({ extra: 'x' }), st({ id: 'US-002', dependsOn: ['US-001'] })], storiesTruncated: true }))
      .toEqual({ kind: 'mirror', patch: { stories: [st(), st({ id: 'US-002', dependsOn: ['US-001'] })], storiesTruncated: true } });
    expect(interpretEvent('snapshot', { stories: [] })).toEqual({ kind: 'mirror', patch: { stories: [], storiesTruncated: false } });
  });

  it('accepts a full 8 KiB list of 100 stories (Review focus 1)', () => {
    const stories = Array.from({ length: 100 }, (_, i) => st({ id: `S${i}`, title: '' }));
    expect(Buffer.byteLength(JSON.stringify(stories), 'utf8')).toBeLessThanOrEqual(8_192);
    expect(interpretEvent('snapshot', { stories })).toEqual({ kind: 'mirror', patch: { stories, storiesTruncated: false } });
  });

  it('drops an invalid or over-cap list (and its flag) but keeps the rest of the snapshot (D150)', () => {
    const bad: unknown[] = [
      'nope', [st(), 'x'], Array.from({ length: 101 }, (_, i) => st({ id: `S${i}`, title: '' })),
      Array.from({ length: 60 }, (_, i) => st({ id: `S${i}`, title: 't'.repeat(80) })),
      [st({ id: '' })], [st({ id: 'x'.repeat(129) })], [st({ title: 'x'.repeat(81) })], [st({ title: 3 })],
      [st({ status: 'Passed' })], [st({ status: 'x'.repeat(33) })], [st({ attempts: -1 })], [st({ attempts: 1.5 })],
      [st({ attempts: 1_000_001 })], [st({ dependsOn: 'US-001' })], [st({ dependsOn: Array.from({ length: 11 }, (_, i) => `D${i}`) })],
      [st({ dependsOn: [''] })],
    ];
    for (const stories of bad) {
      expect(interpretEvent('snapshot', { stories, storiesTruncated: true, currentPhase: 'review' })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
    }
  });

  it('an absent list leaves the stored one alone (Review focus 4)', () => {
    expect(interpretEvent('snapshot', { currentPhase: 'review', storiesTruncated: true })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/sync/event-payloads.spec.ts`
Expected: FAIL. Valid lists produce no `stories` in the patch.

- [ ] **Step 3: Column, migration, domain**

`apps/api/prisma/schema.prisma`, in `model FleetJob`, directly after the `wipPush` line:

```prisma
  stories           Json? // S1b §1.2: PRD stories, at most 100 and 8 KiB
  storiesTruncated  Boolean   @default(false)
```

(Match the column alignment of the surrounding lines; `bunx prisma format` from `apps/api` may realign them.)

Create `apps/api/prisma/migrations/20261001150000_fleet_job_stories/migration.sql`:

```sql
-- S1b slice 1b: the PRD story list from the runner's snapshots.
ALTER TABLE "FleetJob" ADD COLUMN "stories" JSONB;
ALTER TABLE "FleetJob" ADD COLUMN "storiesTruncated" BOOLEAN NOT NULL DEFAULT false;
```

Run: `cd apps/api && bun run db:generate`

`apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`: above `FleetJobRecord` add

```ts
/** S1b §1.2: one PRD user story as the runner reported it. */
export interface FleetJobStory {
  id: string;
  title: string;
  status: string;
  attempts: number;
  dependsOn: string[];
}
```

in `FleetJobRecord` after `wipPush: string | null;` add

```ts
  stories: FleetJobStory[] | null;
  storiesTruncated: boolean;
```

and change the last line of `Mutable` to:

```ts
  | 'resultBranch' | 'resultSha' | 'resultPrUrl' | 'wipPush' | 'stories' | 'storiesTruncated' | 'ackedRunnerSeq';
```

`apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `job()` literal: change `wipPush: null, eventSeq: 0,` to
`wipPush: null, stories: null, storiesTruncated: false, eventSeq: 0,`.

- [ ] **Step 4: Repository mapping**

`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`: import `FleetJobStory` from `./domain/fleet-job.domain`
alongside the existing domain imports. In `toJob`, after `costSpentUsd: r.costSpentUsd.toString(),` add:

```ts
  stories: r.stories as unknown as FleetJobStory[] | null,
```

In `update`, change the destructuring and add the JSON handling next to `progress`:

```ts
    const { bumpEpoch, costSpentUsd, progress, stories, ...rest } = patch;
    const data: Prisma.FleetJobUpdateInput = {
      ...rest,
      ...(costSpentUsd !== undefined ? { costSpentUsd: new Prisma.Decimal(costSpentUsd) } : {}),
      ...(progress !== undefined ? { progress: progress === null ? Prisma.DbNull : (progress as Prisma.InputJsonValue) } : {}),
      ...(stories !== undefined ? { stories: stories === null ? Prisma.DbNull : (stories as unknown as Prisma.InputJsonValue) } : {}),
      ...(bumpEpoch ? { leaseEpoch: { increment: 1 } } : {}),
    };
```

- [ ] **Step 5: Mirror the list**

In `apps/api/src/fleet/sync/event-payloads.ts`, change the domain import to
`import type { FleetJobPatch, FleetJobStory } from '../jobs/domain/fleet-job.domain';` and add after `WIP_PUSH_RE`:

```ts
/** S1b §1.2 bounds: the runner's STORY_LIMITS (`apps/runner/src/watcher/prd-stories.ts`). */
const STORIES_MAX = 100;
const STORIES_MAX_BYTES = 8_192;
const STORY_ID_MAX = 128;
const STORY_TITLE_MAX = 80;
const STORY_DEPENDS_MAX = 10;
const STORY_ATTEMPTS_MAX = 1_000_000;
const STORY_STATUS_RE = /^[a-z][a-z-]{0,31}$/;

const isStoryId = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && v.length <= STORY_ID_MAX;

function story(v: unknown): FleetJobStory | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { id, title, status, attempts, dependsOn } = v as Obj;
  if (!isStoryId(id) || typeof title !== 'string' || title.length > STORY_TITLE_MAX) return null;
  if (typeof status !== 'string' || !STORY_STATUS_RE.test(status)) return null;
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0 || attempts > STORY_ATTEMPTS_MAX) return null;
  if (!Array.isArray(dependsOn) || dependsOn.length > STORY_DEPENDS_MAX || !dependsOn.every(isStoryId)) return null;
  return { id: id as string, title, status, attempts, dependsOn: dependsOn as string[] };
}

/** One bad story drops the whole list: it is one mirrored field (S1b §1.3). */
function storyList(v: unknown): FleetJobStory[] | undefined {
  if (!Array.isArray(v) || v.length > STORIES_MAX || Buffer.byteLength(JSON.stringify(v), 'utf8') > STORIES_MAX_BYTES) return undefined;
  const stories = v.map(story);
  return stories.every((s) => s !== null) ? stories : undefined;
}
```

In `mirror()`, after the `progress` const add `const stories = storyList(p.stories);` and append to `entries`
after the `wipPush` entry:

```ts
    ['stories', stories],
    ['storiesTruncated', stories === undefined ? undefined : p.storiesTruncated === true],   // D150
```

Run: `cd apps/api && bun run test:scoped src/fleet/sync/event-payloads.spec.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing DTO test**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`, change the literal's line `wipPush: 'failed:diverged',`
to:

```ts
      wipPush: 'failed:diverged', stories: [{ id: 'US-001', title: 't', status: 'passed', attempts: 1, dependsOn: [] }], storiesTruncated: true,
```

and add a second test inside the `describe`, before its closing `});`:

```ts
  it('a list page leaves the story list out (D149); a single job carries it', () => {
    const record = {
      id: 'j', projectId: 'p', repoId: 'r', ref: 'main', command: 'RUN', feature: 'f', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null,
      leaseEpoch: 1, state: 'RUNNING', stateReason: null, requestedById: 'u', queuedAt: now, assignedAt: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null,
      progress: null, currentStoryId: 'US-001', currentPhase: 'implement', costSpentUsd: '0', lastHeartbeatAt: null,
      finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
      wipPush: null, stories: [{ id: 'US-001', title: 't', status: 'in-progress', attempts: 0, dependsOn: [] }], storiesTruncated: true,
      eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null, updatedAt: now,
    } as const;
    const full = JSON.parse(JSON.stringify(FleetJobDto.from({ ...record, stories: [...record.stories] } as never)));
    expect(full).toEqual(expect.objectContaining({ stories: [record.stories[0]], storiesTruncated: true }));
    const summary = JSON.parse(JSON.stringify(FleetJobDto.summary({ ...record, stories: [...record.stories] } as never)));
    expect(summary).toEqual(expect.objectContaining({ id: 'j', currentStoryId: 'US-001', stories: null, storiesTruncated: false }));
  });
```

and in the first test add after the `wipPush` expectation:

```ts
    expect(json).toEqual(expect.objectContaining({ stories: [{ id: 'US-001', title: 't', status: 'passed', attempts: 1, dependsOn: [] }], storiesTruncated: true }));
```

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/dto/fleet-job.dto.spec.ts`
Expected: FAIL. The suite does not compile (TS2339: `summary` does not exist on `typeof FleetJobDto`).

- [ ] **Step 7: Expose the list in the DTO**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, above `export class FleetJobDto`:

```ts
export class FleetJobStoryDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare title: string;
  @ApiProperty({ description: "nax's story status (pending, in-progress, passed, failed, ...)" }) declare status: string;
  @ApiProperty() declare attempts: number;
  @ApiProperty({ type: [String] }) declare dependsOn: string[];
}
```

after the `wipPush` property:

```ts
  @ApiPropertyOptional({ type: [FleetJobStoryDto], nullable: true, description: 'PRD stories in PRD order (S1b §1.2). Null on list pages (D149).' }) declare stories: FleetJobStoryDto[] | null;
  @ApiProperty({ description: 'True when the runner cut the story list to fit (S1b §1.2)' }) declare storiesTruncated: boolean;
```

in `from()`, directly after the existing line
`resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl, wipPush: r.wipPush,` add this
new line (do not retype the existing one):

```ts
      stories: r.stories, storiesTruncated: r.storiesTruncated,
```

and add after `from()`:

```ts
  /** D149: a list page leaves the story list out (100 rows of up to 8 KiB each); `GET :id` carries it. */
  static summary(r: FleetJobRecord): FleetJobDto {
    return Object.assign(FleetJobDto.from(r), { stories: null, storiesTruncated: false });
  }
```

`apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `list()`: change `FleetJobDto.from` to `FleetJobDto.summary`.

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/dto/fleet-job.dto.spec.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing integration assertions (requeue + #185)**

In `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`, test
`'requeues a CRASHED job: ...'`: change the `insertJob('rq', {...})` fields' last line from `wipPush: 'pushed',` to

```ts
      wipPush: 'pushed', stories: [{ id: 'US-001', title: 't', status: 'failed', attempts: 2, dependsOn: [] }], storiesTruncated: true,
```

and the `after` assertion to

```ts
    expect(after).toEqual(expect.objectContaining({ naxRunId: null, finishedAt: null, ackedRunnerSeq: 0, wipPush: null, stories: null, storiesTruncated: false }));
```

Add a new test at the end of the `describeIntegration` block:

```ts
  it('serves stories and wipPush over HTTP; list pages leave the stories out (S1b 1b, D149, #185)', async () => {
    const stories = [
      { id: 'US-001', title: 'first', status: 'passed', attempts: 1, dependsOn: [] },
      { id: 'US-002', title: 'second', status: 'in-progress', attempts: 0, dependsOn: ['US-001'] },
    ];
    const job = await insertJob('http-dto', { state: 'FAILED', wipPush: 'failed:diverged', stories, storiesTruncated: true, finishedAt: new Date() });
    const one = data<Record<string, unknown>>(await request(server).get(`/api/projects/web/fleet/jobs/${job.id}`).set(auth('dev')).expect(200));
    expect(one).toEqual(expect.objectContaining({ id: job.id, wipPush: 'failed:diverged', stories, storiesTruncated: true }));
    const page = data<{ records: Array<Record<string, unknown>> }>(
      await request(server).get('/api/projects/web/fleet/jobs').query({ feature: 'http-dto' }).set(auth('dev')).expect(200),
    );
    expect(page.records).toEqual([expect.objectContaining({ id: job.id, wipPush: 'failed:diverged', stories: null, storiesTruncated: false })]);
  });
```

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: FAIL. The requeue test still sees the stories (`requeue` does not clear them yet). The HTTP test passes
already if Steps 3-7 are in; it pins the DTO over HTTP (#185).

- [ ] **Step 9: Clear on requeue**

`apps/api/src/fleet/jobs/fleet-jobs.service.ts`, requeue `extra`, change the last line to:

```ts
            resultBranch: null, resultSha: null, resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,
            ackedRunnerSeq: 0, bumpEpoch: true,
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: PASS.

- [ ] **Step 10: Contract and API checks**

From the repo root: `bun run generate` (needs `apps/api/.env`; in a fresh worktree copy it from the main checkout,
or `api:export-spec` exits 1 with no message).
Then: `cd apps/api && bun run type-check && bun run lint && bun run test:unit`
Expected: all pass; `git diff --stat openapi.json` shows `FleetJobStoryDto`, `stories`, `storiesTruncated`.
Also run the fleet integration specs that read jobs:
`cd apps/api && bun run test:scoped test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts test/integration/fleet/fleet-jobs-schema.integration.spec.ts`
Expected: PASS.

The integration suites build their schema with `prisma db push`, so no test checks `migration.sql`. Verify it
against `schema.prisma` in a scratch database (a new name, so concurrent test runs are not disturbed):

```bash
docker exec koda-postgres-test-1 psql -U koda -d postgres -c 'CREATE DATABASE koda_shadow'
cd apps/api && bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow --exit-code
docker exec koda-postgres-test-1 psql -U koda -d postgres -c 'DROP DATABASE koda_shadow'
```

Expected: `No difference detected.`

- [ ] **Step 11: Commit**

```bash
git add apps/api/prisma apps/api/src/fleet apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts openapi.json
git commit -m "feat(fleet): stories snapshot fields, FleetJob columns and job DTO"
```

---

### Task 4: Web — story checklist on the job page

**Files:**
- Modify: `apps/web/lib/fleet-types.ts` (`FleetJobStoryDto`, `FleetJobDto`)
- Modify: `apps/web/lib/fleet-jobs.ts` (`storyRows`)
- Create: `apps/web/components/fleet/FleetJobStories.vue`
- Modify: `apps/web/pages/[project]/fleet/jobs/[id].vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Test: `apps/web/tests/lib/fleet-jobs.spec.ts`, create `apps/web/tests/components/fleet-job-stories.spec.ts`, `apps/web/tests/pages/fleet-job-detail.spec.ts`

**Interfaces:**
- Consumes: `FleetJobDto.stories`, `.storiesTruncated` from the API (Task 3).
- Produces: `storyRows(job): StoryRow[]`, `StoryRow { id; title; status; attempts; current; phase; variant }`;
  component `FleetJobStories` with prop `job: FleetJobDto`.

- [ ] **Step 1: Types**

`apps/web/lib/fleet-types.ts`: above `export interface FleetJobDto` add

```ts
export interface FleetJobStoryDto {
  id: string
  title: string
  status: string
  attempts: number
  dependsOn: string[]
}
```

and inside `FleetJobDto` after `wipPush: string | null`:

```ts
  stories: FleetJobStoryDto[] | null
  storiesTruncated: boolean
```

In `apps/web/tests/lib/fleet-jobs.spec.ts`, the `job()` literal: change `resultPrUrl: null, wipPush: null,` to
`resultPrUrl: null, wipPush: null, stories: null, storiesTruncated: false,`.

Run: `cd apps/web && bun run type-check`
Expected: PASS. (`nuxt typecheck` does not cover `tests/`, so the fixture edit is kept by hand, not enforced.)

- [ ] **Step 2: Write the failing `storyRows` tests**

In `apps/web/tests/lib/fleet-jobs.spec.ts` add `storyRows,` to the import list (alphabetical, after `safePrUrl,`)
and a new `describe` after `describe('wipPushStatus', ...)`:

```ts
describe('storyRows', () => {
  const stories = [
    { id: 'US-001', title: 'Login', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Logout', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
    { id: 'US-003', title: 'Audit', status: 'regression-failed', attempts: 3, dependsOn: [] },
    { id: 'US-004', title: 'Docs', status: 'decomposed', attempts: 0, dependsOn: [] },
  ]

  test('one row per story; status picks the badge variant; the active job highlights its current story', () => {
    const rows = storyRows(job({ state: 'RUNNING', stories, currentStoryId: 'US-002', currentPhase: 'implement' }))
    expect(rows.map(r => [r.id, r.variant, r.current, r.phase])).toEqual([
      ['US-001', 'default', false, null],
      ['US-002', 'secondary', true, 'implement'],
      ['US-003', 'destructive', false, null],
      ['US-004', 'outline', false, null],
    ])
    expect(rows[1]).toEqual(expect.objectContaining({ title: 'Logout', status: 'in-progress', attempts: 2 }))
  })

  test('a finished job highlights nothing (D152)', () => {
    expect(storyRows(job({ state: 'FAILED', stories, currentStoryId: 'US-002', currentPhase: 'implement' })).some(r => r.current)).toBe(false)
  })

  test('no list, or junk entries, give no rows', () => {
    expect(storyRows(job({ stories: null }))).toEqual([])
    const junk = [null, 'x', { title: 'no id' }, { id: '' }, { id: 'US-9', attempts: 'many' }] as unknown as FleetJobDto['stories']
    expect(storyRows(job({ stories: junk }))).toEqual([
      { id: 'US-9', title: '', status: 'pending', attempts: 0, current: false, phase: null, variant: 'outline' },
    ])
  })
})
```

Run: `cd apps/web && bun run test -- tests/lib/fleet-jobs.spec.ts`
Expected: FAIL, `storyRows` is not exported.

- [ ] **Step 3: Implement `storyRows`**

In `apps/web/lib/fleet-jobs.ts`, after `wipPushStatus`:

```ts
export interface StoryRow {
  id: string
  title: string
  status: string
  attempts: number
  /** D152: only while the job is active. */
  current: boolean
  phase: string | null
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
}

const STORY_VARIANTS: Readonly<Record<string, StoryRow['variant']>> = {
  'passed': 'default',
  'in-progress': 'secondary',
  'failed': 'destructive',
  'regression-failed': 'destructive',
}

/** S1b §1.4: the job page's story checklist. The server validated the list; each row is still checked. */
export function storyRows(job: Pick<FleetJobDto, 'stories' | 'state' | 'currentStoryId' | 'currentPhase'>): StoryRow[] {
  if (!Array.isArray(job.stories)) return []
  const active = isActiveJobState(job.state)
  return job.stories.flatMap((entry: unknown): StoryRow[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const s = entry as Record<string, unknown>
    const id = text(s.id)
    if (id === null) return []
    const status = text(s.status) ?? 'pending'
    const current = active && id === job.currentStoryId
    return [{
      id,
      title: text(s.title) ?? '',
      status,
      attempts: count(s.attempts) ?? 0,
      current,
      phase: current ? job.currentPhase : null,
      variant: STORY_VARIANTS[status] ?? 'outline',
    }]
  })
}
```

`text` and `count` are the module's existing helpers (`count` ~line 52, `text` ~line 95). Placing `storyRows`
right after `wipPushStatus` (before `text`) is fine: it only calls `text` at run time, and lint accepts it.

Run: `cd apps/web && bun run test -- tests/lib/fleet-jobs.spec.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing component test**

Create `apps/web/tests/components/fleet-job-stories.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import type { FleetJobDto } from '../../lib/fleet-types'

const file = webFile('components', 'fleet', 'FleetJobStories.vue')
const base = {
  state: 'RUNNING', currentStoryId: 'US-002', currentPhase: 'implement', storiesTruncated: false,
  stories: [
    { id: 'US-001', title: 'Login form', status: 'passed', attempts: 1, dependsOn: [] },
    { id: 'US-002', title: 'Session cookie', status: 'in-progress', attempts: 2, dependsOn: ['US-001'] },
  ],
} as unknown as FleetJobDto
const mount = (over: Partial<FleetJobDto> = {}) =>
  mountSfc(file, { props: { job: { ...base, ...over } }, globals: { useI18n: enI18n }, components: uiStubs })

describe('FleetJobStories (S1b §1.4)', () => {
  test('one row per story with title, translated status and attempts', () => {
    const { find, textOf, unmount } = mount()
    const rows = find('[data-testid="fleet-job-story"]')
    expect(rows.map(r => r.props['data-story'])).toEqual(['US-001', 'US-002'])
    expect(textOf(rows[0])).toContain('Login form')
    expect(textOf(rows[0])).toContain('Passed')
    expect(textOf(rows[0])).toContain('Attempts: 1')
    expect(find('[data-stub="badge"]').map(b => b.props.variant)).toEqual(['default', 'secondary'])
    unmount()
  })

  test('highlights the current story with its phase while the job is active', () => {
    const { find, textOf, unmount } = mount()
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'true'])
    const phase = find('[data-testid="fleet-job-story-phase"]')
    expect(phase).toHaveLength(1)
    expect(textOf(phase[0])).toContain('implement')
    unmount()
  })

  test('a finished job highlights nothing', () => {
    const { find, unmount } = mount({ state: 'FAILED' })
    expect(find('[data-testid="fleet-job-story"]').map(r => r.props['data-current'])).toEqual(['false', 'false'])
    expect(find('[data-testid="fleet-job-story-phase"]')).toHaveLength(0)
    unmount()
  })

  test('the truncation note shows only when the list was cut', () => {
    const plain = mount()
    expect(plain.find('[data-testid="fleet-job-stories-truncated"]')).toHaveLength(0)
    plain.unmount()
    const cut = mount({ storiesTruncated: true })
    const note = cut.find('[data-testid="fleet-job-stories-truncated"]')
    expect(note).toHaveLength(1)
    expect(cut.textOf(note[0])).toContain('first 2 stories')
    cut.unmount()
  })

  test('without a list it renders nothing (the page keeps the counts only)', () => {
    const { find, unmount } = mount({ stories: null })
    expect(find('[data-testid="fleet-job-stories"]')).toHaveLength(0)
    unmount()
  })
})
```

Run: `cd apps/web && bun run test -- tests/components/fleet-job-stories.spec.ts`
Expected: FAIL, the SFC file does not exist.

- [ ] **Step 5: Locale strings**

`apps/web/i18n/locales/en.json`, inside `fleet.jobs.detail`, after the `"wipPush": {...},` object:

```json
        "stories": {
          "title": "Stories",
          "attempts": "Attempts: {count}",
          "phase": "Now: {phase}",
          "truncated": "List truncated: showing the first {count} stories."
        },
```

and inside `"fleet"`, as a sibling directly after the `"state": {...}` object (the one whose keys are `QUEUED` to
`CANCELLED`, ~line 674-684):

```json
    "storyStatus": {
      "pending": "Pending",
      "in-progress": "In progress",
      "passed": "Passed",
      "failed": "Failed",
      "skipped": "Skipped",
      "blocked": "Blocked",
      "paused": "Paused",
      "regression-failed": "Regression failed",
      "decomposed": "Decomposed",
      "unknown": "Unknown"
    },
```

`apps/web/i18n/locales/zh.json`, same two places:

```json
        "stories": {
          "title": "故事",
          "attempts": "尝试次数：{count}",
          "phase": "当前阶段：{phase}",
          "truncated": "列表已截断：仅显示前 {count} 个故事。"
        },
```

```json
    "storyStatus": {
      "pending": "待处理",
      "in-progress": "进行中",
      "passed": "已通过",
      "failed": "失败",
      "skipped": "已跳过",
      "blocked": "已阻塞",
      "paused": "已暂停",
      "regression-failed": "回归失败",
      "decomposed": "已拆分",
      "unknown": "未知"
    },
```

- [ ] **Step 6: The component**

Create `apps/web/components/fleet/FleetJobStories.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import { storyRows } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t, te } = useI18n()

const rows = computed(() => storyRows(props.job))
const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.storyStatus', status)
</script>

<template>
  <section v-if="rows.length > 0" class="space-y-2" data-testid="fleet-job-stories">
    <h2 class="text-sm font-medium">{{ t('fleet.jobs.detail.stories.title') }}</h2>
    <ul class="divide-y divide-border rounded-md border border-border text-sm">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
        :class="row.current ? 'bg-muted' : ''"
        data-testid="fleet-job-story"
        :data-story="row.id"
        :data-current="row.current ? 'true' : 'false'"
        :aria-current="row.current ? 'step' : undefined"
      >
        <span class="font-mono text-xs">{{ row.id }}</span>
        <span class="min-w-0 flex-1 break-words">{{ row.title }}</span>
        <span v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-job-story-phase">{{ t('fleet.jobs.detail.stories.phase', { phase: row.phase }) }}</span>
        <span class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</span>
        <Badge :variant="row.variant">{{ statusLabel(row.status) }}</Badge>
      </li>
    </ul>
    <p v-if="job.storiesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-job-stories-truncated">
      {{ t('fleet.jobs.detail.stories.truncated', { count: rows.length }) }}
    </p>
  </section>
</template>
```

Run: `cd apps/web && bun run test -- tests/components/fleet-job-stories.spec.ts`
Expected: PASS.

- [ ] **Step 7: Put it on the page**

In `apps/web/pages/[project]/fleet/jobs/[id].vue`: after
`import FleetJobProgress from '~/components/fleet/FleetJobProgress.vue'` add
`import FleetJobStories from '~/components/fleet/FleetJobStories.vue'`, and directly after
`<FleetJobProgress :job="job" />` add:

```vue
      <FleetJobStories :job="job" />
```

Pin the wiring: in `apps/web/tests/pages/fleet-job-detail.spec.ts`, inside `describe('job detail', ...)`, add

```ts
  test('renders the story checklist under the progress block', () => {
    expect(detail).toMatch(/<FleetJobProgress :job="job" \/>\s*<FleetJobStories :job="job" \/>/)
  })
```

Run: `cd apps/web && bun run test -- tests/pages/fleet-job-detail.spec.ts`
Expected: PASS (FAIL if the page line is missing).

- [ ] **Step 8: Web checks**

Run: `cd apps/web && bun run type-check && bun run lint && bun run test`
Expected: all pass (an en/zh key-parity test, if present, passes because both locales gained the same keys).

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib apps/web/components/fleet/FleetJobStories.vue 'apps/web/pages/[project]/fleet/jobs/[id].vue' apps/web/i18n/locales apps/web/tests/lib/fleet-jobs.spec.ts apps/web/tests/components/fleet-job-stories.spec.ts apps/web/tests/pages/fleet-job-detail.spec.ts
git commit -m "feat(web): story checklist on the fleet job page"
```

---

### Task 5: Runner integration — stories end to end, and the halted push (D144, D153)

**Files:**
- Modify: `apps/runner/test/integration/harness/git-front.ts` (push hold)
- Modify: `apps/runner/test/integration/harness/world.ts` (`FEATURES`, `JobView`, `job()`, `World.holdPushes`)
- Modify: `apps/runner/test/integration/wip-push.integration.spec.ts`

**Interfaces:**
- Consumes: everything above; the 1a progress push (`apps/runner/src/executor/progress-push.ts`); its
  `PLAN_PUSH_BACKOFF_MS` first back-off of 2 s.
- Produces (test-only): `PushHold { reached: Promise<void>; attempts(): number; fail(): void; clear(): void }`;
  `GitFront.holdPushes(): PushHold`; `World.holdPushes(): PushHold`; `JobView.stories: unknown`,
  `JobView.storiesTruncated: boolean`.

- [ ] **Step 1: Add the push hold to the git front**

Replace `apps/runner/test/integration/harness/git-front.ts` with:

```ts
import { createGitHttp, type GitHttpRequest } from '../../helpers/git-http';

/** D153: holds git's push discovery so a test can land an ABANDON between nax exit and the progress push. */
export interface PushHold {
  /** Resolves when the first receive-pack request arrives. */
  readonly reached: Promise<void>;
  /** Receive-pack requests seen while armed. */
  attempts(): number;
  /** Answer the held request, and every later one while armed, with a 500. */
  fail(): void;
  /** Disarm; later pushes go through. */
  clear(): void;
}

export interface GitFront {
  readonly url: string;
  readonly requests: readonly GitHttpRequest[];
  holdPushes(): PushHold;
  stop(): void;
}

const isReceivePack = (url: URL): boolean =>
  url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';

interface Hold {
  count: number;
  readonly reached: () => void;
  readonly gate: Promise<void>;
}

/**
 * D91: the fake forge as the runner sees it. Git paths go to `git http-backend` and need the minted token as Basic
 * auth; every other path is proxied to the fake forge (the API's GitHub calls).
 */
export function startGitFront(forgeUrl: string, reposRoot: string, token: () => string): GitFront {
  const git = createGitHttp(reposRoot, { username: 'x-access-token', password: token });
  let hold: Hold | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,   // a held push waits for the test; Bun's default 10 s would drop it
    async fetch(req) {
      const url = new URL(req.url);
      const armed = hold;
      if (armed && isReceivePack(url)) {
        armed.count += 1;
        armed.reached();
        await armed.gate;
        return new Response('held by the test', { status: 500 });
      }
      const answered = await git.handle(req);
      if (answered) return answered;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
      return fetch(`${forgeUrl}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: git.requests,
    holdPushes() {
      let reached: () => void = () => undefined;
      let open: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      const state: Hold = { count: 0, reached: () => reached(), gate: new Promise<void>((resolve) => { open = resolve; }) };
      hold = state;
      return {
        reached: reachedPromise,
        attempts: () => state.count,
        fail: () => open(),
        clear: () => {
          if (hold === state) hold = null;
          open();
        },
      };
    },
    stop: () => { server.stop(true); },
  };
}
```

- [ ] **Step 2: Extend the world**

In `apps/runner/test/integration/harness/world.ts`:

- `import { startGitFront, type PushHold } from './git-front';` (replace the existing `startGitFront` import).
- `FEATURES`: append `'fh'`: `['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg', 'fh']`.
- `JobView`: append `stories: unknown; storiesTruncated: boolean;` after `wipPush: string | null;`.
- `job()`: change `currentStoryId: r.currentStoryId, wipPush: r.wipPush,` to
  `currentStoryId: r.currentStoryId, wipPush: r.wipPush, stories: r.stories, storiesTruncated: r.storiesTruncated,`.
- `World`: add `holdPushes(): PushHold;` after `withFake...`.
- In the returned world object, next to `gitRequests: front.requests,`, add `holdPushes: () => front.holdPushes(),`.
- `apps/runner/test/integration/harness/index.ts`: no change needed (`PushHold` is used through `World`).

Run: `cd apps/runner && bun run type-check`
Expected: PASS.

- [ ] **Step 3: Assert the story list in the existing 1a specs**

In `apps/runner/test/integration/wip-push.integration.spec.ts`:

Test `'FAILED on runner A pushes story commits plus only prd.json; ...'`, after the first `expect(first).toMatchObject(...)`:

```ts
    // S1b 1b: the final watcher tick read the PRD nax left behind (FAKE_NAX_DIRTY_PRD marks US-001 passed).
    expect(first.stories).toEqual([{ id: 'US-001', title: 'story', status: 'passed', attempts: 1, dependsOn: [] }]);
    expect(first.storiesTruncated).toBe(false);
```

Test `'a cost-limit stop pushes too'`, after its `toMatchObject`:

```ts
    expect(job.stories).toEqual([{ id: 'US-001', title: 'story', status: 'pending', attempts: 0, dependsOn: [] }]);
```

- [ ] **Step 4: Write the D144 test**

Add to the imports: `import { waitFor } from '../helpers/wait';`. Add a third test inside the `describe`:

```ts
  test('a halt between nax exit and the progress push pushes nothing (D144, D153)', async () => {
    const hold = world.holdPushes();
    try {
      const id = await world.withFake({ FAKE_NAX_SCENARIO: 'failed' }, async () => {
        const jobId = await world.dispatch({ feature: 'fh', pinnedRunnerId: aId });
        await hold.reached;   // nax has exited and the progress push is on the wire
        return jobId;
      });
      const held = await world.job(id);
      expect(held.state).toBe('RUNNING');
      // What the silence sweep and FenceService.abandon write. The runner's own fence would need a sync that
      // mentions the job, which an exited nax no longer guarantees (D153).
      await world.prisma.$transaction([
        world.prisma.fleetJob.update({ where: { id }, data: { state: 'CRASHED', leaseEpoch: { increment: 1 } } }),
        world.prisma.fleetCommand.create({ data: { runnerId: aId, jobId: id, type: 'ABANDON', leaseEpoch: held.leaseEpoch, payload: { reason: 'stale_lease' } } }),
      ]);
      await waitFor(
        async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', deliveredAt: { not: null } } })) > 0,
        { timeoutMs: 15_000, message: 'ABANDON was not delivered' },
      );
      // abandon() waits for the repo mutex the push holds, so the ack comes only after the push gives up. The failed
      // attempt's 2 s back-off is where the push sees the halt.
      hold.fail();
      await waitFor(
        async () => (await world.prisma.fleetCommand.count({ where: { jobId: id, type: 'ABANDON', ackResult: 'ok' } })) > 0,
        { timeoutMs: 30_000, message: 'ABANDON was not acked ok' },
      );
      expect(hold.attempts()).toBe(1);   // halted at the back-off, not three attempts exhausted
      expect(await sh(world.origin.dir, 'branch', '--list', 'feat/fh')).toBe('');
      expect(await world.job(id)).toMatchObject({ state: 'CRASHED', wipPush: null });
    } finally {
      hold.clear();
    }
  });
```

- [ ] **Step 5: Run the runner integration suite**

Run: `cd apps/api && bun run test:db:up && cd ../.. && bunx turbo run build --filter=@nathapp/koda-api && cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`

The harness runs the API's built `dist/main.js` (`harness/api-process.ts`): rebuild the API after any change under
`apps/api`, or the harness runs stale code and the new `stories` assertions fail.
Expected: PASS, all specs (23 before this slice, plus the new D144 test). If the D144 test times out at
"ABANDON was not delivered", check that the runner's sync loop is not blocked behind the push: the ABANDON is
delivered by a sync, and only its handling waits on the mutex.

To prove the test can fail: temporarily change `if (input.isHalted?.() === true) return { kind: 'halted' };` in
`apps/runner/src/executor/progress-push.ts` to `if (false) return { kind: 'halted' };`, rerun only this file
(`KODA_DB_TESTS=1 bun test test/integration/wip-push.integration.spec.ts`), and expect the D144 test to FAIL
(`attempts()` is 3). Revert the change.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/test/integration
git commit -m "test(runner): story list end to end; a halted job's progress push pushes nothing (D144)"
```

---

### Task 6: Whole-slice verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` (§1.3 D149 note; §1.5
  halted-push note)
- Modify: `.nax/mono/apps/runner/context.md` (watcher line), then regenerate agent files

- [ ] **Step 1: Spec notes**

In the spec §1.3, change the bullet that ends "exposed in `FleetJobDto`." so its first sentence reads:

```markdown
- `FleetJob` gains `wipPush String?` (1a) and `stories Json?`, `storiesTruncated Boolean @default(false)` (1b),
  exposed in `FleetJobDto` (list pages carry `stories: null`; 1b plan D149).
```

keeping the rest of that bullet (the requeue sentence) unchanged. In §1.5, after the 1a runner integration bullet,
add:

```markdown
  The halted case is covered by the 1b plan's D153 test (the harness holds the push).
```

Runner agent guidance: in `.nax/mono/apps/runner/context.md`, change the architecture line
`src/watcher/         status.json poll, run-log and stdout/stderr tails, rate cap` to
`src/watcher/         status.json poll, run-log and stdout/stderr tails, rate cap; RUN only: prd.json story list (S1b 1b), capped 100 stories / 8 KiB`.
Then regenerate the agent files from the repo root: `nax generate && nax generate --all-packages` (local, not a
billed run), and include every regenerated file in the commit below. Never edit the generated `AGENTS.md` /
`CLAUDE.md` files by hand.

- [ ] **Step 2: Repo-wide checks**

From the repo root:

Run: `bun run type-check && bun run lint && bun run test`
Expected: all workspaces pass.

Run: `bun run generate && git status --short openapi.json`
Expected: no changes (Task 3 committed the regenerated contract).

Run the integration suites touched by this slice:
`cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts test/integration/fleet/runner-sync.integration.spec.ts`
and, after `bunx turbo run build --filter=@nathapp/koda-api` from the repo root,
`cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md .nax/mono/apps/runner/context.md
git add -u   # the agent files nax generate rewrote
git commit -m "docs(fleet): S1b spec and runner context notes for the story list slice"
```

- [ ] **Step 4: PR notes to carry**

The PR body must state: closes #185 (HTTP coverage of `wipPush`, Task 3); closes the D144 gap from #183 (Task 5);
deviation D149 (list pages carry `stories: null`); D146 (PLAN jobs never send stories).
