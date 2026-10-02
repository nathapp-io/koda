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
