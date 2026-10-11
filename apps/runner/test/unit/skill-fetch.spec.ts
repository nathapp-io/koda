import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const skillFetchModule = await import('../../src/thread/skill-fetch').catch(() => undefined);

const root = join(import.meta.dir, `.skill-fetch-${crypto.randomUUID()}`);
const skillsRoot = join(root, 'skills-cache');
const repositoryRoot = join(root, 'origin-repository');
const sha = 'a'.repeat(40);
const sourceId = 'public-skills';
const skillDir = 'skills/demo';
const now = new Date('2026-10-11T12:00:00.000Z');

interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

interface GitCall {
  args: string[];
  options: GitRunOptions;
}

function fakeGit(sourceExists = true): { run: (args: string[], options: GitRunOptions) => Promise<void>; calls: GitCall[] } {
  const calls: GitCall[] = [];
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options });
      if (args[0] === 'init') {
        await mkdir(join(options.cwd, '.git'), { recursive: true });
      }
      if (args.includes('fetch')) {
        if (!sourceExists || !args.includes(sha)) throw new Error('missing source SHA');
        await mkdir(options.cwd, { recursive: true });
        await writeFile(join(options.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await mkdir(join(options.cwd, skillDir), { recursive: true });
        await writeFile(join(options.cwd, skillDir, 'SKILL.md'), '# Demo skill\n', 'utf8');
      }
    },
  };
}

function skill(override: Record<string, unknown> = {}) {
  return {
    sourceId,
    owner: 'example-owner',
    repo: 'skills',
    sha,
    dir: skillDir,
    ...override,
  };
}

async function ensureModule(): Promise<boolean> {
  expect(skillFetchModule).toBeDefined();
  return skillFetchModule !== undefined;
}

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(join(repositoryRoot, skillDir), { recursive: true });
  await writeFile(join(repositoryRoot, skillDir, 'SKILL.md'), '# Demo skill\n', 'utf8');
});

beforeEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
  await mkdir(skillsRoot, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SHA-pinned public skill fetch and cache (US-003)', () => {
  test('US-003 AC-1: returns success when fetching a source from a file origin', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    const result = await skillFetchModule!.ensureSkills({
      skills: [skill()], skillsRoot, git, timeoutMs: 10_000, origin: `file://${repositoryRoot}`,
    });
    expect(result).toEqual({ ok: true });
  });

  test('US-003 AC-2: materializes the requested skill file beneath the cache snapshot', async () => {
    if (!(await ensureModule())) return;
    const result = await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git: fakeGit(), timeoutMs: 10_000 });
    expect(result.ok && await readFile(join(skillsRoot, sourceId, sha, skillDir, 'SKILL.md'), 'utf8')).toBe('# Demo skill\n');
  });

  test('US-003 AC-3: reuses a completed snapshot without fetching again', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    git.calls.length = 0;
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    expect(git.calls.some(({ args }) => args.includes('fetch'))).toBe(false);
  });

  test('US-003 AC-4: refreshes the mtime of a reused snapshot', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    const cachePath = join(skillsRoot, sourceId, sha);
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    await utimes(cachePath, old, old);
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    expect((await stat(cachePath)).mtime.getTime()).toBeGreaterThan(old.getTime());
  });

  test('US-003 AC-5: disables terminal prompting on fetch', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    const fetch = git.calls.find(({ args }) => args.includes('fetch'));
    expect(fetch?.options.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('US-003 AC-6: clears Git credential helpers for fetch', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git, timeoutMs: 10_000 });
    const fetch = git.calls.find(({ args }) => args.includes('fetch'));
    const configIndex = fetch?.args.indexOf('-c') ?? -1;
    expect(configIndex >= 0 && fetch?.args[configIndex + 1]).toBe('credential.helper=');
  });

  test('US-003 AC-7: removes Git metadata from the completed snapshot', async () => {
    if (!(await ensureModule())) return;
    await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git: fakeGit(), timeoutMs: 10_000 });
    const entries = await readdir(join(skillsRoot, sourceId, sha));
    expect(entries).not.toContain('.git');
  });

  test('US-003 AC-8: returns a fetch failure when the requested SHA is absent', async () => {
    if (!(await ensureModule())) return;
    const result = await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git: fakeGit(false), timeoutMs: 10_000 });
    expect(result).toEqual({ ok: false, reason: 'skill_fetch_failed' });
  });

  test('US-003 AC-9: leaves no cache entry when the requested SHA is absent', async () => {
    if (!(await ensureModule())) return;
    const result = await skillFetchModule!.ensureSkills({ skills: [skill()], skillsRoot, git: fakeGit(false), timeoutMs: 10_000 });
    const sourcePath = join(skillsRoot, sourceId);
    const entries = await readdir(sourcePath).catch(() => []);
    expect(result.ok === false && entries).toEqual([]);
  });

  test('US-003 AC-10: rejects a fetched tree larger than maxTreeBytes', async () => {
    if (!(await ensureModule())) return;
    const result = await skillFetchModule!.ensureSkills({
      skills: [skill()], skillsRoot, git: fakeGit(), timeoutMs: 10_000, maxTreeBytes: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'skill_fetch_failed' });
  });

  test('US-003 AC-11: rejects an option-like SHA before invoking git', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    const result = await skillFetchModule!.ensureSkills({
      skills: [skill({ sha: '--upload-pack=x' })], skillsRoot, git, timeoutMs: 10_000,
    });
    expect(result.ok === false && git.calls).toEqual([]);
  });

  test('US-003 AC-12: rejects a parent-traversing skill directory before invoking git', async () => {
    if (!(await ensureModule())) return;
    const git = fakeGit();
    const result = await skillFetchModule!.ensureSkills({
      skills: [skill({ dir: '../escape' })], skillsRoot, git, timeoutMs: 10_000,
    });
    expect(result.ok === false && git.calls).toEqual([]);
  });

  test('US-003 AC-13: prunes a snapshot older than the default cache age', async () => {
    if (!(await ensureModule())) return;
    const cachePath = join(skillsRoot, sourceId, sha);
    await mkdir(cachePath, { recursive: true });
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    await utimes(cachePath, old, old);
    await skillFetchModule!.pruneSkillCache(skillsRoot, now);
    const exists = await stat(cachePath).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  test('US-003 AC-14: retains a snapshot younger than the default cache age', async () => {
    if (!(await ensureModule())) return;
    const cachePath = join(skillsRoot, sourceId, sha);
    await mkdir(cachePath, { recursive: true });
    const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await utimes(cachePath, recent, recent);
    await skillFetchModule!.pruneSkillCache(skillsRoot, now);
    const exists = await stat(cachePath).then(() => true, () => false);
    expect(exists).toBe(true);
  });
});
