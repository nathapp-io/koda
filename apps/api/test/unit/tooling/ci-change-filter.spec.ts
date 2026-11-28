import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(__dirname, '../../../../..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

function stepBody(): string {
  const lines = workflow.split('\n');
  const stepStart = lines.findIndex((line) => /^      - id: filter$/.test(line));
  if (stepStart < 0) throw new Error('filter step not found');
  let stepEnd = stepStart + 1;
  while (stepEnd < lines.length && !/^      - /.test(lines[stepEnd]) && !/^    [^ ]/.test(lines[stepEnd])) stepEnd++;
  const step = lines.slice(stepStart, stepEnd);
  const runIndex = step.findIndex((line) => /^        run: \|$/.test(line));
  if (runIndex < 0) throw new Error('filter run block not found');
  const body = [] as string[];
  for (const line of step.slice(runIndex + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.trim() ? line.slice(10) : '');
  }
  return body.join('\n');
}

const body = stepBody();
let tempRoot: string;

beforeEach(() => { tempRoot = mkdtempSync(join(tmpdir(), 'koda-ci-filter-')); });
afterEach(() => { rmSync(tempRoot, { recursive: true, force: true }); });

function runFilter(event: string, paths: string[]) {
  const bin = join(tempRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(tempRoot, 'git-calls');
  const pathFile = join(tempRoot, 'paths');
  const pathFileZ = join(tempRoot, 'paths-z');
  writeFileSync(pathFile, paths.join('\n') + (paths.length ? '\n' : ''));
  // `git diff --name-only -z` emits each raw path NUL-terminated, so a path may hold any byte, a newline and
  // non-ASCII included. `git diff --name-only` C-quotes such a path (`"deployments/caf\303\251.sh"`, and a
  // newline becomes `\n`); the stub does both, like git (review B7).
  writeFileSync(pathFileZ, paths.map((path) => `${path}\0`).join(''));
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/bash',
      `echo called >> '${calls}'`,
      'case " $* " in',
      `  *" -z "*) cat '${pathFileZ}' ;;`,
      '  *)',
      `    while IFS= read -r path; do`,
      `      case "$path" in`,
      `        *[!\\ -~]*) printf '"%s"\\n' "$path" ;;`,
      `        *) printf '%s\\n' "$path" ;;`,
      '      esac',
      `    done < '${pathFile}'`,
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const script = join(tempRoot, 'filter.sh');
  writeFileSync(script, body);
  const output = join(tempRoot, 'github-output');
  writeFileSync(output, '');
  execFileSync('/bin/bash', ['-e', script], {
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, EVENT_NAME: event, BASE_SHA: 'base', HEAD_SHA: 'head' },
  });
  return { output: readFileSync(output, 'utf8').trim(), calls: exists(calls) };
}

function exists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

describe('CI change filter workflow step', () => {
  it('writes code=true for 5,000 changed app paths over 64 KiB', () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `apps/${String(i).padStart(5, '0')}-${'x'.repeat(20)}.ts`);
    expect(paths.join('\n').length).toBeGreaterThan(64 * 1024);
    expect(runFilter('pull_request', paths).output).toBe('code=true');
  });

  it('writes code=false when only documentation changes', () => {
    expect(runFilter('pull_request', ['README.md', 'docs/guide.md']).output).toBe('code=false');
  });

  it('recognizes the OpenAPI TypeScript config as code', () => {
    expect(runFilter('pull_request', ['openapi-ts.config.ts']).output).toBe('code=true');
  });

  it('recognizes deployment files as code', () => {
    expect(runFilter('pull_request', ['deployments/example/rollback.sh']).output).toBe('code=true');
  });

  it.each(['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.test.yml'])('recognizes a change to %s alone as code', (file) => {
    expect(runFilter('pull_request', [file]).output).toBe('code=true');
  });

  it('validates a PR that renames a supported Compose file to an unmatched path', () => {
    const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'user.name=CI Test', '-c', 'user.email=test@example.invalid', ...args,
    ], { cwd: tempRoot, env });
    git('init', '--quiet', '--template=');
    writeFileSync(join(tempRoot, 'docker-compose.dev.yml'), 'services: {}\n');
    git('add', 'docker-compose.dev.yml');
    git('commit', '--quiet', '-m', 'Add dev Compose');
    git('mv', 'docker-compose.dev.yml', 'archived.yml');
    git('commit', '--quiet', '-m', 'Rename dev Compose');

    const output = join(tempRoot, 'github-output');
    execFileSync('/bin/bash', ['-c', body], {
      cwd: tempRoot,
      env: { ...env, EVENT_NAME: 'pull_request', BASE_SHA: 'HEAD~1', HEAD_SHA: 'HEAD', GITHUB_OUTPUT: output },
    });
    expect(readFileSync(output, 'utf8').trim()).toBe('code=true');
  });

  it('recognizes a deployment file whose path Git would quote', () => {
    // `git diff --name-only` prints `"deployments/caf\303\251.sh"`, which matches no path pattern, so the
    // filter must read the raw NUL-separated listing (review B7).
    expect(runFilter('pull_request', ['deployments/café.sh']).output).toBe('code=true');
  });

  it('matches each NUL-delimited path whole when a name contains a newline', () => {
    // Git reported ONE path. Turning the NUL list into a newline list would split it into `docs/note` and
    // `apps/a.ts`, and the second fragment would count the PR as a code change (review B7).
    expect(runFilter('pull_request', ['docs/note\napps/a.ts']).output).toBe('code=false');
    expect(runFilter('pull_request', ['docs/note\napps/a.ts\napps/b.ts']).output).toBe('code=false');
    // A real code path that merely contains a newline still counts.
    expect(runFilter('pull_request', ['apps/a.ts\nREADME.md']).output).toBe('code=true');
  });

  it('pushes write code=true without invoking git', () => {
    const result = runFilter('push', []);
    expect(result.output).toBe('code=true');
    expect(result.calls).toBe(false);
  });

  it('matches sample paths for every push path pattern', () => {
    const pushBlock = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  # No workflow-level path filter'));
    const pathsBlock = pushBlock.slice(pushBlock.indexOf('    paths:'));
    const patterns = [...pathsBlock.matchAll(/^      - "([^"]+)"$/gm)].map((match) => match[1]);
    const expression = workflow.match(/CODE_PATHS='([^']+)'/)?.[1];
    if (!expression) throw new Error('CODE_PATHS expression not found');
    expect(patterns.length).toBeGreaterThan(0);
    const regex = new RegExp(expression);
    for (const pattern of patterns) {
      const sample = pattern.replace(/\*\*/g, 'a/b.ts').replace(/\*/g, 'x');
      expect(regex.test(sample), `${pattern} -> ${sample}`).toBe(true);
    }
  });

  it('includes deployment, Compose, and OpenAPI config paths in push filters', () => {
    const pushBlock = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  # No workflow-level path filter'));
    for (const path of ['openapi-ts.config.ts', 'docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.test.yml', 'deployments/**']) {
      expect(pushBlock).toContain(`- "${path}"`);
    }
  });

  function declaredPatches(): string[] {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      patchedDependencies: Record<string, string>;
    };
    return Object.values(manifest.patchedDependencies);
  }

  function makeGitHistory(changedPath: string): { base: string; head: string; cwd: string } {
    const cwd = join(tempRoot, 'history');
    mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'user.name=CI Test', '-c', 'user.email=test@example.invalid', ...args,
    ], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
    git('init', '--quiet', '--template=');
    writeFileSync(join(cwd, 'README.md'), 'fixture readme\n');
    for (const patch of declaredPatches()) {
      mkdirSync(join(cwd, patch, '..'), { recursive: true });
      writeFileSync(join(cwd, patch), 'initial patch content\n');
    }
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, changedPath), `${readFileSync(join(cwd, changedPath), 'utf8')}changed\n`);
    git('add', changedPath);
    git('commit', '--quiet', '-m', 'change');
    return { base, head: git('rev-parse', 'HEAD'), cwd };
  }

  function runActualFilter(history: { base: string; head: string; cwd: string }): string {
    const output = join(tempRoot, 'actual-output');
    execFileSync('/bin/bash', ['-e', '-c', body], {
      cwd: history.cwd,
      env: { ...process.env, EVENT_NAME: 'pull_request', BASE_SHA: history.base, HEAD_SHA: history.head, GITHUB_OUTPUT: output },
    });
    return readFileSync(output, 'utf8').trim();
  }

  function pushPatterns(): string[] {
    const pushBlock = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  # No workflow-level path filter'));
    return [...pushBlock.matchAll(/^      - "([^"]+)"$/gm)].map((match) => match[1]);
  }

  function matchesPushPath(path: string): boolean {
    return pushPatterns().some((pattern) => {
      const expression = pattern.split('**').map((part) => part.split('*').map((segment) => segment.replace(/[.+?^${}()|[\\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
      return new RegExp(`^${expression}$`).test(path);
    });
  }

  it.each(declaredPatches())('actual PR filter selects patch-only change %s', (patch) => {
    expect(runActualFilter(makeGitHistory(patch))).toBe('code=true');
  });

  it('actual PR filter rejects README-only control diff', () => {
    expect(runActualFilter(makeGitHistory('README.md'))).toBe('code=false');
  });

  it.each(declaredPatches())('main push paths select patch-only change %s', (patch) => {
    expect(matchesPushPath(patch)).toBe(true);
  });

  it('main push paths reject README-only control diff', () => {
    expect(matchesPushPath('README.md')).toBe(false);
  });

  it.each(declaredPatches())('runner test hash changes for %s and returns after restoration', (patch) => {
    const worktree = join(tempRoot, 'worktree');
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: repoRoot });
    try {
      // Test the configured rule even before it has been committed into the worktree's HEAD.
      writeFileSync(join(worktree, 'turbo.json'), readFileSync(join(repoRoot, 'turbo.json')));
      const turbo = join(repoRoot, 'node_modules/.bin/turbo');
      const taskHash = () => {
        const output = execFileSync(turbo, ['run', 'test', '--filter=@nathapp/koda-runner', '--dry=json'], {
          cwd: worktree,
          env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
        }).toString();
        const plan = JSON.parse(output) as { tasks: Array<{ taskId: string; hash: string }> };
        const task = plan.tasks.find(({ taskId }) => taskId === '@nathapp/koda-runner#test');
        if (!task) throw new Error('Runner test task missing from Turbo dry run');
        return task.hash;
      };
      const baselineContents = readFileSync(join(worktree, patch));
      const baseline = taskHash();
      writeFileSync(join(worktree, patch), Buffer.concat([baselineContents, Buffer.from('\nchanged patch content\n')]));
      expect(taskHash()).not.toBe(baseline);
      writeFileSync(join(worktree, patch), baselineContents);
      expect(taskHash()).toBe(baseline);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
    }
  });
});
