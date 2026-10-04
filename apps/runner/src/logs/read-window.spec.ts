import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { readWindow } from './read-window';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const file = async (content: string | Buffer) => {
  const path = join(await tmp.make('window'), 'f.log');
  await writeFile(path, content);
  return path;
};
const text = (w: { bytes: Buffer } | null) => w?.bytes.toString('utf8');

describe('readWindow (spec §2.4, R12)', () => {
  test('an absent file is null', async () => {
    expect(await readWindow(join(await tmp.make('none'), 'missing.log'), 0, 64, false)).toBeNull();
  });
  test('cuts after the last newline, from the given offset, and reports the file size', async () => {
    const path = await file('a\nbb\ncc');
    expect(await readWindow(path, 0, 64, false)).toEqual({ fileSize: 7, bytes: Buffer.from('a\nbb\n') });
    expect(text(await readWindow(path, 2, 64, false))).toBe('bb\n');
  });
  test('holds a partial last line back, but sends it whole when reading to the end (drain)', async () => {
    const path = await file('a\nbb\ncc');
    expect(text(await readWindow(path, 5, 64, false))).toBe('');
    expect(text(await readWindow(path, 5, 64, true))).toBe('cc');
  });
  test('never reads more than maxBytes; a window with no newline is sent whole only when it is full (R12)', async () => {
    const path = await file(`${'x'.repeat(100)}\n`);
    expect((await readWindow(path, 0, 64, false))?.bytes.length).toBe(64);
    expect(text(await readWindow(path, 64, 64, false))).toBe(`${'x'.repeat(36)}\n`);
    const short = await file('no newline yet');
    expect(text(await readWindow(short, 0, 64, false))).toBe('');
  });
  test('at or past the end it returns no bytes and the real size (the caller detects a shrink)', async () => {
    const path = await file('abc\n');
    expect(await readWindow(path, 4, 64, false)).toEqual({ fileSize: 4, bytes: Buffer.alloc(0) });
    expect(await readWindow(path, 10, 64, true)).toEqual({ fileSize: 4, bytes: Buffer.alloc(0) });
  });
  test('works on raw bytes: a multi-byte character split by the window stays split', async () => {
    const path = await file(Buffer.from('éé\n', 'utf8'));
    const head = await readWindow(path, 0, 3, true);
    expect(head?.bytes).toEqual(Buffer.from([0xc3, 0xa9, 0xc3]));
  });
});
