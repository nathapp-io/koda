import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { deleteJobProfile, jobProfileName, jobProfilePath, projectNameFor, sweepOrphanProfiles, writeJobProfile } from './job-profile';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const NAX_NAME = /^[a-z0-9_-]+$/;

describe('projectNameFor (design §2 step 5)', () => {
  test('lowercases, replaces other characters with -, appends the first 8 hex of SHA-256(owner/repo)', () => {
    expect(projectNameFor('Foo.Bar', 'My.Repo')).toBe(`foo-bar-my-repo-${sha8('Foo.Bar/My.Repo')}`);
    expect(projectNameFor('infra/team', 'deploy')).toBe(`infra-team-deploy-${sha8('infra/team/deploy')}`);
  });
  test('a 100-character name is truncated to 55 characters plus -hash8 (at most 64) and stays valid for nax', () => {
    const name = projectNameFor('a'.repeat(50), 'r'.repeat(100));
    expect(name).toHaveLength(64);
    expect(name).toMatch(NAX_NAME);
    expect(name.endsWith(`-${sha8(`${'a'.repeat(50)}/${'r'.repeat(100)}`)}`)).toBe(true);
  });
  test('leading -, _ and . are stripped so the name never starts with . or _', () => {
    const name = projectNameFor('acme', '.github');
    expect(name).toBe(`acme--github-${sha8('acme/.github')}`);
    const dotted = projectNameFor('._x', '__y');
    expect(dotted[0]).not.toMatch(/[._]/);
    expect(dotted).toMatch(NAX_NAME);
  });
  test('an all-symbol name falls back to "repo"; distinct repos with the same slug get distinct names', () => {
    expect(projectNameFor('...', '---')).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(projectNameFor('a.b', 'c')).not.toBe(projectNameFor('a-b', 'c'));
  });
});

describe('job profile file', () => {
  test('names and paths', () => {
    expect(jobProfileName('cabc123')).toBe('koda-job-cabc123');
    expect(jobProfilePath('/n', 'cabc123')).toBe(join('/n', 'profiles', 'koda-job-cabc123.json'));
    expect(() => jobProfileName('../x')).toThrow();
  });
  test('writes {outputDir, name}, replaces atomically, deletes idempotently', async () => {
    const home = await tmp.make('nax');
    const path = await writeJobProfile(home, 'j1', '/out/j1/nax-out', 'acme-app-12345678');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ outputDir: '/out/j1/nax-out', name: 'acme-app-12345678' });
    await writeJobProfile(home, 'j1', '/out/other', 'n');
    expect(JSON.parse(await readFile(path, 'utf8')).outputDir).toBe('/out/other');
    await deleteJobProfile(home, 'j1');
    await expect(stat(path)).rejects.toThrow();
    await deleteJobProfile(home, 'j1');
  });
  test('sweepOrphanProfiles removes koda-job profiles of unknown jobs and nothing else', async () => {
    const home = await tmp.make('nax');
    await mkdir(join(home, 'profiles'), { recursive: true });
    for (const f of ['koda-job-live.json', 'koda-job-dead.json', 'machine.json', 'koda-job-notes.txt']) await writeFile(join(home, 'profiles', f), '{}');
    expect(await sweepOrphanProfiles(home, new Set(['live']))).toEqual(['koda-job-dead.json']);
    await expect(stat(join(home, 'profiles', 'koda-job-dead.json'))).rejects.toThrow();
    for (const f of ['koda-job-live.json', 'machine.json', 'koda-job-notes.txt']) await stat(join(home, 'profiles', f));
    expect(await sweepOrphanProfiles(join(home, 'missing'), new Set())).toEqual([]);
  });
});
