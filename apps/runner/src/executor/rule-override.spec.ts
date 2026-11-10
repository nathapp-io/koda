import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuleOverrideAssign } from '@nathapp/fleet-protocol';
import { makeTempDirs } from '../../test/helpers/tmp';
import { materializeRuleOverride } from './rule-override';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const override = (over: Partial<RuleOverrideAssign> = {}): RuleOverrideAssign => ({
  sha256: 'a'.repeat(64), rulesMode: 'merge', rules: [{ path: 'api.md', content: 'x' }], ...over,
});

describe('materializeRuleOverride (fleet #370 US-009)', () => {
  let jobDir!: string;
  beforeEach(async () => { jobDir = await tmp.make('rules'); });

  test('AC-6: writes every rule and the context, and names them for the profile', async () => {
    const value = override({
      rules: [{ path: 'api.md', content: 'api rule' }, { path: 'pkg/web.md', content: 'web rule' }],
      context: { content: 'project context', mode: 'append' },
    });
    const context = await materializeRuleOverride(jobDir, value);
    expect(await readFile(join(jobDir, 'koda-rules', 'api.md'), 'utf8')).toBe('api rule');
    expect(await readFile(join(jobDir, 'koda-rules', 'pkg', 'web.md'), 'utf8')).toBe('web rule');
    expect(await readFile(join(jobDir, 'koda-context.md'), 'utf8')).toBe('project context');
    expect(context).toEqual({
      rules: { overrideDir: join(jobDir, 'koda-rules'), overrideMode: 'merge' },
      projectContext: { file: join(jobDir, 'koda-context.md'), mode: 'append' },
    });
  });

  test('AC-6: the returned paths are absolute', async () => {
    const context = await materializeRuleOverride(jobDir, override({ context: { content: 'c', mode: 'replace' } }));
    expect(context.rules.overrideDir).toBe(join(jobDir, 'koda-rules'));
    expect(context.projectContext?.file).toBe(join(jobDir, 'koda-context.md'));
  });

  test('AC-6: a replace rules mode is carried into the profile context', async () => {
    const context = await materializeRuleOverride(jobDir, override({ rulesMode: 'replace' }));
    expect(context.rules.overrideMode).toBe('replace');
  });

  test('AC-7: a previous attempt\'s rule files are gone', async () => {
    await mkdir(join(jobDir, 'koda-rules'), { recursive: true });
    await writeFile(join(jobDir, 'koda-rules', 'old.md'), 'old');
    await materializeRuleOverride(jobDir, override());
    expect(await readdir(join(jobDir, 'koda-rules'))).toEqual(['api.md']);
    await expect(stat(join(jobDir, 'koda-rules', 'old.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('AC-8: an override without a context removes the context file of a previous attempt', async () => {
    await materializeRuleOverride(jobDir, override({ context: { content: 'old context', mode: 'append' } }));
    await stat(join(jobDir, 'koda-context.md'));
    const context = await materializeRuleOverride(jobDir, override());
    await expect(stat(join(jobDir, 'koda-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.projectContext).toBeUndefined();
    expect('projectContext' in context).toBe(false);
  });

  test('AC-9: the rule files are mode 0600', async () => {
    await materializeRuleOverride(jobDir, override({ rules: [{ path: 'api.md', content: 'x' }, { path: 'pkg/web.md', content: 'y' }] }));
    expect((await stat(join(jobDir, 'koda-rules', 'api.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(jobDir, 'koda-rules', 'pkg', 'web.md'))).mode & 0o777).toBe(0o600);
  });

  test('AC-9: the rules directory is private to the job', async () => {
    await materializeRuleOverride(jobDir, override());
    expect((await stat(join(jobDir, 'koda-rules'))).mode & 0o777).toBe(0o700);
  });

  test('AC-10: a rule path outside the rules directory is refused and writes nothing', async () => {
    const outside = join(jobDir, 'escaped.md');
    await expect(materializeRuleOverride(jobDir, override({ rules: [{ path: '../escaped.md', content: 'x' }] }))).rejects.toThrow('rule override path');
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(jobDir, 'koda-rules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('AC-10: no rule is written when one of the paths is outside the rules directory', async () => {
    await expect(materializeRuleOverride(jobDir, override({
      rules: [{ path: 'api.md', content: 'kept' }, { path: '../../escaped.md', content: 'x' }],
    }))).rejects.toThrow('rule override path');
    await expect(stat(join(jobDir, 'koda-rules', 'api.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
