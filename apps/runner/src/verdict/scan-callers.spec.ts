import { afterAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { readFixResult } from './fix-result';
import { reviewPosted } from './review-posted';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

/** US-006: the callers scan instead of reading, so the marker sits behind a file far larger than one buffer. */
const FILLER_LINES = 50_000;

async function stdoutWith(prefix: string, lastLine: string): Promise<string> {
  const path = join(await tmp.make(prefix), 'nax.stdout');
  await writeFile(path, `${'nax: working on it\n'.repeat(FILLER_LINES)}${lastLine}\n`);
  return path;
}

test('AC-5: readFixResult reads the assigned PR result behind 50,000 filler lines', async () => {
  const path = await stdoutWith('scan-callers-fix', 'nax bot fix: PR #7 — pushed abc');
  expect(await readFixResult(path, 7)).toEqual({ kind: 'pushed', logPath: null });
});

test('AC-6: reviewPosted reads the posted marker behind 50,000 filler lines', async () => {
  const path = await stdoutWith('scan-callers-review', 'nax bot review: artifact /out/bot/pr-42/r1/bot-review.json');
  expect(await reviewPosted(path)).toBe(true);
});

test('AC-7: reviewPosted on a path that does not exist resolves false', async () => {
  const dir = await tmp.make('scan-callers-missing');
  expect(await reviewPosted(join(dir, 'nax.stdout'))).toBe(false);
});
