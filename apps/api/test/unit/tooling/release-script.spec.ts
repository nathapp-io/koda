import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflow-steps';

// Black-box tests of `scripts/release.ts` in a throwaway repository whose `origin` is a local bare repository.
// Git runs with an empty global config, so the developer's hooks and identity never apply, and nothing here
// touches the real checkout.

const MANIFESTS = ['package.json', 'apps/api/package.json', 'apps/cli/package.json', 'apps/web/package.json'];

interface Fixture {
  work: string;
  origin: string;
  env: NodeJS.ProcessEnv;
}

interface Run {
  status: number;
  output: string;
}

let root: string;

function git(fixture: Fixture, cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: fixture.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function manifest(name: string, version: string): string {
  // Two-space JSON with a trailing newline, like the real manifests; `version` sits after `name`.
  return `${JSON.stringify({ name, version, private: true, scripts: { build: 'echo build' } }, null, 2)}\n`;
}

function makeFixture(version = '0.4.2', overrides: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(root, 'repo-'));
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // No inherited gh login (CI has none, a developer machine does): every gh call in a test goes to a stub.
    GH_CONFIG_DIR: join(dir, 'gh-config'),
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  };
  const fixture: Fixture = { work: join(dir, 'work'), origin: join(dir, 'origin.git'), env };
  mkdirSync(fixture.work);
  git(fixture, dir, 'init', '--quiet', '--bare', '--initial-branch=main', fixture.origin);
  git(fixture, fixture.work, 'init', '--quiet', '--initial-branch=main');
  for (const file of MANIFESTS) {
    mkdirSync(join(fixture.work, file, '..'), { recursive: true });
    writeFileSync(join(fixture.work, file), manifest(file, overrides[file] ?? version));
  }
  writeFileSync(join(fixture.work, 'bun.lock'), `lock ${version}\n`);
  cpSync(join(REPO_ROOT, 'scripts/release.ts'), join(fixture.work, 'scripts/release.ts'));
  cpSync(join(REPO_ROOT, 'scripts/lib'), join(fixture.work, 'scripts/lib'), { recursive: true });
  git(fixture, fixture.work, 'add', '.');
  git(fixture, fixture.work, 'commit', '--quiet', '-m', 'seed');
  git(fixture, fixture.work, 'remote', 'add', 'origin', fixture.origin);
  git(fixture, fixture.work, 'push', '--quiet', '-u', 'origin', 'main');
  return fixture;
}

const REAL_BUN = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim();

