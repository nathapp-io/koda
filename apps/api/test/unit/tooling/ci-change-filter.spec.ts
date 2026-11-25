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
});
