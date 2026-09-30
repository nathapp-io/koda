import { afterAll, describe, expect, test } from 'bun:test';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNaxCli, parseNaxJson } from '../../src/nax/nax-cli';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const TOKEN_VARS = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'];
/** A stand-in nax that prints its argv, cwd and the variables the runner controls as one JSON object. */
const ECHO = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.NAX_GLOBAL_CONFIG_DIR ?? null, tokens: ${JSON.stringify(TOKEN_VARS)}.filter((k) => process.env[k] !== undefined) }));`;

async function script(body: string): Promise<string> {
  const path = join(await tmp.make('naxcli'), 'nax.ts');
  await writeFile(path, body);
  return path;
}

describe('createNaxCli (D96)', () => {
  test('runs naxCommand plus args in cwd, with NAX_GLOBAL_CONFIG_DIR and without any forge token variable', async () => {
    const path = await script(ECHO);
    const cwd = await tmp.make('cwd');
    const saved = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = 'ghs_leak';
    try {
      const parsed = parseNaxJson(await createNaxCli(['bun', path], '/opt/naxhome').run(['config', '--json'], { cwd }));
      if (!parsed.ok) throw new Error(`unexpected ${parsed.code}`);
      expect(parsed.value).toMatchObject({ argv: ['config', '--json'], home: '/opt/naxhome', tokens: [] });
      expect(await realpath(parsed.value['cwd'] as string)).toBe(await realpath(cwd));
    } finally {
      if (saved === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = saved;
    }
  });
  test('Review focus 2: a nax that hangs is killed at the timeout and reported as NAX_TIMEOUT', async () => {
    const path = await script('setInterval(() => undefined, 1000);');
    const started = Date.now();
    const result = await createNaxCli(['bun', path], '/tmp', 300).run(['auth', 'list', '--json'], { cwd: await tmp.make('cwd') });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(parseNaxJson(result)).toEqual({ ok: false, code: 'NAX_TIMEOUT' });
  });
  test('a naxCommand that does not exist is exit 127 and NAX_NOT_FOUND, not a throw', async () => {
    const result = await createNaxCli(['/nonexistent/nax-binary'], '/tmp').run(['--version'], { cwd: await tmp.make('cwd') });
    expect(result.code).toBe(127);
    expect(parseNaxJson(result)).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
  });
});
