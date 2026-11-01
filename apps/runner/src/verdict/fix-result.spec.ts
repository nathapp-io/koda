import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixResult, readPushedSha } from './fix-result';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-fix-result-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test('AC-1: identifies a pushed outcome only for the assigned PR', async () => {
  const dir = await tempDir();
  const stdout = join(dir, 'fix.stdout');
  await writeFile(stdout, 'nax bot fix: PR #4 — pushed abc1234\n');
  expect(await readFixResult(stdout, 4)).toEqual({ kind: 'pushed', logPath: null });
});

test('AC-2: identifies nothing-to-fix with an advisor ledger push', async () => {
  const dir = await tempDir();
  const stdout = join(dir, 'fix.stdout');
  await writeFile(stdout, 'nax bot fix: PR #4 — nothing to fix; pushed advisor ledger abc1234\n');
  expect(await readFixResult(stdout, 4)).toEqual({ kind: 'nothing', logPath: null });
});

test('AC-3: ignores a fix result for another PR', async () => {
  const dir = await tempDir();
  const stdout = join(dir, 'fix.stdout');
  await writeFile(stdout, 'nax bot fix: PR #5 — pushed abc1234\n');
  expect(await readFixResult(stdout, 4)).toEqual({ kind: 'none', logPath: null });
});

test('AC-4: reads a log path only from a line-start log marker', async () => {
  const dir = await tempDir();
  const stdout = join(dir, 'fix.stdout');
  await writeFile(stdout, `prefix nax bot fix: log ${join(dir, 'bot.jsonl')}\n`);
  expect(await readFixResult(stdout, 4)).toEqual({ kind: 'none', logPath: null });
  await writeFile(stdout, `nax bot fix: log ${join(dir, 'bot.jsonl')}\n`);
  expect(await readFixResult(stdout, 4)).toEqual({ kind: 'none', logPath: join(dir, 'bot.jsonl') });
});

test('AC-5: accepts a full lowercase pushed SHA from sibling bot-state.json', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'bot-state.json'), JSON.stringify({ pushedSha: 'a'.repeat(40) }));
  expect(await readPushedSha(join(dir, 'bot.jsonl'))).toBe('a'.repeat(40));
});

test('AC-6: missing state or a short pushed SHA returns null', async () => {
  const dir = await tempDir();
  expect(await readPushedSha(join(dir, 'missing', 'bot.jsonl'))).toBeNull();
  const stateDir = join(dir, 'short');
  await mkdir(stateDir);
  await writeFile(join(stateDir, 'bot-state.json'), JSON.stringify({ pushedSha: 'a'.repeat(39) }));
  expect(await readPushedSha(join(stateDir, 'bot.jsonl'))).toBeNull();
});
