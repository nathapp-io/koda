import { afterAll, expect, test } from 'bun:test';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { writeReviewRulings } from './review-rulings-file';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

test('US-008 AC-4: writes the exact private versioned caller rulings and returns its path', async () => {
  const dir = await tmp.make('rulings');
  const rulings = { headSha: 'a'.repeat(40), rulings: [{ item: 'D-1', ruling: 'confirm: checked', by: 'koda:agent:dev', at: '2026-01-01T00:00:00+00:00' }] };
  const path = await writeReviewRulings(dir, rulings);
  expect(path).toBe(join(dir, 'review-rulings.json'));
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify({ version: 1, ...rulings }));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await chmod(path, 0o644);
  await writeFile(path, 'stale');
  await writeReviewRulings(dir, rulings);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
