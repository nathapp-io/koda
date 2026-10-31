import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { reviewPosted } from './review-posted';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('reviewPosted', () => {
  test('recognizes a posted-review marker line', async () => {
    const dir = await tmp.make('review-marker');
    const stdout = join(dir, 'nax.stdout');
    await writeFile(stdout, 'ordinary output\nnax bot review: artifact /out/bot/pr-42/r1/bot-review.json\n');
    expect(await reviewPosted(stdout)).toBe(true);
  });

  test('ignores output without a marker at the start of a line', async () => {
    const dir = await tmp.make('review-no-marker');
    const stdout = join(dir, 'nax.stdout');
    await writeFile(stdout, 'prefix nax bot review: artifact /out/review.json\n');
    expect(await reviewPosted(stdout)).toBe(false);
  });

  test('returns false when stdout does not exist', async () => {
    const dir = await tmp.make('review-missing');
    expect(await reviewPosted(join(dir, 'nax.stdout'))).toBe(false);
  });
});
