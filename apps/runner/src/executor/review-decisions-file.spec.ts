import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { writeReviewDecisions } from './review-decisions-file';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('writeReviewDecisions', () => {
  test('AC-1: writes the versioned decisions object', async () => {
    const dir = await tmp.make('decisions-content');
    await writeReviewDecisions(dir, [{ id: 'm1', statement: 's' }]);
    expect(JSON.parse(await readFile(join(dir, 'review-decisions.json'), 'utf8'))).toEqual({ version: 1, decisions: [{ id: 'm1', statement: 's' }] });
  });

  test('AC-2: returns the absolute decisions file path', async () => {
    const dir = await tmp.make('decisions-path');
    expect(await writeReviewDecisions(dir, [{ id: 'm1', statement: 's' }])).toBe(join(dir, 'review-decisions.json'));
  });

  test('AC-3: creates the file with mode 0600', async () => {
    const dir = await tmp.make('decisions-mode');
    const path = await writeReviewDecisions(dir, [{ id: 'm1', statement: 's' }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('AC-4: writes exactly the compact JSON bytes', async () => {
    const dir = await tmp.make('decisions-size');
    const decisions = [{ id: 'm1', statement: 's' }];
    const path = await writeReviewDecisions(dir, decisions);
    expect((await stat(path)).size).toBe(Buffer.byteLength(JSON.stringify({ version: 1, decisions })));
  });
});
