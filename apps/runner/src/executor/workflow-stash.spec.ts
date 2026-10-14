import { afterAll, describe, expect, test } from 'bun:test';
import { lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { stashWorkflowOutputs } from './workflow-stash';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const RESULT = JSON.stringify({ schemaVersion: 1, runId: 'r1', verdict: { outcome: 'ready', reasons: [] } });

async function layout(opts: { result?: string; report?: string | Buffer; decisions?: string; reportSymlink?: string } = {}): Promise<{ repoDir: string; jobDir: string; sinceMs: number }> {
  const base = await tmp.make('wstash');
  const repoDir = join(base, 'repo');
  const jobDir = join(base, 'job');
  const featureDir = join(repoDir, '.nax', 'features', 'feat');
  const runDir = join(featureDir, 'workflow', 'run-1');
  await mkdir(runDir, { recursive: true });
  await mkdir(jobDir, { recursive: true });
  const sinceMs = Date.now() - 60_000;
  await writeFile(join(runDir, 'result.json'), opts.result ?? RESULT);
  if (opts.reportSymlink !== undefined) {
    await symlink(opts.reportSymlink, join(runDir, 'feature-report.md'));
  } else if (opts.report !== undefined) {
    await writeFile(join(runDir, 'feature-report.md'), opts.report);
  }
  if (opts.decisions !== undefined) {
    await writeFile(join(featureDir, 'decisions.jsonl'), opts.decisions);
  }
  return { repoDir, jobDir, sinceMs };
}

async function snapshot(dir: string): Promise<Map<string, { size: number; mtimeMs: number; content: string }>> {
  const out = new Map<string, { size: number; mtimeMs: number; content: string }>();
  async function walk(current: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        const st = await lstat(full);
        let content = '';
        try {
          content = await readFile(full, 'utf8');
        } catch {
          content = '<unreadable>';
        }
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, content });
      }
    }
  }
  await walk(dir, '');
  return out;
}

describe('stashWorkflowOutputs (US-003)', () => {
  test('AC-1: copies result, report and decisions and returns all three names', async () => {
    const { repoDir, jobDir, sinceMs } = await layout({ report: '# report\n', decisions: '{"a":1}\n' });
    const names = await stashWorkflowOutputs(repoDir, jobDir, 'feat', sinceMs);
    expect([...names].sort()).toEqual(['decisions.jsonl', 'feature-report.md', 'result.json']);
    expect(await readFile(join(jobDir, 'workflow', 'result.json'), 'utf8')).toBe(RESULT);
    expect(await readFile(join(jobDir, 'workflow', 'feature-report.md'), 'utf8')).toBe('# report\n');
    expect(await readFile(join(jobDir, 'workflow', 'decisions.jsonl'), 'utf8')).toBe('{"a":1}\n');
  });

  test('AC-2: a feature-report larger than 1 MiB is skipped, others still copied', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 'x');
    const { repoDir, jobDir, sinceMs } = await layout({ report: big, decisions: '{"a":1}\n' });
    const names = await stashWorkflowOutputs(repoDir, jobDir, 'feat', sinceMs);
    expect([...names].sort()).toEqual(['decisions.jsonl', 'result.json']);
    await expect(stat(join(jobDir, 'workflow', 'feature-report.md'))).rejects.toThrow();
    expect(await readFile(join(jobDir, 'workflow', 'result.json'), 'utf8')).toBe(RESULT);
  });

  test('AC-3: decisions older than sinceMs is skipped', async () => {
    const base = await tmp.make('wstash3');
    const repoDir = join(base, 'repo');
    const jobDir = join(base, 'job');
    const featureDir = join(repoDir, '.nax', 'features', 'feat');
    const runDir = join(featureDir, 'workflow', 'run-1');
    await mkdir(runDir, { recursive: true });
    await mkdir(jobDir, { recursive: true });
    const sinceMs = Date.now();
    await writeFile(join(runDir, 'result.json'), RESULT);
    await writeFile(join(featureDir, 'decisions.jsonl'), '{"old":true}\n');
    const past = new Date(sinceMs - 10_000);
    await utimes(join(featureDir, 'decisions.jsonl'), past, past);
    // result.json is new (mtime >= sinceMs or just before due to clock); force it fresh.
    const future = new Date(Date.now() + 1_000);
    await utimes(join(runDir, 'result.json'), future, future);
    const names = await stashWorkflowOutputs(repoDir, jobDir, 'feat', sinceMs);
    expect([...names].sort()).toEqual(['result.json']);
    await expect(stat(join(jobDir, 'workflow', 'decisions.jsonl'))).rejects.toThrow();
  });

  test('AC-4: a symlinked feature-report outside the checkout is not copied', async () => {
    const base = await tmp.make('wstash4');
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'secret');
    const repoDir = join(base, 'repo');
    const jobDir = join(base, 'job');
    const featureDir = join(repoDir, '.nax', 'features', 'feat');
    const runDir = join(featureDir, 'workflow', 'run-1');
    await mkdir(runDir, { recursive: true });
    await mkdir(jobDir, { recursive: true });
    const sinceMs = Date.now() - 60_000;
    await writeFile(join(runDir, 'result.json'), RESULT);
    await writeFile(join(featureDir, 'decisions.jsonl'), '{"a":1}\n');
    await symlink(outside, join(runDir, 'feature-report.md'));
    const names = await stashWorkflowOutputs(repoDir, jobDir, 'feat', sinceMs);
    expect([...names].sort()).toEqual(['decisions.jsonl', 'result.json']);
    await expect(stat(join(jobDir, 'workflow', 'feature-report.md'))).rejects.toThrow();
  });

  test('AC-5: creates, modifies or deletes no file inside repoDir', async () => {
    const { repoDir, jobDir, sinceMs } = await layout({ report: '# r\n', decisions: '{"a":1}\n' });
    const before = await snapshot(repoDir);
    await stashWorkflowOutputs(repoDir, jobDir, 'feat', sinceMs);
    const after = await snapshot(repoDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, value] of before) {
      const next = after.get(key);
      expect(next).toBeDefined();
      expect(next?.content).toBe(value.content);
      expect(next?.size).toBe(value.size);
      expect(next?.mtimeMs).toBe(value.mtimeMs);
    }
  });

  test('AC-6: no workflow folder returns empty and creates no job workflow folder', async () => {
    const base = await tmp.make('wstash6');
    const repoDir = join(base, 'repo');
    const jobDir = join(base, 'job');
    await mkdir(join(repoDir, '.nax', 'features', 'feat'), { recursive: true });
    await mkdir(jobDir, { recursive: true });
    const names = await stashWorkflowOutputs(repoDir, jobDir, 'feat', Date.now() - 60_000);
    expect([...names]).toEqual([]);
    await expect(stat(join(jobDir, 'workflow'))).rejects.toThrow();
  });
});