function release(fixture: Fixture, args: string[], input = '', env: NodeJS.ProcessEnv = fixture.env): Run {
  const result = spawnSync(REAL_BUN, ['scripts/release.ts', ...args], {
    cwd: fixture.work,
    env,
    input,
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

function originTag(fixture: Fixture, tag: string): string {
  return git(fixture, fixture.origin, 'tag', '--list', tag);
}

/**
 * Stubs on PATH: `gh` records its arguments (`auth status` exits GH_AUTH_EXIT, `pr create` exits GH_PR_EXIT);
 * `bun install` rewrites bun.lock from the api manifest; any other `bun` call runs the real bun.
 */
function withStubs(fixture: Fixture, opts: { authExit?: number; prExit?: number } = {}): NodeJS.ProcessEnv {
  const bin = join(fixture.work, '..', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/bash',
      `echo "$*" >> "${join(fixture.work, '..', 'gh-calls')}"`,
      `[ "$1 $2" = "auth status" ] && exit ${opts.authExit ?? 0}`,
      `[ "$1 $2" = "pr create" ] && exit ${opts.prExit ?? 0}`,
      'exit 0',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'bun'),
    [
      '#!/bin/bash',
      'if [ "$1" = "install" ]; then',
      `  "${REAL_BUN}" -e "const v=require(process.cwd()+'/apps/api/package.json').version;require('fs').writeFileSync('bun.lock','lock '+v+'\\\\n')"`,
      '  exit $?',
      'fi',
      `exec "${REAL_BUN}" "$@"`,
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'bun'), 0o755);
  return { ...fixture.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
}

function ghCalls(fixture: Fixture): string {
  const file = join(fixture.work, '..', 'gh-calls');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'koda-release-script-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('release script: planning the version bump', () => {
  it.each([
    ['patch', '0.4.2', '0.4.3'],
    ['minor', '0.4.2', '0.5.0'],
    ['major', '0.4.2', '1.0.0'],
    ['canary', '0.4.2', '0.4.3-canary.1'],
    ['canary', '0.5.0-canary.1', '0.5.0-canary.2'],
    ['promote', '0.5.0-canary.2', '0.5.0'],
    ['0.5.0-canary.1', '0.4.2', '0.5.0-canary.1'],
    ['0.5.0', '0.4.2', '0.5.0'],
  ])('%s from %s plans %s without changing anything', (kind, current, next) => {
    const fixture = makeFixture(current);
    const run = release(fixture, ['--dry-run', kind]);
    expect(run.output).toContain(`${current} -> ${next}`);
    expect(run.output).toContain(`Tag: v${next}`);
    expect(run.output).toContain(`Branch: release/v${next}`);
    expect(run.status).toBe(0);
    expect(git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
    expect(git(fixture, fixture.work, 'branch', '--list', `release/v${next}`)).toBe('');
  });

  it('describes a canary as publishing only the canary channels', () => {
    const run = release(makeFixture(), ['--dry-run', '0.5.0-canary.1']);
    expect(run.output).toContain('nathapp/koda-api:canary');
    expect(run.output).toContain('npm dist-tag canary');
    expect(run.output).not.toContain(':latest');
  });

  it('describes a stable release with its immutable Docker tag', () => {
    const run = release(makeFixture(), ['--dry-run', 'minor']);
    expect(run.output).toContain('nathapp/koda-api:v0.5.0');
    expect(run.output).toContain('nathapp/koda-web:v0.5.0');
  });

  it.each([
    ['0.4.2', 'must be above'],
    ['0.4.1', 'must be above'],
    ['0.5', 'Invalid release version'],
    ['1.0.0-beta.1', 'not releasable'],
  ])('refuses %s', (kind, message) => {
    const run = release(makeFixture(), ['--dry-run', kind]);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(message);
  });

  it('refuses promote when the current version is not a canary', () => {
    const run = release(makeFixture('0.4.2'), ['--dry-run', 'promote']);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('not a canary');
  });

  it('refuses a workspace whose manifests disagree and names the odd one', () => {
    const run = release(makeFixture('0.4.2', { 'apps/web/package.json': '0.4.1' }), ['--dry-run', 'patch']);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('apps/web/package.json');
  });

  it('refuses to prepare a release from a branch other than main', () => {
    const fixture = makeFixture();
    git(fixture, fixture.work, 'checkout', '--quiet', '-b', 'feature');
    const run = release(fixture, ['patch'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('Must be on main');
  });

  it('refuses to prepare a release from a dirty tree', () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.work, 'stray.txt'), 'x');
    const run = release(fixture, ['patch'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('dirty');
  });

  it('refuses a version whose tag already exists on origin', () => {
    const fixture = makeFixture();
    git(fixture, fixture.work, 'tag', 'v0.4.3');
    git(fixture, fixture.work, 'push', '--quiet', 'origin', 'v0.4.3');
    git(fixture, fixture.work, 'tag', '-d', 'v0.4.3');
    const run = release(fixture, ['patch'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('v0.4.3 already exists');
  });

  it('stops without changes when the confirmation is declined', () => {
    const fixture = makeFixture();
    const run = release(fixture, ['patch'], 'n\n', withStubs(fixture));
    expect(run.output).toContain('Aborted');
    expect(git(fixture, fixture.work, 'branch', '--list', 'release/v0.4.3')).toBe('');
    expect(git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
  });
});

describe('release script: preparing the release PR', () => {
  it('pushes release/vX.Y.Z with one commit of the four manifests and bun.lock, opens the PR, returns to main', () => {
    const fixture = makeFixture();
    const run = release(fixture, ['patch'], 'y\n', withStubs(fixture));
    expect(run.status).toBe(0);
    expect(git(fixture, fixture.origin, 'branch', '--list', 'release/v0.4.3')).toContain('release/v0.4.3');
    expect(git(fixture, fixture.origin, 'rev-list', '--count', 'main..release/v0.4.3')).toBe('1');
    const changed = git(fixture, fixture.origin, 'diff', '--name-only', 'main', 'release/v0.4.3').split('\n').sort();
    expect(changed).toEqual(['apps/api/package.json', 'apps/cli/package.json', 'apps/web/package.json', 'bun.lock', 'package.json']);
    expect(git(fixture, fixture.origin, 'log', '-1', '--format=%s', 'release/v0.4.3')).toBe('chore: release v0.4.3');
    expect(git(fixture, fixture.origin, 'show', 'release/v0.4.3:bun.lock')).toBe('lock 0.4.3');
    expect(ghCalls(fixture)).toMatch(/pr create .*--head release\/v0\.4\.3/);
    expect(git(fixture, fixture.work, 'branch', '--show-current')).toBe('main');
    expect(git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
  });

  it('refuses before changing anything when gh is not signed in', () => {
    const fixture = makeFixture();
    const run = release(fixture, ['patch'], 'y\n', withStubs(fixture, { authExit: 1 }));
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('gh auth login');
    expect(git(fixture, fixture.work, 'branch', '--list', 'release/v0.4.3')).toBe('');
  });

  it('refuses before changing anything when the release branch exists on origin', () => {
    const fixture = makeFixture();
    git(fixture, fixture.work, 'push', '--quiet', 'origin', 'main:refs/heads/release/v0.4.3');
    const run = release(fixture, ['patch'], 'y\n', withStubs(fixture));
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('release/v0.4.3 already exists on origin');
    expect(git(fixture, fixture.work, 'branch', '--show-current')).toBe('main');
  });

  it('refuses before changing anything when the release branch exists locally', () => {
    const fixture = makeFixture();
    git(fixture, fixture.work, 'branch', 'release/v0.4.3');
    const run = release(fixture, ['patch'], 'y\n', withStubs(fixture));
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('release/v0.4.3 already exists locally');
  });

  it('when opening the PR fails after the push, says how to finish and leaves main checked out', () => {
    const fixture = makeFixture();
    const run = release(fixture, ['patch'], 'y\n', withStubs(fixture, { prExit: 1 }));
    expect(run.status).not.toBe(0);
    expect(git(fixture, fixture.origin, 'branch', '--list', 'release/v0.4.3')).toContain('release/v0.4.3');
    expect(run.output).toContain('gh pr create --base main --head release/v0.4.3');
    expect(git(fixture, fixture.work, 'branch', '--show-current')).toBe('main');
  });
});

describe('release script: writing the version', () => {
  it('changes only the version line of each manifest and keeps the formatting', () => {
    const fixture = makeFixture();
    const script =
      "import { readVersions, writeVersion } from './scripts/lib/release-manifests.ts';" +
      "writeVersion(process.cwd(), '0.5.0-canary.1');" +
      'console.log(JSON.stringify([...readVersions(process.cwd()).values()]));';
    const result = spawnSync('bun', ['-e', script], { cwd: fixture.work, env: fixture.env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(Array(MANIFESTS.length).fill('0.5.0-canary.1'));
    const diff = git(fixture, fixture.work, 'diff', '--numstat');
    for (const file of MANIFESTS) expect(diff).toContain(`1\t1\t${file}`);
    expect(readFileSync(join(fixture.work, 'apps/api/package.json'), 'utf8')).toBe(
      manifest('apps/api/package.json', '0.5.0-canary.1'),
    );
  });
});

describe('release script: pushing the tag', () => {
  it('dry run names the tag and what it publishes, and creates nothing', () => {
    const fixture = makeFixture('0.5.0-canary.1');
    const run = release(fixture, ['--dry-run', 'tag']);
    expect(run.status).toBe(0);
    expect(run.output).toContain('v0.5.0-canary.1');
    expect(run.output).toContain('nathapp/koda-api:canary');
    expect(git(fixture, fixture.work, 'tag', '--list')).toBe('');
  });

  it('pushes the tag at origin/main once confirmed', () => {
    const fixture = makeFixture('0.5.0');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).toBe(0);
    expect(originTag(fixture, 'v0.5.0')).toBe('v0.5.0');
    expect(git(fixture, fixture.origin, 'rev-list', '-n', '1', 'v0.5.0')).toBe(
      git(fixture, fixture.work, 'rev-parse', 'HEAD'),
    );
  });

  it('pushes nothing when the confirmation is declined', () => {
    const fixture = makeFixture('0.5.0');
    const run = release(fixture, ['tag'], 'n\n');
    expect(run.output).toContain('Aborted');
    expect(originTag(fixture, 'v0.5.0')).toBe('');
  });

  it('refuses a local commit that origin/main does not have', () => {
    const fixture = makeFixture('0.5.0');
    writeFileSync(join(fixture.work, 'local.txt'), 'x');
    git(fixture, fixture.work, 'add', 'local.txt');
    git(fixture, fixture.work, 'commit', '--quiet', '-m', 'local only');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('does not match origin/main');
    expect(originTag(fixture, 'v0.5.0')).toBe('');
  });

  it('refuses a tag that origin already holds', () => {
    const fixture = makeFixture('0.5.0');
    git(fixture, fixture.work, 'tag', 'v0.5.0');
    git(fixture, fixture.work, 'push', '--quiet', 'origin', 'v0.5.0');
    git(fixture, fixture.work, 'tag', '-d', 'v0.5.0');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('already exists on origin');
  });

  it('refuses a local tag that points at another commit', () => {
    const fixture = makeFixture('0.5.0');
    git(fixture, fixture.work, 'tag', 'v0.5.0');
    writeFileSync(join(fixture.work, 'next.txt'), 'x');
    git(fixture, fixture.work, 'add', 'next.txt');
    git(fixture, fixture.work, 'commit', '--quiet', '-m', 'next');
    git(fixture, fixture.work, 'push', '--quiet', 'origin', 'main');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('not at HEAD');
  });

  it('retries a failed tag push by delivering the existing local tag at HEAD', () => {
    const fixture = makeFixture('0.5.0');
    git(fixture, fixture.work, 'tag', 'v0.5.0');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).toBe(0);
    expect(originTag(fixture, 'v0.5.0')).toBe('v0.5.0');
  });

  it('refuses to tag from a branch other than main', () => {
    const fixture = makeFixture('0.5.0');
    git(fixture, fixture.work, 'checkout', '--quiet', '-b', 'feature');
    const run = release(fixture, ['tag'], 'y\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('Must be on main');
  });
});

describe('release script: usage', () => {
  it('prints usage for a missing argument', () => {
    const run = release(makeFixture(), []);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('Usage: bun run release');
  });
});
