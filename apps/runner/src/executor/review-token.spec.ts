import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { REVIEW_TOKEN_FILE, removeReviewToken, writeReviewToken } from './review-token';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('review-token (US-006: the K0 token file)', () => {
  test('AC-1: writeReviewToken creates <jobDir>/forge-token with the token and returns its path', async () => {
    const jobDir = await tmp.make('rt');
    const path = await writeReviewToken(jobDir, 'tok-review-9');
    expect(path).toBe(join(jobDir, REVIEW_TOKEN_FILE));
    expect(path).toBe(join(jobDir, 'forge-token'));
    expect(await readFile(path, 'utf8')).toBe('tok-review-9');
  });

  test('AC-2: the created file has mode 0600', async () => {
    const jobDir = await tmp.make('rt');
    const path = await writeReviewToken(jobDir, 'tok-review-9');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('AC-3: removeReviewToken removes <jobDir>/forge-token', async () => {
    const jobDir = await tmp.make('rt');
    const path = await writeReviewToken(jobDir, 'tok-review-9');
    await removeReviewToken(jobDir);
    await expect(stat(path)).rejects.toThrow();
  });

  test('a second write replaces the token of an earlier write', async () => {
    const jobDir = await tmp.make('rt');
    await writeReviewToken(jobDir, 'tok-first');
    const path = await writeReviewToken(jobDir, 'tok-second');
    expect(await readFile(path, 'utf8')).toBe('tok-second');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('removing a token file that is not there is not an error', async () => {
    const jobDir = await tmp.make('rt');
    await expect(removeReviewToken(jobDir)).resolves.toBeUndefined();
  });
});
