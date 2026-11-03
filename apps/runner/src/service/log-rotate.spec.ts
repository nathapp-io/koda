import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { RUNNER_LOG_MAX_BYTES, rotateLogFile } from './log-rotate';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const BYTES = 'a'.repeat(25);

async function logFile(contents: string): Promise<string> {
  const path = join(await tmp.make('rotate'), 'runner.log');
  await writeFile(path, contents);
  return path;
}

/** OPS-1: launchd appends to runner.log forever; the daemon bounds it with this helper. */
describe('RUNNER_LOG_MAX_BYTES', () => {
  test('AC-7: the default ceiling is 10 MiB', () => {
    expect(RUNNER_LOG_MAX_BYTES).toBe(10_485_760);
    expect(RUNNER_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('rotateLogFile', () => {
  test('AC-8: a log larger than maxBytes moves its bytes to .1 and empties the original inode', async () => {
    const path = await logFile(BYTES);
    const before = await stat(path);
    expect(await rotateLogFile(path, 10)).toBe(true);
    expect(await readFile(`${path}.1`, 'utf8')).toBe(BYTES);
    expect(await readFile(path, 'utf8')).toBe('');
    // The same inode, not a new file: launchd holds the log's descriptor open, so a rename would keep it writing
    // into the .1 file.
    expect((await stat(path)).ino).toBe(before.ino);
  });

  test('AC-9: an existing .1 is replaced, never appended to', async () => {
    const path = await logFile(BYTES);
    await writeFile(`${path}.1`, 'an older rotation that is far longer than the new contents');
    expect(await rotateLogFile(path, 10)).toBe(true);
    expect(await readFile(`${path}.1`, 'utf8')).toBe(BYTES);
  });

  test('AC-10: a missing log rotates nothing and does not throw', async () => {
    const path = join(await tmp.make('rotate'), 'runner.log');
    expect(await rotateLogFile(path, 10)).toBe(false);
    await expect(stat(`${path}.1`)).rejects.toThrow();
  });

  test('AC-11: a log exactly at maxBytes is not rotated (strictly greater only)', async () => {
    const path = await logFile(BYTES);
    expect(await rotateLogFile(path, 25)).toBe(false);
    await expect(stat(`${path}.1`)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(BYTES);
  });

  test('a log under maxBytes is left alone', async () => {
    const path = await logFile('short');
    expect(await rotateLogFile(path, 10)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('short');
  });

  test('a path that is not a regular file is an error (the daemon cannot bound it), whatever its size', async () => {
    const path = join(await tmp.make('rotate'), 'runner.log');
    await mkdir(path);                                        // a directory where the log should be
    await expect(rotateLogFile(path, RUNNER_LOG_MAX_BYTES)).rejects.toThrow(/not a regular file/);
  });

  test('a filesystem error other than a missing log propagates to the caller, which guards it', async () => {
    const dir = await tmp.make('rotate');
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    // ENOTDIR, not ENOENT: only a missing log is silent; a broken path must reach the daemon's warning.
    await expect(rotateLogFile(join(file, 'runner.log'), 1)).rejects.toThrow();
  });

  test('F1: a symlink in place of the log is refused, and its target is neither copied nor truncated', async () => {
    const dir = await tmp.make('rotate');
    const path = join(dir, 'runner.log');
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, BYTES);
    await symlink(victim, path);
    await expect(rotateLogFile(path, 10)).rejects.toThrow(/not a regular file/);
    expect(await readFile(victim, 'utf8')).toBe(BYTES);                    // untouched
    expect(await readFile(path, 'utf8')).toBe(BYTES);                      // the link still resolves
    await expect(stat(`${path}.1`)).rejects.toThrow();                     // nothing was written
  });
});
