import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NAX_TRIGGER_NAMES } from '../approvals/nax-triggers';
import { makeTempDirs } from '../../test/helpers/tmp';
import { deleteJobProfile, jobProfileContent, jobProfileName, jobProfilePath, projectNameFor, sweepOrphanProfiles, writeJobProfile } from './job-profile';

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

describe('relay overlay (spec §4.1, plan D275)', () => {
  let naxHome!: string;
  beforeEach(async () => { naxHome = await tmp.make('profile-relay'); });
  const relay = { bashMode: 'escalate' as const, approvalTimeoutSec: 90, endpoint: { url: 'http://127.0.0.1:43210/ask', secret: 'f'.repeat(64) } };

  test('a raw job keeps the bare overlay', () => {
    expect(jobProfileContent('/out', 'acme-app-1234abcd')).toEqual({ outputDir: '/out', name: 'acme-app-1234abcd' });
  });

  test('AC-1: includes the bot cost limit', () => {
    expect(jobProfileContent('/out', 'p', undefined, 2.5)).toEqual({ outputDir: '/out', name: 'p', bot: { costLimit: 2.5 } });
  });

  test('a cost limit preserves relay overlay keys', () => {
    expect(jobProfileContent('/out', 'p', relay, 2.5)).toMatchObject({
      bot: { costLimit: 2.5 }, execution: { bashApproval: 'escalate', approvalTimeout: 90_000 }, interaction: { plugin: 'webhook' },
    });
  });

  test('a relayed job sets bash approval, the webhook plugin and silences every trigger', () => {
    expect(jobProfileContent('/out', 'p', relay)).toEqual({
      outputDir: '/out', name: 'p',
      execution: { bashApproval: 'escalate', approvalTimeout: 90_000 },
      interaction: {
        plugin: 'webhook',
        config: { url: 'http://127.0.0.1:43210/ask', secret: 'f'.repeat(64), requireSecret: true, callbackPort: 0 },
        triggers: Object.fromEntries(NAX_TRIGGER_NAMES.map((n) => [n, false])),
      },
    });
  });

  test('the written profile is mode 0600 (it now holds a secret)', async () => {
    const path = await writeJobProfile(naxHome, 'j1', '/out', 'p', relay);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).interaction.config.secret).toBe('f'.repeat(64));
  });
});

describe('agent model aliases overlay (fleet-agent-job US-008)', () => {
  let naxHome!: string;
  beforeEach(async () => { naxHome = await tmp.make('profile-agent'); });
  const relay = { bashMode: 'escalate' as const, approvalTimeoutSec: 600, endpoint: { url: 'http://127.0.0.1:1/ask', secret: 's'.repeat(64) } };

  test('AC-1: modelAliases { reviewer: "acp:claude" } becomes agent.modelAliases on the profile', () => {
    const profile = jobProfileContent('/out', 'p', undefined, undefined, { reviewer: 'acp:claude' });
    expect(profile.agent).toEqual({ modelAliases: { reviewer: 'acp:claude' } });
    expect((profile.agent as { modelAliases: Record<string, string> }).modelAliases).toEqual({ reviewer: 'acp:claude' });
    expect(profile).toMatchObject({ outputDir: '/out', name: 'p' });
  });

  test('AC-2: absent and empty aliases both leave no agent key at all', () => {
    for (const aliases of [undefined, {}]) {
      const profile = jobProfileContent('/out', 'p', undefined, undefined, aliases);
      expect('agent' in profile).toBe(false);
      expect(profile).toEqual({ outputDir: '/out', name: 'p' });
    }
  });

  test('AC-14: the bot cost limit keeps its exact shape when the aliases argument is omitted', () => {
    expect(jobProfileContent('/out', 'repo', undefined, 5)).toEqual({ outputDir: '/out', name: 'repo', bot: { costLimit: 5 } });
    expect('agent' in jobProfileContent('/out', 'repo', undefined, 5)).toBe(false);
  });

  test('aliases coexist with the relay overlay and the bot cost limit', () => {
    expect(jobProfileContent('/out', 'p', relay, 2.5, { reviewer: 'acp:claude' })).toMatchObject({
      bot: { costLimit: 2.5 },
      execution: { bashApproval: 'escalate', approvalTimeout: 600_000 },
      interaction: { plugin: 'webhook' },
      agent: { modelAliases: { reviewer: 'acp:claude' } },
    });
  });

  test('writeJobProfile writes the aliases, and an empty map writes no agent key', async () => {
    const path = await writeJobProfile(naxHome, 'j1', '/out', 'p', undefined, undefined, { reviewer: 'acp:claude' });
    expect(JSON.parse(await readFile(path, 'utf8')).agent).toEqual({ modelAliases: { reviewer: 'acp:claude' } });
    await writeJobProfile(naxHome, 'j1', '/out', 'p', undefined, undefined, {});
    expect('agent' in JSON.parse(await readFile(path, 'utf8'))).toBe(false);
  });
});

describe('rule override context overlay (fleet #370 US-009)', () => {
  const context = {
    rules: { overrideDir: '/j/koda-rules', overrideMode: 'replace' as const },
    projectContext: { file: '/j/koda-context.md', mode: 'replace' as const },
  };

  test('AC-11: the profile carries the rules directory and the project context', () => {
    const profile = jobProfileContent('/out', 'p', undefined, undefined, undefined, context);
    expect(profile.context).toEqual(context);
  });

  test('AC-12: a job without an override keeps no context key', () => {
    expect('context' in jobProfileContent('/out', 'p')).toBe(false);
    expect(jobProfileContent('/out', 'p')).toEqual({ outputDir: '/out', name: 'p' });
  });

  test('the context overlay keeps the relay, the cost limit and the model aliases', () => {
    const relay = { bashMode: 'escalate' as const, approvalTimeoutSec: 90, endpoint: { url: 'http://127.0.0.1:43210/ask', secret: 'f'.repeat(64) } };
    expect(jobProfileContent('/out', 'p', relay, 2.5, { reviewer: 'acp:claude' }, context)).toMatchObject({
      bot: { costLimit: 2.5 }, agent: { modelAliases: { reviewer: 'acp:claude' } }, context,
    });
  });

  test('an override without a project context carries only the rules', () => {
    const profile = jobProfileContent('/out', 'p', undefined, undefined, undefined, { rules: { overrideDir: '/j/koda-rules', overrideMode: 'merge' } });
    expect(profile.context).toEqual({ rules: { overrideDir: '/j/koda-rules', overrideMode: 'merge' } });
  });

  test('writeJobProfile writes the context into the profile file', async () => {
    const home = await tmp.make('profile-context');
    const path = await writeJobProfile(home, 'j1', '/out', 'p', undefined, undefined, undefined, context);
    expect(JSON.parse(await readFile(path, 'utf8')).context).toEqual(context);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
