import { afterAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { MAX_SCAN_LINE_BYTES, scanLines } from './scan-lines';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

/** A real file in a temp dir: these tests are about what a stream delivers, so the file is real. */
async function fileWith(prefix: string, contents: string): Promise<string> {
  const path = join(await tmp.make(prefix), 'nax.stdout');
  await writeFile(path, contents);
  return path;
}

test('AC-1: a path that does not exist resolves false and never calls onLine', async () => {
  const dir = await tmp.make('scan-missing');
  const seen: string[] = [];
  const resolved = await scanLines(join(dir, 'nax.stdout'), (line) => { seen.push(line); });
  expect(resolved).toBe(false);
  expect(seen).toEqual([]);
});

test('AC-2: a line feed and a carriage return plus line feed both end a line', async () => {
  const path = await fileWith('scan-terminators', 'a\nb\r\nc');
  const seen: string[] = [];
  const resolved = await scanLines(path, (line) => { seen.push(line); });
  expect(resolved).toBe(true);
  expect(seen).toEqual(['a', 'b', 'c']);
});

test('AC-3: stop ends the scan after the first line of a three-line file', async () => {
  const path = await fileWith('scan-stop', 'one\ntwo\nthree\n');
  const seen: string[] = [];
  const resolved = await scanLines(path, (line) => { seen.push(line); return 'stop'; });
  expect(resolved).toBe(true);
  expect(seen).toEqual(['one']);
});

test('AC-4: a line over the cap is delivered once, cut to the cap, and the next line follows', async () => {
  const path = await fileWith('scan-cap', `${'x'.repeat(200_000)}\ntail\n`);
  const seen: string[] = [];
  const resolved = await scanLines(path, (line) => { seen.push(line); });
  expect(resolved).toBe(true);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe('x'.repeat(MAX_SCAN_LINE_BYTES));
  expect(seen[1]).toBe('tail');
});

test('AC-13: a path that is a directory rejects', async () => {
  const dir = await tmp.make('scan-directory');
  await expect(scanLines(dir, () => undefined)).rejects.toThrow();
});

test('AC-14: an empty file resolves true and never calls onLine', async () => {
  const path = await fileWith('scan-empty', '');
  const seen: string[] = [];
  const resolved = await scanLines(path, (line) => { seen.push(line); });
  expect(resolved).toBe(true);
  expect(seen).toEqual([]);
});
