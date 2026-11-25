import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const saved = JSON.stringify({
  apiUrl: 'http://fixture.invalid', apiKey: 'fixture-key',
  profiles: { work: { apiUrl: 'http://fixture.invalid', apiKey: 'fixture-profile-key' } },
});
let home: string;
let project: string;
let globalFile: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'koda-init-')));
  project = join(home, 'project');
  globalFile = join(home, '.koda', 'config.json');
  mkdirSync(project);
  mkdirSync(join(home, '.koda'));
  writeFileSync(globalFile, saved);
  writeFileSync(join(home, 'routes.json'), JSON.stringify({
    '/api/projects/sample': { ret: 0, data: { slug: 'sample' } },
  }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function runInit(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [
    '--require', resolve(__dirname, '../../test/helpers/output-api.cjs'), '--import', require.resolve('tsx'),
    resolve(__dirname, '../index.ts'), 'init', '--project', 'sample', ...args,
  ], {
    cwd, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', KODA_TEST_HOME: home, KODA_TEST_RESPONSES: join(home, 'routes.json') },
  });
  if (result.error) throw result.error;
  return result;
}

it.each(['working directory', '--cwd', 'linked directory', 'linked file', 'hard-linked file'])(
  'preserves the global config when init targets it via %s', (target) => {
    const dir = join(project, '.koda');
    if (target === 'linked directory') symlinkSync(join(home, '.koda'), dir, 'dir');
    if (target === 'linked file' || target === 'hard-linked file') {
      mkdirSync(dir);
      const link = join(dir, 'config.json');
      if (target === 'linked file') symlinkSync(globalFile, link);
      else linkSync(globalFile, link);
    }
    const result = runInit(target === 'working directory' ? home : project, target === '--cwd' ? ['--cwd', home] : []);
    expect(readFileSync(globalFile, 'utf8')).toBe(saved);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/global config/i);
    expect(result.stdout).toBe('');
  },
);

it('can initialize and reinitialize a project beneath home', () => {
  const projectFile = join(project, '.koda', 'config.json');
  const first = runInit(project, ['--default-priority', 'HIGH']);
  expect(first.status).toBe(0);
  expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual({ projectSlug: 'sample', defaults: { priority: 'HIGH' } });

  const second = runInit(project);
  expect(second.status).toBe(0);
  expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual({ projectSlug: 'sample' });
  expect(readFileSync(globalFile, 'utf8')).toBe(saved);
});
