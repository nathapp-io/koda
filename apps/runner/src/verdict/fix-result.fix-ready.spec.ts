import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixState } from './fix-result';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-fix-ready-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const log = (dir: string): string => join(dir, 'bot.jsonl');
const statePath = (dir: string): string => join(dir, 'bot-state.json');

test('AC-1: extracts pushed SHA and ready flag with reply and resolution counts', async () => {
  const dir = await tempDir();
  const pushedSha = 'b'.repeat(40);
  await writeFile(statePath(dir), JSON.stringify({ pushedSha, markedReady: true, replied: 3, resolved: 2 }));
  expect(await readFixState(log(dir))).toEqual({ pushedSha, fixReady: { markedReady: true, replied: 3, resolved: 2 } });
});

test('AC-2: includes ready-held reason when FIX could not mark the PR ready', async () => {
  const dir = await tempDir();
  const readyHeld = 'PR head changed since this execution';
  await writeFile(statePath(dir), JSON.stringify({ markedReady: false, readyHeld }));
  expect(await readFixState(log(dir))).toEqual({ pushedSha: null, fixReady: { markedReady: false, readyHeld } });
});

test('AC-3: missing markedReady yields null fixReady but keeps a valid SHA', async () => {
  const dir = await tempDir();
  const pushedSha = 'c'.repeat(40);
  await writeFile(statePath(dir), JSON.stringify({ pushedSha }));
  expect(await readFixState(log(dir))).toEqual({ pushedSha, fixReady: null });
});

test('AC-5: a missing bot-state file returns null', async () => {
  const dir = await tempDir();
  expect(await readFixState(log(dir))).toBeNull();
});

test('AC-6: invalid JSON returns null', async () => {
  const dir = await tempDir();
  await writeFile(statePath(dir), '{');
  expect(await readFixState(log(dir))).toBeNull();
});

test('AC-7: a symlink bot-state file returns null', async () => {
  const dir = await tempDir();
  const target = join(dir, 'target.json');
  await writeFile(target, JSON.stringify({ pushedSha: 'd'.repeat(40), markedReady: true }));
  await symlink(target, statePath(dir));
  expect(await readFixState(log(dir))).toBeNull();
});

test('AC-8: readyHeld is clipped to 500 characters', async () => {
  const dir = await tempDir();
  await writeFile(statePath(dir), JSON.stringify({ markedReady: false, readyHeld: 'x'.repeat(600) }));
  expect(await readFixState(log(dir))).toEqual({ pushedSha: null, fixReady: { markedReady: false, readyHeld: 'x'.repeat(500) } });
});

test('AC-11: an unreadable state file returns null', async () => {
  const dir = await tempDir();
  const stateDir = statePath(dir);
  await mkdir(stateDir);
  expect(await readFixState(log(dir))).toBeNull();
});
