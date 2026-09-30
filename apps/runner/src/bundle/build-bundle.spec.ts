import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { buildBundle, collectBundleEntries, isBenignTarExit, listBundleEntries, sha256File } from './build-bundle';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

async function jobDirWith(): Promise<string> {
  const jobDir = await tmp.make('bundle');
  const out = join(jobDir, 'nax-out');
  await mkdir(join(out, 'features', 'feat', 'runs'), { recursive: true });
  await mkdir(join(out, 'prompt-audit', 'feat'), { recursive: true });
  await mkdir(join(out, 'features', 'feat', 'prompt-audit'), { recursive: true });
  await mkdir(join(out, 'cost'), { recursive: true });
  await mkdir(join(jobDir, 'plan-logs'), { recursive: true });
  await writeFile(join(out, 'status.json'), '{"run":{}}');
  await writeFile(join(out, 'metrics.json'), '{}');
  await writeFile(join(out, 'cost', 'cost-1.jsonl'), '{}\n');
  await writeFile(join(out, 'features', 'feat', 'runs', 'log-1.jsonl'), '{}\n');
  await symlink('log-1.jsonl', join(out, 'features', 'feat', 'runs', 'latest.jsonl'));
  await writeFile(join(out, 'file with spaces.txt'), 'x');
  await writeFile(join(out, 'prompt-audit', 'feat', 'p.json'), 'SECRET PROMPT');
  await writeFile(join(out, 'features', 'feat', 'prompt-audit', 'q.json'), 'SECRET PROMPT 2');
  await writeFile(join(jobDir, 'nax.stdout'), 'out');
  await writeFile(join(jobDir, 'nax.stderr'), 'err');
  await writeFile(join(jobDir, 'plan-logs', 'plan-1.jsonl'), '{"m":1}\n');
  await writeFile(join(jobDir, 'plan-logs', 'ignore.txt'), 'not a jsonl');
  return jobDir;
}
async function tarList(path: string): Promise<string[]> {
  const proc = Bun.spawn(['tar', '-tzf', path], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split('\n').filter(Boolean).sort();
}

describe('listBundleEntries (D27)', () => {
  test('RUN: nax-out minus prompt-audit at any depth, plus stdout and stderr; sorted, relative', async () => {
    const entries = await listBundleEntries(await jobDirWith(), 'RUN');
    expect(entries).toEqual([
      'nax-out/cost/cost-1.jsonl', 'nax-out/features/feat/runs/latest.jsonl', 'nax-out/features/feat/runs/log-1.jsonl',
      'nax-out/file with spaces.txt', 'nax-out/metrics.json', 'nax-out/status.json', 'nax.stderr', 'nax.stdout',
    ]);
  });
  test('PLAN adds the plan logs, jsonl only', async () => {
    const entries = await listBundleEntries(await jobDirWith(), 'PLAN');
    expect(entries).toContain('plan-logs/plan-1.jsonl');
    expect(entries).not.toContain('plan-logs/ignore.txt');
    expect(await listBundleEntries(await jobDirWith(), 'RUN')).not.toContain('plan-logs/plan-1.jsonl');
  });
  test('missing pieces are simply absent', async () => {
    expect(await listBundleEntries(await tmp.make('empty'), 'RUN')).toEqual([]);
  });
  test('a name with a newline or a backslash cannot go in the -T list: it is skipped and reported (D68)', async () => {
    const jobDir = await jobDirWith();
    await writeFile(join(jobDir, 'nax-out', 'two\nlines.txt'), 'x');
    await writeFile(join(jobDir, 'nax-out', 'back\\slash.txt'), 'x');
    const { entries, skipped } = await collectBundleEntries(jobDir, 'RUN');
    expect(skipped).toEqual(['nax-out/back\\slash.txt', 'nax-out/two\nlines.txt']);
    expect(entries.some((name) => name.includes('\n') || name.includes('\\'))).toBe(false);
    expect(entries).toContain('nax-out/file with spaces.txt');
    const file = await buildBundle({ jobDir, command: 'RUN' });
    expect(file.skipped).toEqual(skipped);
    expect((await tarList(file.path)).some((name) => name.includes('slash'))).toBe(false);
    expect(JSON.parse(await readFile(join(jobDir, 'bundle-manifest.json'), 'utf8')).skipped).toEqual(skipped);
  });
});

describe('isBenignTarExit (D68)', () => {
  test('accepts exit 0, and exit 1 only when tar merely saw a file change under it', () => {
    expect(isBenignTarExit(0, '')).toBe(true);
    expect(isBenignTarExit(1, 'tar: nax-out/features/f/runs/log-1.jsonl: file changed as we read it\n')).toBe(true);
    expect(isBenignTarExit(1, 'tar: a: file changed as we read it\ntar: b: file changed as we read it\n')).toBe(true);
  });
  test('refuses every other failure, including exit 1 with a real error and any higher exit code', () => {
    expect(isBenignTarExit(1, 'tar: nax-out/x: Cannot stat: No such file or directory\n')).toBe(false);
    expect(isBenignTarExit(1, 'tar: a: file changed as we read it\ntar: b: Cannot open: Permission denied\n')).toBe(false);
    expect(isBenignTarExit(1, '')).toBe(false);
    expect(isBenignTarExit(2, 'tar: a: file changed as we read it\n')).toBe(false);
  });
});

describe('buildBundle', () => {
  test('writes a tar.gz with the listed files, a manifest, the symlink as a link, and a matching size and sha256', async () => {
    const jobDir = await jobDirWith();
    const file = await buildBundle({ jobDir, command: 'PLAN' });
    expect(file.path).toBe(join(jobDir, 'bundle.tar.gz'));
    expect(file.size).toBe((await stat(file.path)).size);
    expect(file.sha256).toBe(createHash('sha256').update(await readFile(file.path)).digest('hex'));
    const names = await tarList(file.path);
    expect(names).toContain('bundle-manifest.json');
    expect(names).toContain('nax-out/status.json');
    expect(names).toContain('plan-logs/plan-1.jsonl');
    expect(names.some((n) => n.includes('prompt-audit'))).toBe(false);
    const verbose = Bun.spawn(['tar', '-tvzf', file.path], { stdout: 'pipe' });
    expect(await new Response(verbose.stdout).text()).toMatch(/latest\.jsonl -> log-1\.jsonl/);
    const manifest = JSON.parse(await readFile(join(jobDir, 'bundle-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, command: 'PLAN' });
    expect(manifest.entries).toContain('nax.stdout');
  });
  test('an otherwise empty job dir still produces a valid archive (the manifest)', async () => {
    const file = await buildBundle({ jobDir: await tmp.make('empty'), command: 'RUN' });
    expect(await tarList(file.path)).toEqual(['bundle-manifest.json']);
  });
  test('rebuilding replaces the previous archive', async () => {
    const jobDir = await jobDirWith();
    const first = await buildBundle({ jobDir, command: 'RUN' });
    await writeFile(join(jobDir, 'nax-out', 'extra.txt'), 'later');
    const second = await buildBundle({ jobDir, command: 'RUN' });
    expect(second.path).toBe(first.path);
    expect(second.sha256).not.toBe(first.sha256);
    expect(await tarList(second.path)).toContain('nax-out/extra.txt');
  });
  test('sha256File streams a file', async () => {
    const path = join(await tmp.make('sha'), 'f');
    await writeFile(path, 'hello');
    expect(await sha256File(path)).toBe(createHash('sha256').update('hello').digest('hex'));
  });
});
